/**
 * Harness handle for the transport link: the only network path between Wallets and mints.
 *
 * Each Wallet process uses its own link port as HTTP and WebSocket proxy and the same canonical
 * URL for each mint. HTTP passes through the mint's pinned Fault Lab gateway, tagged with the
 * Wallet so gateway rules can target it; WebSockets, which the gateway cannot carry, are tunnelled
 * to the mint. The link adds the connection faults the gateway lacks: Wallet-to-mint outages and
 * abrupt WebSocket disconnects. See `transportLinkProcess.ts`.
 */
import { openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InfrastructureFailure } from './environment.ts';

/** Transport evidence for one Wallet and mint. Probe traffic is counted separately. */
export interface WalletLinkEvidence {
  offline: boolean;
  requests: number;
  requestsByPath: Record<string, number>;
  failedRequests: number;
  refusedConnections: number;
  connectionsClosedByFault: number;
  webSocketUpgrades: number;
  webSocketsOpen: number;
  webSocketsClosedByFault: number;
  webSocketBytesToMint: number;
  webSocketBytesFromMint: number;
  probeRequests: number;
  probeWebSockets: number;
}

export interface LinkEvidence {
  wallets: Record<
    string,
    {
      /** Requests that named no known mint or bypassed proxy form; they were refused. */
      unrouted: number;
      mints: Record<string, WalletLinkEvidence>;
    }
  >;
}

export interface LinkMint {
  name: string;
  /** Fault Lab gateway carrying this mint's HTTP. */
  gateway: string;
  /** Direct mint URL, used only for WebSocket tunnels. */
  direct: string;
}

/** Marks harness readiness probes so the link counts them apart from Wallet traffic. */
export const PROBE_HEADERS = { 'x-sim-probe': '1' } as const;

/**
 * The URL every Wallet uses for a logical mint. The reserved `.invalid` host never resolves, so a
 * request that bypassed the link fails instead of reaching the mint unobserved.
 */
export function canonicalMintUrl(mint: string): string {
  return `http://${mint}.faultsim.invalid`;
}

/**
 * The gateway's operation-ID match requires 21 URL-safe characters and a final `A`, `Q`, `g` or
 * `w`. The tag is a Wallet label, not secret material.
 */
export function walletTag(wallet: string): string {
  const label = `wallet-${wallet}`.replace(/[^A-Za-z0-9_-]/g, '_');
  if (label.length > 21) throw new Error(`Wallet name ${wallet} is too long for a link tag`);
  return `${label.padEnd(21, '_')}A`;
}

const entry = fileURLToPath(new URL('./transportLinkProcess.ts', import.meta.url));

/** Bundles the link process for Node. */
export async function prepareTransportLink(cacheRoot: string): Promise<string> {
  const outdir = join(cacheRoot, 'transport-link-build');
  const build = await Bun.build({
    entrypoints: [entry],
    target: 'node',
    format: 'esm',
    outdir,
    naming: 'transport-link.mjs',
  });
  if (!build.success) {
    throw new InfrastructureFailure(`Transport link bundle failed: ${build.logs.join('; ')}`);
  }
  return join(outdir, 'transport-link.mjs');
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buffered = '';
  const reader = stream.getReader();
  try {
    while (!buffered.includes('\n')) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return buffered.split('\n')[0]!;
}

type Selection = { wallets?: string[]; mints?: string[] };

export class TransportLink {
  private constructor(
    private readonly process: Bun.Subprocess<'ignore', 'pipe', number>,
    private readonly controlUrl: string,
    private readonly controlToken: string,
    private readonly proxies: Map<string, string>,
  ) {}

  static async start(options: {
    bundlePath: string;
    mints: LinkMint[];
    wallets: string[];
    logPath: string;
  }): Promise<TransportLink> {
    // The control token only guards this loopback link; it is not Wallet secret material.
    const controlToken = crypto.randomUUID();
    const child = Bun.spawn(['node', options.bundlePath], {
      env: {
        PATH: process.env.PATH ?? '',
        LINK_MINTS: JSON.stringify(
          options.mints.map((mint) => ({
            ...mint,
            host: new URL(canonicalMintUrl(mint.name)).host,
          })),
        ),
        LINK_WALLETS: JSON.stringify(
          options.wallets.map((wallet) => ({ wallet, tag: walletTag(wallet) })),
        ),
        LINK_CONTROL_TOKEN: controlToken,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: openSync(options.logPath, 'a'),
    });
    const line = await Promise.race([firstLine(child.stdout), Bun.sleep(10_000).then(() => '')]);
    let ready: { ready: true; control: number; wallets: Record<string, number> };
    try {
      ready = JSON.parse(line) as typeof ready;
    } catch {
      child.kill('SIGKILL');
      throw new InfrastructureFailure('Transport link did not start');
    }
    const proxies = new Map(
      Object.entries(ready.wallets).map(([wallet, port]) => [wallet, `http://127.0.0.1:${port}`]),
    );
    return new TransportLink(child, `http://127.0.0.1:${ready.control}`, controlToken, proxies);
  }

  /** The proxy URL this Wallet's process uses for all mint traffic. */
  proxyFor(wallet: string): string {
    const url = this.proxies.get(wallet);
    if (!url) throw new Error(`No link port for ${wallet}`);
    return url;
  }

  get running(): boolean {
    return this.process.exitCode === null && this.process.signalCode === null;
  }

  private async control(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.running) throw new InfrastructureFailure('Transport link process exited');
    const response = await fetch(`${this.controlUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.controlToken}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new InfrastructureFailure(`Transport link control ${path} returned ${response.status}`);
    }
    return response.json();
  }

  async evidence(): Promise<LinkEvidence> {
    return (await this.control('GET', '/evidence')) as LinkEvidence;
  }

  /** Starts an outage: closes the selected connections and refuses new ones until reconnect. */
  async disconnect(
    selection: Selection = {},
  ): Promise<
    { wallet: string; mint: string; closedConnections: number; closedWebSockets: number }[]
  > {
    return (await this.control('POST', '/disconnect', selection)) as {
      wallet: string;
      mint: string;
      closedConnections: number;
      closedWebSockets: number;
    }[];
  }

  /** Ends the selected outages; every outage when the selection names nothing. */
  async reconnect(selection: Selection = {}): Promise<void> {
    await this.control('POST', '/reconnect', selection);
  }

  /** Abruptly closes the Wallet's open WebSockets to the mint and returns how many were closed. */
  async dropWebSockets(wallet: string, mint: string): Promise<number> {
    const [result] = (await this.control('POST', '/drop-websockets', {
      wallets: [wallet],
      mints: [mint],
    })) as { closed: number }[];
    return result!.closed;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
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
