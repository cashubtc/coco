import type { ProofService } from '@core/services';
import type {
  BalanceQuery,
  BalanceSnapshot,
  BalancesByMint,
  BalancesByMintAndUnit,
  BalancesByUnit,
} from '../types';

export class WalletBalancesApi {
  private readonly proofService: ProofService;

  constructor(proofService: ProofService) {
    this.proofService = proofService;
  }

  async byMint(scope?: BalanceQuery): Promise<BalancesByMint> {
    return this.proofService.getBalancesByMint(scope);
  }

  async byMintAndUnit(scope?: BalanceQuery): Promise<BalancesByMintAndUnit> {
    return this.proofService.getBalancesByMintAndUnit(scope);
  }

  async byUnit(scope?: BalanceQuery): Promise<BalancesByUnit> {
    return this.proofService.getBalancesByUnit(scope);
  }

  async total(scope?: BalanceQuery): Promise<BalanceSnapshot> {
    return this.proofService.getBalanceTotal(scope);
  }

  async totalByUnit(scope?: BalanceQuery): Promise<BalancesByUnit> {
    return this.proofService.getBalanceTotalByUnit(scope);
  }
}
