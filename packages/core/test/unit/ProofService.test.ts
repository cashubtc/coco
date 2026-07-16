import { Amount, type OutputDataLike } from '@cashu/cashu-ts';
import { describe, it, beforeEach, afterEach, expect, mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { ProofService } from '../../services/ProofService.ts';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository.ts';
import { MemoryCounterRepository } from '../../repositories/memory/MemoryCounterRepository.ts';
import { CounterService } from '../../services/CounterService.ts';
import { SeedService } from '../../services/SeedService.ts';
import {
  ProofOperationError,
  ProofValidationError,
  UnitMismatchError,
  UnitValidationError,
} from '../../models/Error.ts';
import type { CoreProof } from '../../types.ts';
import { OutputData } from '@cashu/cashu-ts';
import type { SerializedOutputData } from '../../utils.ts';
import { makeOutputDataCreator } from '../fixtures/OutputDataCreator.ts';

describe('ProofService', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';

  let proofRepo: MemoryProofRepository;
  let counterRepo: MemoryCounterRepository;
  let counterService: CounterService;
  let bus: EventBus<CoreEvents>;
  let seedService: SeedService;

  // Minimal wallet service stub with only used methods
  let walletService: {
    getWalletWithActiveKeysetId: (mintUrl: string, unit?: string) => Promise<any>;
    getWallet: (
      mintUrl: string,
      unit?: string,
    ) => Promise<{ selectProofsToSend: (proofs: any[], amount: Amount) => { send: any[] } }>;
  };

  // Minimal mint service stub
  let mintService: {
    getAllTrustedMints: () => Promise<{ mintUrl: string }[]>;
    ensureUpdatedMint: (mintUrl: string) => Promise<{ mint: any; keysets: any[] }>;
  };

  // Minimal keyRingService stub
  let keyRingService: {
    signProof: (proof: any, publicKey: string) => Promise<any>;
  };

  const makeProof = (overrides: Partial<CoreProof>): CoreProof =>
    ({
      amount: Amount.from(1),
      C: 'C_' as unknown as any,
      id: keysetId,
      unit: 'sat',
      secret: Math.random().toString(36).slice(2),
      mintUrl,
      state: 'ready',
      ...overrides,
    }) as unknown as CoreProof;

  const unitAmount = (amount: number | bigint | Amount, unit = 'sat') => ({
    amount: Amount.from(amount),
    unit,
  });

  const makeSeed = () => new Uint8Array(64).fill(7);

  let originalCreateDeterministicData: typeof OutputData.createDeterministicData;
  let originalCreateSingleDeterministicData: typeof OutputData.createSingleDeterministicData;

  beforeEach(() => {
    proofRepo = new MemoryProofRepository();
    counterRepo = new MemoryCounterRepository();
    bus = new EventBus<CoreEvents>();
    counterService = new CounterService(counterRepo, undefined, bus);
    seedService = new SeedService(async () => makeSeed());

    walletService = {
      async getWalletWithActiveKeysetId() {
        return { keys: { id: keysetId } };
      },
      async getWallet() {
        return {
          selectProofsToSend(proofs: any[], _amount: Amount) {
            // Default naive selector used by tests; specific tests can override walletService
            return { send: proofs.slice(0, 1) };
          },
        };
      },
    };

    mintService = {
      async getAllTrustedMints() {
        return [{ mintUrl }];
      },
      async ensureUpdatedMint(_mintUrl: string) {
        return { mint: {}, keysets: [] };
      },
    };

    keyRingService = {
      async signProof(proof: any, _publicKey: string) {
        // Simple stub that adds a witness field
        return { ...proof, witness: 'mock-signature' };
      },
    };

    originalCreateDeterministicData = OutputData.createDeterministicData;
    originalCreateSingleDeterministicData = OutputData.createSingleDeterministicData;
  });

  afterEach(() => {
    // Restore OutputData static
    OutputData.createDeterministicData = originalCreateDeterministicData;
    OutputData.createSingleDeterministicData = originalCreateSingleDeterministicData;
  });

  describe('createMintOutputsAtCounter', () => {
    it('derives exact outputs at the supplied counter without advancing persistence', async () => {
      const generated = [
        new OutputData(
          { amount: Amount.from(5), id: keysetId, B_: 'B_mint_output' },
          1n,
          new TextEncoder().encode('mint-output'),
        ),
      ];
      const createDeterministicData = mock(() => generated);
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
        makeOutputDataCreator({ createDeterministicData }),
      );

      const result = await service.createMintOutputsAtCounter(mintUrl, unitAmount(5), 7);

      expect(createDeterministicData).toHaveBeenCalledWith(Amount.from(5), makeSeed(), 7, {
        id: keysetId,
      });
      expect(result.keysetId).toBe(keysetId);
      expect(result.counterStart).toBe(7);
      expect(result.counterEnd).toBe(8);
      expect(result.outputData.keep).toHaveLength(1);
      await expect(counterRepo.getCounter(mintUrl, keysetId)).resolves.toBeNull();
    });
  });

  describe('createOutputsAndIncrementCounters', () => {
    it('delegates deterministic keep and send outputs to the supplied creator', async () => {
      const keepOutputs = [
        { marker: 'keep-1' },
        { marker: 'keep-2' },
      ] as unknown as OutputDataLike[];
      const sendOutputs = [{ marker: 'send-1' }] as unknown as OutputDataLike[];
      const createDeterministicData = mock((amount: Amount, _seed: Uint8Array, counter: number) =>
        amount.equals(3) && counter === 0 ? keepOutputs : sendOutputs,
      );
      const creator = makeOutputDataCreator({ createDeterministicData });
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
        creator,
      );

      const result = await service.createOutputsAndIncrementCounters(mintUrl, {
        keep: unitAmount(3),
        send: unitAmount(7),
      });

      expect(createDeterministicData).toHaveBeenNthCalledWith(1, Amount.from(3), makeSeed(), 0, {
        id: keysetId,
      });
      expect(createDeterministicData).toHaveBeenNthCalledWith(2, Amount.from(7), makeSeed(), 2, {
        id: keysetId,
      });
      expect(result.keep).toBe(keepOutputs);
      expect(result.send).toBe(sendOutputs);
      await expect(counterRepo.getCounter(mintUrl, keysetId)).resolves.toEqual({
        mintUrl,
        keysetId,
        counter: 3,
      });
    });

    it('does not invoke the creator for zero-valued keep or send sides', async () => {
      const createDeterministicData = mock(() => []);
      const creator = makeOutputDataCreator({ createDeterministicData });
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
        creator,
      );

      await service.createOutputsAndIncrementCounters(mintUrl, {
        keep: unitAmount(0),
        send: unitAmount(0),
      });

      expect(createDeterministicData).not.toHaveBeenCalled();
      await expect(counterRepo.getCounter(mintUrl, keysetId)).resolves.toEqual({
        mintUrl,
        keysetId,
        counter: 0,
      });
    });

    it('propagates creator errors without using a built-in fallback', async () => {
      const creatorError = new Error('custom creator failed');
      const createDeterministicData = mock(() => {
        throw creatorError;
      });
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
        makeOutputDataCreator({ createDeterministicData }),
      );

      await expect(
        service.createOutputsAndIncrementCounters(mintUrl, {
          keep: unitAmount(1),
          send: unitAmount(0),
        }),
      ).rejects.toBe(creatorError);
      expect(createDeterministicData).toHaveBeenCalledTimes(1);
      await expect(counterRepo.getCounter(mintUrl, keysetId)).resolves.toEqual({
        mintUrl,
        keysetId,
        counter: 0,
      });
    });

    it('throws when mintUrl is missing', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );
      await expect(
        service.createOutputsAndIncrementCounters('', {
          keep: unitAmount(1),
          send: unitAmount(1),
        }),
      ).rejects.toThrow(ProofValidationError);
    });

    it('rejects invalid or negative internal unit amounts', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await expect(
        service.createOutputsAndIncrementCounters(mintUrl, {
          keep: { amount: -1 as unknown as Amount, unit: 'sat' },
          send: unitAmount(0),
        }),
      ).rejects.toThrow();

      await expect(
        service.createOutputsAndIncrementCounters(mintUrl, {
          keep: { amount: Number.NaN as unknown as Amount, unit: 'sat' },
          send: unitAmount(5),
        }),
      ).rejects.toThrow();
    });

    it('creates deterministic outputs and increments counters accordingly', async () => {
      const calls: Array<{ amount: Amount; counter: number }> = [];
      OutputData.createDeterministicData = ((
        amount: Amount,
        _seed: Uint8Array,
        counter: number,
      ) => {
        calls.push({ amount, counter });
        // Return arrays with predictable sizes not necessarily equal to amount
        const size = amount.equals(3) ? 2 : amount.equals(7) ? 4 : 0;
        return new Array(size).fill({}) as any;
      }) as any;

      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      const result = await service.createOutputsAndIncrementCounters(mintUrl, {
        keep: unitAmount(3),
        send: unitAmount(7),
      });

      expect(calls.length).toBe(2);
      // First call uses current counter (0)
      expect(calls[0]).toEqual({ amount: Amount.from(3), counter: 0 });
      // Second call uses offset by keep outputs length (2)
      expect(calls[1]).toEqual({ amount: Amount.from(7), counter: 2 });

      expect(result.keep.length).toBe(2);
      expect(result.send.length).toBe(4);

      const finalCounter = await counterRepo.getCounter(mintUrl, keysetId);
      expect(finalCounter?.counter).toBe(6);
    });

    it('uses the requested unit when creating outputs', async () => {
      const getWalletWithActiveKeysetId = mock(async (_mintUrl: string, unit?: string) => {
        expect(unit).toBe('usd');
        return { keys: { id: 'usd-keyset' }, keysetId: 'usd-keyset' };
      });
      walletService = {
        getWalletWithActiveKeysetId,
        async getWallet() {
          return {
            selectProofsToSend() {
              return { send: [] };
            },
          };
        },
      };
      OutputData.createDeterministicData = (() => [{}]) as any;

      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await service.createOutputsAndIncrementCounters(
        mintUrl,
        { keep: unitAmount(1, 'USD'), send: unitAmount(0, 'USD') },
        {},
      );

      expect(getWalletWithActiveKeysetId).toHaveBeenCalledWith(mintUrl, 'usd');
      const counter = await counterRepo.getCounter(mintUrl, 'usd-keyset');
      expect(counter?.counter).toBe(1);
    });
  });

  describe('createBlankOutputs', () => {
    it('delegates blank outputs with consecutive counters to the supplied creator', async () => {
      const createSingleDeterministicData = mock(
        (_amount: Amount, _seed: Uint8Array, counter: number, _keysetId: string) =>
          ({ counter }) as unknown as OutputDataLike,
      );
      const creator = makeOutputDataCreator({ createSingleDeterministicData });
      OutputData.createSingleDeterministicData = () => {
        throw new Error('built-in single deterministic creation must not be used');
      };
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
        creator,
      );

      const result = await service.createBlankOutputs(mintUrl, unitAmount(8));

      expect(createSingleDeterministicData).toHaveBeenCalledTimes(3);
      expect(createSingleDeterministicData.mock.calls.map((call) => call[2])).toEqual([0, 1, 2]);
      for (const call of createSingleDeterministicData.mock.calls) {
        expect(Amount.from(call[0]).isZero()).toBe(true);
        expect(call[1]).toEqual(makeSeed());
        expect(call[3]).toBe(keysetId);
      }
      expect(result).toHaveLength(3);
    });

    it('creates blank outputs for bigint-backed amounts above MAX_SAFE_INTEGER', async () => {
      const counters: number[] = [];
      OutputData.createSingleDeterministicData = ((
        amount: Parameters<typeof OutputData.createSingleDeterministicData>[0],
        _seed: Uint8Array,
        counter: number,
      ) => {
        expect(Amount.from(amount)).toEqual(Amount.zero());
        counters.push(counter);
        return {} as OutputData;
      }) as typeof OutputData.createSingleDeterministicData;

      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      const amount = Amount.from(1n << 60n);

      const result = await service.createBlankOutputs(mintUrl, { amount, unit: 'sat' });

      expect(result.length).toBe(60);
      expect(counters).toEqual(Array.from({ length: 60 }, (_, index) => index));
      await expect(counterRepo.getCounter(mintUrl, keysetId)).resolves.toEqual({
        mintUrl,
        keysetId,
        counter: 60,
      });
    });
  });

  describe('calculateSendAmountWithFees', () => {
    it('ignores denominations above MAX_SAFE_INTEGER when splitting', async () => {
      walletService = {
        async getWalletWithActiveKeysetId() {
          return {
            wallet: {
              getFeesForKeyset: () => Amount.zero(),
            },
            keysetId,
            keys: {
              id: keysetId,
              keys: {
                '1': 'key-1',
                '2': 'key-2',
                '9007199254740993': 'key-too-large',
              },
            },
          };
        },
        async getWallet() {
          return {
            selectProofsToSend(proofs: any[]) {
              return { send: proofs.slice(0, 1) };
            },
          };
        },
      };

      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await expect(service.calculateSendAmountWithFees(mintUrl, unitAmount(3))).resolves.toEqual(
        Amount.from(3),
      );
    });

    it('throws when all available denominations exceed MAX_SAFE_INTEGER', async () => {
      walletService = {
        async getWalletWithActiveKeysetId() {
          return {
            wallet: {
              getFeesForKeyset: () => Amount.zero(),
            },
            keysetId,
            keys: {
              id: keysetId,
              keys: {
                '9007199254740992': 'key-a',
                '9007199254740993': 'key-b',
              },
            },
          };
        },
        async getWallet() {
          return {
            selectProofsToSend(proofs: any[]) {
              return { send: proofs.slice(0, 1) };
            },
          };
        },
      };

      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await expect(service.calculateSendAmountWithFees(mintUrl, unitAmount(1))).rejects.toThrow(
        'Unable to split remaining amount: 1',
      );
    });
  });

  describe('saveProofs', () => {
    it('throws when a proof is missing unit metadata', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );
      const proof = makeProof({ secret: 'missing-unit' }) as unknown as Omit<CoreProof, 'unit'>;
      delete (proof as { unit?: string }).unit;

      await expect(service.saveProofs(mintUrl, [proof as CoreProof])).rejects.toThrow(
        UnitValidationError,
      );
    });

    it('emits per-group events and persists on success', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      const events: Array<{ mintUrl: string; keysetId: string; proofs: CoreProof[] }> = [];
      bus.on('proofs:saved', (payload) => {
        events.push(payload);
      });

      const proofs: CoreProof[] = [
        makeProof({ secret: 's1', id: 'k1', amount: Amount.from(5) }),
        makeProof({ secret: 's2', id: 'k1', amount: Amount.from(10) }),
        makeProof({ secret: 's3', id: 'k2', amount: Amount.from(15) }),
      ];

      await service.saveProofs(mintUrl, proofs);

      // Two groups: k1 and k2
      expect(events.length).toBe(2);
      const groupIds = events.map((e) => e.keysetId).sort();
      expect(groupIds).toEqual(['k1', 'k2']);

      const ready = await proofRepo.getReadyProofs(mintUrl);
      expect(ready.length).toBe(3);
    });

    it('aggregates failures across groups and throws ProofOperationError', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      // Pre-seed repository with a proof to force a collision for keyset kBad
      await proofRepo.saveProofs(mintUrl, [
        makeProof({ secret: 'dup', id: 'kBad', amount: Amount.from(1) }),
      ]);

      const proofs: CoreProof[] = [
        // This one will collide (same secret under same mint)
        makeProof({ secret: 'dup', id: 'kBad', amount: Amount.from(2) }),
        // Another independent group should succeed
        makeProof({ secret: 'ok1', id: 'kOk', amount: Amount.from(3) }),
      ];

      await expect(service.saveProofs(mintUrl, proofs)).rejects.toThrow(ProofOperationError);
    });

    it('returns early when proofs array is empty', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      const events: Array<{ mintUrl: string; keysetId: string; proofs: CoreProof[] }> = [];
      bus.on('proofs:saved', (payload) => {
        events.push(payload);
      });

      await service.saveProofs(mintUrl, []);
      expect(events.length).toBe(0);
    });
  });

  describe('state changes and deletions', () => {
    it('setProofState updates repository and emits event', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      const p1 = makeProof({ secret: 'a', id: 'k1', state: 'ready' });
      const p2 = makeProof({ secret: 'b', id: 'k1', state: 'ready' });
      await proofRepo.saveProofs(mintUrl, [p1, p2]);

      const events: Array<{
        mintUrl: string;
        secrets: string[];
        state: 'inflight' | 'ready' | 'spent';
      }> = [];
      bus.on('proofs:state-changed', (payload) => {
        events.push(payload);
      });

      await service.setProofState(mintUrl, ['a', 'b'], 'spent');

      expect(events.length).toBe(1);
      expect(events[0]).toEqual({ mintUrl, secrets: ['a', 'b'], state: 'spent' });
    });

    it('deleteProofs removes proofs and emits event', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      const p1 = makeProof({ secret: 'x', id: 'k1' });
      const p2 = makeProof({ secret: 'y', id: 'k1' });
      await proofRepo.saveProofs(mintUrl, [p1, p2]);

      const events: Array<{ mintUrl: string; secrets: string[] }> = [];
      bus.on('proofs:deleted', (payload) => {
        events.push(payload);
      });

      await service.deleteProofs(mintUrl, ['x']);
      expect(events.length).toBe(1);
      expect(events[0]).toEqual({ mintUrl, secrets: ['x'] });

      const remaining = await proofRepo.getReadyProofs(mintUrl);
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.secret).toBe('y');
    });

    it('wipeProofsByKeysetId removes by keyset and emits event', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await proofRepo.saveProofs(mintUrl, [
        makeProof({ secret: 'p1', id: 'k1' }),
        makeProof({ secret: 'p2', id: 'k2' }),
        makeProof({ secret: 'p3', id: 'k1' }),
      ]);

      const events: Array<{ mintUrl: string; keysetId: string }> = [];
      bus.on('proofs:wiped', (payload) => {
        events.push(payload);
      });

      await service.wipeProofsByKeysetId(mintUrl, 'k1');
      expect(events.length).toBe(1);
      expect(events[0]).toEqual({ mintUrl, keysetId: 'k1' });

      const remaining = await proofRepo.getReadyProofs(mintUrl);
      expect(remaining.map((p) => p.secret).sort()).toEqual(['p2']);
    });
  });

  describe('checkInflightProofs', () => {
    it('marks spent inflight proofs based on mint state checks', async () => {
      const otherMintUrl = 'https://mint.other';

      const mintProofs = [
        makeProof({ secret: 's1', state: 'inflight', mintUrl }),
        makeProof({ secret: 's2', state: 'inflight', mintUrl }),
      ];
      const otherProofs = [makeProof({ secret: 's3', state: 'inflight', mintUrl: otherMintUrl })];

      await proofRepo.saveProofs(mintUrl, mintProofs);
      await proofRepo.saveProofs(otherMintUrl, otherProofs);

      proofRepo.getInflightProofs = mock(async (_mintUrls?: string[]) => [
        ...mintProofs,
        ...otherProofs,
      ]);

      const checkProofsStates = mock(async (proofs: CoreProof[]) => {
        const requestedMintUrl = proofs[0]?.mintUrl;
        if (requestedMintUrl === mintUrl) {
          return [{ state: 'SPENT' }, { state: 'UNSPENT' }];
        }
        return [{ state: 'SPENT' }];
      });
      const getWalletWithActiveKeysetId = mock(async (_requestedMintUrl: string) => {
        return {
          wallet: {
            checkProofsStates,
          },
        } as any;
      });
      walletService = {
        getWalletWithActiveKeysetId,
        getWallet: walletService.getWallet,
      };

      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await service.checkInflightProofs();

      const proof1 = await proofRepo.getProofBySecret(mintUrl, 's1');
      const proof2 = await proofRepo.getProofBySecret(mintUrl, 's2');
      const proof3 = await proofRepo.getProofBySecret(otherMintUrl, 's3');

      expect(proof1?.state).toBe('spent');
      expect(proof2?.state).toBe('inflight');
      expect(proof3?.state).toBe('spent');
      expect(getWalletWithActiveKeysetId).toHaveBeenCalledTimes(2);
      expect(getWalletWithActiveKeysetId).toHaveBeenCalledWith(mintUrl, 'sat');
      expect(getWalletWithActiveKeysetId).toHaveBeenCalledWith(otherMintUrl, 'sat');
      expect(checkProofsStates).toHaveBeenCalledTimes(2);
    });

    it('checks inflight proofs separately for each unit', async () => {
      const satProof = makeProof({ secret: 'sat-inflight', state: 'inflight', unit: 'sat' });
      const usdProof = makeProof({ secret: 'usd-inflight', state: 'inflight', unit: 'usd' });
      await proofRepo.saveProofs(mintUrl, [satProof, usdProof]);
      proofRepo.getInflightProofs = mock(async () => [satProof, usdProof]);

      const checkProofsStates = mock(async (proofs: CoreProof[]) => {
        expect(new Set(proofs.map((proof) => proof.unit)).size).toBe(1);
        return proofs.map(() => ({ state: 'UNSPENT' }));
      });
      const getWalletWithActiveKeysetId = mock(async () => ({
        wallet: { checkProofsStates },
      }));
      walletService = {
        getWalletWithActiveKeysetId,
        getWallet: walletService.getWallet,
      };

      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await service.checkInflightProofs();

      expect(getWalletWithActiveKeysetId).toHaveBeenCalledWith(mintUrl, 'sat');
      expect(getWalletWithActiveKeysetId).toHaveBeenCalledWith(mintUrl, 'usd');
      expect(checkProofsStates).toHaveBeenCalledTimes(2);
    });

    it('skips checks when no inflight proofs exist', async () => {
      const getInflightProofs = mock(async (_mintUrls?: string[]) => []);
      const checkProofsStates = mock(async () => [{ state: 'SPENT' }]);
      const getWalletWithActiveKeysetId = mock(async () => {
        return {
          wallet: {
            checkProofsStates,
          },
        } as any;
      });
      proofRepo.getInflightProofs = getInflightProofs;
      walletService = {
        getWalletWithActiveKeysetId,
        getWallet: walletService.getWallet,
      };

      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await service.checkInflightProofs();

      expect(getInflightProofs).toHaveBeenCalledTimes(1);
      expect(getWalletWithActiveKeysetId).not.toHaveBeenCalled();
      expect(checkProofsStates).not.toHaveBeenCalled();
    });
  });

  describe('queries', () => {
    it('getReadyProofs, getAllReadyProofs, getProofsByKeysetId, hasProofsForKeyset', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      const pReady1 = makeProof({ secret: 'r1', id: 'k1', state: 'ready' });
      const pReady2 = makeProof({ secret: 'r2', id: 'k2', state: 'ready' });
      const pSpent = makeProof({ secret: 's1', id: 'k1', state: 'spent' });
      await proofRepo.saveProofs(mintUrl, [pReady1, pReady2, pSpent]);

      const ready = await service.getReadyProofs(mintUrl);
      expect(ready.map((p) => p.secret).sort()).toEqual(['r1', 'r2']);

      const allReady = await service.getAllReadyProofs();
      expect(allReady.map((p) => p.secret).sort()).toEqual(['r1', 'r2']);

      const byK1 = await service.getProofsByKeysetId(mintUrl, 'k1');
      expect(byK1.map((p) => p.secret).sort()).toEqual(['r1']);

      const hasK1 = await service.hasProofsForKeyset(mintUrl, 'k1');
      expect(hasK1).toBe(true);
      const hasK3 = await service.hasProofsForKeyset(mintUrl, 'k3');
      expect(hasK3).toBe(false);
    });
  });

  describe('selectProofsToSend', () => {
    it('throws when not enough proofs available', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await proofRepo.saveProofs(mintUrl, [
        makeProof({ secret: 'a1', id: 'k1', amount: Amount.from(5) }),
        makeProof({ secret: 'a2', id: 'k1', amount: Amount.from(10) }),
      ]);

      await expect(service.selectProofsToSend(mintUrl, unitAmount(100))).rejects.toThrow(
        ProofValidationError,
      );
    });

    it('ignores proofs that are already reserved by another operation', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await proofRepo.saveProofs(mintUrl, [
        makeProof({ secret: 'available-1', id: 'k1', amount: Amount.from(50) }),
        makeProof({
          secret: 'reserved-1',
          id: 'k1',
          amount: Amount.from(100),
          usedByOperationId: 'op-1',
        }),
      ]);

      const selected = await service.selectProofsToSend(mintUrl, unitAmount(40));
      expect(selected.map((p) => p.secret)).toEqual(['available-1']);
    });

    it('delegates to wallet.selectProofsToSend and returns selected proofs', async () => {
      // Override wallet selector to return a specific subset
      walletService = {
        async getWalletWithActiveKeysetId() {
          return { keys: { id: keysetId } };
        },
        async getWallet() {
          return {
            selectProofsToSend(proofs: any[], amount: Amount) {
              // pick smallest number of proofs that reach amount
              const selected: any[] = [];
              let acc = Amount.zero();
              for (const p of proofs) {
                if (acc.greaterThanOrEqual(amount)) break;
                selected.push(p);
                acc = acc.add((p as any).amount ?? 0);
              }
              return { send: selected };
            },
          };
        },
      };

      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      const p1 = makeProof({ secret: 'b1', id: 'k1', amount: Amount.from(30) });
      const p2 = makeProof({ secret: 'b2', id: 'k1', amount: Amount.from(50) });
      const p3 = makeProof({ secret: 'b3', id: 'k1', amount: Amount.from(80) });
      await proofRepo.saveProofs(mintUrl, [p1, p2, p3]);

      const selected = await service.selectProofsToSend(mintUrl, unitAmount(60));
      // Expect our wallet stub to choose p1 + p2
      expect(selected.map((p) => p.secret)).toEqual(['b1', 'b2']);
    });

    it('selects only proofs for the requested unit', async () => {
      const getWallet = mock(async (_mintUrl: string, unit?: string) => ({
        selectProofsToSend(proofs: any[], amount: Amount) {
          expect(unit).toBe('usd');
          expect(proofs.every((proof) => proof.unit === 'usd')).toBe(true);
          const selected: any[] = [];
          let total = Amount.zero();
          for (const proof of proofs) {
            if (total.greaterThanOrEqual(amount)) break;
            selected.push(proof);
            total = total.add(proof.amount);
          }
          return { send: selected };
        },
      }));
      walletService = {
        async getWalletWithActiveKeysetId() {
          return { keys: { id: keysetId } };
        },
        getWallet,
      };
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await proofRepo.saveProofs(mintUrl, [
        makeProof({ secret: 'sat-large', id: 'k1', amount: Amount.from(100), unit: 'sat' }),
        makeProof({ secret: 'usd-1', id: 'k1', amount: Amount.from(30), unit: 'usd' }),
        makeProof({ secret: 'usd-2', id: 'k1', amount: Amount.from(25), unit: 'usd' }),
      ]);

      const selected = await service.selectProofsToSend(mintUrl, unitAmount(50, 'USD'), false);

      expect(getWallet).toHaveBeenCalledWith(mintUrl, 'usd');
      expect(selected.map((proof) => proof.secret)).toEqual(['usd-1', 'usd-2']);
    });

    it('does not use sat balance to satisfy an insufficient custom-unit selection', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await proofRepo.saveProofs(mintUrl, [
        makeProof({ secret: 'sat-large', id: 'k1', amount: Amount.from(100), unit: 'sat' }),
        makeProof({ secret: 'usd-small', id: 'k1', amount: Amount.from(10), unit: 'usd' }),
      ]);

      await expect(service.selectProofsToSend(mintUrl, unitAmount(50, 'usd'))).rejects.toThrow(
        ProofValidationError,
      );
    });
  });

  describe('reserveProofs', () => {
    it('emits the reserved input amount without counting operation output proofs', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );
      const operationId = 'reserve-op';
      const events: CoreEvents['proofs:reserved'][] = [];
      bus.on('proofs:reserved', (payload) => {
        events.push(payload);
      });

      await proofRepo.saveProofs(mintUrl, [
        makeProof({ secret: 'reserve-input', amount: Amount.from(5), unit: 'usd' }),
        makeProof({
          secret: 'reserve-output',
          amount: Amount.from(100),
          unit: 'usd',
          createdByOperationId: operationId,
        }),
      ]);

      const result = await service.reserveProofs(mintUrl, ['reserve-input'], operationId, {
        unit: 'USD',
      });

      expect(result).toEqual({ amount: Amount.from(5), unit: 'usd' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        mintUrl,
        operationId,
        secrets: ['reserve-input'],
      });
      expect(events[0]?.amount).toEqual({ amount: Amount.from(5), unit: 'usd' });
    });
  });

  describe('balance queries', () => {
    const otherMintUrl = 'https://mint.other';
    const operationId = 'op-123';

    it('returns canonical snapshot and legacy single-mint views', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await proofRepo.saveProofs(mintUrl, [
        makeProof({ secret: 'a1', amount: Amount.from(100) }),
        makeProof({ secret: 'a2', amount: Amount.from(50) }),
      ]);
      await proofRepo.reserveProofs(mintUrl, ['a1'], operationId);

      await expect(service.getBalancesByMint({ mintUrls: [mintUrl] })).resolves.toEqual({
        [mintUrl]: {
          spendable: Amount.from(50),
          reserved: Amount.from(100),
          total: Amount.from(150),
          unit: 'sat',
        },
      });
      await expect(service.getBalanceTotal({ mintUrls: [mintUrl] })).resolves.toEqual({
        spendable: Amount.from(50),
        reserved: Amount.from(100),
        total: Amount.from(150),
        unit: 'sat',
      });
      await expect(service.getBalance(mintUrl)).resolves.toEqual(Amount.from(150));
      await expect(service.getSpendableBalance(mintUrl)).resolves.toEqual(Amount.from(50));
      await expect(service.getBalanceBreakdown(mintUrl)).resolves.toEqual({
        ready: Amount.from(50),
        reserved: Amount.from(100),
        total: Amount.from(150),
      });
    });

    it('uses mint-scoped ready proof reads for scoped balance queries', async () => {
      const originalGetReadyProofs = proofRepo.getReadyProofs.bind(proofRepo);
      const originalGetAllReadyProofs = proofRepo.getAllReadyProofs.bind(proofRepo);

      proofRepo.getReadyProofs = mock((mintUrl: string, filter?: any) =>
        originalGetReadyProofs(mintUrl, filter),
      );
      proofRepo.getAllReadyProofs = mock((filter?: any) => originalGetAllReadyProofs(filter));

      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await proofRepo.saveProofs(mintUrl, [
        makeProof({ secret: 'scope-a1', amount: Amount.from(100) }),
        makeProof({ secret: 'scope-a2', amount: Amount.from(50) }),
      ]);
      await proofRepo.saveProofs(otherMintUrl, [
        makeProof({ secret: 'scope-b1', amount: Amount.from(200), mintUrl: otherMintUrl }),
      ]);
      await proofRepo.reserveProofs(mintUrl, ['scope-a1'], operationId);

      await expect(service.getBalancesByMint({ mintUrls: [mintUrl] })).resolves.toEqual({
        [mintUrl]: {
          spendable: Amount.from(50),
          reserved: Amount.from(100),
          total: Amount.from(150),
          unit: 'sat',
        },
      });

      expect(proofRepo.getReadyProofs).toHaveBeenCalledTimes(1);
      expect(proofRepo.getReadyProofs).toHaveBeenCalledWith(mintUrl, { units: ['sat'] });
      expect(proofRepo.getAllReadyProofs).not.toHaveBeenCalled();
    });

    it('returns an empty snapshot for an explicit empty mint selection', async () => {
      const originalGetReadyProofs = proofRepo.getReadyProofs.bind(proofRepo);
      const originalGetAllReadyProofs = proofRepo.getAllReadyProofs.bind(proofRepo);

      proofRepo.getReadyProofs = mock((mintUrl: string, filter?: any) =>
        originalGetReadyProofs(mintUrl, filter),
      );
      proofRepo.getAllReadyProofs = mock((filter?: any) => originalGetAllReadyProofs(filter));

      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await proofRepo.saveProofs(mintUrl, [
        makeProof({ secret: 'empty-a1', amount: Amount.from(100) }),
      ]);
      await proofRepo.saveProofs(otherMintUrl, [
        makeProof({ secret: 'empty-b1', amount: Amount.from(200), mintUrl: otherMintUrl }),
      ]);

      await expect(service.getBalancesByMint({ mintUrls: [] })).resolves.toEqual({});
      await expect(service.getBalanceTotal({ mintUrls: [] })).resolves.toEqual({
        spendable: Amount.from(0),
        reserved: Amount.from(0),
        total: Amount.from(0),
        unit: 'sat',
      });

      expect(proofRepo.getReadyProofs).not.toHaveBeenCalled();
      expect(proofRepo.getAllReadyProofs).not.toHaveBeenCalled();
    });

    it('treats an explicit empty unit selection as no balance results', async () => {
      const originalGetReadyProofs = proofRepo.getReadyProofs.bind(proofRepo);
      const originalGetAllReadyProofs = proofRepo.getAllReadyProofs.bind(proofRepo);

      proofRepo.getReadyProofs = mock((mintUrl: string, filter?: any) =>
        originalGetReadyProofs(mintUrl, filter),
      );
      proofRepo.getAllReadyProofs = mock((filter?: any) => originalGetAllReadyProofs(filter));

      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await proofRepo.saveProofs(mintUrl, [
        makeProof({ secret: 'empty-unit-a1', amount: Amount.from(100), unit: 'sat' }),
        makeProof({ secret: 'empty-unit-u1', amount: Amount.from(40), unit: 'usd' }),
      ]);

      await expect(service.getBalancesByMint({ units: [] })).resolves.toEqual({});
      await expect(service.getBalanceTotal({ units: [] })).resolves.toEqual({
        spendable: Amount.zero(),
        reserved: Amount.zero(),
        total: Amount.zero(),
        unit: 'sat',
      });

      expect(proofRepo.getReadyProofs).not.toHaveBeenCalled();
      expect(proofRepo.getAllReadyProofs).not.toHaveBeenCalled();
    });

    it('returns canonical and legacy map views for all mints', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await proofRepo.saveProofs(mintUrl, [
        makeProof({ secret: 'b1', amount: Amount.from(100) }),
        makeProof({ secret: 'b2', amount: Amount.from(50) }),
      ]);
      await proofRepo.saveProofs(otherMintUrl, [
        makeProof({ secret: 'c1', amount: Amount.from(200), mintUrl: otherMintUrl }),
      ]);
      await proofRepo.reserveProofs(mintUrl, ['b1'], operationId);

      await expect(service.getBalancesByMint()).resolves.toEqual({
        [mintUrl]: {
          spendable: Amount.from(50),
          reserved: Amount.from(100),
          total: Amount.from(150),
          unit: 'sat',
        },
        [otherMintUrl]: {
          spendable: Amount.from(200),
          reserved: Amount.from(0),
          total: Amount.from(200),
          unit: 'sat',
        },
      });
      await expect(service.getBalanceTotal()).resolves.toEqual({
        spendable: Amount.from(250),
        reserved: Amount.from(100),
        total: Amount.from(350),
        unit: 'sat',
      });
      await expect(service.getBalances()).resolves.toEqual({
        [mintUrl]: Amount.from(150),
        [otherMintUrl]: Amount.from(200),
      });
      await expect(service.getSpendableBalances()).resolves.toEqual({
        [mintUrl]: Amount.from(50),
        [otherMintUrl]: Amount.from(200),
      });
      await expect(service.getBalancesBreakdown()).resolves.toEqual({
        [mintUrl]: { ready: Amount.from(50), reserved: Amount.from(100), total: Amount.from(150) },
        [otherMintUrl]: {
          ready: Amount.from(200),
          reserved: Amount.zero(),
          total: Amount.from(200),
        },
      });
    });

    it('keeps mixed-unit balances separated', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await proofRepo.saveProofs(mintUrl, [
        makeProof({ secret: 'sat-ready', amount: Amount.from(100), unit: 'sat' }),
        makeProof({ secret: 'usd-ready', amount: Amount.from(40), unit: 'usd' }),
        makeProof({ secret: 'usd-reserved', amount: Amount.from(10), unit: 'usd' }),
      ]);
      await proofRepo.saveProofs(otherMintUrl, [
        makeProof({
          secret: 'other-usd',
          amount: Amount.from(7),
          mintUrl: otherMintUrl,
          unit: 'usd',
        }),
      ]);
      await proofRepo.reserveProofs(mintUrl, ['usd-reserved'], operationId);

      await expect(service.getBalancesByMint()).resolves.toEqual({
        [mintUrl]: {
          spendable: Amount.from(100),
          reserved: Amount.zero(),
          total: Amount.from(100),
          unit: 'sat',
        },
      });
      await expect(service.getBalancesByMint({ units: ['usd'] })).resolves.toEqual({
        [mintUrl]: {
          spendable: Amount.from(40),
          reserved: Amount.from(10),
          total: Amount.from(50),
          unit: 'usd',
        },
        [otherMintUrl]: {
          spendable: Amount.from(7),
          reserved: Amount.zero(),
          total: Amount.from(7),
          unit: 'usd',
        },
      });
      await expect(service.getBalancesByMintAndUnit()).resolves.toEqual({
        [mintUrl]: {
          sat: {
            spendable: Amount.from(100),
            reserved: Amount.zero(),
            total: Amount.from(100),
            unit: 'sat',
          },
          usd: {
            spendable: Amount.from(40),
            reserved: Amount.from(10),
            total: Amount.from(50),
            unit: 'usd',
          },
        },
        [otherMintUrl]: {
          usd: {
            spendable: Amount.from(7),
            reserved: Amount.zero(),
            total: Amount.from(7),
            unit: 'usd',
          },
        },
      });
      await expect(service.getBalanceTotal({ units: ['sat', 'usd'] })).rejects.toThrow(
        ProofValidationError,
      );
      await expect(service.getBalanceTotalByUnit()).resolves.toEqual({
        sat: {
          spendable: Amount.from(100),
          reserved: Amount.zero(),
          total: Amount.from(100),
          unit: 'sat',
        },
        usd: {
          spendable: Amount.from(47),
          reserved: Amount.from(10),
          total: Amount.from(57),
          unit: 'usd',
        },
      });
    });

    it('filters trusted balances across canonical and legacy queries', async () => {
      const service = new ProofService(
        counterService,
        proofRepo,
        walletService as any,
        mintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await proofRepo.saveProofs(mintUrl, [
        makeProof({ secret: 'd1', amount: Amount.from(100) }),
        makeProof({ secret: 'd2', amount: Amount.from(50) }),
      ]);
      await proofRepo.saveProofs(otherMintUrl, [
        makeProof({ secret: 'e1', amount: Amount.from(500), mintUrl: otherMintUrl }),
      ]);
      await proofRepo.reserveProofs(mintUrl, ['d1'], operationId);

      await expect(service.getBalancesByMint({ trustedOnly: true })).resolves.toEqual({
        [mintUrl]: {
          spendable: Amount.from(50),
          reserved: Amount.from(100),
          total: Amount.from(150),
          unit: 'sat',
        },
      });
      await expect(service.getBalanceTotal({ trustedOnly: true })).resolves.toEqual({
        spendable: Amount.from(50),
        reserved: Amount.from(100),
        total: Amount.from(150),
        unit: 'sat',
      });
      await expect(service.getTrustedBalances()).resolves.toEqual({
        [mintUrl]: Amount.from(150),
      });
      await expect(service.getTrustedSpendableBalances()).resolves.toEqual({
        [mintUrl]: Amount.from(50),
      });
      await expect(service.getTrustedBalancesBreakdown()).resolves.toEqual({
        [mintUrl]: { ready: Amount.from(50), reserved: Amount.from(100), total: Amount.from(150) },
      });
    });
  });

  describe('recoverProofsFromOutputData', () => {
    let originalToProof: typeof OutputData.prototype.toProof;

    beforeEach(() => {
      originalToProof = OutputData.prototype.toProof;
    });

    afterEach(() => {
      OutputData.prototype.toProof = originalToProof;
    });

    it('unblinds signatures via toProof() rather than copying C_ directly', async () => {
      const B_ = 'mock_blinded_point_B_';
      const serializedOutputData: SerializedOutputData = {
        keep: [],
        send: [
          {
            blindedMessage: { amount: '1', id: keysetId, B_ },
            blindingFactor: 'deadbeef',
            secret: Buffer.from('test-secret').toString('hex'),
          },
        ],
      };

      const unblindedC = 'UNBLINDED_C';
      const blindedC_ = 'BLINDED_C_';

      (OutputData.prototype as any).toProof = mock(() => ({
        id: keysetId,
        amount: Amount.from(1),
        secret: 'test-secret',
        C: unblindedC,
      }));

      const localMintService = {
        async getAllTrustedMints() {
          return [{ mintUrl }];
        },
        async ensureUpdatedMint(_url: string) {
          return {
            mint: {},
            keysets: [{ id: keysetId, unit: 'sat', active: true, keypairs: { '1': 'pubkey-1' } }],
          };
        },
      };

      const localWalletService = {
        async getWalletWithActiveKeysetId() {
          return {
            wallet: {
              mint: {
                async restore(_req: any) {
                  return {
                    outputs: [{ B_, amount: 1, id: keysetId }],
                    signatures: [{ B_, id: keysetId, amount: Amount.from(1), C_: blindedC_ }],
                  };
                },
              },
              async checkProofsStates(_proofs: any[]) {
                return [{ state: 'UNSPENT' }];
              },
            },
          };
        },
        async getWallet() {
          return { selectProofsToSend: (p: any[]) => ({ send: p }) };
        },
      };

      const service = new ProofService(
        counterService,
        proofRepo,
        localWalletService as any,
        localMintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      const recovered = await service.recoverProofsFromOutputData(mintUrl, serializedOutputData, {
        unit: 'sat',
        persistRecoveredProofs: false,
      });

      expect(recovered).toHaveLength(1);
      // C must be the unblinded value produced by toProof(), not the raw blinded signature C_
      expect(recovered[0]?.C).toBe(unblindedC);
      expect(recovered[0]?.C).not.toBe(blindedC_);
    });

    it('rejects restored signatures from a different-unit keyset', async () => {
      const B_ = 'mock_blinded_point_B_';
      const serializedOutputData: SerializedOutputData = {
        keep: [],
        send: [
          {
            blindedMessage: { amount: '1', id: keysetId, B_ },
            blindingFactor: 'deadbeef',
            secret: Buffer.from('test-secret').toString('hex'),
          },
        ],
      };

      const toProof = mock(() => ({
        id: keysetId,
        amount: Amount.from(1),
        secret: 'test-secret',
        C: 'UNBLINDED_C',
      }));
      (OutputData.prototype as any).toProof = toProof;

      const localMintService = {
        async getAllTrustedMints() {
          return [{ mintUrl }];
        },
        async ensureUpdatedMint(_url: string) {
          return {
            mint: {},
            keysets: [{ id: keysetId, unit: 'usd', active: true, keypairs: { '1': 'pubkey-1' } }],
          };
        },
      };

      const localWalletService = {
        async getWalletWithActiveKeysetId() {
          return {
            wallet: {
              mint: {
                async restore(_req: any) {
                  return {
                    outputs: [{ B_, amount: 1, id: keysetId }],
                    signatures: [{ B_, id: keysetId, amount: Amount.from(1), C_: 'BLINDED_C_' }],
                  };
                },
              },
              async checkProofsStates(_proofs: any[]) {
                return [{ state: 'UNSPENT' }];
              },
            },
          };
        },
        async getWallet() {
          return { selectProofsToSend: (p: any[]) => ({ send: p }) };
        },
      };

      const service = new ProofService(
        counterService,
        proofRepo,
        localWalletService as any,
        localMintService as any,
        keyRingService as any,
        seedService,
        undefined,
        bus,
      );

      await expect(
        service.recoverProofsFromOutputData(mintUrl, serializedOutputData, {
          unit: 'sat',
          persistRecoveredProofs: false,
        }),
      ).rejects.toThrow(UnitMismatchError);
      expect(toProof).not.toHaveBeenCalled();
    });
  });
});
