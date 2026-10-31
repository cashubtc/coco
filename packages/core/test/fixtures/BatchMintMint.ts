import {
  Amount,
  createBlindSignature,
  createNewMintKeys,
  hashToCurve,
  pointFromHex,
  serializeMintKeys,
  verifyMintQuoteSignature,
} from '@cashu/cashu-ts';
import { bytesToHex } from '@noble/curves/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

type Method = 'bolt11' | 'bolt12' | 'onchain';
type WireOutput = { id: string; amount: number; B_: string };

export interface FakeMintQuote {
  quote: string;
  method: Method;
  unit: string;
  request: string;
  /** Fixed amount for BOLT11 (and optionally BOLT12); undefined for reusable amountless quotes. */
  amount?: number;
  amountPaid: number;
  amountIssued: number;
  pubkey?: string;
  expiry: number;
}

export interface BatchMintRequestBody {
  quotes: string[];
  quote_amounts: number[];
  outputs: WireOutput[];
  signatures?: Array<string | null>;
}

/**
 * How the fake mint answers the next NUT-29 batch mint request:
 * - `issue`: validate, issue and return signatures;
 * - `issue-then-drop`: issue, then fail the transport before the response arrives;
 * - `network`: fail the transport without reaching the mint;
 * - `server`: HTTP 500 without processing;
 * - `short`: issue but return one signature too few (invalid success);
 * - `unsupported`: HTTP 404 without a NUT code, as from a mint without the endpoint;
 * - `unparseable` / `wrong-shape`: HTTP 200 with a non-JSON body / without `signatures`;
 * - `unauthorized` / `rate-limited`: HTTP 401 / 429 without processing;
 * - `{ code }`: reject with a NUT error code without issuing.
 */
export type BatchMintBehavior =
  | 'issue'
  | 'issue-then-drop'
  | 'network'
  | 'server'
  | 'short'
  | 'unsupported'
  | 'unparseable'
  | 'wrong-shape'
  | 'unauthorized'
  | 'rate-limited'
  | { code: number; detail?: string };

export type RestoreBehavior = 'all' | 'none' | 'partial' | 'unavailable';

const keysetSeed = (unit: string) => new Uint8Array(32).fill(unit === 'sat' ? 7 : 9);

/**
 * In-process HTTP mint for Batch Mint tests. It implements the NUT-04/09/20/29 endpoints Coco uses
 * with real blind signatures and NUT-20 signature verification, and records every request.
 */
export class FakeBatchMint {
  readonly keysets = ['sat', 'usd'].map((unit) => {
    const keys = createNewMintKeys(10, keysetSeed(unit), { unit });
    return { unit, keys };
  });
  readonly quotes = new Map<string, FakeMintQuote>();
  readonly signed = new Map<string, { id: string; amount: number; C_: string }>();
  readonly requests: Array<{ path: string; body?: unknown }> = [];
  readonly batchRequests: BatchMintRequestBody[] = [];
  readonly batchBehaviors: BatchMintBehavior[] = [];
  restoreBehavior: RestoreBehavior = 'all';
  quoteCheckBehavior: 'ok' | 'unavailable' = 'ok';
  nut29: { max_batch_size?: number; methods?: Method[] } | null = {
    max_batch_size: 3,
    methods: ['bolt11', 'bolt12', 'onchain'],
  };
  /** Called after a batch request is issued but before its response is returned. */
  onBatchIssued?: () => Promise<void> | void;

  private originalFetch?: typeof fetch;

  constructor(readonly mintUrl = 'https://batch-mint.test') {}

  install(): void {
    this.originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      this.handle(String(input), init)) as typeof fetch;
  }

  uninstall(): void {
    if (this.originalFetch) globalThis.fetch = this.originalFetch;
  }

  keysetId(unit = 'sat'): string {
    return this.keysets.find((keyset) => keyset.unit === unit)!.keys.keysetId;
  }

  addQuote(
    quote: Omit<FakeMintQuote, 'request' | 'expiry' | 'amountIssued'> & {
      amountIssued?: number;
    },
  ): FakeMintQuote {
    const stored: FakeMintQuote = {
      amountIssued: 0,
      ...quote,
      request: `${quote.method}-request-${quote.quote}`,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    };
    this.quotes.set(stored.quote, stored);
    return stored;
  }

  /** Wire quote response, as the mint returns it from its quote endpoints. */
  quoteResponse(quoteId: string): Record<string, unknown> {
    const quote = this.quotes.get(quoteId);
    if (!quote) throw new Error(`unknown quote ${quoteId}`);
    const base = {
      quote: quote.quote,
      method: quote.method,
      request: quote.request,
      unit: quote.unit,
      expiry: quote.expiry,
      amount_paid: quote.amountPaid,
      amount_issued: quote.amountIssued,
      updated_at: null,
    };
    if (quote.method === 'bolt11') {
      return {
        ...base,
        amount: quote.amount,
        state: quote.amountPaid === 0 ? 'UNPAID' : quote.amountIssued > 0 ? 'ISSUED' : 'PAID',
        ...(quote.pubkey ? { pubkey: quote.pubkey } : {}),
      };
    }
    return {
      ...base,
      pubkey: quote.pubkey,
      ...(quote.method === 'bolt12' ? { amount: quote.amount ?? null } : {}),
    };
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ path, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    const error = (code: number, detail: string) => json({ code, detail }, 400);

    if (path === '/v1/info') return json(this.info());
    if (path === '/v1/keysets')
      return json({
        keysets: this.keysets.map(({ unit, keys }) => ({
          id: keys.keysetId,
          unit,
          active: true,
          input_fee_ppk: 0,
        })),
      });
    const keysMatch = path.match(/^\/v1\/keys\/(.+)$/);
    if (keysMatch) {
      const keyset = this.keysets.find(({ keys }) => keys.keysetId === keysMatch[1]);
      return json({
        keysets: keyset
          ? [
              {
                id: keyset.keys.keysetId,
                unit: keyset.unit,
                keys: serializeMintKeys(keyset.keys.pubKeys),
              },
            ]
          : [],
      });
    }
    const checkMatch = path.match(/^\/v1\/mint\/quote\/(\w+)\/check$/);
    if (checkMatch) {
      if (this.quoteCheckBehavior === 'unavailable') return json({ error: 'unavailable' }, 503);
      return json((body.quotes as string[]).map((quoteId) => this.quoteResponse(quoteId)));
    }
    const quoteMatch = path.match(/^\/v1\/mint\/quote\/(\w+)\/(.+)$/);
    if (quoteMatch) {
      if (this.quoteCheckBehavior === 'unavailable') return json({ error: 'unavailable' }, 503);
      return json(this.quoteResponse(quoteMatch[2]!));
    }
    const batchMatch = path.match(/^\/v1\/mint\/(\w+)\/batch$/);
    if (batchMatch) return this.batchMint(batchMatch[1] as Method, body, json, error);
    const mintMatch = path.match(/^\/v1\/mint\/(\w+)$/);
    if (mintMatch) {
      const result = this.issue(mintMatch[1] as Method, {
        quotes: [body.quote],
        // Reusable quotes mint the outputs' total, as NUT-04 requests carry no amount for them.
        quote_amounts: [
          Number(
            body.amount ??
              this.quotes.get(body.quote)?.amount ??
              (body.outputs as WireOutput[]).reduce((sum, o) => sum + Number(o.amount), 0),
          ),
        ],
        outputs: body.outputs,
        signatures: [body.signature ?? null],
      });
      return 'code' in result ? error(result.code, result.detail) : json(result);
    }
    if (path === '/v1/restore') {
      if (this.restoreBehavior === 'unavailable') return json({ error: 'unavailable' }, 503);
      let outputs = (body.outputs as WireOutput[]).filter((output) => this.signed.has(output.B_));
      if (this.restoreBehavior === 'none') outputs = [];
      if (this.restoreBehavior === 'partial') outputs = outputs.slice(0, 1);
      return json({ outputs, signatures: outputs.map((output) => this.signed.get(output.B_)) });
    }
    if (path === '/v1/checkstate') {
      return json({
        states: (body.Ys as string[]).map((Y) => ({ Y, state: 'UNSPENT', witness: null })),
      });
    }
    return json({ error: `unhandled ${path}` }, 404);
  }

  private async batchMint(
    method: Method,
    body: BatchMintRequestBody,
    json: (value: unknown, status?: number) => Response,
    error: (code: number, detail: string) => Response,
  ): Promise<Response> {
    this.batchRequests.push(structuredClone(body));
    const behavior = this.batchBehaviors.shift() ?? 'issue';
    if (behavior === 'network') throw new TypeError('fetch failed');
    if (behavior === 'server') return json({ error: 'internal error' }, 500);
    if (behavior === 'unsupported') return json({ detail: 'Not Found' }, 404);
    if (behavior === 'unparseable') return new Response('<html>ok</html>', { status: 200 });
    if (behavior === 'wrong-shape') return json({ promises: [] });
    if (behavior === 'unauthorized') return json({ error: 'unauthorized' }, 401);
    if (behavior === 'rate-limited') return json({ error: 'slow down' }, 429);
    if (typeof behavior === 'object') return error(behavior.code, behavior.detail ?? 'rejected');
    if (new Set(body.quotes).size !== body.quotes.length) return error(11016, 'duplicate quote');
    if (this.nut29?.max_batch_size && body.quotes.length > this.nut29.max_batch_size)
      return error(11017, 'batch too large');
    const result = this.issue(method, body);
    if ('code' in result) return error(result.code, result.detail);
    await this.onBatchIssued?.();
    if (behavior === 'issue-then-drop') throw new TypeError('connection reset');
    if (behavior === 'short') result.signatures.pop();
    return json(result);
  }

  /** Validate the complete request first, then issue atomically. */
  private issue(
    method: Method,
    body: BatchMintRequestBody,
  ):
    | { signatures: Array<{ id: string; amount: number; C_: string }> }
    | {
        code: number;
        detail: string;
      } {
    const amounts = body.quote_amounts.map(Number);
    for (const [index, quoteId] of body.quotes.entries()) {
      const quote = this.quotes.get(quoteId);
      if (!quote || quote.method !== method) return { code: 20000, detail: 'unknown quote' };
      const amount = amounts[index]!;
      if (quote.pubkey) {
        const signature = body.signatures?.[index];
        const outputs = body.outputs.map((output) => ({
          ...output,
          amount: Amount.from(output.amount),
        }));
        if (!signature || !verifyMintQuoteSignature(quote.pubkey, quoteId, outputs, signature))
          return { code: 20008, detail: 'invalid signature' };
      }
      if (quote.method === 'bolt11') {
        if (quote.amountIssued > 0) return { code: 20002, detail: 'already issued' };
        if (quote.amountPaid < quote.amount!) return { code: 20001, detail: 'not paid' };
        if (amount !== quote.amount) return { code: 11012, detail: 'amount mismatch' };
      } else if (quote.amountPaid - quote.amountIssued < amount) {
        return { code: 20001, detail: 'not paid' };
      }
    }
    const total = (body.outputs as WireOutput[]).reduce((sum, o) => sum + Number(o.amount), 0);
    if (total !== amounts.reduce((sum, amount) => sum + amount, 0))
      return { code: 11002, detail: 'unbalanced' };
    if (body.outputs.some((output) => this.signed.has(output.B_)))
      return { code: 10002, detail: 'outputs already signed' };
    for (const [index, quoteId] of body.quotes.entries())
      this.quotes.get(quoteId)!.amountIssued += amounts[index]!;
    const signatures = body.outputs.map((output) => {
      const keyset = this.keysets.find(({ keys }) => keys.keysetId === output.id)!;
      const signature = {
        id: output.id,
        amount: Number(output.amount),
        C_: createBlindSignature(
          pointFromHex(output.B_),
          keyset.keys.privKeys[String(output.amount)]!,
          output.id,
        ).C_.toHex(true),
      };
      this.signed.set(output.B_, signature);
      return signature;
    });
    return { signatures };
  }

  private info() {
    const methods = (['bolt11', 'bolt12', 'onchain'] as const).flatMap((method) =>
      ['sat', 'usd'].map((unit) => ({
        method,
        unit,
        min_amount: 1,
        max_amount: 100000,
      })),
    );
    return {
      name: 'Fake Batch Mint',
      pubkey: '02'.padEnd(66, 'a'),
      version: 'fake/1.0.0',
      contact: [],
      nuts: {
        '4': { methods, disabled: false },
        '5': { methods: [], disabled: false },
        '7': { supported: true },
        '9': { supported: true },
        '20': { supported: true },
        ...(this.nut29 ? { '29': this.nut29 } : {}),
      },
    };
  }
}

/** A deterministic NUT-20 quote key the Wallet owns or does not own. */
export function quoteKey(fill: number): { secretKey: Uint8Array; publicKeyHex: string } {
  const secretKey = new Uint8Array(32).fill(fill);
  return { secretKey, publicKeyHex: bytesToHex(secp256k1.getPublicKey(secretKey, true)) };
}

/** Y values the mint reports for proof state checks. */
export function proofY(secret: string): string {
  return hashToCurve(new TextEncoder().encode(secret)).toHex(true);
}
