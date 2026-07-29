export type FixtureMeltState = 'UNPAID' | 'PENDING' | 'PAID';
export type FixtureMintState = 'UNPAID' | 'PAID' | 'ISSUED';
export type FixtureFailurePoint =
  | 'melt:before'
  | 'melt:after-commit'
  | 'mint:before'
  | 'mint:after-commit'
  | 'restore:before';

export interface MintSwapFixtureCall {
  path: string;
  method: string;
  body?: unknown;
}

/** Deterministic local protocol boundary used by mint-swap ambiguity/restart tests. */
export class MintSwapHttpFixture {
  meltState: FixtureMeltState = 'UNPAID';
  mintState: FixtureMintState = 'UNPAID';
  meltChange: unknown[] = [];
  issuedSignatures: unknown[] = [];
  restoredSignatures: unknown[] = [];
  readonly calls: MintSwapFixtureCall[] = [];
  private readonly failures = new Map<FixtureFailurePoint, number>();
  private server?: ReturnType<typeof Bun.serve>;

  get url(): string {
    if (!this.server) throw new Error('Mint swap fixture is not running');
    return this.server.url.toString().replace(/\/$/, '');
  }

  failNext(point: FixtureFailurePoint, count = 1): void {
    this.failures.set(point, count);
  }

  start(): void {
    if (this.server) return;
    this.server = Bun.serve({ port: 0, fetch: (request) => this.handle(request) });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'GET' ? undefined : await request.json().catch(() => undefined);
    this.calls.push({ path: url.pathname, method: request.method, body });

    if (url.pathname === '/v1/info') {
      return Response.json({ nuts: { 4: {}, 5: {}, 7: {}, 8: {}, 9: {}, 20: {} } });
    }
    if (url.pathname === '/v1/melt/bolt11' && request.method === 'POST') {
      if (this.consume('melt:before')) return unavailable();
      this.meltState = this.meltState === 'UNPAID' ? 'PENDING' : this.meltState;
      if (this.consume('melt:after-commit')) return unavailable();
      return Response.json(this.meltResponse());
    }
    if (url.pathname.startsWith('/v1/melt/quote/bolt11/')) {
      return Response.json(this.meltResponse());
    }
    if (url.pathname === '/v1/mint/bolt11' && request.method === 'POST') {
      if (this.consume('mint:before')) return unavailable();
      if (this.mintState === 'PAID') this.mintState = 'ISSUED';
      if (this.consume('mint:after-commit')) return unavailable();
      return Response.json({ signatures: this.issuedSignatures });
    }
    if (url.pathname === '/v1/restore' && request.method === 'POST') {
      if (this.consume('restore:before')) return unavailable();
      return Response.json({ outputs: [], signatures: this.restoredSignatures });
    }
    if (url.pathname === '/v1/checkstate' && request.method === 'POST') {
      return Response.json({ states: [] });
    }
    return Response.json({ detail: 'not found' }, { status: 404 });
  }

  private meltResponse() {
    return {
      quote: 'source-quote',
      state: this.meltState,
      payment_preimage: this.meltState === 'PAID' ? 'fixture-preimage' : null,
      change: this.meltState === 'PAID' ? this.meltChange : undefined,
    };
  }

  private consume(point: FixtureFailurePoint): boolean {
    const remaining = this.failures.get(point) ?? 0;
    if (remaining === 0) return false;
    this.failures.set(point, remaining - 1);
    return true;
  }
}

function unavailable(): Response {
  return Response.json({ detail: 'injected unavailable response' }, { status: 503 });
}
