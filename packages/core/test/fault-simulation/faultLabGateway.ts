/**
 * Thin adapter over the pinned Cashu Fault Lab HTTP fault gateway.
 *
 * The gateway is consumed from a verified checkout of one pinned revision, bundled for Node and run
 * as a separate process controlled through its documented `/__faults/v1/` API. It only shapes
 * transport between Wallets and a mint; it never touches Wallet persistence or recovery.
 *
 * The gateway must run under Node: hosted by Bun's `node:http` compatibility layer, its `drop`
 * action turns into an empty `200` response instead of a closed connection.
 */
import { existsSync, mkdirSync, openSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { InfrastructureFailure, freePort, waitUntil } from './environment.ts';

export const FAULT_LAB_REPOSITORY = 'https://github.com/GautamBytes/cashu-fault-lab.git';
export const FAULT_LAB_REVISION = '1cc954d33a1088fd20efc48c5437e3a7441920f7';

/** The subset of the gateway's rule contract this harness uses. */
export interface GatewayRule {
  phase: 'before_forward' | 'after_downstream_commit' | 'after_downstream_response';
  action: 'drop' | 'delay';
  match: { method: string; path: string };
  count?: number;
  delayMs?: number;
}

/** Gateway counters and rule application evidence, as reported by its control API. */
export interface GatewayEvidence {
  inbound: number;
  forwarded: number;
  responded: number;
  dropped: number;
  delayed: number;
  requests: { method: string; path: string; attemptOrdinal: number }[];
  rules: {
    id: string;
    phase: string;
    action: string;
    method?: string;
    path?: string;
    remaining: number;
    applied: number;
  }[];
}

function run(command: string[], cwd?: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new InfrastructureFailure(
      `${command.slice(0, 2).join(' ')} failed: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().trim();
}

/**
 * Returns a Node bundle of the pinned gateway, fetching and verifying the checkout on first use.
 * `COCO_FAULT_LAB_CHECKOUT` may point at an existing checkout, which must be at the pinned revision.
 */
export async function preparePinnedGateway(cacheRoot: string): Promise<string> {
  const checkout =
    process.env.COCO_FAULT_LAB_CHECKOUT ?? join(cacheRoot, 'cashu-fault-lab', FAULT_LAB_REVISION);
  if (!existsSync(join(checkout, '.git'))) {
    const staging = `${checkout}.partial-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    run(['git', 'init', '-q'], staging);
    run(['git', 'fetch', '-q', '--depth', '1', FAULT_LAB_REPOSITORY, FAULT_LAB_REVISION], staging);
    run(['git', 'checkout', '-q', '--detach', 'FETCH_HEAD'], staging);
    renameSync(staging, checkout);
  }
  const head = run(['git', 'rev-parse', 'HEAD'], checkout);
  if (head !== FAULT_LAB_REVISION) {
    throw new InfrastructureFailure(`Fault Lab checkout is at ${head}, not ${FAULT_LAB_REVISION}`);
  }
  if (run(['git', 'status', '--porcelain', '--', 'apps/http-fault-gateway'], checkout) !== '') {
    throw new InfrastructureFailure('Fault Lab gateway sources differ from the pinned revision');
  }

  const outdir = join(cacheRoot, 'cashu-fault-lab-build', FAULT_LAB_REVISION);
  const build = await Bun.build({
    entrypoints: [join(checkout, 'apps/http-fault-gateway/src/bin.ts')],
    target: 'node',
    format: 'esm',
    outdir,
    naming: 'http-fault-gateway.mjs',
  });
  if (!build.success) {
    throw new InfrastructureFailure(`Fault Lab gateway bundle failed: ${build.logs.join('; ')}`);
  }
  return join(outdir, 'http-fault-gateway.mjs');
}

export function nodeVersion(): string {
  return run(['node', '--version']);
}

/** One gateway process in front of one mint. Wallets use {@link url} as that mint's URL. */
export class FaultLabGateway {
  private constructor(
    readonly url: string,
    private readonly controlToken: string,
    private readonly process: Bun.Subprocess,
  ) {}

  static async start(options: {
    bundlePath: string;
    downstream: string;
    logPath: string;
  }): Promise<FaultLabGateway> {
    // Another process can claim the free port before the gateway binds it.
    for (let attempt = 1; ; attempt++) {
      try {
        return await FaultLabGateway.startOnce(options, await freePort());
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
  }

  private static async startOnce(
    options: { bundlePath: string; downstream: string; logPath: string },
    port: number,
  ): Promise<FaultLabGateway> {
    // The control token only guards this loopback gateway; it is not Wallet secret material.
    const controlToken = crypto.randomUUID();
    const log = openSync(options.logPath, 'a');
    const child = Bun.spawn(['node', options.bundlePath], {
      env: {
        PATH: process.env.PATH ?? '',
        CFL_HTTP_FAULT_GATEWAY_DOWNSTREAM: options.downstream,
        CFL_HTTP_FAULT_GATEWAY_CONTROL_TOKEN: controlToken,
        CFL_HTTP_FAULT_GATEWAY_PORT: String(port),
      },
      stdout: log,
      stderr: log,
    });
    const gateway = new FaultLabGateway(`http://127.0.0.1:${port}`, controlToken, child);
    try {
      await waitUntil('Fault Lab gateway control API', 10_000, async () => {
        if (child.exitCode !== null) throw new InfrastructureFailure('Fault Lab gateway exited');
        await gateway.evidence();
        return true;
      });
    } catch (error) {
      await gateway.stop();
      throw error;
    }
    return gateway;
  }

  private async control(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${this.url}/__faults/v1/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.controlToken}`,
        'content-type': 'application/json',
      },
    });
    if (!response.ok) {
      throw new InfrastructureFailure(`Fault Lab control ${path} returned ${response.status}`);
    }
    return response.json();
  }

  async addRule(rule: GatewayRule): Promise<string> {
    const { id } = (await this.control('rules', {
      method: 'POST',
      body: JSON.stringify(rule),
    })) as { id: string };
    return id;
  }

  async clearRules(): Promise<void> {
    await this.control('rules', { method: 'DELETE' });
  }

  async evidence(): Promise<GatewayEvidence> {
    return (await this.control('evidence')) as GatewayEvidence;
  }

  async stop(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    this.process.kill('SIGTERM');
    const exited = await Promise.race([
      this.process.exited.then(() => true),
      Bun.sleep(2_000).then(() => false),
    ]);
    if (!exited) {
      this.process.kill('SIGKILL');
      await this.process.exited;
    }
  }
}
