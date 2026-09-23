import { Amount } from '@cashu/cashu-ts';
import type {
  LastSafeCheckpoint,
  MintSwapOperation,
  MintSwapOperationState,
  MintSwapRetryState,
} from '../../operations/mintSwap/MintSwapOperation.ts';

export const MINT_SWAP_CREATED_AT = 1_700_000_000_000;

export function initialMintSwapRetry(nextAttemptAt: number | null): MintSwapRetryState {
  return { attemptCount: 0, lastAttemptAt: null, nextAttemptAt, lastError: null };
}

/** One explicit, valid runtime fixture per V1 state. */
export function mintSwapFixtures(
  id = 'swap',
  createdAt = MINT_SWAP_CREATED_AT,
): { [S in MintSwapOperationState]: Extract<MintSwapOperation, { state: S }> } {
  const base = {
    schemaVersion: 1 as const,
    id,
    revision: 0,
    sourceMintUrl: 'https://source.example',
    destinationMintUrl: 'https://destination.example',
    unit: 'sat' as const,
    destinationAmount: Amount.from(100),
    sourceDebitCap: Amount.from(110),
    sourceQuote: {
      mintUrl: 'https://source.example',
      method: 'bolt11' as const,
      quoteId: `melt-${id}`,
    },
    destinationQuote: {
      mintUrl: 'https://destination.example',
      method: 'bolt11' as const,
      quoteId: `mint-${id}`,
    },
    sourceOperationId: `source-${id}`,
    destinationOperationId: `destination-${id}`,
    paymentRequestHash: 'ab'.repeat(32),
    createdAt,
    cancellationRequestedAt: createdAt,
  };
  const preparedFacts = {
    sourceDebitBounds: {
      minimum: Amount.from(102),
      maximum: Amount.from(110),
      reserved: Amount.from(128),
    },
  };
  const sourceFacts = { ...preparedFacts, sourceStartedAt: createdAt + 2_000 };
  const fundedFacts = {
    ...sourceFacts,
    sourceSettlement: {
      reserved: Amount.from(128),
      returned: Amount.from(23),
      finalDebit: Amount.from(105),
      totalFee: Amount.from(5),
      sourcePaidObservedAt: createdAt + 3_000,
    },
  };
  const destinationFacts = { ...fundedFacts, destinationStartedAt: createdAt + 4_000 };
  const sourceCheckpoint: LastSafeCheckpoint = {
    state: 'source_pending',
    stateEnteredAt: createdAt + 2_000,
    ...sourceFacts,
  };
  const exit = {
    sourcePayment: 'confirmed_unpaid' as const,
    sourceProofs: 'released' as const,
    verifiedAt: createdAt + 5_000,
  };
  const at = (offset: number) => ({
    updatedAt: createdAt + offset,
    stateEnteredAt: createdAt + offset,
  });
  return {
    preparing: { ...base, state: 'preparing', ...at(0), retry: initialMintSwapRetry(createdAt) },
    prepared: {
      ...base,
      state: 'prepared',
      ...at(1_000),
      ...preparedFacts,
      retry: initialMintSwapRetry(null),
    },
    source_pending: {
      ...base,
      state: 'source_pending',
      ...at(2_000),
      ...sourceFacts,
      retry: initialMintSwapRetry(createdAt + 2_000),
    },
    destination_funded: {
      ...base,
      state: 'destination_funded',
      ...at(3_000),
      ...fundedFacts,
      retry: initialMintSwapRetry(createdAt + 3_000),
    },
    destination_pending: {
      ...base,
      state: 'destination_pending',
      ...at(4_000),
      ...destinationFacts,
      retry: initialMintSwapRetry(createdAt + 4_000),
    },
    completed: {
      ...base,
      state: 'completed',
      ...at(5_000),
      ...destinationFacts,
      retry: initialMintSwapRetry(null),
      destinationCompletion: {
        quoteAmountIssued: Amount.from(100),
        storedProofAmount: Amount.from(100),
        proofsVerifiedAt: createdAt + 5_000,
      },
      completedAt: createdAt + 5_000,
    },
    cancelled: {
      ...base,
      state: 'cancelled',
      ...at(5_000),
      retry: initialMintSwapRetry(null),
      lastSafe: sourceCheckpoint,
      valueNeutral: exit,
      cancelledAt: createdAt + 5_000,
    },
    failed: {
      ...base,
      state: 'failed',
      ...at(5_000),
      retry: initialMintSwapRetry(null),
      lastSafe: sourceCheckpoint,
      valueNeutral: exit,
      failure: { code: 'source_payment_rejected' },
      failedAt: createdAt + 5_000,
    },
    needs_attention: {
      ...base,
      state: 'needs_attention',
      ...at(5_000),
      retry: initialMintSwapRetry(null),
      lastSafe: {
        state: 'destination_pending',
        stateEnteredAt: createdAt + 4_000,
        ...destinationFacts,
      },
      attentionAt: createdAt + 5_000,
      attention: {
        reason: 'contradictory_evidence',
        invariant: 'destination_completion',
        evidence: {
          code: 'proof_total_mismatch',
          leg: 'destination',
          observedAt: createdAt + 5_000,
        },
      },
    },
  } satisfies Record<MintSwapOperationState, MintSwapOperation>;
}

export function mintSwapCheckpoint(operation: MintSwapOperation): LastSafeCheckpoint {
  const { state, stateEnteredAt } = operation;
  switch (state) {
    case 'preparing':
      return { state, stateEnteredAt };
    case 'prepared':
      return { state, stateEnteredAt, sourceDebitBounds: operation.sourceDebitBounds };
    case 'source_pending':
      return {
        state,
        stateEnteredAt,
        sourceDebitBounds: operation.sourceDebitBounds,
        sourceStartedAt: operation.sourceStartedAt,
      };
    case 'destination_funded':
      return {
        state,
        stateEnteredAt,
        sourceDebitBounds: operation.sourceDebitBounds,
        sourceStartedAt: operation.sourceStartedAt,
        sourceSettlement: operation.sourceSettlement,
      };
    case 'destination_pending':
      return {
        state,
        stateEnteredAt,
        sourceDebitBounds: operation.sourceDebitBounds,
        sourceStartedAt: operation.sourceStartedAt,
        sourceSettlement: operation.sourceSettlement,
        destinationStartedAt: operation.destinationStartedAt,
      };
    default:
      throw new Error('A checkpoint requires a nonterminal operation');
  }
}
