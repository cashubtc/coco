import { describe, it, beforeEach, expect, mock } from 'bun:test';
import { WalletApi } from '../../api/WalletApi';
import { MintService } from '../../services/MintService';
import { WalletService } from '../../services/WalletService';
import { ProofService } from '../../services/ProofService';
import { WalletRestoreService } from '../../services/WalletRestoreService';
import { TransactionService } from '../../services/TransactionService';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import { UnknownMintError } from '../../models/Error';
import { getEncodedToken, OutputData, PaymentRequest } from '@cashu/cashu-ts';
import type { Proof } from '@cashu/cashu-ts';
import { ReceiveOperationService } from '../../operations/receive/ReceiveOperationService';
import { MemoryProofRepository, MemoryReceiveOperationRepository } from '@core/repositories';
import { TokenService } from '../../services/TokenService';
import type { MintAdapter } from '../../infra/MintAdapter';

describe('WalletApi - Trust Enforcement', () => {
  let walletApi: WalletApi;
  let mockMintService: any;
  let mockWalletService: any;
  let mockProofService: any;
  let mockWalletRestoreService: any;
  let transactionService: TransactionService;
  let eventBus: EventBus<CoreEvents>;
  let proofReceiveRepo: MemoryProofRepository;
  let receiveOpRepo: MemoryReceiveOperationRepository;
  let receiveOperationService: ReceiveOperationService;
  let tokenService: TokenService;
  let mintAdapter: MintAdapter;

  const testMintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';
  const testProofs: Proof[] = [
    {
      id: keysetId,
      amount: 10,
      secret: 'secret-1',
      C: 'C-1',
    } as Proof,
  ];

  const makeOutputData = (secrets: string[]): OutputData[] =>
    secrets.map(
      (secret) =>
        new OutputData(
          { amount: 10, id: keysetId, B_: `B_${secret}` },
          BigInt(1),
          new TextEncoder().encode(secret),
        ),
    );

  const createMockMintAdapter = (): MintAdapter =>
    ({
      checkProofStates: mock(() => Promise.resolve([])),
    }) as unknown as MintAdapter;

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
        keep: makeOutputData(['out-1', 'out-2']),
        send: [],
      })),
      saveProofs: mock(async () => {}),
      prepareProofsForReceiving: mock(async (proofs: any[]) => proofs),
    };

    mockWalletRestoreService = {};

    transactionService = new TransactionService(
      mockMintService,
      mockWalletService,
      mockProofService,
      eventBus,
    );

    receiveOpRepo = new MemoryReceiveOperationRepository();
    proofReceiveRepo = new MemoryProofRepository();
    tokenService = new TokenService(mockMintService);
    mintAdapter = createMockMintAdapter();

    receiveOperationService = new ReceiveOperationService(
      receiveOpRepo,
      proofReceiveRepo,
      mockProofService,
      mockMintService,
      mockWalletService,
      mintAdapter,
      tokenService,
      eventBus,
    );

    walletApi = new WalletApi(
      mockMintService,
      mockWalletService,
      mockProofService,
      mockWalletRestoreService,
      transactionService,
      receiveOperationService,
      tokenService,
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

  describe('decodeToken', () => {
    it('should use the wallet for the token mint', async () => {
      const token = {
        mint: testMintUrl,
        proofs: testProofs,
      };
      const encodedToken = getEncodedToken(token);
      const decodedToken = {
        mint: testMintUrl,
        proofs: testProofs,
      };

      const decodeTokenMock = mock(async () => decodedToken);
      mockWalletService.getWallet = mock(async (mintUrl: string) => {
        return {
          decodeToken: decodeTokenMock,
        };
      });

      const result = await walletApi.decodeToken(encodedToken);

      expect(mockWalletService.getWallet).toHaveBeenCalledWith(testMintUrl);
      expect(decodeTokenMock).toHaveBeenCalledWith(encodedToken);
      expect(result).toEqual(decodedToken);
    });
  });

  describe('encodeToken', () => {
    it('should encode tokens with default encoding', () => {
      const token = {
        mint: testMintUrl,
        proofs: testProofs,
      };

      const encodedToken = walletApi.encodeToken(token);

      expect(encodedToken).toBe(getEncodedToken(token));
    });

    it('should encode tokens with V3 when version 3 is specified', () => {
      const token = {
        mint: testMintUrl,
        proofs: [
          {
            id: '009a1f293253e41e',
            amount: 2,
            secret: '407915bc212be61a77e3e6d2aeb4c727980bda51cd06a6afc29e2861768a7837',
            C: '02bc9097997d81afb2cc7346b5e4345a9346bd2a506eb7958598a72f0cf85163ea',
          } as Proof,
        ],
      };

      const encodedToken = walletApi.encodeToken(token, { version: 3 });

      expect(encodedToken).toStartWith('cashuA');
      expect(encodedToken).toBe(getEncodedToken(token, { version: 3 }));
    });

    it('should encode tokens with V4 when version 4 is specified', () => {
      const v4Token = {
        mint: testMintUrl,
        proofs: [
          {
            id: '009a1f293253e41e',
            amount: 2,
            secret: '407915bc212be61a77e3e6d2aeb4c727980bda51cd06a6afc29e2861768a7837',
            C: '02bc9097997d81afb2cc7346b5e4345a9346bd2a506eb7958598a72f0cf85163ea',
          } as Proof,
        ],
      };

      const encodedToken = walletApi.encodeToken(v4Token, { version: 4 });

      expect(encodedToken).toStartWith('cashuB');
      expect(encodedToken).toBe(getEncodedToken(v4Token, { version: 4 }));
    });
  });

  describe('encodePaymentRequest', () => {
    it('should encode payment request as creqA by default', () => {
      const pr = new PaymentRequest([], 'test-id', 10, 'sat', [testMintUrl]);

      const encoded = walletApi.encodePaymentRequest(pr);

      expect(encoded).toStartWith('creqA');
    });

    it('should encode payment request as creqA when specified', () => {
      const pr = new PaymentRequest([], 'test-id', 10, 'sat', [testMintUrl]);

      const encoded = walletApi.encodePaymentRequest(pr, 'creqA');

      expect(encoded).toStartWith('creqA');
    });

    it('should encode payment request as creqB when specified', () => {
      const pr = new PaymentRequest([], 'test-id', 10, 'sat', [testMintUrl]);

      const encoded = walletApi.encodePaymentRequest(pr, 'creqB');

      expect(encoded).toStartWith('CREQB');
    });
  });
});
