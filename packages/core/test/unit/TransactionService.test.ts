import { describe, it, beforeEach, expect, mock } from 'bun:test';
import type { Proof, Token } from '@cashu/cashu-ts';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import { ProofValidationError } from '../../models/Error';
import { TransactionService } from '../../services/TransactionService';

describe('TransactionService', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';

  let mintService: any;
  let walletService: any;
  let proofService: any;
  let eventBus: EventBus<CoreEvents>;
  let service: TransactionService;

  const proofs: Proof[] = [
    {
      id: keysetId,
      amount: 10,
      secret: 'secret-1',
      C: 'C-1',
    } as Proof,
  ];

  beforeEach(() => {
    eventBus = new EventBus<CoreEvents>();

    mintService = {
      isTrustedMint: mock(async () => true),
      ensureUpdatedMint: mock(async () => ({
        mint: { url: mintUrl },
        keysets: [{ id: keysetId, unit: 'sat' }],
      })),
    };

    walletService = {
      getWalletWithActiveKeysetId: mock(async () => ({
        wallet: {
          unit: 'sat',
          receive: mock(async () => []),
          getFeesForProofs: mock(() => 0),
        },
      })),
    };

    proofService = {
      prepareProofsForReceiving: mock(async (inputProofs: Proof[]) => inputProofs),
      createOutputsAndIncrementCounters: mock(async () => ({
        keep: [{ amount: 10, id: keysetId, B_: 'B_out-1' }],
        send: [],
      })),
      saveProofs: mock(async () => {}),
    };

    service = new TransactionService(mintService, walletService, proofService, eventBus);
  });

  it('rejects tokens with unsupported units', async () => {
    const token: Token = { mint: mintUrl, proofs, unit: 'usd' } as Token;

    await expect(service.receive(token)).rejects.toThrow(ProofValidationError);
    await expect(service.receive(token)).rejects.toThrow(
      "Unsupported mint unit 'usd'. Only 'sat' is currently supported.",
    );
    expect(walletService.getWalletWithActiveKeysetId).not.toHaveBeenCalled();
    expect(proofService.prepareProofsForReceiving).not.toHaveBeenCalled();
  });
});
