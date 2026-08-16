import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  CocoInitializationError,
  normalizeMintUrl,
  type Logger,
  type Manager,
} from '@cashu/coco-core';
import type { NPCAccountApi } from 'coco-cashu-plugin-npc';

import { CONFIG_FILE, SALT_FILE, type WalletConfig } from './utils/config.js';
import { decryptMnemonic, encryptMnemonic } from './utils/crypto.js';
import {
  CocoSessionStartupError,
  initializeWallet as initializeCocoSession,
} from './utils/wallet.js';
import { ensurePrivateStateDirectory, ensureSecretFile, writeSecretFile } from './utils/files.js';

export type CocoSessionState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export interface CocodStatus {
  wallet: {
    configuredAt: string;
    mintUrl: string;
  } | null;
  seedAccess: {
    state: 'locked' | 'available';
    requiresPassphrase: boolean;
  } | null;
  cocoSession: {
    state: CocoSessionState;
    startedAt: string | null;
    lastFailure: {
      code: string;
      message: string;
      occurredAt: string;
    } | null;
  };
}

export interface RunningCocoSession {
  manager: Manager;
  mintUrl: string;
  npcAccount: NPCAccountApi;
}

export interface InitializeWalletInput {
  mnemonic?: string;
  passphrase?: string;
  mintUrl?: string;
}

export interface InitializeWalletResult {
  mnemonic: string;
  requiresPassphrase: boolean;
}

export interface SessionStartTransition {
  /** Resolves after Seed Access is acquired and the session enters `starting`. */
  accepted: Promise<void>;
  /** Resolves after the session reaches `running`. */
  completion: Promise<void>;
}

interface CocodRuntimeOptions {
  configFile?: string;
  saltFile?: string;
  logger?: Logger;
  initializeSession?: (
    config: WalletConfig,
    passphrase: string | undefined,
    logger: Logger | undefined,
  ) => Promise<RunningCocoSession>;
}

export class CocodRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CocodRuntimeError';
  }
}

/**
 * Owns cocod's Wallet, Wallet Seed Access, and Coco Session lifecycle independently of transport.
 */
export class CocodRuntime {
  private readonly configFile: string;
  private readonly saltFile: string;
  private readonly logger?: Logger;
  private readonly initializeSession: NonNullable<CocodRuntimeOptions['initializeSession']>;

  private walletConfig: WalletConfig | null = null;
  private seedAccessAvailable = false;
  private session: RunningCocoSession | null = null;
  private sessionState: CocoSessionState = 'stopped';
  private startedAt: string | null = null;
  private lastFailure: CocodStatus['cocoSession']['lastFailure'] = null;
  private initializeInProgress = false;
  private startTransition: SessionStartTransition | null = null;
  private stopPromise: Promise<void> | null = null;

  private constructor(options: CocodRuntimeOptions = {}) {
    this.configFile = options.configFile ?? CONFIG_FILE;
    this.saltFile = options.saltFile ?? SALT_FILE;
    this.logger = options.logger;
    this.initializeSession = options.initializeSession ?? initializeCocoSession;
  }

  static async load(options: CocodRuntimeOptions = {}): Promise<CocodRuntime> {
    const runtime = new CocodRuntime(options);
    await runtime.loadWalletConfiguration();
    return runtime;
  }

  getStatus(): CocodStatus {
    const config = this.walletConfig;
    return {
      wallet: config
        ? {
            configuredAt: config.createdAt,
            mintUrl: config.mintUrl,
          }
        : null,
      seedAccess: config
        ? {
            state: this.seedAccessAvailable ? 'available' : 'locked',
            requiresPassphrase: config.encrypted,
          }
        : null,
      cocoSession: {
        state: this.sessionState,
        startedAt: this.startedAt,
        lastFailure: this.lastFailure,
      },
    };
  }

  getRunningSession(): RunningCocoSession | null {
    return this.sessionState === 'running' ? this.session : null;
  }

  async initializeWallet(input: InitializeWalletInput): Promise<InitializeWalletResult> {
    if (this.walletConfig || this.initializeInProgress) {
      throw new CocodRuntimeError('wallet_already_configured', 'Wallet already initialized');
    }

    const mnemonic = input.mnemonic ?? generateMnemonic(wordlist, 256);
    if (!validateMnemonic(mnemonic, wordlist)) {
      throw new CocodRuntimeError('invalid_mnemonic', 'Invalid mnemonic');
    }

    this.initializeInProgress = true;
    try {
      const passphrase = input.passphrase || undefined;
      const mintUrl = normalizeConfiguredMintUrl(
        input.mintUrl || 'https://mint.minibits.cash/Bitcoin',
      );
      const createdAt = new Date().toISOString();
      let config: WalletConfig;

      if (passphrase) {
        const { ciphertext, salt } = await encryptMnemonic(mnemonic, passphrase);
        await writeSecretFile(this.saltFile, salt);
        config = {
          version: 1,
          mnemonic: ciphertext,
          encrypted: true,
          mintUrl,
          createdAt,
        };
      } else {
        config = {
          version: 1,
          mnemonic,
          encrypted: false,
          mintUrl,
          createdAt,
        };
      }

      await writeSecretFile(this.configFile, JSON.stringify(config, null, 2));
      this.walletConfig = config;
      this.seedAccessAvailable = !config.encrypted;
      this.lastFailure = null;

      if (!config.encrypted) {
        await this.startSession().completion;
      }

      return { mnemonic, requiresPassphrase: config.encrypted };
    } finally {
      this.initializeInProgress = false;
    }
  }

  startSession(input: { passphrase?: string } = {}): SessionStartTransition {
    if (!this.walletConfig) {
      throw new CocodRuntimeError('wallet_not_configured', 'Wallet is not initialized');
    }
    if (this.sessionState === 'running') {
      return completedStartTransition();
    }
    if (this.sessionState === 'stopping') {
      throw new CocodRuntimeError('session_transition_in_progress', 'Coco Session is stopping');
    }
    if (this.startTransition) {
      return this.startTransition;
    }
    if (this.sessionState === 'failed') {
      throw new CocodRuntimeError('session_restart_required', 'Cocod process restart required');
    }
    if (this.walletConfig.encrypted && !input.passphrase) {
      throw new CocodRuntimeError(
        'passphrase_required',
        'Passphrase required for encrypted wallet',
      );
    }

    this.startedAt = null;
    const config = this.walletConfig;
    if (!config.encrypted) {
      this.sessionState = 'starting';
    }

    const preparedConfig = config.encrypted
      ? this.acquireSeedAccess(config, input.passphrase!)
      : Promise.resolve(config);
    const accepted = preparedConfig.then(() => undefined);
    void accepted.catch(() => {});
    const transition: SessionStartTransition = {
      accepted,
      completion: Promise.resolve(),
    };
    transition.completion = preparedConfig
      .then((sessionConfig) => this.initializeSession(sessionConfig, undefined, this.logger))
      .then((session) => {
        this.session = session;
        if (!this.stopPromise) {
          this.sessionState = 'running';
          this.startedAt = new Date().toISOString();
          this.lastFailure = null;
        }
      })
      .catch((error: unknown) => {
        const cleanupUnconfirmed = cleanupWasUnconfirmed(error);
        const unlockFailed =
          error instanceof CocodRuntimeError && error.code === 'wallet_unlock_failed';
        this.session = null;
        this.sessionState = cleanupUnconfirmed ? 'failed' : 'stopped';
        if (config.encrypted) {
          this.seedAccessAvailable = false;
        }
        this.startedAt = null;
        if (!unlockFailed) {
          this.lastFailure = {
            code: 'session_start_failed',
            message: 'Coco Session failed to start',
            occurredAt: new Date().toISOString(),
          };
        }
        throw error;
      })
      .finally(() => {
        this.startTransition = null;
      });

    this.startTransition = transition;
    return transition;
  }

  stopSession(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    if (this.sessionState === 'stopped' && !this.startTransition) {
      return Promise.resolve();
    }
    if (this.sessionState === 'failed') {
      return Promise.reject(
        new CocodRuntimeError('session_restart_required', 'Cocod process restart required'),
      );
    }

    if (this.startTransition) {
      this.sessionState = 'stopping';
    }
    const stop = this.stopAfterPendingStart().finally(() => {
      this.stopPromise = null;
    });
    this.stopPromise = stop;
    return stop;
  }

  async dispose(): Promise<void> {
    if (this.sessionState === 'failed') {
      if (this.session) {
        await this.session.manager.dispose();
      }
      return;
    }
    await this.stopSession();
  }

  private async loadWalletConfiguration(): Promise<void> {
    await ensurePrivateStateDirectory(this.configFile);
    if (!(await Bun.file(this.configFile).exists())) {
      return;
    }

    await ensureSecretFile(this.configFile);
    const contents = await Bun.file(this.configFile).text();
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch (error) {
      throw new CocodRuntimeError('invalid_wallet_config', 'Invalid Wallet configuration', {
        cause: error,
      });
    }
    const parsed = parseWalletConfig(value);
    if (parsed.encrypted && !(await Bun.file(this.saltFile).exists())) {
      throw new CocodRuntimeError(
        'invalid_wallet_config',
        'Encrypted Wallet configuration is missing its salt',
      );
    }
    if (parsed.encrypted) {
      await ensureSecretFile(this.saltFile);
      const salt = await Bun.file(this.saltFile).text();
      if (!isCanonicalBase64(salt, 16, 16)) {
        throw new CocodRuntimeError('invalid_wallet_config', 'Invalid Wallet encryption salt');
      }
    }

    this.walletConfig = parsed;
    this.seedAccessAvailable = !parsed.encrypted;
  }

  private async acquireSeedAccess(config: WalletConfig, passphrase: string): Promise<WalletConfig> {
    try {
      const salt = await Bun.file(this.saltFile).text();
      const mnemonic = await decryptMnemonic(config.mnemonic, passphrase, salt);
      this.seedAccessAvailable = true;
      if (!this.stopPromise) {
        this.sessionState = 'starting';
      }
      return { ...config, mnemonic, encrypted: false };
    } catch (error) {
      throw new CocodRuntimeError('wallet_unlock_failed', 'Wallet unlock failed', {
        cause: error,
      });
    }
  }

  private async stopAfterPendingStart(): Promise<void> {
    if (this.startTransition) {
      try {
        await this.startTransition.completion;
      } catch {
        return;
      }
    }

    if (!this.session) {
      this.sessionState = 'stopped';
      this.startedAt = null;
      return;
    }

    this.sessionState = 'stopping';
    try {
      await this.session.manager.dispose();
      this.session = null;
      this.sessionState = 'stopped';
      this.seedAccessAvailable = this.walletConfig?.encrypted === false;
      this.startedAt = null;
    } catch (error) {
      this.sessionState = 'failed';
      this.lastFailure = {
        code: 'session_stop_failed',
        message: 'Coco Session failed to stop cleanly',
        occurredAt: new Date().toISOString(),
      };
      throw error;
    }
  }
}

function parseWalletConfig(value: unknown): WalletConfig {
  if (!value || typeof value !== 'object') {
    throw invalidWalletConfig();
  }
  const config = value as Partial<WalletConfig>;
  if (
    config.version !== 1 ||
    typeof config.mnemonic !== 'string' ||
    typeof config.encrypted !== 'boolean' ||
    typeof config.mintUrl !== 'string' ||
    typeof config.createdAt !== 'string' ||
    !isRfc3339Utc(config.createdAt)
  ) {
    throw invalidWalletConfig();
  }
  if (config.encrypted) {
    if (!isCanonicalBase64(config.mnemonic, 28)) {
      throw invalidWalletConfig();
    }
  } else if (!validateMnemonic(config.mnemonic, wordlist)) {
    throw invalidWalletConfig();
  }

  return {
    version: 1,
    mnemonic: config.mnemonic,
    encrypted: config.encrypted,
    mintUrl: normalizeConfiguredMintUrl(config.mintUrl, 'invalid_wallet_config'),
    createdAt: config.createdAt,
  };
}

function cleanupWasUnconfirmed(error: unknown): boolean {
  return (
    (error instanceof CocoInitializationError || error instanceof CocoSessionStartupError) &&
    error.cleanupState === 'unconfirmed'
  );
}

function completedStartTransition(): SessionStartTransition {
  const completed = Promise.resolve();
  return { accepted: completed, completion: completed };
}

function normalizeConfiguredMintUrl(value: string, code = 'invalid_mint_url'): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Mint URL must use HTTP or HTTPS');
    }
    return normalizeMintUrl(value);
  } catch (error) {
    throw new CocodRuntimeError(code, 'Invalid mint URL', { cause: error });
  }
}

function invalidWalletConfig(): CocodRuntimeError {
  return new CocodRuntimeError('invalid_wallet_config', 'Invalid Wallet configuration');
}

function isRfc3339Utc(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return false;
  }
  return new Date(value).toISOString() === value;
}

function isCanonicalBase64(value: string, minimumBytes: number, exactBytes?: number): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64');
  return (
    decoded.length >= minimumBytes &&
    (exactBytes === undefined || decoded.length === exactBytes) &&
    decoded.toString('base64') === value
  );
}
