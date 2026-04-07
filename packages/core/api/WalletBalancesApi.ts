import type { ProofService } from '@core/services';
import type { BalanceQuery, BalanceSnapshot, BalancesByMint } from '../types';

export class WalletBalancesApi {
  private readonly proofService: ProofService;

  constructor(proofService: ProofService) {
    this.proofService = proofService;
  }

  async byMint(scope?: BalanceQuery): Promise<BalancesByMint> {
    return this.proofService.getBalancesByMint(scope);
  }

  async total(scope?: BalanceQuery): Promise<BalanceSnapshot> {
    return this.proofService.getBalanceTotal(scope);
  }
}
