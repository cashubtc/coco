const MIN_TEST_PORT = 40_000;
const TEST_PORT_RANGE = 20_000;
let nextTestPort = MIN_TEST_PORT;

interface TcpTestServerOptions<R extends string> {
  fetch(request: Request): Response | Promise<Response>;
  routes?: Bun.Serve.Routes<undefined, R>;
}

type TcpTestServer = Bun.Server<undefined> & { port: number };

export function startTcpTestServer<R extends string>(
  options: TcpTestServerOptions<R>,
): TcpTestServer {
  for (let attempt = 0; attempt < TEST_PORT_RANGE; attempt++) {
    const port = nextTestPort;
    nextTestPort = MIN_TEST_PORT + ((nextTestPort - MIN_TEST_PORT + 1) % TEST_PORT_RANGE);
    try {
      return Bun.serve({ ...options, hostname: '127.0.0.1', port }) as TcpTestServer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        throw error;
      }
    }
  }
  throw new Error('Failed to bind an available TCP test port');
}
