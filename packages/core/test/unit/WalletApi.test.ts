import { describe, it, beforeEach, expect, mock } from 'bun:test';
import { WalletApi } from '../../api/WalletApi';
import { MintService } from '../../services/MintService';
import { WalletService } from '../../services/WalletService';
import { ProofService } from '../../services/ProofService';
import { WalletRestoreService } from '../../services/WalletRestoreService';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import { UnknownMintError } from '../../models/Error';
import { getEncodedToken } from '@cashu/cashu-ts';
import type { Proof } from '@cashu/cashu-ts';

describe('WalletApi - Trust Enforcement', () => {
  let walletApi: WalletApi;
  let mockMintService: any;
  let mockWalletService: any;
  let mockProofService: any;
  let mockWalletRestoreService: any;
  let eventBus: EventBus<CoreEvents>;

  const testMintUrl = 'https://mint.test';
  const testProofs: Proof[] = [
    {
      id: 'keyset-1',
      amount: 10,
      secret: 'secret-1',
      C: 'C-1',
    } as Proof,
  ];

  beforeEach(() => {
    eventBus = new EventBus<CoreEvents>();

    mockMintService = {
      isTrustedMint: mock(async (mintUrl: string) => false),
      addMintByUrl: mock(async () => ({ mint: {}, keysets: [{ id: 'keyset-1' }] })),
      ensureUpdatedMint: mock(async () => ({
        mint: { url: testMintUrl },
        keysets: [
          {
            id: 'keyset-1',
            unit: 'sat',
            active: true,
            keys: {
              1: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
              2: '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
              4: '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
              8: '03774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb',
              10: '03e5e8d9b1e9e1e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0',
            },
          },
        ],
      })),
    };

    mockWalletService = {
      getWalletWithActiveKeysetId: mock(async () => ({
        wallet: {
          receive: mock(async () => []),
          getFeesForProofs: mock(() => 0),
        },
      })),
    };

    mockProofService = {
      createOutputsAndIncrementCounters: mock(async () => ({
        keep: [{ amount: 10, id: 'keyset-1' }],
        send: [],
      })),
      saveProofs: mock(async () => {}),
    };

    mockWalletRestoreService = {};

    walletApi = new WalletApi(
      mockMintService,
      mockWalletService,
      mockProofService,
      mockWalletRestoreService,
      eventBus,
    );
  });

  describe('receive - trust enforcement', () => {
    it('should reject tokens from untrusted mints', async () => {
      const token = {
        mint: testMintUrl,
        proofs: testProofs,
      };

      mockMintService.isTrustedMint.mockImplementation(async () => false);

      await expect(walletApi.receive(token)).rejects.toThrow(UnknownMintError);
      await expect(walletApi.receive(token)).rejects.toThrow('not trusted');
    });

    it('should accept tokens from trusted mints', async () => {
      const token = {
        mint: testMintUrl,
        proofs: testProofs,
      };

      mockMintService.isTrustedMint.mockImplementation(async () => true);

      // Should not throw
      await walletApi.receive(token);

      expect(mockWalletService.getWalletWithActiveKeysetId).toHaveBeenCalledWith(testMintUrl);
    });

    it('should check trust status before processing token', async () => {
      const token = {
        mint: testMintUrl,
        proofs: testProofs,
      };

      mockMintService.isTrustedMint.mockImplementation(async () => false);

      await expect(walletApi.receive(token)).rejects.toThrow();

      // Wallet service should not be called if mint is not trusted
      expect(mockWalletService.getWalletWithActiveKeysetId).not.toHaveBeenCalled();
    });

    it('should reject string tokens from untrusted mints', async () => {
      const token = {
        mint: testMintUrl,
        proofs: testProofs,
      };
      const encodedToken = getEncodedToken(token);

      mockMintService.isTrustedMint.mockImplementation(async () => false);

      await expect(walletApi.receive(encodedToken)).rejects.toThrow(UnknownMintError);
      await expect(walletApi.receive(encodedToken)).rejects.toThrow('not trusted');
    });

    it('should accept string tokens from trusted mints', async () => {
      const token = {
        mint: testMintUrl,
        proofs: testProofs,
      };
      const encodedToken = getEncodedToken(token);

      mockMintService.isTrustedMint.mockImplementation(async () => true);

      // Should not throw
      await walletApi.receive(encodedToken);

      expect(mockWalletService.getWalletWithActiveKeysetId).toHaveBeenCalledWith(testMintUrl);
    });

    it('should provide clear error message for untrusted mints', async () => {
      const token = {
        mint: testMintUrl,
        proofs: testProofs,
      };

      mockMintService.isTrustedMint.mockImplementation(async () => false);

      try {
        await walletApi.receive(token);
        expect(true).toBe(false); // Should not reach here
      } catch (err: any) {
        expect(err.message).toContain('not trusted');
        expect(err.message).toContain(testMintUrl);
      }
    });
  });

  describe('trust workflow integration', () => {
    it('should allow receiving tokens after mint is trusted', async () => {
      const token = {
        mint: testMintUrl,
        proofs: testProofs,
      };

      // Initially untrusted
      mockMintService.isTrustedMint.mockImplementation(async () => false);
      await expect(walletApi.receive(token)).rejects.toThrow();

      // After trusting
      mockMintService.isTrustedMint.mockImplementation(async () => true);
      await walletApi.receive(token); // Should not throw
    });

    it('should prevent receiving tokens after mint is untrusted', async () => {
      const token = {
        mint: testMintUrl,
        proofs: testProofs,
      };

      // Initially trusted
      mockMintService.isTrustedMint.mockImplementation(async () => true);
      await walletApi.receive(token); // Should not throw

      // After untrusting
      mockMintService.isTrustedMint.mockImplementation(async () => false);
      await expect(walletApi.receive(token)).rejects.toThrow();
    });
  });

  describe('send - trust not required', () => {
    it('should allow sending from any mint (trusted or not)', async () => {
      // Note: send() doesn't check trust status
      // This is by design - users can send from any mint they have proofs for
      const amount = 10;

      mockWalletService.getWalletWithActiveKeysetId.mockImplementation(async () => ({
        wallet: {
          send: mock(async () => ({ send: testProofs, keep: [] })),
          getFeesForProofs: mock(() => 0),
        },
      }));

      mockProofService.selectProofsToSend = mock(async () => testProofs);
      mockProofService.setProofState = mock(async () => {});

      // Should work regardless of trust status
      const result = await walletApi.send(testMintUrl, amount);

      expect(result.mint).toBe(testMintUrl);
      expect(result.proofs).toEqual(testProofs);
    });
  });

  describe('restore', () => {
    it('should add mint during restore (creating as trusted by default)', async () => {
      mockWalletService.getWalletWithActiveKeysetId.mockImplementation(async () => ({
        wallet: {},
      }));

      mockWalletRestoreService.restoreKeyset = mock(async () => {});

      await walletApi.restore(testMintUrl);

      expect(mockMintService.addMintByUrl).toHaveBeenCalledWith(testMintUrl, { trusted: true });
    });
  });
});
