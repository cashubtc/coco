import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ControllablePaymentProcessor } from './ControllablePaymentProcessor.ts';
import type { ExperimentalTestMintOptions } from './types.ts';

const CDK_VERSION = '0.17.0-rc.0';
const CDK_PROTOCOL_VERSION = '3.0.0';
const CDK_BINARY_SHA256: Partial<Record<NodeJS.Architecture, string>> = {
  x64: 'd6868866b0b0873faa527d7cc949427c6e3d4e2a0b92b2ec6a99319c9f33eb29',
  arm64: 'f958ea46608accd1e3525ebb3469915a88143762c5e062191ecbd8d3bbdca3cf',
};
const CDK_ARCHIVE_ARCH: Partial<Record<NodeJS.Architecture, string>> = {
  x64: 'x86_64',
  arm64: 'aarch64',
};

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port) throw new Error('Could not allocate a local port');
  return port;
}

async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status}`);
  await Bun.write(path, await response.arrayBuffer());
}

function platformRelease(): { archiveArch: string; sha256: string } {
  if (process.platform !== 'linux') {
    throw new Error(`ExperimentalTestMint currently supports Linux, not ${process.platform}`);
  }
  const archiveArch = CDK_ARCHIVE_ARCH[process.arch];
  const sha256 = CDK_BINARY_SHA256[process.arch];
  if (!archiveArch || !sha256) {
    throw new Error(`ExperimentalTestMint does not support architecture ${process.arch}`);
  }
  return { archiveArch, sha256 };
}

/**
 * Runs a real CDK mint backed by an in-memory, controllable payment processor.
 *
 * @experimental This package is private and its interface may change without notice.
 */
export class ExperimentalTestMint {
  readonly url: string;
  readonly payments: ControllablePaymentProcessor;

  private stopped = false;

  private constructor(
    url: string,
    payments: ControllablePaymentProcessor,
    private readonly scratchDir: string,
    private readonly mintProcess: ReturnType<typeof Bun.spawn>,
  ) {
    this.url = url;
    this.payments = payments;
  }

  static async start(options: ExperimentalTestMintOptions = {}): Promise<ExperimentalTestMint> {
    const mintPort = options.mintPort ?? (await availablePort());
    const processorPort = options.processorPort ?? (await availablePort());
    const mintUrl = `http://127.0.0.1:${mintPort}`;
    const scratchDir = await mkdtemp(join(options.scratchRoot ?? tmpdir(), 'coco-test-mint-'));
    const payments = new ControllablePaymentProcessor();
    let mintProcess: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const binaryPath = join(scratchDir, `cdk-mintd-${CDK_VERSION}`);
      const protoPath = join(scratchDir, 'payment_processor.proto');
      const configPath = join(scratchDir, 'config.toml');
      const mintWorkDir = join(scratchDir, 'mint');
      const { archiveArch, sha256 } = platformRelease();
      const releaseRoot = `https://github.com/cashubtc/cdk/releases/download/v${CDK_VERSION}`;
      const sourceRoot = `https://raw.githubusercontent.com/cashubtc/cdk/v${CDK_VERSION}`;

      await mkdir(mintWorkDir, { recursive: true });
      await Promise.all([
        download(`${releaseRoot}/cdk-mintd-${CDK_VERSION}-${archiveArch}`, binaryPath),
        download(
          `${sourceRoot}/crates/cdk-payment-processor/src/proto/payment_processor.proto`,
          protoPath,
        ),
      ]);

      const actualHash = createHash('sha256')
        .update(Buffer.from(await Bun.file(binaryPath).arrayBuffer()))
        .digest('hex');
      if (actualHash !== sha256) throw new Error('Downloaded CDK mintd checksum mismatch');
      await chmod(binaryPath, 0o755);
      await Bun.write(
        configPath,
        `[info]
url = "${mintUrl}/"
listen_host = "127.0.0.1"
listen_port = ${mintPort}
mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

[database]
engine = "sqlite"

[ln]
ln_backend = "grpcprocessor"

[grpc_processor]
supported_units = ["sat"]
addr = "http://127.0.0.1"
port = ${processorPort}
`,
      );

      await payments.start(protoPath, processorPort);
      mintProcess = Bun.spawn(
        [binaryPath, '--work-dir', mintWorkDir, '--config', configPath],
        options.showMintLogs
          ? { stdout: 'inherit', stderr: 'inherit' }
          : { stdout: 'ignore', stderr: 'ignore' },
      );
      await ExperimentalTestMint.waitUntilReady(
        mintUrl,
        mintProcess,
        options.startupTimeoutMs ?? 20_000,
      );
      if (payments.snapshot().protocolVersion !== CDK_PROTOCOL_VERSION) {
        throw new Error(
          `Unexpected CDK payment-processor protocol: ${payments.snapshot().protocolVersion}`,
        );
      }
      return new ExperimentalTestMint(mintUrl, payments, scratchDir, mintProcess);
    } catch (error) {
      mintProcess?.kill();
      if (mintProcess) await mintProcess.exited;
      await payments.stop();
      await rm(scratchDir, { recursive: true, force: true });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.mintProcess.kill();
    await this.mintProcess.exited;
    await this.payments.stop();
    await rm(this.scratchDir, { recursive: true, force: true });
  }

  private static async waitUntilReady(
    mintUrl: string,
    mintProcess: ReturnType<typeof Bun.spawn>,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (mintProcess.exitCode !== null) {
        throw new Error(`CDK mintd exited before becoming ready (${mintProcess.exitCode})`);
      }
      try {
        const response = await fetch(`${mintUrl}/v1/info`);
        if (response.ok) return;
      } catch {
        // Expected while mintd starts.
      }
      await Bun.sleep(100);
    }
    throw new Error(`Timed out waiting for CDK mintd after ${timeoutMs}ms`);
  }
}
