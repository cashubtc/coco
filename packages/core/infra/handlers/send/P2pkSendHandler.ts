import { type Token, type Proof, type OutputConfig, OutputData } from '@cashu/cashu-ts';
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
  getSecretsFromSerializedOutputData,
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
    const { operation, wallet, proofService, logger } = ctx;
    const { mintUrl, amount } = operation;

    // Validate that we have a pubkey in methodData
    const pubkey = (operation.methodData as { pubkey: string })?.pubkey;
    if (!pubkey) {
      throw new ProofValidationError('P2PK send requires a pubkey in methodData');
    }

    // P2PK always requires a swap to lock proofs to the pubkey
    // Select proofs including fees
    const selected = await proofService.selectProofsToSend(mintUrl, amount, true);
    const selectedAmount = selected.reduce((acc: number, p: Proof) => acc + p.amount, 0);
    const fee = wallet.getFeesForProofs(selected);
    const keepAmount = selectedAmount - amount - fee;

    // Use ProofService to create outputs and increment counters
    const outputResult = await proofService.createOutputsAndIncrementCounters(mintUrl, {
      keep: keepAmount,
      send: 0,
    });

    const keyset = wallet.getKeyset();

    const sendOT = OutputData.createP2PKData({ pubkey }, amount, keyset);

    // Serialize for storage
    const serializedOutputData = serializeOutputData({
      keep: outputResult.keep,
      send: sendOT,
    });

    logger?.debug('P2PK send prepared', {
      operationId: operation.id,
      amount,
      fee,
      keepAmount,
      selectedAmount,
      proofCount: selected.length,
      keepOutputs: outputResult.keep.length,
      sendOutputs: sendOT.length,
      pubkey,
    });

    // Reserve the selected proofs
    const inputSecrets = selected.map((p: Proof) => p.secret);
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
    const { operation, wallet, reservedProofs, proofService, logger } = ctx;
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

    const outputConfig: OutputConfig = {
      send: { type: 'custom', data: outputData.send },
      keep: { type: 'custom', data: outputData.keep },
    };

    // Perform the swap with the mint
    const result = await wallet.send(amount, inputProofs, undefined, outputConfig);
    const sendProofs = result.send;
    const keepProofs = result.keep;

    // Persist keep proofs as ready and P2PK send proofs as inflight so the
    // existing proof watcher/finalization flow can track them uniformly.
    const keepCoreProofs = mapProofToCoreProof(mintUrl, 'ready', keepProofs, {
      createdByOperationId: operation.id,
    });
    const sendCoreProofs = mapProofToCoreProof(mintUrl, 'inflight', sendProofs, {
      createdByOperationId: operation.id,
    });
    if (keepCoreProofs.length > 0 || sendCoreProofs.length > 0) {
      await proofService.saveProofs(mintUrl, [...keepCoreProofs, ...sendCoreProofs]);
    }

    // Mark input proofs as spent (use proofService to emit events)
    await proofService.setProofState(mintUrl, inputProofSecrets, 'spent');

    const token: Token = {
      mint: mintUrl,
      proofs: sendProofs,
      unit: wallet.unit,
    };

    // Build pending operation
    const pending: PendingSendOperation = {
      ...operation,
      state: 'pending',
      updatedAt: Date.now(),
      token,
    };

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
    } else {
      throw new Error(`P2PK Send Operation in ${operation.state} state can not be rolled back.`);
    }
  }

  /**
   * Recover an executing operation that failed mid-execution.
   */
  async recoverExecuting(ctx: RecoverExecutingContext): Promise<ExecutionResult> {
    const { operation, wallet, proofRepository, proofService, logger } = ctx;

    // P2PK always requires swap - check with mint
    const proofInputs = operation.inputProofSecrets.map((secret: string) => ({ secret }));
    let inputStates;
    try {
      inputStates = await wallet.checkProofsStates(proofInputs as unknown as Proof[]);
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
        error: 'Recovered: P2PK swap never executed',
      };
      return { status: 'FAILED', failed };
    }

    if (!operation.outputData) {
      throw new Error('Missing output data for P2PK recovery after swap execution');
    }

    const existingProofs = await proofRepository.getProofsByOperationId(
      operation.mintUrl,
      operation.id,
    );
    const outputSecrets = getSecretsFromSerializedOutputData(operation.outputData);
    const keepOutputData = {
      keep: operation.outputData.keep,
      send: [],
    };

    const existingKeepProofs = existingProofs.filter((p: CoreProof) =>
      outputSecrets.keepSecrets.includes(p.secret),
    );
    if (existingKeepProofs.length === 0 && keepOutputData.keep.length > 0) {
      await proofService.recoverProofsFromOutputData(operation.mintUrl, keepOutputData, {
        createdByOperationId: operation.id,
      });
    }

    let sendProofs: Proof[] = existingProofs.filter((p: CoreProof) =>
      outputSecrets.sendSecrets.includes(p.secret),
    );
    if (sendProofs.length === 0 && operation.outputData.send.length > 0) {
      const recoveredSendProofs = await proofService.recoverProofsFromOutputData(
        operation.mintUrl,
        {
          keep: [],
          send: operation.outputData.send,
        },
        {
          persistRecoveredProofs: false,
        },
      );

      if (recoveredSendProofs.length > 0) {
        await proofService.saveProofs(
          operation.mintUrl,
          mapProofToCoreProof(operation.mintUrl, 'inflight', recoveredSendProofs, {
            createdByOperationId: operation.id,
          }),
        );
      }
      sendProofs = recoveredSendProofs;
    }

    // Mark input proofs as spent
    await proofService.setProofState(operation.mintUrl, operation.inputProofSecrets, 'spent');

    let token: Token | undefined;
    if (sendProofs.length > 0) {
      token = {
        mint: operation.mintUrl,
        proofs: sendProofs,
        unit: wallet.unit,
      };
    } else if (outputSecrets.sendSecrets.length > 0) {
      const sendStates = await wallet.checkProofsStates(
        outputSecrets.sendSecrets.map((secret) => ({ secret })) as unknown as Proof[],
      );
      const allSendProofsSpent = sendStates.every((state) => state.state === 'SPENT');
      if (!allSendProofsSpent) {
        throw new Error('Recovered P2PK swap succeeded but token could not be reconstructed');
      }
    }

    const pending: PendingSendOperation = {
      ...operation,
      state: 'pending',
      updatedAt: Date.now(),
      token,
    };

    logger?.info('Recovered P2PK executing operation', { operationId: operation.id });

    return { status: 'PENDING', pending, token };
  }
}
