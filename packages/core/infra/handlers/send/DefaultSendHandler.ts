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
 * Default send handler for standard (unlocked) token sends.
 * Handles the prepare and execute phases for sending cashu tokens.
 */
export class DefaultSendHandler implements SendMethodHandler<'default'> {
  /**
   * Prepare the send operation by selecting proofs and creating outputs.
   */
  async prepare(ctx: BasePrepareContext): Promise<PreparedSendOperation> {
    const { operation, wallet, proofRepository, proofService, eventBus, logger } = ctx;
    const { mintUrl, amount } = operation;

    // Get available proofs (ready and not reserved by other operations)
    const availableProofs = await proofRepository.getAvailableProofs(mintUrl);
    const totalAvailable = availableProofs.reduce((acc: number, p: CoreProof) => acc + p.amount, 0);

    if (totalAvailable < amount) {
      throw new ProofValidationError(
        `Insufficient balance: need ${amount}, have ${totalAvailable}`,
      );
    }

    // Try exact match first (no swap needed)
    const exactProofs = wallet.selectProofsToSend(availableProofs, amount, false);
    const exactAmount = exactProofs.send.reduce((acc: number, p: Proof) => acc + p.amount, 0);
    const needsSwap = exactAmount !== amount || exactProofs.send.length === 0;

    let selectedProofs: Proof[];
    let fee = 0;
    let serializedOutputData: PreparedSendOperation['outputData'];

    if (!needsSwap && exactProofs.send.length > 0) {
      // Exact match - no swap needed, no OutputData
      selectedProofs = exactProofs.send;
      logger?.debug('Exact match found for send', {
        operationId: operation.id,
        amount,
        proofCount: selectedProofs.length,
      });
    } else {
      // Need to swap - select proofs including fees
      const selected = wallet.selectProofsToSend(availableProofs, amount, true);
      selectedProofs = selected.send;
      const selectedAmount = selectedProofs.reduce((acc: number, p: Proof) => acc + p.amount, 0);
      fee = wallet.getFeesForProofs(selectedProofs);
      const keepAmount = selectedAmount - amount - fee;

      // Use ProofService to create outputs and increment counters
      const outputResult = await proofService.createOutputsAndIncrementCounters(mintUrl, {
        keep: keepAmount,
        send: amount,
      });

      // Serialize for storage
      serializedOutputData = serializeOutputData({
        keep: outputResult.keep,
        send: outputResult.send,
      });

      logger?.debug('Swap required for send', {
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
      needsSwap,
      fee,
      inputAmount: selectedProofs.reduce((acc: number, p: Proof) => acc + p.amount, 0),
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

    logger?.info('Send operation prepared', {
      operationId: operation.id,
      needsSwap,
      fee,
      inputProofCount: inputSecrets.length,
    });

    return prepared;
  }

  /**
   * Execute the send operation by performing the swap and creating the token.
   */
  async execute(ctx: ExecuteContext): Promise<ExecutionResult> {
    const { operation, wallet, reservedProofs, proofService, eventBus, logger } = ctx;
    const { mintUrl, amount, needsSwap, inputProofSecrets } = operation;

    const inputProofs = reservedProofs.filter((p: Proof) => inputProofSecrets.includes(p.secret));

    if (inputProofs.length !== inputProofSecrets.length) {
      throw new Error('Could not find all reserved proofs');
    }

    let sendProofs: Proof[];
    let keepProofs: Proof[] = [];

    if (!needsSwap) {
      // Exact match - just use the proofs directly
      sendProofs = inputProofs;
      logger?.debug('Executing exact match send', {
        operationId: operation.id,
        proofCount: sendProofs.length,
      });

      // Mark send proofs as inflight
      const sendSecrets = sendProofs.map((p: Proof) => p.secret);
      await proofService.setProofState(mintUrl, sendSecrets, 'inflight');
    } else {
      // Perform swap using stored OutputData
      if (!operation.outputData) {
        throw new Error('Missing output data for swap operation');
      }

      // Deserialize OutputData
      const outputData = deserializeOutputData(operation.outputData);

      logger?.debug('Executing swap', {
        operationId: operation.id,
        keepOutputs: outputData.keep.length,
        sendOutputs: outputData.send.length,
      });

      const outputConfig: OutputConfig = {
        send: { type: 'custom', data: outputData.send },
        keep: { type: 'custom', data: outputData.keep },
      };
      // Perform the swap with the mint
      const result = await wallet.send(amount, inputProofs, undefined, outputConfig);
      sendProofs = result.send;
      keepProofs = result.keep;

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
    }

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

    logger?.info('Send operation executed', {
      operationId: operation.id,
      sendProofCount: sendProofs.length,
      keepProofCount: keepProofs.length,
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

    logger?.info('Send operation finalized', { operationId: operation.id });
  }

  /**
   * Rollback the send operation by reclaiming proofs.
   */
  async rollback(ctx: RollbackContext): Promise<void> {
    const { operation, wallet, proofRepository, proofService, logger } = ctx;
    const { mintUrl, inputProofSecrets } = operation;

    if (operation.state === 'prepared') {
      // Simple case: just release the reserved proofs - no swap was done yet
      await proofService.releaseProofs(mintUrl, inputProofSecrets);
      logger?.info('Rolling back prepared operation - released reserved proofs', {
        operationId: operation.id,
      });
    } else if (operation.state === 'pending' || operation.state === 'rolling_back') {
      // Complex case: need to reclaim the send proofs by swapping them back
      const sendSecrets = getSendProofSecrets(operation);

      if (sendSecrets.length > 0) {
        // Get the send proofs
        const allProofs = await proofRepository.getProofsByOperationId(mintUrl, operation.id);
        const sendProofs = allProofs.filter(
          (p: CoreProof) => sendSecrets.includes(p.secret) && p.state === 'inflight',
        );

        if (sendProofs.length > 0) {
          const totalAmount = sendProofs.reduce((acc: number, p: CoreProof) => acc + p.amount, 0);
          const fee = wallet.getFeesForProofs(sendProofs);
          const reclaimAmount = totalAmount - fee;

          if (reclaimAmount > 0) {
            // Use ProofService to create outputs for reclaim
            const outputResult = await proofService.createOutputsAndIncrementCounters(mintUrl, {
              keep: reclaimAmount,
              send: 0,
            });

            // Swap to reclaim
            const keep = await wallet.receive(
              { mint: mintUrl, proofs: sendProofs, unit: wallet.unit },
              undefined,
              { type: 'custom', data: outputResult.keep },
            );

            // Save reclaimed proofs
            await proofService.saveProofs(mintUrl, mapProofToCoreProof(mintUrl, 'ready', keep));

            // Mark send proofs as spent
            await proofService.setProofState(
              mintUrl,
              sendProofs.map((p: CoreProof) => p.secret),
              'spent',
            );

            logger?.info('Reclaimed proofs from pending operation', {
              operationId: operation.id,
              reclaimedAmount: reclaimAmount,
              proofCount: keep.length,
            });
          }
        }
      }

      // Release any remaining reservations
      await proofService.releaseProofs(mintUrl, inputProofSecrets);
      const keepSecrets = getKeepProofSecrets(operation);
      if (keepSecrets.length > 0) {
        await proofService.releaseProofs(mintUrl, keepSecrets);
      }
    }
  }

  /**
   * Recover an executing operation that failed mid-execution.
   */
  async recoverExecuting(ctx: RecoverExecutingContext): Promise<ExecutionResult> {
    const { operation, wallet, proofService, logger } = ctx;

    // Case: Exact match - no mint interaction, always safe to rollback
    if (!operation.needsSwap) {
      await proofService.releaseProofs(operation.mintUrl, operation.inputProofSecrets);
      const failed: RolledBackSendOperation = {
        ...operation,
        state: 'rolled_back',
        updatedAt: Date.now(),
        error: 'Recovered: no swap needed, operation never finalized',
      };
      return { status: 'FAILED', failed };
    }

    // Case: Swap required - need to check with mint
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
        error: 'Recovered: swap never executed',
      };
      return { status: 'FAILED', failed };
    }

    // Swap happened - recover proofs from OutputData
    if (operation.outputData) {
      await proofService.recoverProofsFromOutputData(operation.mintUrl, operation.outputData);
    }

    // Mark input proofs as spent
    await proofService.setProofState(operation.mintUrl, operation.inputProofSecrets, 'spent');

    const failed: RolledBackSendOperation = {
      ...operation,
      state: 'rolled_back',
      updatedAt: Date.now(),
      error: 'Recovered: swap succeeded but token never returned',
    };

    logger?.info('Recovered executing operation', { operationId: operation.id });

    return { status: 'FAILED', failed };
  }
}
