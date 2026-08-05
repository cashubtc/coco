import { Amount, initializeCoco, type Manager, type MintOperation } from '@cashu/coco-core';
import { SqliteRepositories } from '@cashu/coco-sqlite-bun';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

type LifecyclePhase =
  | 'created'
  | 'prepared'
  | 'submitted'
  | 'ambiguous'
  | 'reconciling'
  | 'succeeded'
  | 'failed_definitive'
  | 'recovery_blocked';

interface MintLifecycleInput {
  readonly operationId: string;
  readonly kind: 'mint';
  readonly mint: string;
  readonly unit: string;
  readonly amount: number;
  readonly method: 'bolt11';
}

interface LifecycleOperationView {
  readonly operationId: string;
  readonly kind: 'mint';
  readonly mint: string;
  readonly unit: string;
  readonly intentHash: string;
  readonly phase: LifecyclePhase;
  readonly evidenceCode?: string;
  readonly amount: number;
  readonly requestHash: string;
  readonly quoteHash: string;
  readonly outputPlanHash: string;
}

interface StoredOperationRow {
  readonly operation_id: string;
  readonly input_json: string;
  readonly coco_operation_id: string;
  readonly intent_hash: string;
  readonly phase: LifecyclePhase;
  readonly evidence_code: string | null;
  readonly request_hash: string;
  readonly quote_hash: string;
  readonly output_plan_hash: string;
}

export interface CocoLifecycleAdapterOptions {
  readonly controlToken: string;
  readonly databasePath: string;
  readonly host?: string;
  readonly implementationVersion?: string;
  readonly mintId: string;
  readonly mintImplementation?: string;
  readonly mintVersion?: string;
  readonly mintUrl: string;
  readonly port?: number;
  readonly unit: string;
}

export interface RunningCocoLifecycleAdapter {
  readonly url: string;
  stop(): Promise<void>;
}

class LifecycleHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class CocoLifecycleAdapter {
  readonly #options: CocoLifecycleAdapterOptions;
  #database: Database | undefined;
  #manager: Manager | undefined;

  constructor(options: CocoLifecycleAdapterOptions) {
    if (options.controlToken.length === 0 || /[\r\n]/u.test(options.controlToken)) {
      throw new Error('Fault Lab adapter control token is invalid');
    }
    if (options.databasePath !== ':memory:' && !options.databasePath.endsWith('.sqlite')) {
      throw new Error('Fault Lab adapter database path must end in .sqlite');
    }
    if (!isCanonicalMintUrl(options.mintUrl)) {
      throw new Error('Fault Lab adapter mint URL must be canonical');
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,15}$/u.test(options.unit)) {
      throw new Error('Fault Lab adapter unit is invalid');
    }
    this.#options = options;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      this.#authorize(request);
      return await this.#route(request);
    } catch (error) {
      if (error instanceof LifecycleHttpError) {
        return json({ code: error.code, message: error.message }, error.status);
      }
      console.error('Coco Fault Lab adapter request failed', error);
      return json({ code: 'INTERNAL_ERROR', message: 'Internal server error' }, 500);
    }
  }

  async stop(): Promise<void> {
    await this.#closeSession();
  }

  #authorize(request: Request): void {
    if (request.headers.get('authorization') !== `Bearer ${this.#options.controlToken}`) {
      throw new LifecycleHttpError(
        401,
        'UNAUTHORIZED',
        'A valid adapter control token is required',
      );
    }
  }

  async #route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET' && path === '/v1/lifecycle/capabilities') {
      return json(this.#capabilities());
    }
    if (request.method === 'POST' && path === '/v1/lifecycle/reset') {
      const body = await requestJson(request);
      if (!isRecord(body) || typeof body.seed !== 'string' || body.seed.length === 0) {
        throw new LifecycleHttpError(422, 'SCHEMA_VALIDATION', 'A non-empty seed is required');
      }
      await this.#reset(body.seed);
      return json({ ok: true });
    }
    if (request.method === 'POST' && path === '/v1/lifecycle/operations') {
      return json(await this.#start(parseMintInput(await requestJson(request))));
    }

    const operationRoute = path.match(
      /^\/v1\/lifecycle\/operations\/([A-Za-z0-9_-]{22})(\/resume)?$/u,
    );
    if (operationRoute !== null) {
      const operationId = operationRoute[1]!;
      if (request.method === 'POST' && operationRoute[2] === '/resume') {
        return json(await this.#resume(operationId));
      }
      if (request.method === 'GET' && operationRoute[2] === undefined) {
        return json(await this.#operation(operationId));
      }
    }

    if (request.method === 'GET' && path === '/v1/lifecycle/wallet') {
      return json(await this.#wallet());
    }
    if (request.method === 'GET' && path === '/v1/lifecycle/evidence') {
      return json([]);
    }

    throw new LifecycleHttpError(404, 'NOT_FOUND', 'Lifecycle route was not found');
  }

  #capabilities() {
    const version = this.#options.implementationVersion ?? 'workspace';
    return {
      schemaVersion: 1,
      implementation: {
        id: 'coco',
        version,
        language: 'typescript',
        runtime: `bun-${Bun.version}`,
        sourceDigest: `sha256:${digest('cashu-fault-lab/coco/source/v1', version)}`,
        buildDigest: `sha256:${digest('cashu-fault-lab/coco/adapter/v1', 'mint')}`,
      },
      operations: ['mint'],
      nuts: [4, 9, 13],
      durability: 'process',
      recovery: ['quote_state', 'nut09_restore'],
      mints: [
        {
          id: this.#options.mintId,
          implementation: this.#options.mintImplementation ?? 'mintd',
          ...(this.#options.mintVersion === undefined
            ? {}
            : { version: this.#options.mintVersion }),
        },
      ],
    } as const;
  }

  async #reset(seed: string): Promise<void> {
    await this.#closeSession();
    await resetDatabaseFiles(this.#options.databasePath);

    if (this.#options.databasePath !== ':memory:') {
      await mkdir(dirname(this.#options.databasePath), { recursive: true });
    }
    const database = new Database(this.#options.databasePath, { create: true, strict: true });
    database.exec('PRAGMA journal_mode = WAL;');
    const repositories = new SqliteRepositories({ database });
    await repositories.init();
    database.exec(`
      CREATE TABLE IF NOT EXISTS coco_fault_lab_operations (
        operation_id TEXT PRIMARY KEY,
        input_json TEXT NOT NULL,
        coco_operation_id TEXT NOT NULL UNIQUE,
        intent_hash TEXT NOT NULL,
        phase TEXT NOT NULL,
        evidence_code TEXT,
        request_hash TEXT NOT NULL,
        quote_hash TEXT NOT NULL,
        output_plan_hash TEXT NOT NULL
      );
    `);

    try {
      this.#manager = await initializeCoco({
        repo: repositories,
        seedGetter: async () =>
          createHash('sha512').update('cashu-fault-lab/coco/seed/v1\0').update(seed).digest(),
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
          meltQuoteWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
          meltSettlementProcessor: { disabled: true },
        },
      });
      this.#database = database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async #start(input: MintLifecycleInput): Promise<LifecycleOperationView> {
    const manager = this.#requiredManager();
    if (input.mint !== this.#options.mintUrl || input.unit !== this.#options.unit) {
      throw new LifecycleHttpError(
        422,
        'LIFECYCLE_WALLET_IDENTITY_MISMATCH',
        'Lifecycle operation does not match the configured wallet',
      );
    }
    const intentHash = digest('cashu-fault-lab/coco/intent/v1', canonicalJson(input));
    const existing = this.#loadOperation(input.operationId);
    if (existing !== undefined) {
      if (existing.intent_hash !== intentHash) {
        throw new LifecycleHttpError(
          409,
          'LIFECYCLE_OPERATION_ID_CONFLICT',
          'Lifecycle operation identity conflicts',
        );
      }
      return rowToView(existing);
    }

    await manager.mint.addMint(input.mint, { trusted: true });
    const quote = await manager.quotes.mint.create({
      mintUrl: input.mint,
      amount: Amount.from(input.amount),
      method: 'bolt11',
      unit: input.unit,
    });
    await this.#waitForMintQuotePayment(quote.mintUrl, quote.quoteId, input.amount);
    const operation = await manager.ops.mint.prepare({
      quote: { mintUrl: quote.mintUrl, method: 'bolt11', quoteId: quote.quoteId },
      amount: Amount.from(input.amount),
    });
    const requestHash = digest(
      'cashu-fault-lab/coco/mint-request/v1',
      canonicalJson({ outputData: operation.outputData, quoteId: operation.quoteId }),
    );
    const outputPlanHash = digest(
      'cashu-fault-lab/coco/output-plan/v1',
      canonicalJson(operation.outputData),
    );
    const quoteHash = digest('cashu-fault-lab/coco/quote/v1', operation.quoteId);
    const row: StoredOperationRow = {
      operation_id: input.operationId,
      input_json: JSON.stringify(input),
      coco_operation_id: operation.id,
      intent_hash: intentHash,
      phase: 'prepared',
      evidence_code: null,
      request_hash: requestHash,
      quote_hash: quoteHash,
      output_plan_hash: outputPlanHash,
    };
    this.#insertOperation(row);

    return this.#execute(row, 'submitted', 'ambiguous');
  }

  async #resume(operationId: string): Promise<LifecycleOperationView> {
    const row = this.#requiredOperation(operationId);
    if (isTerminalPhase(row.phase)) return rowToView(row);
    return this.#execute(row, 'reconciling', 'reconciling');
  }

  async #execute(
    row: StoredOperationRow,
    activePhase: 'submitted' | 'reconciling',
    fallbackPhase: 'ambiguous' | 'reconciling',
  ): Promise<LifecycleOperationView> {
    const manager = this.#requiredManager();
    this.#updatePhase(row.operation_id, activePhase);
    try {
      const operation = await manager.ops.mint.execute(row.coco_operation_id);
      return this.#recordCocoOutcome(row.operation_id, operation, fallbackPhase);
    } catch (error) {
      const operation = await manager.ops.mint.get(row.coco_operation_id);
      console.warn('Coco Fault Lab mint execution requires recovery', {
        operationId: row.operation_id,
        state: operation?.state ?? 'missing',
        error: error instanceof Error ? error.message : String(error),
      });
      return this.#recordCocoOutcome(row.operation_id, operation, fallbackPhase);
    }
  }

  async #waitForMintQuotePayment(mintUrl: string, quoteId: string, amount: number): Promise<void> {
    const required = Amount.from(amount);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const quote = await this.#requiredManager().quotes.mint.refresh({ mintUrl, quoteId });
      if (quote.amountPaid.greaterThanOrEqual(required)) return;
      await Bun.sleep(250);
    }
    throw new Error(`Mint quote ${quoteId} was not paid by the test fixture`);
  }

  #recordCocoOutcome(
    operationId: string,
    operation: MintOperation | null,
    fallbackPhase: 'ambiguous' | 'reconciling',
  ): LifecycleOperationView {
    if (operation?.state === 'finalized') {
      this.#updatePhase(operationId, 'succeeded');
    } else if (operation?.state === 'failed') {
      this.#updatePhase(operationId, 'failed_definitive', 'coco_mint_failed');
    } else {
      this.#updatePhase(operationId, fallbackPhase);
    }
    return rowToView(this.#requiredOperation(operationId));
  }

  async #operation(operationId: string): Promise<LifecycleOperationView> {
    return rowToView(this.#requiredOperation(operationId));
  }

  async #wallet() {
    const manager = this.#requiredManager();
    const balances = await manager.wallet.balances.byMintAndUnit({
      mintUrls: [this.#options.mintUrl],
      units: [this.#options.unit],
    });
    const balance = balances[this.#options.mintUrl]?.[this.#options.unit];
    return {
      walletId: 'coco',
      mint: this.#options.mintUrl,
      unit: this.#options.unit,
      balances: {
        available: balance?.spendable.toNumber() ?? 0,
        reserved: balance?.reserved.toNumber() ?? 0,
        recoverable: 0,
      },
      proofs: [],
    } as const;
  }

  #requiredManager(): Manager {
    if (this.#manager === undefined) {
      throw new LifecycleHttpError(409, 'RESET_REQUIRED', 'Reset the lifecycle adapter first');
    }
    return this.#manager;
  }

  #requiredDatabase(): Database {
    if (this.#database === undefined) {
      throw new LifecycleHttpError(409, 'RESET_REQUIRED', 'Reset the lifecycle adapter first');
    }
    return this.#database;
  }

  #loadOperation(operationId: string): StoredOperationRow | undefined {
    const value = this.#requiredDatabase()
      .query('SELECT * FROM coco_fault_lab_operations WHERE operation_id = ?')
      .get(operationId);
    return value === null ? undefined : (value as StoredOperationRow);
  }

  #requiredOperation(operationId: string): StoredOperationRow {
    const operation = this.#loadOperation(operationId);
    if (operation === undefined) {
      throw new LifecycleHttpError(
        404,
        'LIFECYCLE_OPERATION_NOT_FOUND',
        'Lifecycle operation was not found',
      );
    }
    return operation;
  }

  #insertOperation(row: StoredOperationRow): void {
    this.#requiredDatabase()
      .query(
        `INSERT INTO coco_fault_lab_operations
           (operation_id, input_json, coco_operation_id, intent_hash, phase, evidence_code,
            request_hash, quote_hash, output_plan_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.operation_id,
        row.input_json,
        row.coco_operation_id,
        row.intent_hash,
        row.phase,
        row.evidence_code,
        row.request_hash,
        row.quote_hash,
        row.output_plan_hash,
      );
  }

  #updatePhase(operationId: string, phase: LifecyclePhase, evidenceCode?: string): void {
    this.#requiredDatabase()
      .query(
        `UPDATE coco_fault_lab_operations
         SET phase = ?, evidence_code = ?
         WHERE operation_id = ?`,
      )
      .run(phase, evidenceCode ?? null, operationId);
  }

  async #closeSession(): Promise<void> {
    const manager = this.#manager;
    const database = this.#database;
    this.#manager = undefined;
    this.#database = undefined;
    try {
      await manager?.dispose();
    } finally {
      database?.close();
    }
  }
}

export async function startCocoLifecycleAdapter(
  options: CocoLifecycleAdapterOptions,
): Promise<RunningCocoLifecycleAdapter> {
  const lifecycle = new CocoLifecycleAdapter(options);
  const server = Bun.serve({
    hostname: options.host ?? '127.0.0.1',
    port: options.port ?? 4103,
    fetch: (request) => lifecycle.fetch(request),
  });
  const publicHost = options.host === '0.0.0.0' ? '127.0.0.1' : (options.host ?? '127.0.0.1');
  return {
    url: `http://${publicHost}:${server.port}`,
    async stop() {
      await server.stop(true);
      await lifecycle.stop();
    },
  };
}

function parseMintInput(value: unknown): MintLifecycleInput {
  if (
    !isRecord(value) ||
    typeof value.operationId !== 'string' ||
    !/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(value.operationId) ||
    value.kind !== 'mint' ||
    typeof value.mint !== 'string' ||
    typeof value.unit !== 'string' ||
    !Number.isSafeInteger(value.amount) ||
    (value.amount as number) < 1 ||
    value.method !== 'bolt11'
  ) {
    throw new LifecycleHttpError(422, 'SCHEMA_VALIDATION', 'Mint operation input is invalid');
  }
  return value as unknown as MintLifecycleInput;
}

function rowToView(row: StoredOperationRow): LifecycleOperationView {
  const input = JSON.parse(row.input_json) as MintLifecycleInput;
  return {
    operationId: input.operationId,
    kind: input.kind,
    mint: input.mint,
    unit: input.unit,
    intentHash: row.intent_hash,
    phase: row.phase,
    ...(row.evidence_code === null ? {} : { evidenceCode: row.evidence_code }),
    amount: input.amount,
    requestHash: row.request_hash,
    quoteHash: row.quote_hash,
    outputPlanHash: row.output_plan_hash,
  };
}

function isTerminalPhase(phase: LifecyclePhase): boolean {
  return phase === 'succeeded' || phase === 'failed_definitive' || phase === 'recovery_blocked';
}

function digest(domain: string, value: string): string {
  return createHash('sha256').update(domain).update('\0').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalMintUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return false;
    }
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/u, '');
    return `${url.protocol}//${url.host}${path}` === value;
  } catch {
    return false;
  }
}

async function requestJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new LifecycleHttpError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function resetDatabaseFiles(path: string): Promise<void> {
  if (path === ':memory:') return;
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-shm`, { force: true }),
    rm(`${path}-wal`, { force: true }),
  ]);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function environmentPort(value: string | undefined): number {
  const parsed = value === undefined ? 4103 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('COCO_FAULT_LAB_PORT must be an integer from 1 to 65,535');
  }
  return parsed;
}

if (import.meta.main) {
  const running = await startCocoLifecycleAdapter({
    controlToken: requiredEnvironment('COCO_FAULT_LAB_CONTROL_TOKEN'),
    databasePath: requiredEnvironment('COCO_FAULT_LAB_DATABASE'),
    host: process.env.COCO_FAULT_LAB_HOST ?? '127.0.0.1',
    implementationVersion: process.env.COCO_FAULT_LAB_VERSION,
    mintId: process.env.COCO_FAULT_LAB_MINT_ID ?? 'mintd-local',
    mintImplementation: process.env.COCO_FAULT_LAB_MINT_IMPLEMENTATION ?? 'mintd',
    mintVersion: process.env.COCO_FAULT_LAB_MINT_VERSION,
    mintUrl: requiredEnvironment('COCO_FAULT_LAB_MINT_URL'),
    port: environmentPort(process.env.COCO_FAULT_LAB_PORT),
    unit: process.env.COCO_FAULT_LAB_UNIT ?? 'sat',
  });
  console.log(`Coco Fault Lab lifecycle adapter listening on ${running.url}`);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await running.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}
