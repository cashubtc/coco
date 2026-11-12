/**
 * Transport link process: the only network path between Wallets and mints.
 *
 * Runs under Node, bundled by `prepareTransportLink()`. Each Wallet process uses its own link port
 * as its HTTP and WebSocket proxy, so the link knows whose traffic it carries. Every Wallet uses
 * the same canonical mint URL (a reserved `.invalid` host that never resolves), so tokens stay
 * portable between Wallets and traffic that bypassed the proxy would fail rather than go unseen.
 *
 * - HTTP arrives in proxy form and is forwarded to that mint's Fault Lab gateway with the Wallet's
 *   tag in the gateway's operation header, so gateway rules can target one Wallet. When the gateway
 *   drops an exchange, the link drops the Wallet's connection too rather than inventing a response.
 * - WebSockets arrive as proxy `CONNECT` tunnels. The gateway cannot carry them, so the link checks
 *   that the tunnel opens with a WebSocket upgrade to `/v1/ws` and pipes it to the mint unchanged.
 * - Connection faults per Wallet and mint: an outage closes open connections and refuses new ones
 *   until it ends; a WebSocket drop closes open WebSockets abruptly, without a close frame.
 *
 * The link never reads or alters a delivered body. Requests carrying `x-sim-probe: 1` are harness
 * readiness probes and are counted apart from Wallet traffic.
 */
import { createServer, request as httpRequest, Agent, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';

const { LINK_MINTS, LINK_WALLETS, LINK_CONTROL_TOKEN } = process.env;
if (!LINK_MINTS || !LINK_WALLETS || !LINK_CONTROL_TOKEN) {
  throw new Error('Transport link requires LINK_MINTS, LINK_WALLETS and LINK_CONTROL_TOKEN');
}

interface MintRoute {
  name: string;
  /** Canonical `host:port` Wallets use for this mint. */
  host: string;
  gateway: URL;
  direct: URL;
}

const mints = (
  JSON.parse(LINK_MINTS) as { name: string; host: string; gateway: string; direct: string }[]
).map(
  (mint): MintRoute => ({
    name: mint.name,
    host: mint.host,
    gateway: new URL(mint.gateway),
    direct: new URL(mint.direct),
  }),
);
const routeByHost = new Map(mints.map((mint) => [mint.host, mint]));
const OPERATION_HEADER = 'x-cashu-fault-operation-id';
const PROBE_HEADER = 'x-sim-probe';
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const agent = new Agent({ keepAlive: true });

interface Tunnel {
  mint: string;
  client: Socket;
  upstream: Socket;
  established: boolean;
  probe: boolean;
}

function counters() {
  return {
    requests: 0,
    requestsByPath: {} as Record<string, number>,
    failedRequests: 0,
    refusedConnections: 0,
    connectionsClosedByFault: 0,
    webSocketUpgrades: 0,
    webSocketsOpen: 0,
    webSocketsClosedByFault: 0,
    webSocketBytesToMint: 0,
    webSocketBytesFromMint: 0,
    probeRequests: 0,
    probeWebSockets: 0,
  };
}

/** One Wallet's proxy port. */
class WalletPort {
  readonly offline = new Set<string>();
  /** Open client connections with the mint each one last addressed. */
  readonly connections = new Map<Socket, Set<string>>();
  readonly tunnels = new Set<Tunnel>();
  readonly counters = new Map(mints.map((mint) => [mint.name, counters()]));
  /** Traffic that named no known mint or did not use proxy form; it is refused. */
  unrouted = 0;
  readonly server: Server;

  constructor(
    readonly wallet: string,
    readonly tag: string,
  ) {
    this.server = createServer();
    this.server.on('connection', (socket) => {
      this.connections.set(socket, new Set());
      socket.on('close', () => this.connections.delete(socket));
    });
    this.server.on('request', (request, response) => {
      const target = URL.canParse(request.url ?? '') ? new URL(request.url!) : undefined;
      const route = target ? routeByHost.get(target.host) : undefined;
      if (!target || !route) {
        this.unrouted++;
        request.socket.destroy();
        return;
      }
      const tally = this.counters.get(route.name)!;
      this.connections.get(request.socket)?.add(route.name);
      if (this.offline.has(route.name)) {
        tally.refusedConnections++;
        request.socket.destroy();
        return;
      }
      if (request.headers[PROBE_HEADER] === '1') {
        tally.probeRequests++;
      } else {
        tally.requests++;
        const key = `${request.method} ${evidencePath(target.pathname)}`;
        tally.requestsByPath[key] = (tally.requestsByPath[key] ?? 0) + 1;
      }
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name) || name === PROBE_HEADER) continue;
        headers[name] = value;
      }
      headers.host = route.gateway.host;
      headers[OPERATION_HEADER] = this.tag;
      const upstream = httpRequest(
        new URL(`${target.pathname}${target.search}`, route.gateway),
        { method: request.method, headers, agent },
        (upstreamResponse) => {
          const responseHeaders: Record<string, string | string[]> = {};
          for (const [name, value] of Object.entries(upstreamResponse.headers)) {
            if (value === undefined || HOP_BY_HOP.has(name)) continue;
            responseHeaders[name] = value;
          }
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
          upstreamResponse.pipe(response);
          upstreamResponse.on('close', () => {
            // A response cut short upstream stays cut short for the Wallet.
            if (!upstreamResponse.complete) response.destroy();
          });
        },
      );
      upstream.on('error', () => {
        tally.failedRequests++;
        // The gateway dropped the exchange: drop the Wallet's connection, never answer for it.
        response.destroy();
      });
      response.on('close', () => {
        if (!response.writableFinished) upstream.destroy();
      });
      request.pipe(upstream);
    });
    this.server.on('connect', (request, client: Socket, head: Buffer) => {
      // CONNECT names the port explicitly; the canonical URL leaves the default port implicit.
      const route = routeByHost.get((request.url ?? '').replace(/:80$/u, ''));
      if (!route) {
        this.unrouted++;
        client.destroy();
        return;
      }
      const tally = this.counters.get(route.name)!;
      if (this.offline.has(route.name)) {
        tally.refusedConnections++;
        client.destroy();
        return;
      }
      // Track CONNECT as soon as its mint is known, including the incomplete upgrade request.
      this.connections.get(client)?.add(route.name);
      client.on('error', () => client.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      // Only a WebSocket upgrade may use a tunnel; plain HTTP must pass the gateway.
      let opening = Buffer.from(head);
      const inspect = (chunk: Buffer) => {
        opening = Buffer.concat([opening, chunk]);
        const end = opening.indexOf('\r\n\r\n');
        if (end < 0) {
          if (opening.length > 16_384) client.destroy();
          return;
        }
        client.off('data', inspect);
        client.pause();
        const requestHead = opening.subarray(0, end).toString('latin1');
        const [requestLine, ...headerLines] = requestHead.split('\r\n');
        const isUpgrade =
          /^GET \/v1\/ws(\?|\s)/u.test(requestLine ?? '') &&
          headerLines.some((line) => /^upgrade:\s*websocket$/iu.test(line.trim()));
        if (!isUpgrade) {
          this.unrouted++;
          client.destroy();
          return;
        }
        const probe = headerLines.some((line) => /^x-sim-probe:\s*1$/iu.test(line.trim()));
        this.tunnel(route, client, opening, probe);
      };
      client.on('data', inspect);
      if (head.length > 0) inspect(Buffer.alloc(0));
    });
  }

  private tunnel(route: MintRoute, client: Socket, opening: Buffer, probe: boolean): void {
    const tally = this.counters.get(route.name)!;
    if (probe) tally.probeWebSockets++;
    else tally.webSocketUpgrades++;
    const upstream = connect(Number(route.direct.port), route.direct.hostname);
    const tunnel: Tunnel = { mint: route.name, client, upstream, established: false, probe };
    this.tunnels.add(tunnel);
    upstream.on('connect', () => {
      upstream.write(opening);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('data', (chunk: Buffer) => {
      if (!probe) tally.webSocketBytesFromMint += chunk.length;
      if (!tunnel.established && chunk.toString('latin1', 0, 12) === 'HTTP/1.1 101') {
        tunnel.established = true;
        if (!probe) tally.webSocketsOpen++;
      }
    });
    client.on('data', (chunk: Buffer) => {
      if (!probe) tally.webSocketBytesToMint += chunk.length;
    });
    const teardown = () => {
      if (!this.tunnels.delete(tunnel)) return;
      if (tunnel.established && !probe) tally.webSocketsOpen--;
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on('close', teardown);
      socket.on('error', () => socket.destroy());
    }
  }

  /** Closes open WebSockets to the mint abruptly; the Wallet sees an abnormal closure (1006). */
  dropWebSockets(mint: string): number {
    let closed = 0;
    for (const tunnel of [...this.tunnels]) {
      if (tunnel.mint !== mint || !tunnel.established || tunnel.probe) continue;
      closed++;
      tunnel.client.destroy();
      tunnel.upstream.destroy();
    }
    this.counters.get(mint)!.webSocketsClosedByFault += closed;
    return closed;
  }

  disconnect(mint: string): { closedConnections: number; closedWebSockets: number } {
    this.offline.add(mint);
    const closedWebSockets = this.dropWebSockets(mint);
    let closedConnections = 0;
    for (const [socket, addressed] of this.connections) {
      if (socket.destroyed || !addressed.has(mint)) continue;
      closedConnections++;
      socket.destroy();
    }
    // An outage also closes upstream halves still awaiting a WebSocket upgrade response.
    // dropWebSockets intentionally counts only established Wallet sockets, not these handshakes.
    for (const tunnel of this.tunnels) {
      if (tunnel.mint !== mint) continue;
      tunnel.client.destroy();
      tunnel.upstream.destroy();
    }
    this.counters.get(mint)!.connectionsClosedByFault += closedConnections;
    return { closedConnections, closedWebSockets };
  }

  evidence() {
    const byMint: Record<string, unknown> = {};
    for (const [mint, tally] of this.counters) {
      byMint[mint] = {
        ...tally,
        requestsByPath: { ...tally.requestsByPath },
        offline: this.offline.has(mint),
      };
    }
    return { unrouted: this.unrouted, mints: byMint };
  }
}

function evidencePath(path: string): string {
  return path.replace(/^(\/v1\/(?:mint|melt)\/quote\/[^/]+)\/[^/]+$/u, '$1/:quote_id');
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Transport link did not bind TCP');
  return address.port;
}

const ports = new Map<string, WalletPort>();
for (const { wallet, tag } of JSON.parse(LINK_WALLETS) as { wallet: string; tag: string }[]) {
  ports.set(wallet, new WalletPort(wallet, tag));
}

/** The Wallet ports and mints a control request names; all of them when it names none. */
function selected(body: { wallets?: string[]; mints?: string[] }) {
  const wallets = (body.wallets ?? [...ports.keys()]).map((name) => {
    const port = ports.get(name);
    if (!port) throw new Error(`Unknown Wallet ${name}`);
    return port;
  });
  const names = body.mints ?? mints.map((mint) => mint.name);
  for (const name of names) {
    if (!mints.some((mint) => mint.name === name)) throw new Error(`Unknown mint ${name}`);
  }
  return wallets.flatMap((port) => names.map((mint) => ({ port, mint })));
}

const control = createServer((request, response) => {
  const reply = (status: number, value: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  if (request.headers.authorization !== `Bearer ${LINK_CONTROL_TOKEN}`) {
    reply(401, { error: 'unauthorized' });
    return;
  }
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    try {
      const body = (chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) as {
        wallets?: string[];
        mints?: string[];
      };
      const route = `${request.method} ${request.url}`;
      if (route === 'GET /evidence') {
        const wallets: Record<string, unknown> = {};
        for (const [name, port] of ports) wallets[name] = port.evidence();
        reply(200, { wallets });
      } else if (route === 'POST /disconnect') {
        reply(
          200,
          selected(body).map(({ port, mint }) => ({
            wallet: port.wallet,
            mint,
            ...port.disconnect(mint),
          })),
        );
      } else if (route === 'POST /reconnect') {
        for (const { port, mint } of selected(body)) port.offline.delete(mint);
        reply(200, { ok: true });
      } else if (route === 'POST /drop-websockets') {
        reply(
          200,
          selected(body).map(({ port, mint }) => ({
            wallet: port.wallet,
            mint,
            closed: port.dropWebSockets(mint),
          })),
        );
      } else {
        reply(404, { error: 'not found' });
      }
    } catch (error) {
      reply(422, { error: error instanceof Error ? error.message : String(error) });
    }
  });
});

const walletPorts: Record<string, number> = {};
for (const [name, port] of ports) walletPorts[name] = await listen(port.server);
const controlPort = await listen(control);
process.stdout.write(
  `${JSON.stringify({ ready: true, control: controlPort, wallets: walletPorts })}\n`,
);

const close = () => {
  for (const port of ports.values()) {
    for (const mint of mints) port.disconnect(mint.name);
    port.server.close();
  }
  control.close();
  agent.destroy();
  process.exit(0);
};
process.once('SIGTERM', close);
process.once('SIGINT', close);
