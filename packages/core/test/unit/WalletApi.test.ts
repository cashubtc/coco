import { Amount } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect, mock } from 'bun:test';
import { WalletApi } from '../../api/WalletApi';
import { MintService } from '../../services/MintService';
import { WalletService } from '../../services/WalletService';
import { ProofService } from '../../services/ProofService';
import { WalletRestoreService } from '../../services/WalletRestoreService';
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
  let eventBus: EventBus<CoreEvents>;
  let proofReceiveRepo: MemoryProofRepository;
  let receiveOpRepo: MemoryReceiveOperationRepository;
  let receiveOperationService: ReceiveOperationService;
  let tokenService: TokenService;
  let mintAdapter: MintAdapter;

  const testMintUrl = 'https://mint.test';
  const keysetId = '009a1f293253e41e';
  const testProofs: Proof[] = [
    {
      id: keysetId,
      amount: Amount.from(10),
      secret: 'secret-1',
      C: '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
    } as Proof,
  ];

  const makeOutputData = (secrets: string[]): OutputData[] =>
    secrets.map(
      (secret) =>
        new OutputData(
          { amount: Amount.from(10), id: keysetId, B_: `B_${secret}` },
          BigInt(1),
          new TextEncoder().encode(secret),
        ),
    );

  const encodeLegacyTokenWithoutUnit = (token: { mint: string; proofs: Proof[] }): string => {
    const legacyToken = {
      token: [
        {
          mint: token.mint,
          proofs: token.proofs.map((proof) => ({
            ...proof,
            amount: proof.amount.toNumber(),
          })),
        },
      ],
    };
    return `cashuA${Buffer.from(JSON.stringify(legacyToken))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}`;
  };

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
            id: keysetId,
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
      getWallet: mock(async () => ({
        receive: mock(async () => []),
        getFeesForProofs: mock(() => Amount.zero()),
      })),
      getWalletWithActiveKeysetId: mock(async () => ({
        wallet: {
          receive: mock(async () => []),
          getFeesForProofs: mock(() => Amount.zero()),
        },
      })),
    };

    mockProofService = {
      createOutputsAndIncrementCounters: mock(async () => ({
        keep: makeOutputData(['out-1', 'out-2']),
        send: [],
      })),
      getBalancesByMint: mock(async () => ({
        [testMintUrl]: {
          spendable: Amount.from(10),
          reserved: Amount.from(5),
          total: Amount.from(15),
          unit: 'sat',
        },
      })),
      getBalancesByMintAndUnit: mock(async () => ({
        [testMintUrl]: {
          sat: {
            spendable: Amount.from(10),
            reserved: Amount.from(5),
            total: Amount.from(15),
            unit: 'sat',
          },
        },
      })),
      getBalancesByUnit: mock(async () => ({
        sat: {
          spendable: Amount.from(10),
          reserved: Amount.from(5),
          total: Amount.from(15),
          unit: 'sat',
        },
      })),
      getBalanceTotal: mock(async () => ({
        spendable: Amount.from(10),
        reserved: Amount.from(5),
        total: Amount.from(15),
        unit: 'sat',
      })),
      getBalanceTotalByUnit: mock(async () => ({
        sat: {
          spendable: Amount.from(10),
          reserved: Amount.from(5),
          total: Amount.from(15),
          unit: 'sat',
        },
      })),
      saveProofs: mock(async () => {}),
      prepareProofsForReceiving: mock(async (proofs: any[]) => proofs),
    };

    mockWalletRestoreService = {};

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
      receiveOperationService,
      tokenService,
    );
  });

  describe('receive - trust enforcement', () => {
    it('exposes the structured balances api', async () => {
      await expect(walletApi.balances.byMint()).resolves.toEqual({
        [testMintUrl]: {
          spendable: Amount.from(10),
          reserved: Amount.from(5),
          total: Amount.from(15),
          unit: 'sat',
        },
      });
      await expect(walletApi.balances.total()).resolves.toEqual({
        spendable: Amount.from(10),
        reserved: Amount.from(5),
        total: Amount.from(15),
        unit: 'sat',
      });
    });

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

      expect(mockWalletService.getWalletWithActiveKeysetId).toHaveBeenCalledWith(
        testMintUrl,
        'sat',
      );
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

      expect(mockWalletService.getWalletWithActiveKeysetId).toHaveBeenCalledWith(
        testMintUrl,
        'sat',
      );
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
      mockWalletService.getWallet.mockImplementation(async () => ({}));

      mockWalletRestoreService.restoreKeyset = mock(async () => {});

      await walletApi.restore(testMintUrl);

      expect(mockMintService.addMintByUrl).toHaveBeenCalledWith(testMintUrl, { trusted: true });
    });

    it('restores every advertised keyset unit by default', async () => {
      const satWallet = { unit: 'sat-wallet' };
      const usdWallet = { unit: 'usd-wallet' };
      mockMintService.addMintByUrl.mockImplementation(async () => ({
        mint: {},
        keysets: [
          { id: 'sat-keyset', unit: 'sat' },
          { id: 'usd-keyset', unit: 'USD' },
        ],
      }));
      mockWalletService.getWallet.mockImplementation(async (_mintUrl: string, unit: string) =>
        unit === 'usd' ? usdWallet : satWallet,
      );
      mockWalletRestoreService.restoreKeyset = mock(async () => {});

      await walletApi.restore(testMintUrl);

      expect(mockWalletService.getWallet).toHaveBeenCalledWith(testMintUrl, 'sat');
      expect(mockWalletService.getWallet).toHaveBeenCalledWith(testMintUrl, 'usd');
      expect(mockWalletRestoreService.restoreKeyset).toHaveBeenCalledWith(
        testMintUrl,
        satWallet,
        'sat-keyset',
        'sat',
      );
      expect(mockWalletRestoreService.restoreKeyset).toHaveBeenCalledWith(
        testMintUrl,
        usdWallet,
        'usd-keyset',
        'usd',
      );
    });

    it('restores only requested units when a unit filter is provided', async () => {
      const usdWallet = { unit: 'usd-wallet' };
      mockMintService.addMintByUrl.mockImplementation(async () => ({
        mint: {},
        keysets: [
          { id: 'sat-keyset', unit: 'sat' },
          { id: 'usd-keyset', unit: 'USD' },
        ],
      }));
      mockWalletService.getWallet.mockResolvedValue(usdWallet);
      mockWalletRestoreService.restoreKeyset = mock(async () => {});

      await walletApi.restore(testMintUrl, { units: ['USD'] });

      expect(mockWalletService.getWallet).toHaveBeenCalledTimes(1);
      expect(mockWalletService.getWallet).toHaveBeenCalledWith(testMintUrl, 'usd');
      expect(mockWalletRestoreService.restoreKeyset).toHaveBeenCalledTimes(1);
      expect(mockWalletRestoreService.restoreKeyset).toHaveBeenCalledWith(
        testMintUrl,
        usdWallet,
        'usd-keyset',
        'usd',
      );
    });
  });

  describe('sweep', () => {
    it('sweeps only requested units when a unit filter is provided', async () => {
      const bip39seed = new Uint8Array(64).fill(1);
      mockMintService.addMintByUrl.mockImplementation(async () => ({
        mint: {},
        keysets: [
          { id: 'sat-keyset', unit: 'sat' },
          { id: 'usd-keyset', unit: 'USD' },
        ],
      }));
      mockWalletRestoreService.sweepKeyset = mock(async () => {});

      await walletApi.sweep(testMintUrl, bip39seed, { units: ['USD'] });

      expect(mockWalletRestoreService.sweepKeyset).toHaveBeenCalledTimes(1);
      expect(mockWalletRestoreService.sweepKeyset).toHaveBeenCalledWith(
        testMintUrl,
        'usd-keyset',
        bip39seed,
        'usd',
      );
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

      const result = await walletApi.decodeToken(encodedToken);

      expect(mockMintService.ensureUpdatedMint).toHaveBeenCalledWith(testMintUrl);
      expect(result).toEqual({ ...decodedToken, unit: 'sat' });
    });

    it('infers a unitless token unit from proof keysets when no mint URL is provided', async () => {
      const token = {
        mint: testMintUrl,
        proofs: testProofs,
      };
      const encodedToken = encodeLegacyTokenWithoutUnit(token);
      mockMintService.ensureUpdatedMint.mockImplementation(async () => ({
        mint: { url: testMintUrl },
        keysets: [{ id: keysetId, unit: 'USD', active: true }],
      }));

      const result = await walletApi.decodeToken(encodedToken);

      expect(result.unit).toBe('usd');
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
