import { Amount, sumProofs, type Token, type Proof, type OutputConfig } from '@cashu/cashu-ts';
import type {
  SendMethodHandler,
  ExecuteContext,
  FinalizeContext,
  RollbackContext,
  RecoverExecutingContext,
  ExecutionResult,
  RecoveryResult,
} from '../../../operations/send/SendMethodHandler';
import type {
  PendingSendOperation,
  RolledBackSendOperation,
} from '../../../operations/send/SendOperation';
import { getSendProofSecrets, getKeepProofSecrets } from '../../../operations/send/SendOperation';
import {
  mapProofToCoreProof,
  deserializeOutputData,
  getSecretsFromSerializedOutputData,
} from '../../../utils';
import type { CoreProof } from '../../../types';
import { ProofValidationError } from '../../../models/Error';

/**
 * Default send handler for standard (unlocked) token sends.
 * Handles execution and recovery for standard cashu token sends.
 */
export class DefaultSendHandler implements SendMethodHandler<'default'> {
  /**
   * Execute the send operation by performing the swap and creating the token.
   */
  async execute(ctx: ExecuteContext): Promise<ExecutionResult> {
    const { operation, wallet, reservedProofs, proofService, logger } = ctx;
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
        unit: operation.unit,
        createdByOperationId: operation.id,
      });
      const sendCoreProofs = mapProofToCoreProof(mintUrl, 'inflight', sendProofs, {
        unit: operation.unit,
        createdByOperationId: operation.id,
      });
      await proofService.saveProofs(mintUrl, [...keepCoreProofs, ...sendCoreProofs]);

      // Mark input proofs as spent (use proofService to emit events)
      await proofService.setProofState(mintUrl, inputProofSecrets, 'spent');
    }

    const token: Token = {
      mint: mintUrl,
      proofs: sendProofs,
      unit: operation.unit,
    };

    // Build pending operation
    const pending: PendingSendOperation = {
      ...operation,
      state: 'pending',
      updatedAt: Date.now(),
      token,
    };

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
    const { operation, proofService } = ctx;

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
          const totalAmount = sumProofs(sendProofs);
          const fee = wallet.getFeesForProofs(sendProofs);
          if (totalAmount.lessThanOrEqual(fee)) {
            logger?.warn('Cannot reclaim send proofs because fees consume the amount', {
              operationId: operation.id,
              amount: totalAmount,
              fee,
            });
          } else {
            const reclaimAmount = totalAmount.subtract(fee);

            if (!reclaimAmount.isZero()) {
              // Use ProofService to create outputs for reclaim
              const outputResult = await proofService.createOutputsAndIncrementCounters(
                mintUrl,
                {
                  keep: { amount: reclaimAmount, unit: operation.unit },
                  send: { amount: Amount.zero(), unit: operation.unit },
                },
                {},
              );

              // Swap to reclaim
              const keep = await wallet.receive(
                { mint: mintUrl, proofs: sendProofs, unit: operation.unit },
                undefined,
                { type: 'custom', data: outputResult.keep },
              );

              // Save reclaimed proofs
              await proofService.saveProofs(
                mintUrl,
                mapProofToCoreProof(mintUrl, 'ready', keep, { unit: operation.unit }),
              );

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
  async recoverExecuting(ctx: RecoverExecutingContext): Promise<RecoveryResult> {
    const { operation, wallet, proofRepository, proofService, logger } = ctx;

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
    const proofInputs = await proofRepository.getProofsBySecrets(
      operation.mintUrl,
      operation.inputProofSecrets,
    );
    if (proofInputs.length !== operation.inputProofSecrets.length) {
      throw new ProofValidationError('Cannot recover send operation: missing input proof metadata');
    }
    let inputStates;
    try {
      inputStates = await wallet.checkProofsStates(proofInputs);
    } catch (error) {
      logger?.warn('Could not reach mint for recovery, will retry later', {
        operationId: operation.id,
        mintUrl: operation.mintUrl,
      });
      throw error;
    }
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

    // Swap happened - recover proofs from OutputData if they were not already saved
    if (operation.outputData) {
      const existingProofs = await proofRepository.getProofsByOperationId(
        operation.mintUrl,
        operation.id,
      );
      const outputSecrets = getSecretsFromSerializedOutputData(operation.outputData);
      const allOutputSecrets = [...outputSecrets.keepSecrets, ...outputSecrets.sendSecrets];
      const alreadySaved = existingProofs.some((p: CoreProof) =>
        allOutputSecrets.includes(p.secret),
      );

      if (!alreadySaved) {
        await proofService.recoverProofsFromOutputData(operation.mintUrl, operation.outputData, {
          unit: operation.unit,
          createdByOperationId: operation.id,
        });
      }
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
