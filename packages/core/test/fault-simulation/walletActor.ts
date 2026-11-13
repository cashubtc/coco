/**
 * Harness-side handle for one Wallet actor process.
 *
 * The process boundary makes crashes real: {@link WalletActor.crash} sends SIGKILL, so the Coco
 * Session gets no chance to dispose, flush or finish in-flight work. A restarted actor is a new
 * process and a new Coco Session over the same SQLite file and Wallet Seed file.
 */
import { openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InfrastructureFailure } from './environment.ts';

export type ActorCommand =
  | { type: 'addMint' }
  | { type: 'fund'; amount: number }
  | { type: 'send'; amount: number }
  | { type: 'prepareReceive'; token: string }
  | { type: 'executeReceive'; operationId: string }
  | { type: 'observe'; operationIds: string[] }
  | { type: 'dispose' };

export type ActorReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { name: string; message: string } };

export interface ActorResults {
  addMint: Record<string, never>;
  fund: { operationId: string; state: string };
  send: { operationId: string; token: string };
  prepareReceive: { operationId: string };
  executeReceive: { state: string };
  observe: {
    balance: number;
    operations: { id: string; state: string | undefined; historyEntries: number }[];
  };
  dispose: Record<string, never>;
}

/** A Coco command was rejected; distinct from the actor process being unavailable. */
export class ActorCommandError extends Error {
  override readonly name = 'ActorCommandError';
  constructor(
    readonly command: ActorCommand['type'],
    readonly remote: { name: string; message: string },
  ) {
    super(`${command} failed with ${remote.name}: ${remote.message}`);
  }
}

/** The actor process ended while a command was outstanding. */
export class ActorTerminatedError extends Error {
  override readonly name = 'ActorTerminatedError';
}

export interface WalletActorOptions {
  wallet: string;
  dbPath: string;
  seedPath: string;
  mintUrl: string;
  unit: string;
  /** Private file receiving the actor's stderr. */
  logPath: string;
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim()) yield line;
    }
  }
}

const entry = fileURLToPath(new URL('./walletActorProcess.ts', import.meta.url));

export class WalletActor {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; type: string }
  >();
  private readonly ready: Promise<void>;
  private terminated = false;

  private constructor(
    readonly options: WalletActorOptions,
    private readonly process: Bun.Subprocess<'pipe', 'pipe', number>,
  ) {
    let markReady!: () => void;
    let failReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    void (async () => {
      for await (const line of lines(process.stdout)) {
        const reply = JSON.parse(line) as ActorReply;
        if (reply.id === 0) {
          markReady();
          continue;
        }
        const waiter = this.pending.get(reply.id);
        if (!waiter) continue;
        this.pending.delete(reply.id);
        if (reply.ok) waiter.resolve(reply.result);
        else waiter.reject(new ActorCommandError(waiter.type as ActorCommand['type'], reply.error));
      }
    })();
    void process.exited.then(() => {
      this.terminated = true;
      const error = new ActorTerminatedError(`${options.wallet} process exited`);
      failReady(error);
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    });
  }

  static async start(options: WalletActorOptions): Promise<WalletActor> {
    const log = openSync(options.logPath, 'a');
    const child = Bun.spawn(['bun', entry], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        SIM_DB_PATH: options.dbPath,
        SIM_SEED_PATH: options.seedPath,
        SIM_MINT_URL: options.mintUrl,
        SIM_UNIT: options.unit,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: log,
    });
    const actor = new WalletActor(options, child);
    const started = await Promise.race([
      actor.ready.then(() => true),
      Bun.sleep(30_000).then(() => false),
    ]).catch(() => false);
    if (!started) {
      child.kill('SIGKILL');
      throw new InfrastructureFailure(`${options.wallet} actor did not start`);
    }
    return actor;
  }

  get wallet(): string {
    return this.options.wallet;
  }

  get pid(): number {
    return this.process.pid;
  }

  get running(): boolean {
    return !this.terminated;
  }

  request<T extends ActorCommand>(command: T): Promise<ActorResults[T['type']]> {
    if (this.terminated) {
      return Promise.reject(new ActorTerminatedError(`${this.wallet} is not running`));
    }
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) =>
      this.pending.set(id, { resolve, reject, type: command.type }),
    );
    this.process.stdin.write(`${JSON.stringify({ id, command })}\n`);
    this.process.stdin.flush();
    return result as Promise<ActorResults[T['type']]>;
  }

  /** Abruptly terminates the process and reports how it ended. */
  async crash(): Promise<{ signal: string | null; exitCode: number | null }> {
    this.process.kill('SIGKILL');
    await this.process.exited;
    return { signal: this.process.signalCode, exitCode: this.process.exitCode };
  }

  /** Graceful shutdown for teardown; falls back to SIGKILL if disposal does not finish. */
  async shutdown(): Promise<void> {
    if (this.terminated) return;
    const disposed = await Promise.race([
      this.request({ type: 'dispose' }).then(
        () => true,
        () => false,
      ),
      Bun.sleep(10_000).then(() => false),
    ]);
    if (!disposed) this.process.kill('SIGKILL');
    await this.process.exited;
  }
}
