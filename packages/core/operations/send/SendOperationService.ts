import { type Token, type Proof } from '@cashu/cashu-ts';
import type { SendOperationRepository, ProofRepository } from '../../repositories';
import type {
  SendOperation,
  InitSendOperation,
  PreparedSendOperation,
  ExecutingSendOperation,
  PendingSendOperation,
  CompletedSendOperation,
  RolledBackSendOperation,
  PreparedOrLaterOperation,
} from './SendOperation';
import {
  createSendOperation,
  hasPreparedData,
  getSendProofSecrets,
  getKeepProofSecrets,
} from './SendOperation';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { ProofService } from '../../services/ProofService';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import {
  generateSubId,
  mapProofToCoreProof,
  serializeOutputData,
  deserializeOutputData,
} from '../../utils';
import { UnknownMintError, ProofValidationError } from '../../models/Error';

/**
 * Service that manages send operations as sagas.
 *
 * This service provides crash recovery and rollback capabilities for send operations
 * by breaking them into discrete steps: init → prepare → execute → finalize/rollback.
 */
export class SendOperationService {
  private readonly sendOperationRepository: SendOperationRepository;
  private readonly proofRepository: ProofRepository;
  private readonly proofService: ProofService;
  private readonly mintService: MintService;
  private readonly walletService: WalletService;
  private readonly eventBus: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  constructor(
    sendOperationRepository: SendOperationRepository,
    proofRepository: ProofRepository,
    proofService: ProofService,
    mintService: MintService,
    walletService: WalletService,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
  ) {
    this.sendOperationRepository = sendOperationRepository;
    this.proofRepository = proofRepository;
    this.proofService = proofService;
    this.mintService = mintService;
    this.walletService = walletService;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  /**
   * Create a new send operation.
   * This is the entry point for the saga.
   */
  private async init(mintUrl: string, amount: number): Promise<InitSendOperation> {
    const trusted = await this.mintService.isTrustedMint(mintUrl);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ProofValidationError('Amount must be a positive number');
    }

    const id = generateSubId();
    const operation = createSendOperation(id, mintUrl, amount);

    await this.sendOperationRepository.create(operation);
    this.logger?.debug('Send operation created', { operationId: id, mintUrl, amount });

    return operation;
  }

  /**
   * Prepare the operation by reserving proofs and creating outputs.
   * After this step, the operation can be executed or rolled back.
   */
  private async prepare(operation: InitSendOperation): Promise<PreparedSendOperation> {
    const { mintUrl, amount } = operation;
    const { wallet, keys } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);

    // Get available proofs (ready and not reserved by other operations)
    const availableProofs = await this.proofRepository.getAvailableProofs(mintUrl);
    const totalAvailable = availableProofs.reduce((acc, p) => acc + p.amount, 0);

    if (totalAvailable < amount) {
      throw new ProofValidationError(
        `Insufficient balance: need ${amount}, have ${totalAvailable}`,
      );
    }

    // Try exact match first (no swap needed)
    const exactProofs = wallet.selectProofsToSend(availableProofs, amount, false);
    const exactAmount = exactProofs.send.reduce((acc, p) => acc + p.amount, 0);
    const needsSwap = exactAmount !== amount || exactProofs.send.length === 0;

    let selectedProofs: Proof[];
    let fee = 0;
    let serializedOutputData: PreparedSendOperation['outputData'];

    if (!needsSwap && exactProofs.send.length > 0) {
      // Exact match - no swap needed, no OutputData
      selectedProofs = exactProofs.send;
      this.logger?.debug('Exact match found for send', {
        operationId: operation.id,
        amount,
        proofCount: selectedProofs.length,
      });
    } else {
      // Need to swap - select proofs including fees
      const selected = wallet.selectProofsToSend(availableProofs, amount, true);
      selectedProofs = selected.send;
      const selectedAmount = selectedProofs.reduce((acc, p) => acc + p.amount, 0);
      fee = wallet.getFeesForProofs(selectedProofs);
      const keepAmount = selectedAmount - amount - fee;

      // Use ProofService to create outputs and increment counters
      const outputResult = await this.proofService.createOutputsAndIncrementCounters(mintUrl, {
        keep: keepAmount,
        send: amount,
      });

      // Serialize for storage
      serializedOutputData = serializeOutputData({
        keep: outputResult.keep,
        send: outputResult.send,
      });

      this.logger?.debug('Swap required for send', {
        operationId: operation.id,
        amount,
        fee,
        keepAmount,
        selectedAmount,
        proofCount: selectedProofs.length,
        keepOutputs: outputResult.keep.length,
        sendOutputs: outputResult.send.length,
      });
    }

    // Reserve the selected proofs
    const inputSecrets = selectedProofs.map((p) => p.secret);
    await this.proofRepository.reserveProofs(mintUrl, inputSecrets, operation.id);

    // Build prepared operation
    const prepared: PreparedSendOperation = {
      id: operation.id,
      state: 'prepared',
      mintUrl: operation.mintUrl,
      amount: operation.amount,
      createdAt: operation.createdAt,
      updatedAt: Date.now(),
      error: operation.error,
      needsSwap,
      fee,
      inputAmount: selectedProofs.reduce((acc, p) => acc + p.amount, 0),
      inputProofSecrets: inputSecrets,
      outputData: serializedOutputData,
    };

    await this.sendOperationRepository.update(prepared);
    this.logger?.info('Send operation prepared', {
      operationId: operation.id,
      needsSwap,
      fee,
      inputProofCount: inputSecrets.length,
    });

    return prepared;
  }

  /**
   * Execute the prepared operation.
   * Performs the swap (if needed) and creates the token.
   */
  private async execute(
    operation: PreparedSendOperation,
  ): Promise<{ operation: PendingSendOperation; token: Token }> {
    const { mintUrl, amount, needsSwap, inputProofSecrets } = operation;

    // Mark as executing
    const executing: ExecutingSendOperation = {
      ...operation,
      state: 'executing',
      updatedAt: Date.now(),
    };
    await this.sendOperationRepository.update(executing);

    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);

    // Get the reserved proofs
    const reservedProofs = await this.proofRepository.getProofsByOperationId(mintUrl, operation.id);
    const inputProofs = reservedProofs.filter((p) => inputProofSecrets.includes(p.secret));

    if (inputProofs.length !== inputProofSecrets.length) {
      throw new Error('Could not find all reserved proofs');
    }

    let sendProofs: Proof[];
    let keepProofs: Proof[] = [];

    if (!needsSwap) {
      // Exact match - just use the proofs directly
      sendProofs = inputProofs;
      this.logger?.debug('Executing exact match send', {
        operationId: operation.id,
        proofCount: sendProofs.length,
      });
    } else {
      // Perform swap using stored OutputData
      if (!operation.outputData) {
        throw new Error('Missing output data for swap operation');
      }

      // Deserialize OutputData
      const outputData = deserializeOutputData(operation.outputData);

      this.logger?.debug('Executing swap', {
        operationId: operation.id,
        keepOutputs: outputData.keep.length,
        sendOutputs: outputData.send.length,
      });

      // Perform the swap with the mint
      const result = await wallet.send(amount, inputProofs, { outputData });
      sendProofs = result.send;
      keepProofs = result.keep;

      // Save new proofs (use proofService to emit events)
      const allNewProofs = [...keepProofs, ...sendProofs];
      await this.proofService.saveProofs(
        mintUrl,
        mapProofToCoreProof(mintUrl, 'ready', allNewProofs),
      );

      // Mark new proofs as created by this operation
      await this.proofRepository.setCreatedByOperation(
        mintUrl,
        allNewProofs.map((p) => p.secret),
        operation.id,
      );

      // Mark input proofs as spent (use proofService to emit events)
      await this.proofService.setProofState(mintUrl, inputProofSecrets, 'spent');
    }

    // Mark send proofs as inflight (use proofService to emit events)
    const sendSecrets = sendProofs.map((p) => p.secret);
    await this.proofService.setProofState(mintUrl, sendSecrets, 'inflight');

    // Build pending operation
    const pending: PendingSendOperation = {
      ...executing,
      state: 'pending',
      updatedAt: Date.now(),
    };
    await this.sendOperationRepository.update(pending);

    const token: Token = {
      mint: mintUrl,
      proofs: sendProofs,
    };

    // Emit event
    await this.eventBus.emit('send:created', { mintUrl, token });

    this.logger?.info('Send operation executed', {
      operationId: operation.id,
      sendProofCount: sendProofs.length,
      keepProofCount: keepProofs.length,
    });

    return { operation: pending, token };
  }

  /**
   * High-level send method that orchestrates init → prepare → execute.
   * This is the main entry point for consumers.
   */
  async send(mintUrl: string, amount: number): Promise<Token> {
    const initOp = await this.init(mintUrl, amount);
    const preparedOp = await this.prepare(initOp);
    const { token } = await this.execute(preparedOp);
    return token;
  }

  /**
   * Finalize a pending operation after its proofs have been spent.
   */
  async finalize(operationId: string): Promise<void> {
    const operation = await this.sendOperationRepository.getById(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    if (operation.state !== 'pending') {
      throw new Error(`Cannot finalize operation in state ${operation.state}`);
    }

    // TypeScript knows operation is PendingSendOperation
    const pendingOp = operation as PendingSendOperation;

    const completed: CompletedSendOperation = {
      ...pendingOp,
      state: 'completed',
      updatedAt: Date.now(),
    };
    await this.sendOperationRepository.update(completed);

    // Release proof reservations (they're already spent)
    // Derive secrets from operation data
    const sendSecrets = getSendProofSecrets(pendingOp);
    const keepSecrets = getKeepProofSecrets(pendingOp);

    await this.proofRepository.releaseProofs(pendingOp.mintUrl, pendingOp.inputProofSecrets);
    if (sendSecrets.length > 0) {
      await this.proofRepository.releaseProofs(pendingOp.mintUrl, sendSecrets);
    }
    if (keepSecrets.length > 0) {
      await this.proofRepository.releaseProofs(pendingOp.mintUrl, keepSecrets);
    }

    await this.eventBus.emit('send:finalized', {
      mintUrl: pendingOp.mintUrl,
      operationId,
      operation: completed,
    });

    this.logger?.info('Send operation finalized', { operationId });
  }

  /**
   * Rollback an operation by reclaiming the proofs.
   * Only works for operations in 'prepared', 'executing', or 'pending' state.
   */
  async rollback(operationId: string): Promise<void> {
    const operation = await this.sendOperationRepository.getById(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    if (
      operation.state === 'completed' ||
      operation.state === 'rolled_back' ||
      operation.state === 'init'
    ) {
      throw new Error(`Cannot rollback operation in state ${operation.state}`);
    }

    // At this point, operation has PreparedData
    if (!hasPreparedData(operation)) {
      throw new Error(`Operation ${operationId} is not in a rollbackable state`);
    }

    const { mintUrl, inputProofSecrets } = operation;

    if (operation.state === 'prepared' || operation.state === 'executing') {
      // Just release the reserved proofs - no swap was done yet
      await this.proofRepository.releaseProofs(mintUrl, inputProofSecrets);
      this.logger?.info('Rolling back prepared/executing operation - released reserved proofs', {
        operationId,
      });
    } else if (operation.state === 'pending') {
      // Need to reclaim the send proofs by swapping them back
      const sendSecrets = getSendProofSecrets(operation);

      if (sendSecrets.length > 0) {
        const { wallet, keys } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);

        // Get the send proofs
        const allProofs = await this.proofRepository.getProofsByOperationId(mintUrl, operationId);
        const sendProofs = allProofs.filter(
          (p) => sendSecrets.includes(p.secret) && p.state === 'inflight',
        );

        if (sendProofs.length > 0) {
          const totalAmount = sendProofs.reduce((acc, p) => acc + p.amount, 0);
          const fee = wallet.getFeesForProofs(sendProofs);
          const reclaimAmount = totalAmount - fee;

          if (reclaimAmount > 0) {
            // Use ProofService to create outputs for reclaim
            const outputResult = await this.proofService.createOutputsAndIncrementCounters(
              mintUrl,
              { keep: reclaimAmount, send: 0 },
            );

            // Swap to reclaim
            const { keep } = await wallet.send(0, sendProofs, {
              outputData: { keep: outputResult.keep, send: [] },
            });

            // Save reclaimed proofs
            await this.proofRepository.saveProofs(
              mintUrl,
              mapProofToCoreProof(mintUrl, 'ready', keep),
            );

            // Mark send proofs as spent
            await this.proofRepository.setProofState(
              mintUrl,
              sendProofs.map((p) => p.secret),
              'spent',
            );

            this.logger?.info('Reclaimed proofs from pending operation', {
              operationId,
              reclaimedAmount: reclaimAmount,
              proofCount: keep.length,
            });
          }
        }
      }

      // Release any remaining reservations
      await this.proofRepository.releaseProofs(mintUrl, inputProofSecrets);
      const keepSecrets = getKeepProofSecrets(operation);
      if (keepSecrets.length > 0) {
        await this.proofRepository.releaseProofs(mintUrl, keepSecrets);
      }
    }

    // Build rolled back operation
    const rolledBack: RolledBackSendOperation = {
      ...operation,
      state: 'rolled_back',
      updatedAt: Date.now(),
    };
    await this.sendOperationRepository.update(rolledBack);

    await this.eventBus.emit('send:rolled-back', {
      mintUrl: operation.mintUrl,
      operationId,
      operation: rolledBack,
    });

    this.logger?.info('Send operation rolled back', {
      operationId,
      previousState: operation.state,
    });
  }

  /**
   * Recover pending operations on startup.
   * This should be called during initialization.
   */
  async recoverPendingOperations(): Promise<void> {
    const pending = await this.sendOperationRepository.getPending();

    for (const operation of pending) {
      this.logger?.info('Recovering pending send operation', {
        operationId: operation.id,
        state: operation.state,
      });

      // For now, just log - actual recovery logic will depend on
      // checking proof states with the mint
      // TODO: Implement full recovery logic
    }
  }

  /**
   * Get an operation by ID.
   */
  async getOperation(operationId: string): Promise<SendOperation | null> {
    return this.sendOperationRepository.getById(operationId);
  }

  /**
   * Get all pending operations.
   */
  async getPendingOperations(): Promise<SendOperation[]> {
    return this.sendOperationRepository.getPending();
  }
}
