import { startDaemon } from './daemon';
import { AdministrativeCredential } from './credentials.js';
import {
  assertHostLocalOperation,
  program,
  handleDaemonCommand,
  callDaemonStream,
  formatBalances,
  handleV1Command,
  handleWalletV1Command,
  waitForSessionTransition,
} from './cli-shared';
import type { LifecycleStatusDocument } from './v1/http.js';
import {
  DEFAULT_LOG_LINES,
  followLogFile,
  getLogFileSize,
  parseLogLineCount,
  readRecentLogText,
} from './logs';
import { LOG_FILE } from './utils/config';
import packageJson from '../package.json' with { type: 'json' };

const cliVersion = packageJson.version;

program
  .name('cocod')
  .description('Coco CLI - A Cashu wallet daemon')
  .version(cliVersion, '--version', 'output the version number')
  .option('--url <url>', 'Cocod HTTP endpoint (or COCOD_URL)');

program
  .command('status')
  .description('Show Cocod Process, Wallet Seed Access, and Coco Session status')
  .action(async () => {
    printLifecycleStatus(await handleV1Command((client) => client.status()));
  });

const walletCmd = program.command('wallet').description('Wallet lifecycle operations');

walletCmd
  .command('initialize')
  .description('Create a Wallet with host-generated Wallet Recovery Material')
  .option('--passphrase <passphrase>', 'Protect Wallet Seed Access with a passphrase')
  .action(async (options: { passphrase?: string }) => {
    const result = await handleV1Command((client) =>
      client.initializeWallet({ passphrase: options.passphrase }),
    );
    console.log('Wallet initialized.');
    printWalletRecoveryMaterial(result.generatedMnemonic, true);
    printLifecycleStatus(result.status);
  });

walletCmd
  .command('recovery-material')
  .description('Retrieve the Wallet Recovery Material')
  .option('--passphrase <passphrase>', 'Passphrase for protected Wallet Seed Access')
  .action(async (options: { passphrase?: string }) => {
    const result = await handleV1Command((client) =>
      client.getWalletRecoveryMaterial({ passphrase: options.passphrase }),
    );
    printWalletRecoveryMaterial(result.mnemonic);
  });

const sessionCmd = program.command('session').description('Coco Session lifecycle operations');

sessionCmd
  .command('start')
  .description('Start the Coco Session')
  .option('--passphrase <passphrase>', 'Passphrase for protected Wallet Seed Access')
  .action(async (options: { passphrase?: string }) => {
    const status = await handleV1Command(async (client) =>
      requireSessionState(
        await waitForSessionTransition(
          client,
          await client.startSession({ passphrase: options.passphrase }),
        ),
        'running',
      ),
    );
    printLifecycleStatus(status);
  });

sessionCmd
  .command('stop')
  .description('Stop the Coco Session without stopping the Cocod Process')
  .action(async () => {
    const status = await handleV1Command(async (client) =>
      requireSessionState(
        await waitForSessionTransition(client, await client.stopSession()),
        'stopped',
      ),
    );
    printLifecycleStatus(status);
  });

program
  .command('balance')
  .description('Get wallet balance')
  .action(async () => {
    const balances = await handleWalletV1Command((client) => client.balances());
    console.log(formatBalances(balances));
  });

// Receive - nested subcommands
const receiveCmd = program.command('receive').description('Receive operations');

receiveCmd
  .command('cashu <token>')
  .description('Receive Cashu token')
  .action(async (token: string) => {
    await handleDaemonCommand('/receive/cashu', {
      method: 'POST',
      body: { token },
    });
  });

receiveCmd
  .command('bolt11 <amount>')
  .description('Create Lightning invoice to receive tokens')
  .option('--mint-url <url>', 'Mint URL to use (defaults to the mint URL configured during init)')
  .action(async (amount: string, options: { mintUrl?: string }) => {
    await handleDaemonCommand('/receive/bolt11', {
      method: 'POST',
      body: { amount: parseInt(amount), mintUrl: options.mintUrl },
    });
  });

// Send - nested subcommands
const sendCmd = program.command('send').description('Send operations');

sendCmd
  .command('cashu <amount>')
  .description('Create Cashu token to send')
  .option('--mint-url <url>', 'Mint URL to use (defaults to the mint URL configured during init)')
  .action(async (amount: string, options: { mintUrl?: string }) => {
    await handleDaemonCommand('/send/cashu', {
      method: 'POST',
      body: { amount: parseInt(amount), mintUrl: options.mintUrl },
    });
  });

sendCmd
  .command('bolt11 <invoice>')
  .description('Pay Lightning invoice')
  .option('--mint-url <url>', 'Mint URL to use (defaults to the mint URL configured during init)')
  .action(async (invoice: string, options: { mintUrl?: string }) => {
    await handleDaemonCommand('/send/bolt11', {
      method: 'POST',
      body: { invoice, mintUrl: options.mintUrl },
    });
  });

program
  .command('health')
  .description('Check Cocod Process reachability')
  .action(async () => {
    const health = await handleV1Command((client) => client.health());
    console.log(JSON.stringify(health, null, 2));
  });

// Logs
program
  .command('logs')
  .description('Show daemon logs')
  .option('--follow', 'Stream log updates')
  .option('--lines <number>', 'Number of recent lines to show', String(DEFAULT_LOG_LINES))
  .option('--path', 'Print the resolved log file path')
  .action(async (options: { follow?: boolean; lines?: string; path?: boolean }) => {
    try {
      assertHostLocalOperation('logs');
      if (options.path) {
        console.log(LOG_FILE);
        return;
      }

      const lineCount = parseLogLineCount(options.lines ?? String(DEFAULT_LOG_LINES));
      const fileExists = await Bun.file(LOG_FILE).exists();
      const startPosition = fileExists ? await getLogFileSize(LOG_FILE) : 0;

      if (!fileExists && !options.follow) {
        throw new Error(`Log file not found: ${LOG_FILE}`);
      }

      if (fileExists) {
        const recentLogs = await readRecentLogText(LOG_FILE, lineCount);

        if (recentLogs.length > 0) {
          process.stdout.write(recentLogs);
        }
      }

      if (options.follow) {
        await followLogFile(
          LOG_FILE,
          (chunk) => {
            process.stdout.write(chunk);
          },
          { startPosition },
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    }
  });

// Stop
program
  .command('stop')
  .description('Stop the Cocod Process')
  .action(async () => {
    await handleV1Command((client) => client.stopProcess());
    console.log('Cocod Process is stopping.');
  });

const credentialCmd = program.command('credential').description('Client Credential operations');

credentialCmd
  .command('rotate')
  .description('Rotate the shared administrative Client Credential on this host')
  .action(async () => {
    requireHostLocalOperation('credential rotate');
    const credentials = await AdministrativeCredential.loadOrBootstrap();
    await credentials.rotate();
    console.log('Administrative Client Credential rotated');
  });

// Mints - nested subcommands
const mintsCmd = program.command('mints').description('Mints operations');

mintsCmd
  .command('add <url>')
  .description('Add a mint URL')
  .action(async (url: string) => {
    await handleDaemonCommand('/mints/add', {
      method: 'POST',
      body: { url },
    });
  });

mintsCmd
  .command('list')
  .description('List configured mints')
  .action(async () => {
    await handleDaemonCommand('/mints/list');
  });

mintsCmd
  .command('info <url>')
  .description('Get mint info')
  .action(async (url: string) => {
    await handleDaemonCommand('/mints/info', {
      method: 'POST',
      body: { url },
    });
  });

// NPC - nested subcommands
const npcCmd = program.command('npc').description('NPC operations');

npcCmd
  .command('address')
  .description('Get NPC user address')
  .action(async () => {
    await handleDaemonCommand('/npc/address');
  });

npcCmd
  .command('username <name>')
  .description('Buy/set NPC username')
  .option('--confirm', 'Confirm payment to set username')
  .action(async (name: string, options: { confirm?: boolean }) => {
    await handleDaemonCommand('/npc/username', {
      method: 'POST',
      body: {
        username: name,
        confirm: options.confirm,
      },
    });
  });

// x-cashu - nested subcommands
const xCashuCmd = program.command('x-cashu').description('x-cashu operations');

xCashuCmd
  .command('parse <request>')
  .description('Parse x-cashu request')
  .action(async (request: string) => {
    await handleDaemonCommand('/x-cashu/parse', {
      method: 'POST',
      body: { request },
    });
  });

xCashuCmd
  .command('handle <request>')
  .description('Handle x-cashu request. Returns a X-Cashu header')
  .action(async (request: string) => {
    await handleDaemonCommand('/x-cashu/handle', {
      method: 'POST',
      body: { request },
    });
  });

// History - with pagination and watch options
program
  .command('history')
  .description('Wallet history operations')
  .option('--offset <number>', 'Pagination offset (cannot be combined with --watch)', '0')
  .option('--limit <number>', 'Number of entries to fetch (1-100, default: 20)', '20')
  .option(
    '--watch',
    'Stream history updates in real-time after fetching (can be combined with --limit)',
  )
  .action(async (options: { offset?: string; limit?: string; watch?: boolean }) => {
    const offset = parseInt(options.offset || '0', 10);
    const limit = parseInt(options.limit || '20', 10);

    // Validate: offset and watch cannot be combined
    if (offset > 0 && options.watch) {
      console.error('Error: --offset cannot be combined with --watch');
      process.exit(1);
    }

    // Validate numbers
    if (isNaN(offset) || offset < 0) {
      console.error('Error: --offset must be a non-negative number');
      process.exit(1);
    }

    if (isNaN(limit) || limit < 1 || limit > 100) {
      console.error('Error: --limit must be between 1 and 100');
      process.exit(1);
    }

    // Fetch paginated history first (pass params as query string, not body)
    const queryParams = new URLSearchParams();
    queryParams.set('offset', offset.toString());
    queryParams.set('limit', limit.toString());
    const path = `/history?${queryParams.toString()}`;

    await handleDaemonCommand(path);

    // If watch is enabled, continue streaming after initial fetch
    if (options.watch) {
      try {
        await callDaemonStream('/events', (data) => {
          console.log(JSON.stringify(data));
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exit(1);
      }
    }
  });

// Daemon command - special case, doesn't go through IPC
program
  .command('daemon')
  .description('Start the background daemon')
  .action(async () => {
    requireHostLocalOperation('daemon');
    await startDaemon();
  });

function requireHostLocalOperation(operation: string): void {
  try {
    assertHostLocalOperation(operation);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function printLifecycleStatus(status: LifecycleStatusDocument): void {
  console.log(JSON.stringify(status, null, 2));
}

function printWalletRecoveryMaterial(mnemonic: string, leadingNewline = false): void {
  console.log(
    `${leadingNewline ? '\n' : ''}IMPORTANT: Store this Wallet Recovery Material securely:`,
  );
  console.log(mnemonic);
  console.log('\nAnyone with these words can control the Wallet.');
}

function requireSessionState(
  status: LifecycleStatusDocument,
  expected: 'running' | 'stopped',
): LifecycleStatusDocument {
  if (status.cocoSession.state !== expected) {
    throw new Error(`Coco Session did not reach ${expected}:\n${JSON.stringify(status, null, 2)}`);
  }
  return status;
}

export function cli(args: string[]) {
  program.parse(args);
}
