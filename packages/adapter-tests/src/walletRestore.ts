import { Amount, deriveKeysetId, type Proof, type Wallet } from '@cashu/cashu-ts';
import { Manager } from '@cashu/coco-core';
import type { CoreProof, Repositories } from '@cashu/coco-core/adapter';
import type { ServiceMap } from '@cashu/coco-core/plugin';
import type { ContractOptions, ContractRunner } from './index.ts';

const mintUrl = 'https://mint.test';
const keypairs = {
  '1': '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
};
const keysetId = deriveKeysetId(keypairs, { unit: 'sat' });

function proof(secret: string): CoreProof {
  return {
    id: keysetId,
    amount: Amount.from(1),
    secret,
    C: `C-${secret}`,
    mintUrl,
    unit: 'sat',
    state: 'ready',
  };
}

/** Reach the production runner through the plugin service, keeping internal transactions private. */
async function restoreWith(repositories: Repositories) {
  const manager = new Manager(repositories, async () => new Uint8Array(64));
  let service: ServiceMap['walletRestoreService'] | undefined;
  manager.use({
    name: 'wallet-restore-contract',
    required: ['walletRestoreService'],
    onInit: ({ services }) => {
      service = services.walletRestoreService;
    },
  });
  await manager.initPlugins();
  return {
    prepareSend: () => manager.ops.send.prepare({ mintUrl, amount: 1, forceSwap: true }),
    async restore(proofs: Proof[], last: number | null, states = proofs.map(() => 'UNSPENT')) {
      if (!service) throw new Error('Restore contract service was not initialized');
      const wallet = {
        batchRestore: async () => ({ proofs, lastCounterWithSignature: last }),
        checkProofsStates: async () => states.map((state) => ({ state })),
      } as unknown as Wallet;
      await service.restoreKeyset(mintUrl, wallet, keysetId);
    },
    dispose: () => manager.dispose(),
  };
}

export function runWalletRestoreContract(
  options: ContractOptions,
  { describe, it, expect }: ContractRunner,
): void {
  describe('Wallet Restore transaction contract', () => {
    it('skips pending proofs, preserves ownership and repeats without duplicates', async () => {
      const { repositories, dispose } = await options.createRepositories();
      const app = await restoreWith(repositories);
      try {
        const existing = {
          ...proof('owned'),
          usedByOperationId: 'send',
          createdByOperationId: 'mint',
        };
        await repositories.proofRepository.saveProofs(mintUrl, [existing]);
        const observations = [proof('owned'), proof('new'), proof('pending')];
        await app.restore(observations, 0, ['UNSPENT', 'UNSPENT', 'PENDING']);
        await app.restore(observations, 0, ['UNSPENT', 'UNSPENT', 'PENDING']);
        expect(await repositories.proofRepository.getProofBySecret(mintUrl, 'pending')).toBe(null);
        expect(
          (await repositories.proofRepository.getProofBySecret(mintUrl, 'owned'))
            ?.usedByOperationId,
        ).toBe('send');
        expect(
          (await repositories.proofRepository.getProofBySecret(mintUrl, 'owned'))
            ?.createdByOperationId,
        ).toBe('mint');
        expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toHaveLength(1);
        expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(
          1,
        );
        await app.restore([proof('pending')], null);
        expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toHaveLength(2);
        expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(
          1,
        );
      } finally {
        await app.dispose();
        await dispose();
      }
    });

    it('rolls back counter advancement and all imports on a material conflict', async () => {
      const { repositories, dispose } = await options.createRepositories();
      const app = await restoreWith(repositories);
      try {
        await repositories.counterRepository.setCounter(mintUrl, keysetId, 5);
        await repositories.proofRepository.saveProofs(mintUrl, [
          { ...proof('existing'), state: 'spent', createdByOperationId: 'mint' },
        ]);
        let rejected = false;
        try {
          await app.restore([proof('new'), { ...proof('existing'), C: 'conflict' }], 30);
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
        expect(await repositories.proofRepository.getProofBySecret(mintUrl, 'new')).toBe(null);
        expect(
          (await repositories.proofRepository.getProofBySecret(mintUrl, 'existing'))?.state,
        ).toBe('spent');
        expect(
          (await repositories.proofRepository.getProofBySecret(mintUrl, 'existing'))
            ?.createdByOperationId,
        ).toBe('mint');
        expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(
          5,
        );
      } finally {
        await app.dispose();
        await dispose();
      }
    });

    if (options.createSharedRepositories) {
      it('preserves committed output positions when Restore overlaps Send allocation across connections', async () => {
        const { first, second, dispose } = await options.createSharedRepositories!();
        const firstApp = await restoreWith(first);
        const secondApp = await restoreWith(second);
        try {
          const now = Math.floor(Date.now() / 1000);
          await first.mintRepository.addNewMint({
            mintUrl,
            name: 'Restore contract mint',
            trusted: true,
            createdAt: now,
            updatedAt: now,
            mintInfo: {
              name: 'Restore contract mint',
              version: '1.0.0',
              pubkey: keypairs['1'],
              contact: [],
              nuts: {
                '4': { methods: [], disabled: false },
                '5': { methods: [], disabled: false },
              },
            },
          });
          await first.keysetRepository.addKeyset({
            mintUrl,
            id: keysetId,
            unit: 'sat',
            keypairs,
            active: true,
            feePpk: 0,
          });
          const inputs = ['first-input', 'second-input'].map((secret) => ({
            ...proof(secret),
            amount: Amount.from(2),
          }));
          await firstApp.restore(inputs, 39);
          const initial = await firstApp.prepareSend();
          expect((await first.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(42);

          const [, concurrent] = await Promise.all([
            firstApp.restore(inputs, 39),
            secondApp.prepareSend(),
            firstApp.restore(inputs, 19),
          ]);
          expect((await first.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(44);
          const initialStored = await first.sendOperationRepository.getById(initial.id);
          const concurrentStored = await second.sendOperationRepository.getById(concurrent.id);
          const initialPlan =
            initialStored?.state === 'prepared' ? initialStored.outputData : undefined;
          const concurrentPlan =
            concurrentStored?.state === 'prepared' ? concurrentStored.outputData : undefined;
          if (!initialPlan || !concurrentPlan)
            throw new Error('Expected committed Send output plans');
          const outputs = [
            ...initialPlan.keep,
            ...initialPlan.send,
            ...concurrentPlan.keep,
            ...concurrentPlan.send,
          ];
          expect(outputs).toHaveLength(4);
          expect(new Set(outputs.map((output) => output.secret)).size).toBe(4);
          const stored = await first.proofRepository.getProofsBySecrets(
            mintUrl,
            inputs.map(({ secret }) => secret),
          );
          expect(
            stored
              .map(({ usedByOperationId }) => usedByOperationId)
              .sort()
              .join(','),
          ).toBe([initial.id, concurrent.id].sort().join(','));
        } finally {
          await firstApp.dispose();
          await secondApp.dispose();
          await dispose();
        }
      });

      it('reconciles overlapping observations from independent connections', async () => {
        const { first, second, dispose } = await options.createSharedRepositories!();
        const firstApp = await restoreWith(first);
        const secondApp = await restoreWith(second);
        try {
          await first.counterRepository.setCounter(mintUrl, keysetId, 10);
          await Promise.all([
            firstApp.restore([proof('shared')], 39),
            secondApp.restore([proof('shared')], 19),
          ]);
          expect((await first.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(40);
          expect(await second.proofRepository.getAvailableProofs(mintUrl)).toHaveLength(1);
        } finally {
          await firstApp.dispose();
          await secondApp.dispose();
          await dispose();
        }
      });
    }
  });
}
