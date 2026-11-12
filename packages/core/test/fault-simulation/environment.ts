/**
 * Environment orchestration for wallet fault simulation: pinned mint containers and shared helpers.
 *
 * A failure to establish environment health is an infrastructure failure, never a pass and never a
 * wallet failure.
 */

/** The environment, rather than a Wallet guarantee, could not be established. */
export class InfrastructureFailure extends Error {
  override readonly name = 'InfrastructureFailure';
}

// Keep the image and fee configuration aligned with scripts/test-integration.sh.
export const MINT_IMAGE = 'cashubtc/mintd:0.17.0-rc.0';
export const MINT_INPUT_FEE_PPK = 100;
export const MINT_UNIT = 'sat';
/**
 * Distinct BIP-39 test mnemonics, one per logical mint, so the mints have distinct keysets as
 * independent mints would. The first matches scripts/test-integration.sh.
 */
export const MINT_MNEMONICS = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
];

export async function waitUntil<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined | false>,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      if (error instanceof InfrastructureFailure) throw error;
      lastError = error;
    }
    await Bun.sleep(intervalMs);
  }
  const reason = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new InfrastructureFailure(`Timed out waiting for ${what}${reason}`);
}

/** Asks the OS for a free loopback port. Another process may still claim it before use. */
export async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

function docker(args: string[]): string {
  const result = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new InfrastructureFailure(`docker ${args[0]} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

/** One real mint with a fake Lightning backend, reachable directly only by the harness. */
export class MintContainer {
  private constructor(
    readonly name: string,
    /** Direct URL for harness probes. Wallets reach the mint only through a fault gateway. */
    readonly directUrl: string,
    readonly imageDigest: string,
  ) {}

  static async start(name: string, mnemonic: string): Promise<MintContainer> {
    docker([
      'run',
      '-d',
      '--name',
      name,
      '-p',
      '127.0.0.1::3338',
      '-e',
      'CDK_MINTD_DATABASE=sqlite',
      '-e',
      'CDK_MINTD_LN_BACKEND=fakewallet',
      '-e',
      `CDK_MINTD_INPUT_FEE_PPK=${MINT_INPUT_FEE_PPK}`,
      '-e',
      'CDK_MINTD_LISTEN_HOST=0.0.0.0',
      '-e',
      'CDK_MINTD_LISTEN_PORT=3338',
      '-e',
      'CDK_MINTD_FAKE_WALLET_MIN_DELAY=0',
      '-e',
      'CDK_MINTD_FAKE_WALLET_MAX_DELAY=0',
      '-e',
      `CDK_MINTD_MNEMONIC=${mnemonic}`,
      MINT_IMAGE,
    ]);
    try {
      const port = docker(['port', name, '3338/tcp']).split('\n')[0]!.split(':').pop();
      const directUrl = `http://127.0.0.1:${port}`;
      const imageDigest = docker(['image', 'inspect', '--format', '{{.Id}}', MINT_IMAGE]);
      await waitUntil('mint readiness', 30_000, async () => {
        const response = await fetch(`${directUrl}/v1/info`);
        return response.ok;
      });
      return new MintContainer(name, directUrl, imageDigest);
    } catch (error) {
      Bun.spawnSync(['docker', 'rm', '-f', name]);
      throw error;
    }
  }

  /** Removes the container. mintd ignores SIGTERM, so a graceful stop would only add latency. */
  stop(): void {
    Bun.spawnSync(['docker', 'rm', '-f', this.name], { stdout: 'ignore', stderr: 'ignore' });
  }
}
