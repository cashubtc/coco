import { Amount } from '@cashu/cashu-ts';

import type { MintSwapOperation } from '../../operations/mintSwap/MintSwapOperation';

export const MINT_SWAP_TEST_NOW = 1_700_000_000_000;

export function makePreparedMintSwapOperation(
  overrides: Partial<MintSwapOperation> = {},
): MintSwapOperation {
  return {
    id: 'swap-1',
    state: 'prepared',
    revision: 1,
    sourceMintUrl: 'https://source.test',
    destinationMintUrl: 'https://destination.test',
    unit: 'sat',
    destinationAmount: Amount.from(100),
    destinationQuoteRef: {
      mintUrl: 'https://destination.test',
      method: 'bolt11',
      quoteId: 'destination-quote',
    },
    destinationMintOperationId: 'destination-child',
    sourceQuoteRef: {
      mintUrl: 'https://source.test',
      method: 'bolt11',
      quoteId: 'source-quote',
    },
    sourceMeltOperationId: 'source-child',
    destinationNut20Key: { publicKey: '02abcdef', derivationIndex: 7 },
    preparedPlan: {
      fingerprint: 'prepared-fingerprint',
      dispatchDeadline: Math.floor(MINT_SWAP_TEST_NOW / 1000) + 600,
      requiredDispatchWindowSeconds: 120,
      sourceMeltAmount: Amount.from(100),
      sourceFeeReserve: Amount.from(8),
      sourcePreparationFee: Amount.from(1),
      sourceMeltInputFee: Amount.from(1),
      minimumSourceDebit: Amount.from(102),
      maximumSourceDebit: Amount.from(110),
      reservedSourceAmount: Amount.from(110),
    },
    retry: { attemptCount: 0 },
    createdAt: MINT_SWAP_TEST_NOW,
    updatedAt: MINT_SWAP_TEST_NOW,
    ...overrides,
  };
}
