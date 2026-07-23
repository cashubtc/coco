import { Amount, type AmountLike } from '@cashu/cashu-ts';
import {
  KeysetSyncError,
  MintFetchError,
  ProofValidationError,
  UnknownMintError,
} from '../models/Error';
import type { Mint } from '../models/Mint';
import type { Keyset } from '../models/Keyset';
import type { MintAdapter } from '../infra/MintAdapter';
import type { KeysetRepository, MintRepository } from '../repositories';
import { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type { MintInfo } from '../types';
import type { Logger } from '../logging/Logger.ts';
import { normalizeMintUrl } from '../utils';
import { DEFAULT_UNIT, normalizeUnit, normalizeUnitAmount, type UnitAmount } from '../amounts.ts';

const MINT_REFRESH_TTL_S = 60 * 5;

function supportsNut29MintQuoteCheckFromInfo(mintInfo: MintInfo, method: string): boolean {
  const nuts = mintInfo.nuts as unknown;
  if (!nuts || typeof nuts !== 'object') return false;

  const nut29 = (nuts as Record<string, unknown>)['29'];
  if (!nut29 || typeof nut29 !== 'object') return false;
  const methods = (nut29 as { methods?: unknown }).methods;
  if (methods !== undefined) return Array.isArray(methods) && methods.includes(method);

  const nut4 = (nuts as Record<string, unknown>)['4'];
  if (!nut4 || typeof nut4 !== 'object' || (nut4 as { disabled?: unknown }).disabled === true) {
    return false;
  }
  const mintMethods = (nut4 as { methods?: unknown }).methods;
  return (
    Array.isArray(mintMethods) &&
    mintMethods.some(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        (entry as { method?: unknown }).method === method,
    )
  );
}

export interface MethodUnitCapability {
  supported: boolean;
  disabled: boolean;
  nut: 4 | 5;
  method: string;
  unit: string;
  minAmount?: Amount | null;
  maxAmount?: Amount | null;
  options?: unknown;
  legacySatAllowed?: boolean;
  reason?: string;
}

/** Operation side for Payment Method Capability discovery. */
export type PaymentMethodCapabilityOperationKind = 'mint' | 'melt';

/** Input for checking whether one method/unit pair is supported by mint metadata. */
export interface CheckPaymentMethodCapabilityInput {
  mintUrl: string;
  operation: PaymentMethodCapabilityOperationKind;
  method: string;
  unit: string;
}

/** Input for listing actionable Payment Method Capabilities advertised by a mint. */
export interface ListPaymentMethodCapabilitiesInput {
  mintUrl: string;
  operation?: PaymentMethodCapabilityOperationKind;
  unit?: string;
}

/** Actionable Payment Method Capability advertised through enabled NUT-04/NUT-05 metadata. */
export interface PaymentMethodCapability {
  operation: PaymentMethodCapabilityOperationKind;
  nut: 4 | 5;
  method: string;
  unit: string;
  minAmount?: Amount | null;
  maxAmount?: Amount | null;
  options?: unknown;
}

/** Result for a single Payment Method Capability check, including unsupported reasons. */
export interface PaymentMethodCapabilityCheck extends PaymentMethodCapability {
  supported: boolean;
  disabled: boolean;
  reason?: string;
}

type NutMethodSetting = {
  method: string;
  unit: string;
  min_amount?: AmountLike | null;
  max_amount?: AmountLike | null;
  options?: unknown;
};

type NutMethodSettings = {
  methods?: NutMethodSetting[];
  disabled?: boolean;
};

type NutSupportSettings = {
  supported?: boolean;
};

export class MintService {
  private readonly mintRepo: MintRepository;
  private readonly keysetRepo: KeysetRepository;
  private readonly mintAdapter: MintAdapter;
  private readonly eventBus?: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  constructor(
    mintRepo: MintRepository,
    keysetRepo: KeysetRepository,
    mintAdapter: MintAdapter,
    logger?: Logger,
    eventBus?: EventBus<CoreEvents>,
  ) {
    this.mintRepo = mintRepo;
    this.keysetRepo = keysetRepo;
    this.mintAdapter = mintAdapter;
    this.logger = logger;
    this.eventBus = eventBus;
  }

  /**
   * Add a new mint by URL, running a single update cycle to fetch info & keysets.
   * If the mint already exists, it ensures it is updated.
   * New mints are added as untrusted by default unless explicitly specified.
   *
   * @param mintUrl - The URL of the mint to add
   * @param options - Optional configuration
   * @param options.trusted - Whether to add the mint as trusted (default: false)
   */
  async addMintByUrl(
    mintUrl: string,
    options?: { trusted?: boolean },
  ): Promise<{ mint: Mint; keysets: Keyset[] }> {
    mintUrl = normalizeMintUrl(mintUrl);
    const trusted = options?.trusted ?? false;
    this.logger?.info('Adding mint by URL', { mintUrl, trusted });
    const exists = await this.mintRepo.getMintByUrl(mintUrl).catch(() => null);

    if (exists) {
      // If trusted option was explicitly provided and differs from current state, update it
      if (options?.trusted !== undefined && exists.trusted !== options.trusted) {
        await this.mintRepo.setMintTrusted(mintUrl, options.trusted);
        this.logger?.info('Updated mint trust status', { mintUrl, trusted: options.trusted });
        // Emit trust change events
        if (options.trusted) {
          await this.eventBus?.emit('mint:trusted', { mintUrl });
        } else {
          await this.eventBus?.emit('mint:untrusted', { mintUrl });
        }
        const updated = await this.ensureUpdatedMint(mintUrl);
        await this.eventBus?.emit('mint:updated', updated);
        return updated;
      }
      return this.ensureUpdatedMint(mintUrl);
    }

    const now = Math.floor(Date.now() / 1000);
    const newMint: Mint = {
      mintUrl,
      name: mintUrl,
      mintInfo: {} as MintInfo,
      trusted,
      createdAt: now,
      updatedAt: 0,
    };
    // Do not persist before successful sync; updateMint will persist on success
    const added = await this.updateMint(newMint);
    await this.eventBus?.emit('mint:added', added);
    this.logger?.info('Mint added', { mintUrl, trusted });
    return added;
  }

  async updateMintData(mintUrl: string): Promise<{ mint: Mint; keysets: Keyset[] }> {
    mintUrl = normalizeMintUrl(mintUrl);
    const mint = await this.mintRepo.getMintByUrl(mintUrl).catch(() => null);
    if (!mint) {
      // Mint doesn't exist, create it as untrusted
      const now = Math.floor(Date.now() / 1000);
      const newMint: Mint = {
        mintUrl,
        name: mintUrl,
        mintInfo: {} as MintInfo,
        trusted: false,
        createdAt: now,
        updatedAt: 0,
      };
      return this.updateMint(newMint);
    }
    return this.updateMint(mint);
  }

  async isTrustedMint(mintUrl: string): Promise<boolean> {
    return await this.mintRepo.isTrustedMint(normalizeMintUrl(mintUrl));
  }

  /**
   * Get a known mint and its cached keysets without any mint interaction.
   * Returns null when the mint is not known locally.
   */
  async getKnownMintWithKeysets(
    mintUrl: string,
  ): Promise<{ mint: Mint; keysets: Keyset[] } | null> {
    mintUrl = normalizeMintUrl(mintUrl);
    const mint = await this.mintRepo.getMintByUrl(mintUrl).catch(() => null);
    if (!mint) {
      return null;
    }
    const keysets = await this.keysetRepo.getKeysetsByMintUrl(mint.mintUrl);
    return { mint, keysets };
  }

  async ensureUpdatedMint(mintUrl: string): Promise<{ mint: Mint; keysets: Keyset[] }> {
    mintUrl = normalizeMintUrl(mintUrl);
    let mint = await this.mintRepo.getMintByUrl(mintUrl).catch(() => null);

    if (!mint) {
      // Mint doesn't exist, create it as untrusted
      const now = Math.floor(Date.now() / 1000);
      mint = {
        mintUrl,
        name: mintUrl,
        mintInfo: {} as MintInfo,
        trusted: false,
        createdAt: now,
        updatedAt: 0,
      };
    }

    const now = Math.floor(Date.now() / 1000);
    if (mint.updatedAt < now - MINT_REFRESH_TTL_S) {
      this.logger?.debug('Refreshing stale mint', { mintUrl });
      const updated = await this.updateMint(mint);
      await this.eventBus?.emit('mint:updated', updated);
      return updated;
    }

    const keysets = await this.keysetRepo.getKeysetsByMintUrl(mint.mintUrl);
    return { mint, keysets };
  }

  async deleteMint(mintUrl: string): Promise<void> {
    mintUrl = normalizeMintUrl(mintUrl);
    const mint = await this.mintRepo.getMintByUrl(mintUrl).catch(() => null);
    if (!mint) return;

    const keysets = await this.keysetRepo.getKeysetsByMintUrl(mintUrl);
    await Promise.all(keysets.map((ks) => this.keysetRepo.deleteKeyset(mintUrl, ks.id)));
    await this.mintRepo.deleteMint(mintUrl);
  }

  async getMintInfo(mintUrl: string): Promise<MintInfo> {
    // ensureUpdatedMint already normalizes, but normalize here for consistency
    const { mint } = await this.ensureUpdatedMint(normalizeMintUrl(mintUrl));
    return mint.mintInfo;
  }

  /**
   * Returns whether a mint advertises support for a top-level NUT capability.
   *
   * This currently supports NUT-11 checks only. Mint information is resolved via
   * `getMintInfo()`, so stale local records may be refreshed and fetch failures
   * propagate to the caller. Missing, malformed, or disabled settings return
   * `false` rather than throwing.
   */
  async supportsNut(mintUrl: string, nut: 11): Promise<boolean> {
    this.assertSupportCapabilityNut(nut);
    const normalizedMintUrl = normalizeMintUrl(mintUrl);
    const mintInfo = await this.getMintInfo(normalizedMintUrl);
    const settings = this.getNutSupportSettings(mintInfo, nut);
    return settings?.supported === true;
  }

  /**
   * Returns whether a mint advertises NUT-29 mint quote checks for a payment method.
   *
   * When NUT-29 omits its optional method list, enabled NUT-04 method metadata is
   * used as the source of supported mint methods. Missing or malformed metadata
   * returns `false`; mint-info refresh failures propagate unchanged.
   */
  async supportsNut29MintQuoteCheck(mintUrl: string, method: string): Promise<boolean> {
    const mintInfo = await this.getMintInfo(normalizeMintUrl(mintUrl));
    return supportsNut29MintQuoteCheckFromInfo(mintInfo, method);
  }

  /**
   * Returns the bounded NUT-29 mint quote check limit for one polling group.
   *
   * Unsupported methods and malformed advertised limits use one quote per polling
   * opportunity. An omitted limit uses Coco's protocol safety cap of 100.
   */
  async getNut29MintQuoteCheckLimit(mintUrl: string, method: string): Promise<number> {
    const mintInfo = await this.getMintInfo(normalizeMintUrl(mintUrl));
    if (!supportsNut29MintQuoteCheckFromInfo(mintInfo, method)) return 1;

    const nuts = mintInfo.nuts as unknown as Record<string, unknown>;
    const maxBatchSize = (nuts['29'] as { max_batch_size?: unknown }).max_batch_size;
    if (maxBatchSize === undefined) return 100;
    if (!Number.isSafeInteger(maxBatchSize) || Number(maxBatchSize) < 1) return 1;
    return Math.min(Number(maxBatchSize), 100);
  }

  /**
   * Requires a mint to advertise a top-level NUT capability.
   *
   * This currently supports NUT-11 checks only. Returns when support is
   * advertised, throws `ProofValidationError` when support is absent, and lets
   * mint-info refresh/fetch failures propagate unchanged.
   */
  async assertNutSupported(mintUrl: string, nut: 11, scope?: string): Promise<void> {
    if (await this.supportsNut(mintUrl, nut)) {
      return;
    }

    const context = scope ? ` for ${scope}` : '';
    throw new ProofValidationError(
      `${this.formatNut(nut)} support is required${context} but is not advertised by mint ${normalizeMintUrl(mintUrl)}`,
    );
  }

  async checkPaymentMethodCapability(
    input: CheckPaymentMethodCapabilityInput,
  ): Promise<PaymentMethodCapabilityCheck> {
    const operation = this.assertPaymentMethodCapabilityOperation(input.operation);
    const nut = this.nutForPaymentMethodCapabilityOperation(operation);
    const capability = await this.getMintMethodUnitCapability(
      input.mintUrl,
      nut,
      input.method,
      input.unit,
    );

    return {
      ...capability,
      operation,
    };
  }

  async getMintMethodUnitCapability(
    mintUrl: string,
    nut: 4 | 5,
    method: string,
    unit: string,
  ): Promise<MethodUnitCapability> {
    this.assertMethodCapabilityNut(nut);
    const normalizedMintUrl = normalizeMintUrl(mintUrl);
    const normalizedUnit = normalizeUnit(unit, { defaultUnit: DEFAULT_UNIT });
    const mintInfo = await this.getMintInfo(normalizedMintUrl);
    const settings = this.getNutMethodSettings(mintInfo, nut);
    const nutName = this.formatNut(nut);

    if (settings?.disabled === true) {
      return {
        supported: false,
        disabled: true,
        nut,
        method,
        unit: normalizedUnit,
        reason: `${nutName} is disabled`,
      };
    }

    if (!settings || !Array.isArray(settings.methods)) {
      return {
        supported: false,
        disabled: false,
        nut,
        method,
        unit: normalizedUnit,
        reason: `${nutName} method metadata is missing`,
      };
    }

    const matchingMethod = settings.methods.find((entry) => {
      try {
        return entry.method === method && normalizeUnit(entry.unit) === normalizedUnit;
      } catch {
        return false;
      }
    });

    if (!matchingMethod) {
      return {
        supported: false,
        disabled: false,
        nut,
        method,
        unit: normalizedUnit,
        reason: `${nutName} method ${method} does not support unit ${normalizedUnit}`,
      };
    }

    return {
      supported: true,
      disabled: false,
      nut,
      method,
      unit: normalizedUnit,
      minAmount: this.parseOptionalAmount(matchingMethod.min_amount),
      maxAmount: this.parseOptionalAmount(matchingMethod.max_amount),
      options: matchingMethod.options,
    };
  }

  async listPaymentMethodCapabilities(
    input: ListPaymentMethodCapabilitiesInput,
  ): Promise<PaymentMethodCapability[]> {
    const operations =
      input.operation === undefined
        ? (['mint', 'melt'] as const)
        : [this.assertPaymentMethodCapabilityOperation(input.operation)];
    const unitFilter = input.unit === undefined ? undefined : normalizeUnit(input.unit);
    const mintInfo = await this.getMintInfo(input.mintUrl);
    const capabilities: PaymentMethodCapability[] = [];

    for (const operation of operations) {
      const nut = this.nutForPaymentMethodCapabilityOperation(operation);
      const settings = this.getNutMethodSettings(mintInfo, nut);
      if (!settings || settings.disabled === true || !Array.isArray(settings.methods)) {
        continue;
      }

      for (const entry of settings.methods) {
        let unit: string;
        try {
          unit = normalizeUnit(entry.unit);
        } catch {
          continue;
        }
        if (unitFilter !== undefined && unit !== unitFilter) continue;

        capabilities.push({
          operation,
          nut,
          method: entry.method,
          unit,
          minAmount: this.parseOptionalAmount(entry.min_amount),
          maxAmount: this.parseOptionalAmount(entry.max_amount),
          options: entry.options,
        });
      }
    }

    return capabilities;
  }

  async assertMethodUnitSupported(
    mintUrl: string,
    nut: 4 | 5,
    method: string,
    scope: string | UnitAmount,
  ): Promise<void> {
    let unit: string;
    let requestedAmount: Amount | undefined;
    if (typeof scope === 'string') {
      unit = scope;
    } else {
      const intent = normalizeUnitAmount(scope);
      unit = intent.unit;
      requestedAmount = intent.amount;
    }
    const capability = await this.getMintMethodUnitCapability(mintUrl, nut, method, unit);
    if (!capability.supported) {
      throw new ProofValidationError(
        capability.reason ??
          `${this.formatNut(nut)} method ${method} does not support unit ${capability.unit}`,
      );
    }

    if (requestedAmount === undefined) return;

    const amountRequirement = `${this.formatNut(nut)} method ${method} unit ${capability.unit}`;
    if (capability.minAmount && requestedAmount.lessThan(capability.minAmount)) {
      throw new ProofValidationError(
        `${amountRequirement} requires amount >= ${capability.minAmount}`,
      );
    }
    if (capability.maxAmount && requestedAmount.greaterThan(capability.maxAmount)) {
      throw new ProofValidationError(
        `${amountRequirement} requires amount <= ${capability.maxAmount}`,
      );
    }
  }

  async getAllMints(): Promise<Mint[]> {
    const mints = await this.mintRepo.getAllMints();
    return mints;
  }

  async getAllTrustedMints(): Promise<Mint[]> {
    const mints = await this.mintRepo.getAllTrustedMints();
    return mints;
  }

  async trustMint(mintUrl: string): Promise<void> {
    mintUrl = normalizeMintUrl(mintUrl);
    this.logger?.info('Trusting mint', { mintUrl });
    await this.mintRepo.setMintTrusted(mintUrl, true);
    await this.eventBus?.emit('mint:trusted', { mintUrl });
    await this.eventBus?.emit('mint:updated', await this.ensureUpdatedMint(mintUrl));
  }

  async untrustMint(mintUrl: string): Promise<void> {
    mintUrl = normalizeMintUrl(mintUrl);
    this.logger?.info('Untrusting mint', { mintUrl });
    await this.mintRepo.setMintTrusted(mintUrl, false);
    await this.eventBus?.emit('mint:untrusted', { mintUrl });
    await this.eventBus?.emit('mint:updated', await this.ensureUpdatedMint(mintUrl));
  }

  private getNutMethodSettings(mintInfo: MintInfo, nut: 4 | 5): NutMethodSettings | undefined {
    const nuts = mintInfo.nuts as Record<string, unknown> | undefined;
    return nuts?.[String(nut)] as NutMethodSettings | undefined;
  }

  private getNutSupportSettings(mintInfo: MintInfo, nut: 11): NutSupportSettings | undefined {
    const nuts = mintInfo.nuts as Record<string, unknown> | undefined;
    const settings = nuts?.[String(nut)];
    if (!settings || typeof settings !== 'object') {
      return undefined;
    }
    return settings as NutSupportSettings;
  }

  private assertMethodCapabilityNut(nut: number): asserts nut is 4 | 5 {
    if (nut !== 4 && nut !== 5) {
      throw new ProofValidationError(
        `NUT-${nut} does not define method-unit capabilities; use NUT-04 or NUT-05 method metadata`,
      );
    }
  }

  private assertSupportCapabilityNut(nut: number): asserts nut is 11 {
    if (nut !== 11) {
      throw new ProofValidationError(`NUT-${nut} support capability checks are not implemented`);
    }
  }

  private formatNut(nut: number): string {
    return `NUT-${String(nut).padStart(2, '0')}`;
  }

  private assertPaymentMethodCapabilityOperation(
    operation: string,
  ): PaymentMethodCapabilityOperationKind {
    if (operation !== 'mint' && operation !== 'melt') {
      throw new ProofValidationError(
        `Invalid payment method capability operation ${operation}; use mint or melt`,
      );
    }
    return operation;
  }

  private nutForPaymentMethodCapabilityOperation(
    operation: PaymentMethodCapabilityOperationKind,
  ): 4 | 5 {
    return operation === 'mint' ? 4 : 5;
  }

  private parseOptionalAmount(amount: AmountLike | null | undefined): Amount | null {
    return amount === undefined || amount === null ? null : Amount.from(amount);
  }

  private async updateMint(mint: Mint): Promise<{ mint: Mint; keysets: Keyset[] }> {
    let mintInfo;
    try {
      this.logger?.debug('Fetching mint info', { mintUrl: mint.mintUrl });
      mintInfo = await this.mintAdapter.fetchMintInfo(mint.mintUrl);
    } catch (err) {
      this.logger?.error('Failed to fetch mint info', { mintUrl: mint.mintUrl, err });
      throw new MintFetchError(mint.mintUrl, undefined, err);
    }

    let keysets;
    try {
      this.logger?.debug('Fetching keysets', { mintUrl: mint.mintUrl });
      ({ keysets } = await this.mintAdapter.fetchKeysets(mint.mintUrl));
    } catch (err) {
      this.logger?.error('Failed to fetch keysets', { mintUrl: mint.mintUrl, err });
      throw new MintFetchError(mint.mintUrl, 'Failed to fetch keysets', err);
    }
    await Promise.all(
      keysets.map(async (ks) => {
        const existingKeyset = await this.keysetRepo.getKeysetById(mint.mintUrl, ks.id);
        if (existingKeyset) {
          const keysetModel: Omit<Keyset, 'keypairs' | 'updatedAt'> = {
            mintUrl: mint.mintUrl,
            id: ks.id,
            unit: ks.unit,
            active: ks.active,
            feePpk: ks.input_fee_ppk || 0,
          };
          return this.keysetRepo.updateKeyset(keysetModel);
        } else {
          try {
            const keysRes = await this.mintAdapter.fetchKeysForId(mint.mintUrl, ks.id);
            return this.keysetRepo.addKeyset({
              mintUrl: mint.mintUrl,
              id: ks.id,
              unit: ks.unit,
              keypairs: keysRes,
              active: ks.active,
              feePpk: ks.input_fee_ppk || 0,
            });
          } catch (err) {
            this.logger?.error('Failed to sync keyset', {
              mintUrl: mint.mintUrl,
              keysetId: ks.id,
              err,
            });
            throw new KeysetSyncError(mint.mintUrl, ks.id, undefined, err);
          }
        }
      }),
    );

    // Persist mint updates only after successful fetch and keyset sync
    mint.mintInfo = mintInfo;
    mint.updatedAt = Math.floor(Date.now() / 1000);
    await this.mintRepo.addOrUpdateMint(mint);
    await this.eventBus?.emit('mint:metadata-refreshed', { mintUrl: mint.mintUrl });

    const repoKeysets = await this.keysetRepo.getKeysetsByMintUrl(mint.mintUrl);
    this.logger?.info('Mint updated', { mintUrl: mint.mintUrl, keysets: repoKeysets.length });
    return { mint, keysets: repoKeysets };
  }
}
