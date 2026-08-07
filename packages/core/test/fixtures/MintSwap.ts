import { Amount } from '@cashu/cashu-ts';

import {
  createMintSwapPreparedPlanFingerprint,
  type MintSwapOperation,
} from '../../operations/mintSwap/MintSwapOperation';
import type { OperationEventOutboxRecord } from '../../models/OperationEventOutbox';

export const MINT_SWAP_TEST_NOW = 1_700_000_000_000;

const destinationNut20Key = {
  publicKey: `02${'00'.repeat(32)}`,
  derivationIndex: 7,
} as const;

export function makePreparingMintSwapOperation(
  overrides: Partial<MintSwapOperation> = {},
): MintSwapOperation {
  return {
    id: 'mint-swap-op',
    state: 'preparing',
    revision: 0,
    sourceMintUrl: 'https://source.mint.test',
    destinationMintUrl: 'https://destination.mint.test',
    unit: 'sat',
    destinationAmount: Amount.from(1_000),
    destinationNut20Key: { ...destinationNut20Key },
    preparationLease: {
      ownerId: 'worker-a',
      token: 'lease-token-a',
      stage: 'destination_quote',
      acquiredAt: MINT_SWAP_TEST_NOW,
      expiresAt: MINT_SWAP_TEST_NOW + 30_000,
    },
    retry: { attemptCount: 0 },
    createdAt: MINT_SWAP_TEST_NOW,
    updatedAt: MINT_SWAP_TEST_NOW,
    ...overrides,
  };
}

export function makePreparedMintSwapOperation(
  overrides: Partial<MintSwapOperation> = {},
): MintSwapOperation {
  const destinationAmount = Amount.from(1_000);
  const sourcePreparationFee = Amount.from(2);
  const sourceMeltInputFee = Amount.from(3);
  const sourceFeeReserve = Amount.from(20);
  const minimumSourceDebit = Amount.from(1_005);
  const maximumSourceDebit = Amount.from(1_025);
  const reservedSourceAmount = Amount.from(1_040);
  const destinationQuoteRef = {
    mintUrl: 'https://destination.mint.test',
    method: 'bolt11' as const,
    quoteId: 'destination-quote',
  };
  const sourceQuoteRef = {
    mintUrl: 'https://source.mint.test',
    method: 'bolt11' as const,
    quoteId: 'source-quote',
  };
  const fingerprint = createMintSwapPreparedPlanFingerprint({
    destinationMintOperationId: 'destination-mint-op',
    sourceMeltOperationId: 'source-melt-op',
    destinationQuoteRef,
    sourceQuoteRef,
    destinationNut20Key,
    destinationAmount,
    unit: 'sat',
    sourceInputProofSecrets: ['source-proof-a', 'source-proof-b'],
    destinationOutputData: {
      keep: [
        {
          blindedMessage: { amount: '1000', id: 'destination-keyset', B_: 'destination-B' },
          blindingFactor: '01',
          secret: '64657374696e6174696f6e2d6f7574707574',
        },
      ],
      send: [],
    },
    sourceOutputData: {
      keep: [],
      send: [
        {
          blindedMessage: { amount: '1025', id: 'source-keyset', B_: 'source-B' },
          blindingFactor: '02',
          secret: '736f757263652d6f7574707574',
        },
      ],
    },
    sourceMeltAmount: destinationAmount,
    sourceFeeReserve,
    sourcePreparationFee,
    sourceMeltInputFee,
    minimumSourceDebit,
    maximumSourceDebit,
    reservedSourceAmount,
    dispatchDeadlineSeconds: Math.floor(MINT_SWAP_TEST_NOW / 1_000) + 120,
    requiredDispatchWindowSeconds: 120,
  });

  return {
    id: 'mint-swap-op',
    state: 'prepared',
    revision: 1,
    sourceMintUrl: 'https://source.mint.test',
    destinationMintUrl: 'https://destination.mint.test',
    unit: 'sat',
    destinationAmount,
    destinationNut20Key: { ...destinationNut20Key },
    destinationQuoteRef,
    destinationMintOperationId: 'destination-mint-op',
    sourceQuoteRef,
    sourceMeltOperationId: 'source-melt-op',
    preparedPlan: {
      fingerprint,
      dispatchDeadlineSeconds: Math.floor(MINT_SWAP_TEST_NOW / 1_000) + 120,
      requiredDispatchWindowSeconds: 120,
      sourceMeltAmount: destinationAmount,
      sourceFeeReserve,
      sourcePreparationFee,
      sourceMeltInputFee,
      minimumSourceDebit,
      maximumSourceDebit,
      reservedSourceAmount,
    },
    retry: { attemptCount: 0 },
    createdAt: MINT_SWAP_TEST_NOW,
    updatedAt: MINT_SWAP_TEST_NOW + 1,
    ...overrides,
  };
}

export function makeSettledMintSwapOperation(
  overrides: Partial<MintSwapOperation> = {},
): MintSwapOperation {
  return makePreparedMintSwapOperation({
    state: 'destination_funded',
    revision: 2,
    sourceDispatchAuthorizedAt: MINT_SWAP_TEST_NOW + 2,
    settlement: {
      sourcePaymentFee: Amount.from(5),
      totalSourceFee: Amount.from(10),
      sourceMeltChangeAmount: Amount.from(20),
      sourceKeepAmount: Amount.from(10),
      sourceReturnedAmount: Amount.from(30),
      finalSourceDebit: Amount.from(1_010),
    },
    updatedAt: MINT_SWAP_TEST_NOW + 3,
    ...overrides,
  });
}

export function makeMintSwapOutboxRecord(
  overrides: Partial<OperationEventOutboxRecord> = {},
): OperationEventOutboxRecord {
  return {
    id: 'mint-swap-event',
    operationId: 'mint-swap-op',
    revision: 1,
    eventType: 'mint-swap-op:prepared',
    payload: {
      operationId: 'mint-swap-op',
      revision: 1,
      state: 'prepared',
      sourceMintUrl: 'https://source.mint.test',
      destinationMintUrl: 'https://destination.mint.test',
      unit: 'sat',
      destinationAmount: '1000',
    },
    createdAt: MINT_SWAP_TEST_NOW + 1,
    publishAttempts: 0,
    ...overrides,
  };
}
