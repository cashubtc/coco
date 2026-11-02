import {
  Amount,
  JSONInt,
  PaymentRequest,
  PaymentRequestTransportType,
  sumProofs,
  type Token,
} from '@cashu/cashu-ts';
import { initializeCoco, normalizeUnit, type Manager } from '@cashu/coco-core';
import type { IntegrationTestOptions, IntegrationTestRunner } from './integration.ts';

/** Shared public-API payment behavior, instantiated with each adapter's repository factory. */
export function runPaymentRequestFeeTests(
  options: IntegrationTestOptions,
  runner: IntegrationTestRunner,
  mintAmount: (manager: Manager, mintUrl: string, amount: number, unit: string) => Promise<unknown>,
): void {
  const { describe, it, afterEach, expect } = runner;
  const { mintUrl, createRepositories, logger } = options;
  const unit = normalizeUnit(options.customUnit ?? 'sat');
  const feePpk = options.customUnit ? 0 : 100;
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

  const fund = (coco: Manager, amount = 64) => mintAmount(coco, mintUrl, amount, unit);
  const expectAmount = (actual: Amount | undefined, expected: number) => {
    expect(actual).toBeDefined();
    expect(actual!.equals(Amount.from(expected))).toBe(true);
  };

  describe(`Payment Request receiver input fees (${unit}, ${feePpk} ppk)`, () => {
    afterEach(async () => {
      for (const { coco, disposeStorage } of sessions.splice(0)) {
        try {
          await coco.dispose();
        } finally {
          await disposeStorage();
        }
      }
    });
    for (const scenario of [
      { net: 7, locked: false, chosenAmount: false, http: false, direct: false },
      { net: 7, locked: false, chosenAmount: false, http: false, direct: true },
      { net: 7, locked: true, chosenAmount: false, http: false, direct: false },
      { net: 7, locked: false, chosenAmount: true, http: true, direct: false },
      { net: 7, locked: true, chosenAmount: true, http: true, direct: false },
      ...[1, 3, 8, 15, 16].map((net) => ({
        net,
        locked: false,
        chosenAmount: false,
        http: false,
        direct: false,
      })),
    ]) {
      it(`redeems the requested net amount: ${JSON.stringify(scenario)}`, async () => {
        const { net, locked, chosenAmount, http, direct } = scenario;
        const gross = net + (feePpk === 0 ? 0 : 1);
        const payer = await session();
        const receiver = await session();
        await fund(payer, direct ? gross : 64);
        const keysets = (await (await fetch(`${mintUrl}/v1/keysets`)).json()) as {
          keysets: { id: string; unit: string; active: boolean; input_fee_ppk: number }[];
        };
        expect(
          JSON.stringify(
            keysets.keysets
              .filter((keyset) => keyset.active && keyset.unit === unit)
              .map((keyset) => keyset.input_fee_ppk),
          ),
        ).toBe(JSON.stringify([feePpk]));
        const key = locked ? await receiver.keyring.generateKeyPair() : undefined;
        const target = 'https://receiver.test/payment';
        const encoded = new PaymentRequest(
          http ? [{ type: PaymentRequestTransportType.POST, target }] : [],
          'fee-request',
          chosenAmount ? undefined : Amount.from(net),
          unit,
          [mintUrl],
          undefined,
          undefined,
          key ? { kind: 'P2PK', data: key.publicKeyHex, tags: [] } : undefined,
        ).toEncodedRequest();
        const request = await payer.paymentRequests.parse(encoded);
        const prepared = await payer.paymentRequests.prepare(request, {
          mintUrl,
          ...(chosenAmount ? { amount: { amount: net, unit } } : {}),
        });
        expect(prepared.request.unit).toBe(unit);
        expectAmount(prepared.sendOperation.amount, gross);
        expectAmount(prepared.sendOperation.fee, direct || feePpk === 0 ? 0 : 1);
        expect(prepared.sendOperation.needsSwap).toBe(!direct);
        const committedOutputs = prepared.sendOperation.outputData;
        expectAmount(prepared.request.amount, net);
        let delivered: Token | undefined;
        const originalFetch = globalThis.fetch;
        if (http) {
          globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
            if (args[0] === target) {
              delivered = JSONInt.parse(String(args[1]?.body)) as Token;
              return new Response(null, { status: 204 });
            }
            return originalFetch(...args);
          }, originalFetch);
        }
        try {
          const result = await payer.paymentRequests.execute(prepared);
          expect(result.type).toBe(http ? 'http' : 'inband');
          if (result.type === 'inband') delivered = result.token;
          expect(JSONInt.stringify(result.operation.outputData)).toBe(
            JSONInt.stringify(committedOutputs),
          );
          expectAmount(sumProofs(delivered!.proofs), gross);
          const rates = new Map(keysets.keysets.map((keyset) => [keyset.id, keyset.input_fee_ppk]));
          const aggregatePpk = delivered!.proofs.reduce((total, proof) => {
            const rate = rates.get(proof.id);
            if (rate === undefined)
              throw new Error('Outgoing proof keyset is missing fee metadata');
            return total + BigInt(rate);
          }, 0n);
          const receiverFee = Amount.from((aggregatePpk + 999n) / 1000n);
          expect(
            sumProofs(delivered!.proofs).greaterThanOrEqual(Amount.from(net).add(receiverFee)),
          ).toBe(true);
          if (key) {
            for (const proof of delivered!.proofs) {
              const [kind, condition] = JSON.parse(proof.secret);
              expect(kind).toBe('P2PK');
              expect(condition.data).toBe(key.publicKeyHex);
            }
          }
          await receiver.wallet.receive(delivered!);
        } finally {
          globalThis.fetch = originalFetch;
        }
        expectAmount((await receiver.wallet.balances.total({ units: [unit] })).spendable, net);
        expectAmount(
          (await payer.wallet.balances.total({ units: [unit] })).spendable,
          direct ? 0 : 64 - gross - (feePpk === 0 ? 0 : 1),
        );
      }, 30000);
    }
    for (const swap of [false, true]) {
      it(`keeps ordinary Send amounts at face value (swap: ${swap})`, async () => {
        const payer = await session();
        const receiver = await session();
        await fund(payer, swap ? 64 : 7);
        const prepared = await payer.ops.send.prepare({
          mintUrl,
          amount: { amount: 7, unit },
          forceSwap: swap,
        });
        expect(prepared.needsSwap).toBe(swap);
        expectAmount(prepared.amount, 7);
        expectAmount(prepared.fee, swap && feePpk !== 0 ? 1 : 0);
        const { token } = await payer.ops.send.execute(prepared.id);
        expectAmount(sumProofs(token.proofs), 7);
        await receiver.wallet.receive(token);
        expectAmount(
          (await receiver.wallet.balances.total({ units: [unit] })).spendable,
          feePpk === 0 ? 7 : 6,
        );
      });
    }
    for (const interruption of ['before', 'after'] as const) {
      it(`recovers and redeems a P2PK payment interrupted ${interruption} the mint swap`, async () => {
        const payer = await session();
        const receiver = await session();
        await fund(payer);
        const key = await receiver.keyring.generateKeyPair();
        const encoded = new PaymentRequest(
          [],
          'recovery',
          Amount.from(7),
          unit,
          [mintUrl],
          undefined,
          undefined,
          { kind: 'P2PK', data: key.publicKeyHex, tags: [] },
        ).toEncodedRequest();
        const prepared = await payer.paymentRequests.prepare(
          await payer.paymentRequests.parse(encoded),
          { mintUrl },
        );
        const originalFetch = globalThis.fetch;
        let interrupted = false;
        globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
          if (args[0] === `${mintUrl}/v1/swap`) {
            interrupted = true;
            if (interruption === 'after') {
              // Let the mint commit, then lose its real response before Coco can persist it.
              const response = await originalFetch(...args);
              expect(response.ok).toBe(true);
              await response.arrayBuffer();
            }
            throw new Error('Payment connection lost');
          }
          return originalFetch(...args);
        }, originalFetch);
        try {
          await expect(payer.paymentRequests.execute(prepared)).rejects.toThrow();
        } finally {
          globalThis.fetch = originalFetch;
        }
        expect(interrupted).toBe(true);
        expect((await payer.ops.send.get(prepared.sendOperation.id))?.state).toBe('executing');
        await payer.ops.send.recovery.run();
        const recovered = await payer.ops.send.get(prepared.sendOperation.id);
        expect(recovered?.state).toBe('pending');
        if (recovered?.state !== 'pending' || !recovered.token)
          throw new Error('Payment recovery did not produce a token');
        expect(JSONInt.stringify(recovered.outputData)).toBe(
          JSONInt.stringify(prepared.sendOperation.outputData),
        );
        expectAmount(recovered.amount, feePpk === 0 ? 7 : 8);
        await receiver.wallet.receive(recovered.token);
        expectAmount((await receiver.wallet.balances.total({ units: [unit] })).spendable, 7);
        expectAmount(
          (await payer.wallet.balances.total({ units: [unit] })).spendable,
          feePpk === 0 ? 57 : 55,
        );
      }, 30000);
    }
    if (feePpk !== 0)
      for (const balance of [7, 8]) {
        it(`rejects a nominally funded locked request with ${balance} ${unit} before delivery`, async () => {
          const payer = await session();
          const receiver = await session();
          await fund(payer, balance);
          const key = await receiver.keyring.generateKeyPair();
          const encoded = new PaymentRequest(
            [],
            'insufficient',
            Amount.from(7),
            unit,
            [mintUrl],
            undefined,
            undefined,
            { kind: 'P2PK', data: key.publicKeyHex, tags: [] },
          ).toEncodedRequest();
          const request = await payer.paymentRequests.parse(encoded);
          expect(request.payableMints).toContain(mintUrl);
          await expect(payer.paymentRequests.prepare(request, { mintUrl })).rejects.toThrow();
          expect(await payer.ops.send.listPrepared()).toHaveLength(0);
          expect(await payer.ops.send.listInFlight()).toHaveLength(0);
          expectAmount((await payer.wallet.balances.total({ units: [unit] })).spendable, balance);
          expectAmount((await receiver.wallet.balances.total({ units: [unit] })).total, 0);
        }, 30000);
      }
  });
}
