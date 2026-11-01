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
const gross = feePpk === 0 ? 7 : 8;

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
    { locked: false, chosenAmount: false, http: false, direct: false },
    { locked: false, chosenAmount: false, http: false, direct: true },
    { locked: true, chosenAmount: false, http: false, direct: false },
    { locked: false, chosenAmount: true, http: true, direct: false },
    { locked: true, chosenAmount: true, http: true, direct: false },
  ])(
    `redeems 7 net sats at ${feePpk} ppk: %j`,
    async ({ locked, chosenAmount, http, direct }) => {
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
        chosenAmount ? undefined : Amount.from(7),
        'sat',
        [mintUrl],
        undefined,
        undefined,
        key ? { kind: 'P2PK', data: key.publicKeyHex, tags: [] } : undefined,
      ).toEncodedRequest();
      const request = await payer.paymentRequests.parse(encoded);
      const prepared = await payer.paymentRequests.prepare(request, {
        mintUrl,
        ...(chosenAmount ? { amount: 7 } : {}),
      });
      expect(prepared.request.unit).toBe('sat');
      expect(prepared.sendOperation.amount).toEqual(Amount.from(gross));
      expect(prepared.sendOperation.fee).toEqual(Amount.from(direct || feePpk === 0 ? 0 : 1));
      expect(prepared.sendOperation.needsSwap).toBe(!direct);
      const committedOutputs = prepared.sendOperation.outputData;
      expect(prepared.request.amount).toEqual(Amount.from(7));
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
          sumProofs(delivered!.proofs).greaterThanOrEqual(Amount.from(7).add(receiverFee)),
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
      expect((await receiver.wallet.balances.total()).spendable).toEqual(Amount.from(7));
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
