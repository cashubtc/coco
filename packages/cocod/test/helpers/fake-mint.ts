import { createNewMintKeys, serializeMintKeys } from '@cashu/cashu-ts';

/** A minimal NUT-01/02/04/05/06 Mint that issues BOLT11 Mint Quotes which are never paid. */
export interface FakeMint {
  readonly url: string;
  /** Requests received, as `METHOD /path`. */
  readonly requests: string[];
  stop(): Promise<void>;
}

export function startFakeMint(): FakeMint {
  const keyset = createNewMintKeys(4, new Uint8Array(32).fill(9));
  const keys = { id: keyset.keysetId, unit: 'sat', keys: serializeMintKeys(keyset.pubKeys) };
  const quotes = new Map<string, Record<string, unknown>>();
  const requests: string[] = [];
  let nextQuote = 1;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      requests.push(`${request.method} ${pathname}`);
      if (pathname === '/v1/info') {
        return Response.json({
          name: 'Fake Mint',
          pubkey: '02'.padEnd(66, '1'),
          version: 'fake/1.0.0',
          nuts: {
            '4': {
              methods: [{ method: 'bolt11', unit: 'sat', min_amount: 1, max_amount: 100_000 }],
              disabled: false,
            },
            '5': { methods: [{ method: 'bolt11', unit: 'sat' }], disabled: false },
          },
        });
      }
      if (pathname === '/v1/keysets') {
        return Response.json({
          keysets: [{ id: keyset.keysetId, unit: 'sat', active: true, input_fee_ppk: 0 }],
        });
      }
      if (pathname === '/v1/keys' || pathname === `/v1/keys/${keyset.keysetId}`) {
        return Response.json({ keysets: [keys] });
      }
      if (request.method === 'POST' && pathname === '/v1/mint/quote/bolt11') {
        const body = (await request.json()) as { amount: number; unit: string };
        const quote = {
          quote: `quote-${nextQuote++}`,
          request: `lnbc${body.amount}fake`,
          amount: body.amount,
          unit: body.unit,
          state: 'UNPAID',
          expiry: Math.floor(Date.now() / 1000) + 3_600,
        };
        quotes.set(quote.quote, quote);
        return Response.json(quote);
      }
      const quoteMatch = /^\/v1\/mint\/quote\/bolt11\/(.+)$/.exec(pathname);
      if (quoteMatch && quotes.has(quoteMatch[1]!)) {
        return Response.json(quotes.get(quoteMatch[1]!));
      }
      return Response.json({ detail: 'not found', code: 0 }, { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}
