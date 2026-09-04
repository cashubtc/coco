import { describe, expect, it } from 'bun:test';
import {
  checkTransactionArchitecture,
  loadCoreSourceModules,
  TRANSACTION_ARCHITECTURE_ALLOWLIST,
  type AllowlistedTransactionImport,
  type SourceModule,
  type TransactionArchitectureRule,
} from '../../../../scripts/check-transaction-architecture.ts';

describe('transaction architecture imports', () => {
  it('rejects every forbidden dependency category', () => {
    const cases: Array<{
      module: SourceModule;
      rule: TransactionArchitectureRule;
    }> = [
      {
        module: {
          path: 'packages/core/transactions/proofs/TransactionalProofOperations.ts',
          sourceText: "import type { ProofService } from '@core/services/ProofService.ts';",
        },
        rule: 'transaction-scope-service',
      },
      {
        module: {
          path: 'packages/core/transactions/proofs/TransactionalProofOperations.ts',
          sourceText: "import type { MintAdapter } from '@core/infra';",
        },
        rule: 'transaction-scope-remote-infrastructure',
      },
      {
        module: {
          path: 'packages/core/transactions/proofs/TransactionalProofOperations.ts',
          sourceText: "import type { EventBus } from '@core/events';",
        },
        rule: 'transaction-scope-live-event-bus',
      },
      {
        module: {
          path: 'packages/core/transactions/proofs/TransactionalProofOperations.ts',
          sourceText: "import type { SendTransactions } from '@core/transactions/send/index.ts';",
        },
        rule: 'transaction-scope-application-gateway',
      },
      {
        module: {
          path: 'packages/core/transactions/proofs/TransactionalProofOperations.ts',
          sourceText: "import type { CoreTransactionRunner } from '../CoreTransaction.ts';",
        },
        rule: 'transaction-scope-runner',
      },
      {
        module: {
          path: 'packages/core/transactions/send/SendTransactions.ts',
          sourceText: "import type { ProofRepository } from '@core/repositories';",
        },
        rule: 'application-gateway-repository',
      },
      {
        module: {
          path: 'packages/core/transactions/send/SendTransactions.ts',
          sourceText:
            "import type { ProofTransactions } from '@core/transactions/proofs/index.ts';",
        },
        rule: 'application-gateway-application-gateway',
      },
      {
        module: {
          path: 'packages/core/operations/send/SendOperationService.ts',
          sourceText: "import type { ProofRepository } from '@core/repositories';",
        },
        rule: 'operation-service-repository',
      },
      {
        module: {
          path: 'packages/core/operations/send/SendOperationService.ts',
          sourceText:
            "import type { CoreTransactionRunner } from '@core/transactions/CoreTransaction.ts';",
        },
        rule: 'operation-service-runner',
      },
    ];

    for (const testCase of cases) {
      const result = checkTransactionArchitecture([testCase.module], []);
      expect(result.unexpectedViolations).toEqual([
        expect.objectContaining({
          rule: testCase.rule,
          importer: testCase.module.path,
        }),
      ]);
    }
  });

  it('accepts an exact allowlisted legacy repository import', () => {
    const modules: SourceModule[] = [
      {
        path: 'packages/core/operations/send/SendOperationService.ts',
        sourceText:
          "import type { SendOperationRepository, ProofRepository } from '../../repositories';",
      },
    ];
    const allowlist: AllowlistedTransactionImport[] = [
      {
        rule: 'operation-service-repository',
        importer: modules[0]!.path,
        importSource: '../../repositories',
        importedNames: ['ProofRepository', 'SendOperationRepository'],
        reason: 'Legacy Send persistence awaiting migration.',
      },
    ];

    const result = checkTransactionArchitecture(modules, allowlist);

    expect(result.allowedViolations).toHaveLength(1);
    expect(result.unexpectedViolations).toEqual([]);
    expect(result.staleAllowlist).toEqual([]);
  });

  it('rejects a new binding added to an allowlisted import', () => {
    const modules: SourceModule[] = [
      {
        path: 'packages/core/operations/send/SendOperationService.ts',
        sourceText:
          "import type { CounterRepository, SendOperationRepository, ProofRepository } from '../../repositories';",
      },
    ];
    const allowlist: AllowlistedTransactionImport[] = [
      {
        rule: 'operation-service-repository',
        importer: modules[0]!.path,
        importSource: '../../repositories',
        importedNames: ['ProofRepository', 'SendOperationRepository'],
        reason: 'Legacy Send persistence awaiting migration.',
      },
    ];

    const result = checkTransactionArchitecture(modules, allowlist);

    expect(result.unexpectedViolations).toHaveLength(1);
    expect(result.staleAllowlist).toEqual(allowlist);
  });

  it('accepts the current source tree only through the declared legacy allowlist', async () => {
    const modules = await loadCoreSourceModules();

    const result = checkTransactionArchitecture(modules);

    expect(result.unexpectedViolations).toEqual([]);
    expect(result.staleAllowlist).toEqual([]);
    expect(result.allowedViolations).toHaveLength(TRANSACTION_ARCHITECTURE_ALLOWLIST.length);
  });
});
