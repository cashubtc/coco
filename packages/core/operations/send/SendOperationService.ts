import { OutputData, type Token, type Proof } from '@cashu/cashu-ts';
import type { SendOperationRepository, ProofRepository } from '../../repositories';
import type { SendOperation } from './SendOperation';
import { createSendOperation } from './SendOperation';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { ProofService } from '../../services/ProofService';
import type { CounterService } from '../../services/CounterService';
import type { SeedService } from '../../services/SeedService';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import { generateSubId, mapProofToCoreProof } from '../../utils';
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
  private readonly counterService: CounterService;
  private readonly seedService: SeedService;
  private readonly eventBus: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  constructor(
    sendOperationRepository: SendOperationRepository,
    proofRepository: ProofRepository,
    proofService: ProofService,
    mintService: MintService,
    walletService: WalletService,
    counterService: CounterService,
    seedService: SeedService,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
  ) {
    this.sendOperationRepository = sendOperationRepository;
    this.proofRepository = proofRepository;
    this.proofService = proofService;
    this.mintService = mintService;
    this.walletService = walletService;
    this.counterService = counterService;
    this.seedService = seedService;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  /**
   * Create a new send operation.
   * This is the entry point for the saga.
   */
  private async init(mintUrl: string, amount: number): Promise<SendOperation> {
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
  private async prepare(operation: SendOperation): Promise<SendOperation> {
    if (operation.state !== 'init') {
      throw new Error(`Cannot prepare operation in state ${operation.state}`);
    }

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
    let keepAmount = 0;
    let sendAmount = amount;
    let counterStart: number | undefined;
    let keysetId: string | undefined;

    if (!needsSwap && exactProofs.send.length > 0) {
      // Exact match - no swap needed
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
      keepAmount = selectedAmount - amount - fee;
      sendAmount = amount;

      // Get counter for deterministic output creation
      const currentCounter = await this.counterService.getCounter(mintUrl, keys.id);
      counterStart = currentCounter.counter;
      keysetId = keys.id;

      this.logger?.debug('Swap required for send', {
        operationId: operation.id,
        amount,
        fee,
        keepAmount,
        selectedAmount,
        proofCount: selectedProofs.length,
        counterStart,
      });
    }

    // Reserve the selected proofs
    const inputSecrets = selectedProofs.map((p) => p.secret);
    await this.proofRepository.reserveProofs(mintUrl, inputSecrets, operation.id);

    // Increment counters if swap is needed (outputs will be created deterministically)
    if (needsSwap && counterStart !== undefined && keysetId) {
      const seed = await this.seedService.getSeed();
      // Calculate how many outputs will be created
      const keepOutputCount =
        keepAmount > 0
          ? this.calculateOutputCount(keepAmount, keys.keys)
          : 0;
      const sendOutputCount = this.calculateOutputCount(sendAmount, keys.keys);

      // Increment counter for all outputs
      const totalOutputs = keepOutputCount + sendOutputCount;
      if (totalOutputs > 0) {
        await this.counterService.incrementCounter(mintUrl, keysetId, totalOutputs);
      }
    }

    // Update operation with prepared data
    const prepared: SendOperation = {
      ...operation,
      state: 'prepared',
      needsSwap,
      fee,
      inputAmount: selectedProofs.reduce((acc, p) => acc + p.amount, 0),
      inputProofSecrets: inputSecrets,
      keysetId,
      counterStart,
      keepAmount,
      sendAmount,
      updatedAt: Date.now(),
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
    operation: SendOperation,
  ): Promise<{ operation: SendOperation; token: Token }> {
    if (operation.state !== 'prepared') {
      throw new Error(`Cannot execute operation in state ${operation.state}`);
    }

    const { mintUrl, amount, needsSwap, inputProofSecrets } = operation;

    if (!inputProofSecrets || inputProofSecrets.length === 0) {
      throw new Error('No input proofs found for operation');
    }

    // Mark as executing
    const executing: SendOperation = {
      ...operation,
      state: 'executing',
      updatedAt: Date.now(),
    };
    await this.sendOperationRepository.update(executing);

    const { wallet, keys } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);

    // Get the reserved proofs
    const reservedProofs = await this.proofRepository.getProofsByOperationId(
      mintUrl,
      operation.id,
    );
    const inputProofs = reservedProofs.filter((p) =>
      inputProofSecrets.includes(p.secret),
    );

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
      // Perform swap
      const { counterStart, keepAmount, sendAmount, keysetId } = operation;

      if (counterStart === undefined || keysetId === undefined) {
        throw new Error('Missing counter or keyset information for swap');
      }

      // Recreate deterministic outputs
      const seed = await this.seedService.getSeed();
      const outputData = this.createDeterministicOutputs(
        seed,
        counterStart,
        keys,
        keepAmount ?? 0,
        sendAmount ?? amount,
      );

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

    // Update operation to pending
    const pending: SendOperation = {
      ...executing,
      state: 'pending',
      keepProofSecrets: keepProofs.map((p) => p.secret),
      sendProofSecrets: sendSecrets,
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
    let operation = await this.init(mintUrl, amount);
    operation = await this.prepare(operation);
    const { token } = await this.execute(operation);
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

    const completed: SendOperation = {
      ...operation,
      state: 'completed',
      updatedAt: Date.now(),
    };
    await this.sendOperationRepository.update(completed);

    // Release proof reservations (they're already spent)
    if (operation.inputProofSecrets) {
      await this.proofRepository.releaseProofs(operation.mintUrl, operation.inputProofSecrets);
    }
    if (operation.sendProofSecrets) {
      await this.proofRepository.releaseProofs(operation.mintUrl, operation.sendProofSecrets);
    }

    await this.eventBus.emit('send:finalized', {
      mintUrl: operation.mintUrl,
      operationId,
      operation: completed,
    });

    this.logger?.info('Send operation finalized', { operationId });
  }

  /**
   * Rollback an operation by reclaiming the proofs.
   * Only works for operations in 'prepared' or 'pending' state where proofs are not spent.
   */
  async rollback(operationId: string): Promise<void> {
    const operation = await this.sendOperationRepository.getById(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    if (operation.state === 'completed' || operation.state === 'rolled_back') {
      throw new Error(`Cannot rollback operation in state ${operation.state}`);
    }

    const { mintUrl } = operation;

    if (operation.state === 'prepared') {
      // Just release the reserved proofs - no swap was done yet
      if (operation.inputProofSecrets) {
        await this.proofRepository.releaseProofs(mintUrl, operation.inputProofSecrets);
      }
      this.logger?.info('Rolling back prepared operation - released reserved proofs', {
        operationId,
      });
    } else if (operation.state === 'pending') {
      // Need to reclaim the send proofs by swapping them back
      if (operation.sendProofSecrets && operation.sendProofSecrets.length > 0) {
        const { wallet, keys } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);

        // Get the send proofs
        const allProofs = await this.proofRepository.getProofsByOperationId(mintUrl, operationId);
        const sendProofs = allProofs.filter(
          (p) => operation.sendProofSecrets?.includes(p.secret) && p.state === 'inflight',
        );

        if (sendProofs.length > 0) {
          const totalAmount = sendProofs.reduce((acc, p) => acc + p.amount, 0);
          const fee = wallet.getFeesForProofs(sendProofs);
          const reclaimAmount = totalAmount - fee;

          if (reclaimAmount > 0) {
            // Get new counter for reclaim outputs
            const currentCounter = await this.counterService.getCounter(mintUrl, keys.id);
            const seed = await this.seedService.getSeed();

            // Create outputs for reclaim (all goes to keep)
            const outputData = this.createDeterministicOutputs(
              seed,
              currentCounter.counter,
              keys,
              reclaimAmount,
              0,
            );

            // Increment counter
            await this.counterService.incrementCounter(mintUrl, keys.id, outputData.keep.length);

            // Swap to reclaim
            const { keep } = await wallet.send(0, sendProofs, {
              outputData: { keep: outputData.keep, send: [] },
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
      if (operation.inputProofSecrets) {
        await this.proofRepository.releaseProofs(mintUrl, operation.inputProofSecrets);
      }
      if (operation.sendProofSecrets) {
        await this.proofRepository.releaseProofs(mintUrl, operation.sendProofSecrets);
      }
    }

    // Mark as rolled back
    const rolledBack: SendOperation = {
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

    this.logger?.info('Send operation rolled back', { operationId, previousState: operation.state });
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

  /**
   * Calculate how many outputs will be created for a given amount.
   */
  private calculateOutputCount(amount: number, keys: Record<string, string>): number {
    if (amount <= 0) return 0;

    const sortedAmounts = Object.keys(keys)
      .map(Number)
      .sort((a, b) => b - a);

    let remaining = amount;
    let count = 0;

    for (const denomination of sortedAmounts) {
      if (denomination <= 0) continue;
      const numOutputs = Math.floor(remaining / denomination);
      count += numOutputs;
      remaining -= numOutputs * denomination;
      if (remaining === 0) break;
    }

    return count;
  }

  /**
   * Create deterministic outputs for a swap operation.
   */
  private createDeterministicOutputs(
    seed: Uint8Array,
    counterStart: number,
    keys: { keys: Record<string, string>; id: string },
    keepAmount: number,
    sendAmount: number,
  ): { keep: OutputData[]; send: OutputData[] } {
    const result: { keep: OutputData[]; send: OutputData[] } = { keep: [], send: [] };

    if (keepAmount > 0) {
      result.keep = OutputData.createDeterministicData(keepAmount, seed, counterStart, keys);
    }

    if (sendAmount > 0) {
      result.send = OutputData.createDeterministicData(
        sendAmount,
        seed,
        counterStart + result.keep.length,
        keys,
      );
    }

    return result;
  }
}

