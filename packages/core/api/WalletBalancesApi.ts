import type { BalanceQueries } from '@core/proofs/BalanceQueries.ts';
import type {
  BalanceQuery,
  BalanceSnapshot,
  BalancesByMint,
  BalancesByMintAndUnit,
  BalancesByUnit,
} from '../types';

export class WalletBalancesApi {
  private readonly balanceQueries: BalanceQueries;

  constructor(balanceQueries: BalanceQueries) {
    this.balanceQueries = balanceQueries;
  }

  async byMint(scope?: BalanceQuery): Promise<BalancesByMint> {
    return this.balanceQueries.getBalancesByMint(scope);
  }

  async byMintAndUnit(scope?: BalanceQuery): Promise<BalancesByMintAndUnit> {
    return this.balanceQueries.getBalancesByMintAndUnit(scope);
  }

  async byUnit(scope?: BalanceQuery): Promise<BalancesByUnit> {
    return this.balanceQueries.getBalanceTotalByUnit(scope);
  }

  async total(scope?: BalanceQuery): Promise<BalanceSnapshot> {
    return this.balanceQueries.getBalanceTotal(scope);
  }

  async totalByUnit(scope?: BalanceQuery): Promise<BalancesByUnit> {
    return this.balanceQueries.getBalanceTotalByUnit(scope);
  }
}
