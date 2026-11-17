import { JSONInt, type P2PKOptions, type Token } from '@cashu/cashu-ts';
import { initializeCoco, normalizeUnit, type Manager } from '@cashu/coco-core';
import type { IntegrationTestOptions, IntegrationTestRunner } from './integration.ts';

/** Public receive behavior against a real mint and the selected storage adapter. */
export function runP2pkReceiveTests(
  options: IntegrationTestOptions,
  runner: IntegrationTestRunner,
  mintAmount: (manager: Manager, mintUrl: string, amount: number, unit: string) => Promise<unknown>,
): void {
  const { describe, it, afterEach, expect } = runner;
  const { mintUrl, createRepositories, logger } = options;
  const unit = normalizeUnit(options.customUnit ?? 'sat');
  const sessions: { coco: Manager; disposeStorage: () => Promise<void> }[] = [];

  async function session() {
    const { repositories, dispose } = await createRepositories();
    const seed = crypto.getRandomValues(new Uint8Array(64));
    let coco: Manager;
    try {
      coco = await initializeCoco({
        repo: repositories,
        seedGetter: async () => seed,
        logger,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
          meltQuoteWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
          meltSettlementProcessor: { disabled: true },
          mintSwapOperationProcessor: { disabled: true },
        },
      });
    } catch (error) {
      await dispose();
      throw error;
    }
    sessions.push({ coco, disposeStorage: dispose });
    await coco.mint.addMint(mintUrl, { trusted: true });
    return coco;
  }

  async function send(sender: Manager, conditions: Omit<P2PKOptions, 'kind'>) {
    const prepared = await sender.ops.send.prepare({
      mintUrl,
      amount: { amount: 8, unit },
      target: { type: 'p2pk', options: { kind: 'P2PK', ...conditions } },
    });
    return (await sender.ops.send.execute(prepared.id)).token;
  }

  async function receive(receiver: Manager, token: Token) {
    const prepared = await receiver.ops.receive.prepare({ token });
    expect(prepared.state).toBe('prepared');
    const request = JSONInt.stringify(prepared.inputProofs);
    const finalized = await receiver.ops.receive.execute(prepared.id);
    expect(finalized.state).toBe('finalized');
    expect(JSONInt.stringify(finalized.inputProofs)).toBe(request);
    expect(
      (await receiver.wallet.balances.total({ units: [unit] })).spendable.equals(
        prepared.amount.subtract(prepared.fee),
      ),
    ).toBe(true);
    expect((await receiver.ops.receive.get(prepared.id))?.state).toBe('finalized');
    const history = await receiver.history.getPaginatedHistory(0, 10);
    const entry = history.find((item) => item.type === 'receive');
    expect(entry).toBeDefined();
    expect(await receiver.history.getOperationIdForHistoryEntry(entry!.id)).toBe(prepared.id);
    return prepared;
  }

  describe('P2PK locktime receive', () => {
    afterEach(async () => {
      for (const { coco, disposeStorage } of sessions.splice(0)) {
        try {
          await coco.dispose();
        } finally {
          await disposeStorage();
        }
      }
    });

    for (const multisig of [false, true]) {
      it(`receives proofs with expired locktime and no refund keys (original multisig: ${multisig})`, async () => {
        const sender = await session();
        const receiver = await session();
        await mintAmount(sender, mintUrl, 64, unit);
        const primary = await sender.keyring.generateKeyPair();
        const cosigner = await sender.keyring.generateKeyPair();
        const token = await send(sender, {
          data: primary.publicKeyHex,
          locktime: Math.floor(Date.now() / 1000) - 60,
          ...(multisig ? { pubkeys: [cosigner.publicKeyHex], requiredSignatures: 2 } : {}),
        });
        expect(await receiver.keyring.getAllKeyPairs()).toHaveLength(0);
        const prepared = await receive(receiver, token);
        expect(prepared.inputProofs.every((proof) => proof.witness === undefined)).toBe(true);
      }, 30_000);
    }

    it('requires every proof to be spendable during preparation', async () => {
      const sender = await session();
      const receiver = await session();
      await mintAmount(sender, mintUrl, 64, unit);
      const primary = await sender.keyring.generateKeyPair(true);
      const expired = await send(sender, {
        data: primary.publicKeyHex,
        locktime: Math.floor(Date.now() / 1000) - 60,
      });
      const active = await send(sender, {
        data: primary.publicKeyHex,
        locktime: Math.floor(Date.now() / 1000) + 3600,
      });
      const token = { ...expired, proofs: [...expired.proofs, ...active.proofs] };
      await expect(receiver.ops.receive.prepare({ token })).rejects.toThrow();
      expect(await receiver.ops.receive.listPrepared()).toHaveLength(0);
      await receiver.keyring.addKeyPair(primary.secretKey);
      const prepared = await receive(receiver, token);
      expect(prepared.inputProofs.slice(0, expired.proofs.length).every((p) => !p.witness)).toBe(
        true,
      );
      expect(prepared.inputProofs.slice(expired.proofs.length).every((p) => !!p.witness)).toBe(
        true,
      );
    }, 30_000);

    it('rejects SIG_ALL proofs with expired locktime during preparation', async () => {
      const sender = await session();
      const receiver = await session();
      await mintAmount(sender, mintUrl, 64, unit);
      const primary = await sender.keyring.generateKeyPair();
      const token = await send(sender, {
        data: primary.publicKeyHex,
        sigFlag: 'SIG_ALL',
        locktime: Math.floor(Date.now() / 1000) - 60,
      });
      await expect(receiver.ops.receive.prepare({ token })).rejects.toThrow();
      expect(await receiver.ops.receive.listPrepared()).toHaveLength(0);
    }, 30_000);

    it('rejects a refund-only receiver before locktime and receipt after locktime without an owned key', async () => {
      const sender = await session();
      const receiver = await session();
      await mintAmount(sender, mintUrl, 64, unit);
      const primary = await sender.keyring.generateKeyPair();
      const refund = await receiver.keyring.generateKeyPair();
      const active = await send(sender, {
        data: primary.publicKeyHex,
        locktime: Math.floor(Date.now() / 1000) + 3600,
        refundKeys: [refund.publicKeyHex],
      });
      await expect(receiver.ops.receive.prepare({ token: active })).rejects.toThrow();
      const expired = await send(sender, {
        data: primary.publicKeyHex,
        locktime: Math.floor(Date.now() / 1000) - 60,
        refundKeys: [refund.publicKeyHex],
      });
      await receiver.keyring.removeKeyPair(refund.publicKeyHex);
      await expect(receiver.ops.receive.prepare({ token: expired })).rejects.toThrow();
      expect(await receiver.ops.receive.listPrepared()).toHaveLength(0);
    }, 30_000);
  });
}
