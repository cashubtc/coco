import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { ProofService } from '../../services/ProofService.ts';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository.ts';
import { MemoryCounterRepository } from '../../repositories/memory/MemoryCounterRepository.ts';
import { CounterService } from '../../services/CounterService.ts';
import { SeedService } from '../../services/SeedService.ts';
import { ProofOperationError, ProofValidationError } from '../../models/Error.ts';
import type { CoreProof } from '../../types.ts';
import { OutputData } from '@cashu/cashu-ts';

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
    getWalletWithActiveKeysetId: (mintUrl: string) => Promise<{ keys: { id: string } }>;
    getWallet: (
      mintUrl: string,
    ) => Promise<{ selectProofsToSend: (proofs: any[], amount: number) => { send: any[] } }>;
  };

  // Minimal mint service stub
  let mintService: {
    getAllTrustedMints: () => Promise<{ mintUrl: string }[]>;
  };

  // Minimal keyRingService stub
  let keyRingService: {
    signProof: (proof: any, publicKey: string) => Promise<any>;
  };

  const makeProof = (overrides: Partial<CoreProof>): CoreProof =>
    ({
      amount: 1,
      C: 'C_' as unknown as any,
      id: keysetId,
      secret: Math.random().toString(36).slice(2),
      mintUrl,
      state: 'ready',
      ...overrides,
    } as unknown as CoreProof);

  const makeSeed = () => new Uint8Array(64).fill(7);

  let originalCreateDeterministicData: typeof OutputData.createDeterministicData;

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
          selectProofsToSend(proofs: any[], _amount: number) {
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
    };

    keyRingService = {
      async signProof(proof: any, _publicKey: string) {
        // Simple stub that adds a witness field
        return { ...proof, witness: 'mock-signature' };
      },
    };

    originalCreateDeterministicData = OutputData.createDeterministicData;
  });

  afterEach(() => {
    // Restore OutputData static
    OutputData.createDeterministicData = originalCreateDeterministicData;
  });

  describe('createOutputsAndIncrementCounters', () => {
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
        service.createOutputsAndIncrementCounters('', { keep: 1, send: 1 }),
      ).rejects.toThrow(ProofValidationError);
    });

    it('returns empty arrays for invalid or negative amounts', async () => {
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

      const res1 = await service.createOutputsAndIncrementCounters(mintUrl, {
        keep: -1,
        send: 0,
      });
      expect(res1.keep.length).toBe(0);
      expect(res1.send.length).toBe(0);

      const res2 = await service.createOutputsAndIncrementCounters(mintUrl, {
        keep: Number.NaN as unknown as number,
        send: 5,
      });
      expect(res2.keep.length).toBe(0);
      expect(res2.send.length).toBe(0);
    });

    it('creates deterministic outputs and increments counters accordingly', async () => {
      const calls: Array<{ amount: number; counter: number }> = [];
      OutputData.createDeterministicData = ((
        amount: number,
        _seed: Uint8Array,
        counter: number,
      ) => {
        calls.push({ amount, counter });
        // Return arrays with predictable sizes not necessarily equal to amount
        const size = amount === 3 ? 2 : amount === 7 ? 4 : 0;
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
        keep: 3,
        send: 7,
      });

      expect(calls.length).toBe(2);
      // First call uses current counter (0)
      expect(calls[0]).toEqual({ amount: 3, counter: 0 });
      // Second call uses offset by keep outputs length (2)
      expect(calls[1]).toEqual({ amount: 7, counter: 2 });

      expect(result.keep.length).toBe(2);
      expect(result.send.length).toBe(4);

      const finalCounter = await counterRepo.getCounter(mintUrl, keysetId);
      expect(finalCounter?.counter).toBe(6);
    });
  });

  describe('saveProofs', () => {
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
        makeProof({ secret: 's1', id: 'k1', amount: 5 }),
        makeProof({ secret: 's2', id: 'k1', amount: 10 }),
        makeProof({ secret: 's3', id: 'k2', amount: 15 }),
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
      await proofRepo.saveProofs(mintUrl, [makeProof({ secret: 'dup', id: 'kBad', amount: 1 })]);

      const proofs: CoreProof[] = [
        // This one will collide (same secret under same mint)
        makeProof({ secret: 'dup', id: 'kBad', amount: 2 }),
        // Another independent group should succeed
        makeProof({ secret: 'ok1', id: 'kOk', amount: 3 }),
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

      proofRepo.getInflightProofs = mock(async () => [...mintProofs, ...otherProofs]);

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
      expect(getWalletWithActiveKeysetId).toHaveBeenCalledWith(mintUrl);
      expect(getWalletWithActiveKeysetId).toHaveBeenCalledWith(otherMintUrl);
      expect(checkProofsStates).toHaveBeenCalledTimes(2);
    });

    it('skips checks when no inflight proofs exist', async () => {
      const getInflightProofs = mock(async () => []);
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
        makeProof({ secret: 'a1', id: 'k1', amount: 5 }),
        makeProof({ secret: 'a2', id: 'k1', amount: 10 }),
      ]);

      await expect(service.selectProofsToSend(mintUrl, 100)).rejects.toThrow(ProofValidationError);
    });

    it('delegates to wallet.selectProofsToSend and returns selected proofs', async () => {
      // Override wallet selector to return a specific subset
      walletService = {
        async getWalletWithActiveKeysetId() {
          return { keys: { id: keysetId } };
        },
        async getWallet() {
          return {
            selectProofsToSend(proofs: any[], amount: number) {
              // pick smallest number of proofs that reach amount
              const selected: any[] = [];
              let acc = 0;
              for (const p of proofs) {
                if (acc >= amount) break;
                selected.push(p);
                acc += (p as any).amount ?? 0;
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

      const p1 = makeProof({ secret: 'b1', id: 'k1', amount: 30 });
      const p2 = makeProof({ secret: 'b2', id: 'k1', amount: 50 });
      const p3 = makeProof({ secret: 'b3', id: 'k1', amount: 80 });
      await proofRepo.saveProofs(mintUrl, [p1, p2, p3]);

      const selected = await service.selectProofsToSend(mintUrl, 60);
      // Expect our wallet stub to choose p1 + p2
      expect(selected.map((p) => p.secret)).toEqual(['b1', 'b2']);
    });
  });
});
