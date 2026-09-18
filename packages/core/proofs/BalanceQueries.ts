import { Amount } from '@cashu/cashu-ts';
import type { Mint } from '@core/models/Mint.ts';
import type { CoreProof } from '@core/types.ts';
import type {
  BalanceQuery,
  BalanceSnapshot,
  BalancesByMint,
  BalancesByMintAndUnit,
  BalancesByUnit,
} from '@core/types.ts';
import type { ProofUnitFilter } from '@core/repositories/index.ts';
import { DEFAULT_UNIT, normalizeUnit, normalizeUnitList } from '@core/amounts.ts';
import { ProofValidationError } from '@core/models/Error.ts';

export function emptyBalanceSnapshot(unit: string = DEFAULT_UNIT): BalanceSnapshot {
  const normalizedUnit = normalizeUnit(unit, { defaultUnit: DEFAULT_UNIT });
  return {
    spendable: Amount.zero(),
    reserved: Amount.zero(),
    total: Amount.zero(),
    unit: normalizedUnit,
  };
}

/**
 * Read-only balance aggregation over ready proofs and trusted-mint scope. Cannot write
 * repositories, sign, load the Wallet Seed, or perform remote I/O.
 */
export interface BalanceQueries {
  getBalancesByMintAndUnit(scope?: BalanceQuery): Promise<BalancesByMintAndUnit>;
  getBalancesByMint(scope?: BalanceQuery): Promise<BalancesByMint>;
  getBalanceTotal(scope?: BalanceQuery): Promise<BalanceSnapshot>;
  getBalanceTotalByUnit(scope?: BalanceQuery): Promise<BalancesByUnit>;
}

export class StoredBalanceQueries implements BalanceQueries {
  constructor(
    private readonly proofs: {
      getReadyProofs(mintUrl: string, filter?: ProofUnitFilter): Promise<CoreProof[]>;
      getAllReadyProofs(filter?: ProofUnitFilter): Promise<CoreProof[]>;
    },
    private readonly mints: { getAllTrustedMints(): Promise<Mint[]> },
  ) {}

  async getBalancesByMintAndUnit(scope?: BalanceQuery): Promise<BalancesByMintAndUnit> {
    const requestedMintUrls = scope?.mintUrls ? Array.from(new Set(scope.mintUrls)) : undefined;
    const requestedUnits = normalizeUnitList(scope?.units);
    if (requestedUnits && requestedUnits.length === 0) {
      return {};
    }
    const trustedMintUrls = scope?.trustedOnly
      ? new Set((await this.mints.getAllTrustedMints()).map((mint) => mint.mintUrl))
      : undefined;
    const balances: BalancesByMintAndUnit = {};
    const scopedMintUrls = requestedMintUrls?.filter(
      (mintUrl) => !trustedMintUrls || trustedMintUrls.has(mintUrl),
    );
    const proofFilter = requestedUnits ? { units: requestedUnits } : undefined;
    const proofs = scopedMintUrls
      ? (
          await Promise.all(
            scopedMintUrls.map((mintUrl) => this.proofs.getReadyProofs(mintUrl, proofFilter)),
          )
        ).flat()
      : trustedMintUrls
        ? (
            await Promise.all(
              Array.from(trustedMintUrls).map((mintUrl) =>
                this.proofs.getReadyProofs(mintUrl, proofFilter),
              ),
            )
          ).flat()
        : await this.proofs.getAllReadyProofs(proofFilter);

    for (const proof of proofs) {
      const mintUrl = proof.mintUrl;
      if (trustedMintUrls && !trustedMintUrls.has(mintUrl)) {
        continue;
      }

      const unit = normalizeUnit(proof.unit, { defaultUnit: DEFAULT_UNIT });
      const balancesForMint = balances[mintUrl] ?? (balances[mintUrl] = {});
      const balance = balancesForMint[unit] || emptyBalanceSnapshot(unit);
      if (proof.usedByOperationId) {
        balance.reserved = balance.reserved.add(proof.amount);
      } else {
        balance.spendable = balance.spendable.add(proof.amount);
      }
      balance.total = balance.spendable.add(balance.reserved);
      balancesForMint[unit] = balance;
    }

    if (scopedMintUrls && requestedUnits) {
      for (const mintUrl of scopedMintUrls) {
        const balancesForMint = balances[mintUrl] ?? (balances[mintUrl] = {});
        for (const unit of requestedUnits) {
          balancesForMint[unit] ??= emptyBalanceSnapshot(unit);
        }
      }
    }

    return balances;
  }

  async getBalancesByMint(scope?: BalanceQuery): Promise<BalancesByMint> {
    const unit = this.getSingleBalanceUnit(scope, 'getBalancesByMint');
    if (unit === undefined) {
      return {};
    }
    const balancesByMintAndUnit = await this.getBalancesByMintAndUnit({
      ...scope,
      units: [unit],
    });

    return Object.fromEntries(
      Object.entries(balancesByMintAndUnit).map(([mintUrl, balancesByUnit]) => [
        mintUrl,
        balancesByUnit[unit] ?? emptyBalanceSnapshot(unit),
      ]),
    );
  }

  async getBalanceTotal(scope?: BalanceQuery): Promise<BalanceSnapshot> {
    const unit = this.getSingleBalanceUnit(scope, 'getBalanceTotal');
    if (unit === undefined) {
      return emptyBalanceSnapshot();
    }
    const balances = await this.getBalancesByMint(scope);
    return Object.values(balances).reduce<BalanceSnapshot>(
      (total, balance) => ({
        spendable: total.spendable.add(balance.spendable),
        reserved: total.reserved.add(balance.reserved),
        total: total.total.add(balance.total),
        unit,
      }),
      emptyBalanceSnapshot(unit),
    );
  }

  async getBalanceTotalByUnit(scope?: BalanceQuery): Promise<BalancesByUnit> {
    const requestedUnits = normalizeUnitList(scope?.units);
    if (requestedUnits && requestedUnits.length === 0) {
      return {};
    }
    const balancesByMintAndUnit = await this.getBalancesByMintAndUnit(scope);
    const totals: BalancesByUnit = {};

    for (const balancesByUnit of Object.values(balancesByMintAndUnit)) {
      for (const [unit, balance] of Object.entries(balancesByUnit)) {
        const total = totals[unit] ?? emptyBalanceSnapshot(unit);
        total.spendable = total.spendable.add(balance.spendable);
        total.reserved = total.reserved.add(balance.reserved);
        total.total = total.total.add(balance.total);
        totals[unit] = total;
      }
    }

    if (requestedUnits) {
      for (const unit of requestedUnits) {
        totals[unit] ??= emptyBalanceSnapshot(unit);
      }
    }

    return totals;
  }

  private getSingleBalanceUnit(
    scope: BalanceQuery | undefined,
    caller: string,
  ): string | undefined {
    const units = normalizeUnitList(scope?.units);
    if (!units) {
      return DEFAULT_UNIT;
    }
    if (units.length === 0) {
      return undefined;
    }
    if (units.length > 1) {
      throw new ProofValidationError(
        `${caller} cannot aggregate multiple units; use getBalanceTotalByUnit or getBalancesByMintAndUnit`,
      );
    }
    return units[0]!;
  }
}
