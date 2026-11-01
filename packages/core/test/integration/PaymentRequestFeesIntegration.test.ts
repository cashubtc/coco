import {
  Amount,
  JSONInt,
  PaymentRequest,
  PaymentRequestTransportType,
  sumProofs,
  type Token,
} from '@cashu/cashu-ts';
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeCoco, type Manager } from '../../Manager.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';

const mintUrl = process.env.MINT_URL ?? 'http://localhost:3338';
const sessions: Manager[] = [];
// The custom-unit harness uses zero fees; require the advertised rate in either configuration.
const feePpk = process.env.CUSTOM_UNIT ? 0 : 100;

async function session() {
  const repo = new MemoryRepositories();
  await repo.init();
  const seed = crypto.getRandomValues(new Uint8Array(64));
  const coco = await initializeCoco({
    repo,
    seedGetter: async () => seed,
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
  sessions.push(coco);
  await coco.mint.addMint(mintUrl, { trusted: true });
  return coco;
}

async function fund(coco: Manager, amount = 64) {
  const quote = await coco.quotes.mint.create({ mintUrl, amount, method: 'bolt11' });
  const operation = await coco.ops.mint.prepare({
    quote: { mintUrl, method: 'bolt11', quoteId: quote.quoteId },
    amount,
  });
  let result = await coco.ops.mint.execute(operation.id);
  for (let attempt = 0; result.state !== 'finalized' && attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await coco.ops.mint.refresh(operation.id);
    if (result.state === 'pending') result = await coco.ops.mint.execute(operation.id);
  }
  expect(result.state).toBe('finalized');
}

afterEach(async () => {
  for (const coco of sessions.splice(0)) await coco.dispose();
});

describe('Payment Request receiver input fees', () => {
  it.each([
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
  ])(
    `redeems the requested net amount at ${feePpk} ppk: %j`,
    async ({ net, locked, chosenAmount, http, direct }) => {
      const gross = net + (feePpk === 0 ? 0 : 1);
      const payer = await session();
      const receiver = await session();
      await fund(payer, direct ? gross : 64);
      const keysets = (await (await fetch(`${mintUrl}/v1/keysets`)).json()) as {
        keysets: { id: string; unit: string; active: boolean; input_fee_ppk: number }[];
      };
      expect(
        keysets.keysets
          .filter((keyset) => keyset.active && keyset.unit === 'sat')
          .map((keyset) => keyset.input_fee_ppk),
      ).toEqual([feePpk]);
      const key = locked ? await receiver.keyring.generateKeyPair() : undefined;
      const target = 'https://receiver.test/payment';
      const encoded = new PaymentRequest(
        http ? [{ type: PaymentRequestTransportType.POST, target }] : [],
        'fee-request',
        chosenAmount ? undefined : Amount.from(net),
        'sat',
        [mintUrl],
        undefined,
        undefined,
        key ? { kind: 'P2PK', data: key.publicKeyHex, tags: [] } : undefined,
      ).toEncodedRequest();
      const request = await payer.paymentRequests.parse(encoded);
      const prepared = await payer.paymentRequests.prepare(request, {
        mintUrl,
        ...(chosenAmount ? { amount: net } : {}),
      });
      expect(prepared.request.unit).toBe('sat');
      expect(prepared.sendOperation.amount).toEqual(Amount.from(gross));
      expect(prepared.sendOperation.fee).toEqual(Amount.from(direct || feePpk === 0 ? 0 : 1));
      expect(prepared.sendOperation.needsSwap).toBe(!direct);
      const committedOutputs = prepared.sendOperation.outputData;
      expect(prepared.request.amount).toEqual(Amount.from(net));
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
        expect(result.operation.outputData).toEqual(committedOutputs);
        expect(sumProofs(delivered!.proofs)).toEqual(Amount.from(gross));
        const rates = new Map(keysets.keysets.map((keyset) => [keyset.id, keyset.input_fee_ppk]));
        const aggregatePpk = delivered!.proofs.reduce((total, proof) => {
          const rate = rates.get(proof.id);
          if (rate === undefined) throw new Error('Outgoing proof keyset is missing fee metadata');
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
      expect((await receiver.wallet.balances.total()).spendable).toEqual(Amount.from(net));
      expect((await payer.wallet.balances.total()).spendable).toEqual(
        Amount.from(direct ? 0 : 64 - gross - (feePpk === 0 ? 0 : 1)),
      );
    },
    30000,
  );

  it.each([false, true])('keeps ordinary Send amounts at face value (swap: %s)', async (swap) => {
    const payer = await session();
    const receiver = await session();
    await fund(payer, swap ? 64 : 7);
    const prepared = await payer.ops.send.prepare({ mintUrl, amount: 7, forceSwap: swap });
    expect(prepared.needsSwap).toBe(swap);
    expect(prepared.amount).toEqual(Amount.from(7));
    expect(prepared.fee).toEqual(Amount.from(swap && feePpk !== 0 ? 1 : 0));
    const { token } = await payer.ops.send.execute(prepared.id);
    expect(sumProofs(token.proofs)).toEqual(Amount.from(7));
    await receiver.wallet.receive(token);
    expect((await receiver.wallet.balances.total()).spendable).toEqual(
      Amount.from(feePpk === 0 ? 7 : 6),
    );
  });

  it.each(['before', 'after'] as const)(
    'recovers and redeems a P2PK payment interrupted %s the mint swap',
    async (interruption) => {
      const payer = await session();
      const receiver = await session();
      await fund(payer);
      const key = await receiver.keyring.generateKeyPair();
      const encoded = new PaymentRequest(
        [],
        'recovery',
        Amount.from(7),
        'sat',
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
        await expect(payer.paymentRequests.execute(prepared)).rejects.toThrow(
          'Payment connection lost',
        );
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
      expect(recovered.outputData).toEqual(prepared.sendOperation.outputData);
      expect(recovered.amount).toEqual(Amount.from(feePpk === 0 ? 7 : 8));
      await receiver.wallet.receive(recovered.token);
      expect((await receiver.wallet.balances.total()).spendable).toEqual(Amount.from(7));
      expect((await payer.wallet.balances.total()).spendable).toEqual(
        Amount.from(feePpk === 0 ? 57 : 55),
      );
    },
    30000,
  );

  it.skipIf(feePpk === 0).each([7, 8])(
    'rejects a nominally funded locked request with %i sats before delivery',
    async (balance) => {
      const payer = await session();
      const receiver = await session();
      await fund(payer, balance);
      const key = await receiver.keyring.generateKeyPair();
      const encoded = new PaymentRequest(
        [],
        'insufficient',
        Amount.from(7),
        'sat',
        [mintUrl],
        undefined,
        undefined,
        { kind: 'P2PK', data: key.publicKeyHex, tags: [] },
      ).toEncodedRequest();
      const request = await payer.paymentRequests.parse(encoded);
      expect(request.payableMints).toContain(mintUrl);
      await expect(payer.paymentRequests.prepare(request, { mintUrl })).rejects.toThrow();
      expect(await payer.ops.send.listPrepared()).toEqual([]);
      expect(await payer.ops.send.listInFlight()).toEqual([]);
      expect((await payer.wallet.balances.total()).spendable).toEqual(Amount.from(balance));
      expect((await receiver.wallet.balances.total()).total).toEqual(Amount.zero());
    },
    30000,
  );
});
