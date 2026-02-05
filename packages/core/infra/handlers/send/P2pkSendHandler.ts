import type { Token, Proof, OutputConfig } from '@cashu/cashu-ts';
import type {
  SendMethodHandler,
  BasePrepareContext,
  ExecuteContext,
  FinalizeContext,
  RollbackContext,
  RecoverExecutingContext,
  ExecutionResult,
} from '../../../operations/send/SendMethodHandler';
import type {
  PreparedSendOperation,
  PendingSendOperation,
  RolledBackSendOperation,
} from '../../../operations/send/SendOperation';
import { getSendProofSecrets, getKeepProofSecrets } from '../../../operations/send/SendOperation';
import { ProofValidationError } from '../../../models/Error';
import {
  mapProofToCoreProof,
  serializeOutputData,
  deserializeOutputData,
} from '../../../utils';
import type { CoreProof } from '../../../types';

/**
 * P2PK send handler for sending tokens locked to a recipient's public key.
 * The recipient must have the corresponding private key to spend the tokens.
 */
export class P2pkSendHandler implements SendMethodHandler<'p2pk'> {
  /**
   * Prepare the send operation by selecting proofs and creating outputs.
   * P2PK sends always require a swap to lock the proofs to the pubkey.
   */
  async prepare(ctx: BasePrepareContext): Promise<PreparedSendOperation> {
    const { operation, wallet, proofRepository, proofService, eventBus, logger } = ctx;
    const { mintUrl, amount } = operation;

    // Validate that we have a pubkey in methodData
    const pubkey = (operation.methodData as { pubkey: string })?.pubkey;
    if (!pubkey) {
      throw new ProofValidationError('P2PK send requires a pubkey in methodData');
    }

    // Get available proofs (ready and not reserved by other operations)
    const availableProofs = await proofRepository.getAvailableProofs(mintUrl);
    const totalAvailable = availableProofs.reduce((acc: number, p: CoreProof) => acc + p.amount, 0);

    if (totalAvailable < amount) {
      throw new ProofValidationError(
        `Insufficient balance: need ${amount}, have ${totalAvailable}`,
      );
    }

    // P2PK always requires a swap to lock proofs to the pubkey
    // Select proofs including fees
    const selected = wallet.selectProofsToSend(availableProofs, amount, true);
    const selectedProofs = selected.send;
    const selectedAmount = selectedProofs.reduce((acc: number, p: Proof) => acc + p.amount, 0);
    const fee = wallet.getFeesForProofs(selectedProofs);
    const keepAmount = selectedAmount - amount - fee;

    // Use ProofService to create outputs and increment counters
    const outputResult = await proofService.createOutputsAndIncrementCounters(mintUrl, {
      keep: keepAmount,
      send: amount,
    });

    // Serialize for storage
    const serializedOutputData = serializeOutputData({
      keep: outputResult.keep,
      send: outputResult.send,
    });

    logger?.debug('P2PK send prepared', {
      operationId: operation.id,
      amount,
      fee,
      keepAmount,
      selectedAmount,
      proofCount: selectedProofs.length,
      keepOutputs: outputResult.keep.length,
      sendOutputs: outputResult.send.length,
      pubkey,
    });

    // Reserve the selected proofs
    const inputSecrets = selectedProofs.map((p: Proof) => p.secret);
    await proofService.reserveProofs(mintUrl, inputSecrets, operation.id);

    // Build prepared operation
    const prepared: PreparedSendOperation = {
      id: operation.id,
      state: 'prepared',
      mintUrl: operation.mintUrl,
      amount: operation.amount,
      createdAt: operation.createdAt,
      updatedAt: Date.now(),
      error: operation.error,
      needsSwap: true, // P2PK always needs swap
      fee,
      inputAmount: selectedAmount,
      inputProofSecrets: inputSecrets,
      outputData: serializedOutputData,
      method: operation.method,
      methodData: operation.methodData,
    };

    // Emit prepared event
    await eventBus.emit('send:prepared', {
      mintUrl,
      operationId: prepared.id,
      operation: prepared,
    });

    logger?.info('P2PK send operation prepared', {
      operationId: operation.id,
      fee,
      inputProofCount: inputSecrets.length,
      pubkey,
    });

    return prepared;
  }

  /**
   * Execute the send operation by performing the swap with P2PK locking.
   */
  async execute(ctx: ExecuteContext): Promise<ExecutionResult> {
    const { operation, wallet, reservedProofs, proofService, eventBus, logger } = ctx;
    const { mintUrl, amount, inputProofSecrets } = operation;

    // Get the pubkey from methodData
    const pubkey = (operation.methodData as { pubkey: string })?.pubkey;
    if (!pubkey) {
      throw new Error('P2PK send requires a pubkey in methodData');
    }

    const inputProofs = reservedProofs.filter((p: Proof) => inputProofSecrets.includes(p.secret));

    if (inputProofs.length !== inputProofSecrets.length) {
      throw new Error('Could not find all reserved proofs');
    }

    // Perform swap using stored OutputData with P2PK locking
    if (!operation.outputData) {
      throw new Error('Missing output data for P2PK swap operation');
    }

    // Deserialize OutputData
    const outputData = deserializeOutputData(operation.outputData);

    logger?.debug('Executing P2PK swap', {
      operationId: operation.id,
      keepOutputs: outputData.keep.length,
      sendOutputs: outputData.send.length,
      pubkey,
    });

    // Use P2PK type for send outputs, custom for keep outputs
    // Note: P2PK type doesn't accept custom data - the wallet generates P2PK-locked outputs
    const outputConfig: OutputConfig = {
      send: { type: 'p2pk', options: { pubkey } },
      keep: { type: 'custom', data: outputData.keep },
    };

    // Perform the swap with the mint
    const result = await wallet.send(amount, inputProofs, undefined, outputConfig);
    const sendProofs = result.send;
    const keepProofs = result.keep;

    // Save new proofs with correct states and operationId in a single call
    const keepCoreProofs = mapProofToCoreProof(mintUrl, 'ready', keepProofs, {
      createdByOperationId: operation.id,
    });
    const sendCoreProofs = mapProofToCoreProof(mintUrl, 'inflight', sendProofs, {
      createdByOperationId: operation.id,
    });
    await proofService.saveProofs(mintUrl, [...keepCoreProofs, ...sendCoreProofs]);

    // Mark input proofs as spent (use proofService to emit events)
    await proofService.setProofState(mintUrl, inputProofSecrets, 'spent');

    // Build pending operation
    const pending: PendingSendOperation = {
      ...operation,
      state: 'pending',
      updatedAt: Date.now(),
    };

    const token: Token = {
      mint: mintUrl,
      proofs: sendProofs,
      unit: wallet.unit,
    };

    // Emit pending event
    await eventBus.emit('send:pending', {
      mintUrl,
      operationId: pending.id,
      operation: pending,
      token,
    });

    logger?.info('P2PK send operation executed', {
      operationId: operation.id,
      sendProofCount: sendProofs.length,
      keepProofCount: keepProofs.length,
      pubkey,
    });

    return { status: 'PENDING', pending, token };
  }

  /**
   * Finalize the send operation after proofs are confirmed spent.
   */
  async finalize(ctx: FinalizeContext): Promise<void> {
    const { operation, proofService, eventBus, logger } = ctx;

    // Release proof reservations (they're already spent)
    const sendSecrets = getSendProofSecrets(operation);
    const keepSecrets = getKeepProofSecrets(operation);

    await proofService.releaseProofs(operation.mintUrl, operation.inputProofSecrets);
    if (sendSecrets.length > 0) {
      await proofService.releaseProofs(operation.mintUrl, sendSecrets);
    }
    if (keepSecrets.length > 0) {
      await proofService.releaseProofs(operation.mintUrl, keepSecrets);
    }

    await eventBus.emit('send:finalized', {
      mintUrl: operation.mintUrl,
      operationId: operation.id,
      operation: { ...operation, state: 'finalized', updatedAt: Date.now() },
    });

    logger?.info('P2PK send operation finalized', { operationId: operation.id });
  }

  /**
   * Rollback the send operation.
   * Note: P2PK tokens sent to an external pubkey cannot be reclaimed without the private key.
   * This rollback only handles the prepared state (before swap) and releases reservations.
   */
  async rollback(ctx: RollbackContext): Promise<void> {
    const { operation, proofService, logger } = ctx;
    const { mintUrl, inputProofSecrets } = operation;

    if (operation.state === 'prepared') {
      // Simple case: just release the reserved proofs - no swap was done yet
      await proofService.releaseProofs(mintUrl, inputProofSecrets);
      logger?.info('Rolling back prepared P2PK operation - released reserved proofs', {
        operationId: operation.id,
      });
    } else if (operation.state === 'pending' || operation.state === 'rolling_back') {
      // P2PK tokens are locked to the recipient's pubkey
      // We cannot reclaim them without the private key
      // Just release reservations and mark as rolled back
      await proofService.releaseProofs(mintUrl, inputProofSecrets);
      const keepSecrets = getKeepProofSecrets(operation);
      if (keepSecrets.length > 0) {
        await proofService.releaseProofs(mintUrl, keepSecrets);
      }

      logger?.warn('P2PK tokens cannot be reclaimed - locked to recipient pubkey', {
        operationId: operation.id,
      });
    }
  }

  /**
   * Recover an executing operation that failed mid-execution.
   */
  async recoverExecuting(ctx: RecoverExecutingContext): Promise<ExecutionResult> {
    const { operation, wallet, proofService, logger } = ctx;

    // P2PK always requires swap - check with mint
    const proofInputs = operation.inputProofSecrets.map((secret: string) => ({ secret }));
    const inputStates = await wallet.checkProofsStates(proofInputs as unknown as Proof[]);
    const allSpent = inputStates.every((s: { state: string }) => s.state === 'SPENT');

    if (!allSpent) {
      // Swap never happened - simple rollback
      await proofService.releaseProofs(operation.mintUrl, operation.inputProofSecrets);
      const failed: RolledBackSendOperation = {
        ...operation,
        state: 'rolled_back',
        updatedAt: Date.now(),
        error: 'Recovered: P2PK swap never executed',
      };
      return { status: 'FAILED', failed };
    }

    // Swap happened - recover keep proofs from OutputData
    // Note: Send proofs are P2PK locked and cannot be recovered without the private key
    if (operation.outputData) {
      await proofService.recoverProofsFromOutputData(operation.mintUrl, operation.outputData);
    }

    // Mark input proofs as spent
    await proofService.setProofState(operation.mintUrl, operation.inputProofSecrets, 'spent');

    const failed: RolledBackSendOperation = {
      ...operation,
      state: 'rolled_back',
      updatedAt: Date.now(),
      error: 'Recovered: P2PK swap succeeded but token never returned',
    };

    logger?.info('Recovered P2PK executing operation', { operationId: operation.id });

    return { status: 'FAILED', failed };
  }
}
