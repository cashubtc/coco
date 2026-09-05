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
  const scoped = 'packages/core/transactions/scoped/proofs/ScopedProofCommands.ts';

  it.each(['SendTransactions.ts', 'CoreSendTransactions.ts', 'TransactionalSendTransactions.ts'])(
    'applies gateway ownership rules to %s without prefix exemptions',
    (filename) => {
      const path = `packages/core/transactions/send/${filename}`;
      expect(
        checkTransactionArchitecture(
          [
            {
              path,
              sourceText: "import type { CoreTransactionRunner } from '../CoreTransaction';",
            },
          ],
          [],
        ).unexpectedViolations,
      ).toEqual([]);
      expect(
        checkTransactionArchitecture(
          [
            {
              path,
              sourceText: "import type { ProofService } from '../../services/ProofService';",
            },
          ],
          [],
        ).unexpectedViolations,
      ).toContainEqual(expect.objectContaining({ rule: 'application-gateway-service' }));

      // Importing a gateway under a neutral binding must still reveal its transaction authority.
      expect(
        checkTransactionArchitecture(
          [{ path: scoped, sourceText: `import { Gateway } from '../../send/${filename}';` }],
          [],
        ).unexpectedViolations,
      ).toContainEqual(expect.objectContaining({ rule: 'transaction-scope-application-gateway' }));
    },
  );

  it('rejects a nested runner invocation inside a gateway callback', () => {
    const modules = [
      {
        path: 'packages/core/transactions/send/SendTransactions.ts',
        sourceText:
          'const prepare = () => runner.run(tx => runner.run(other => other.sends.prepare()));',
      },
    ];
    expect(checkTransactionArchitecture(modules, []).unexpectedViolations).toContainEqual(
      expect.objectContaining({ rule: 'nested-transaction-call' }),
    );
  });

  it('does not let a second helper path inherit an existing path exception', () => {
    const root = 'packages/core/operations/send/SendOperationService.ts';
    const first = 'packages/core/operations/send/first.ts';
    const second = 'packages/core/operations/send/second.ts';
    const shared = 'packages/core/operations/send/shared.ts';
    const modules = [
      { path: root, sourceText: "import './first'; import './second';" },
      { path: first, sourceText: "import './shared';" },
      { path: second, sourceText: "import './shared';" },
      {
        path: shared,
        sourceText: "import type { ProofService } from '../../services/ProofService';",
      },
    ];
    const allowlist: AllowlistedTransactionImport[] = [
      {
        rule: 'operation-service-service',
        importer: root,
        importSource: '../../services/ProofService',
        importedNames: ['ProofService'],
        dependencyPath: [root, first, shared],
        reason: 'Existing path only.',
      },
    ];
    const result = checkTransactionArchitecture(modules, allowlist);
    expect(result.allowedViolations).toHaveLength(1);
    expect(result.unexpectedViolations).toContainEqual(
      expect.objectContaining({ dependencyPath: [root, second, shared] }),
    );
  });

  it('rejects injecting scoped commands into an application coordinator', () => {
    const modules = [
      {
        path: 'packages/core/operations/send/SendOperationService.ts',
        sourceText:
          "import type { ScopedProofCommands } from '@core/transactions/scoped/proofs/ScopedProofCommands';",
      },
    ];
    expect(checkTransactionArchitecture(modules, []).unexpectedViolations).toContainEqual(
      expect.objectContaining({ rule: 'operation-service-scoped-commands' }),
    );
  });

  it.each([
    "import type { Repositories } from '@core/repositories';",
    "import { MemoryRepositories } from '@core/repositories/memory';",
    "import { open } from '@core/repositories/hiddenTransactionHelper';",
    "import { MemoryRepositories } from '@cashu/coco-core/adapter';",
    "import type { SendOperationService } from '@core/operations/send/SendOperationService';",
    "const load = () => import('@core/services/ProofService');",
    "const load = () => require('@core/services/ProofService');",
    'const load = (name: string) => import(name);',
    "const request = () => fetch('https://mint.invalid');",
    "const open = (repos: any) => repos['withTransaction'](() => {});",
    "import type { CoreTransactionRunner } from '@core/transactions/CoreTransaction';",
  ])('rejects scoped authority or effects: %s', (sourceText) => {
    expect(
      checkTransactionArchitecture([{ path: scoped, sourceText }], []).unexpectedViolations.length,
    ).toBeGreaterThan(0);
  });

  it('follows runtime helpers and type re-exports without laundering legacy exceptions', () => {
    const root = 'packages/core/operations/send/SendOperationService.ts';
    const modules: SourceModule[] = [
      { path: root, sourceText: "import { reserve } from './helper';" },
      {
        path: 'packages/core/operations/send/helper.ts',
        sourceText:
          "import type { ProofService } from '../../services/ProofService'; export const reserve = () => {};",
      },
    ];
    const result = checkTransactionArchitecture(modules);
    expect(result.unexpectedViolations).toContainEqual(
      expect.objectContaining({
        importer: root,
        rule: 'operation-service-service',
        dependencyPath: [root, modules[1]!.path],
      }),
    );

    const exports: SourceModule[] = [
      { path: scoped, sourceText: "import type { HiddenRunner } from './barrel';" },
      {
        path: 'packages/core/transactions/scoped/proofs/barrel.ts',
        sourceText:
          "export type { CoreTransactionRunner as HiddenRunner } from '@core/transactions/CoreTransaction';",
      },
    ];
    expect(checkTransactionArchitecture(exports, []).unexpectedViolations).toContainEqual(
      expect.objectContaining({ importer: scoped, rule: 'transaction-scope-runner' }),
    );
  });

  it.each([
    'ScopedProofCommands.ts',
    'RepositoryProofCommands.ts',
    'helper.ts',
    'ProofTransactions.ts',
  ])('uses the scoped directory to restrict %s, regardless of its name', (filename) => {
    const result = checkTransactionArchitecture(
      [
        {
          path: `packages/core/transactions/scoped/proofs/${filename}`,
          sourceText: "import { EventBus } from '@core/events';",
        },
      ],
      [],
    );
    expect(result.unexpectedViolations).toContainEqual(
      expect.objectContaining({ rule: 'transaction-scope-live-event-bus' }),
    );
  });

  it.each([
    "export type { ProofRepository as HiddenRepository } from '../repositories';",
    "import type { ProofRepository } from '../repositories'; export type { ProofRepository as HiddenRepository };",
    "export type { LocalRepository as HiddenRepository }; import { type ProofRepository as LocalRepository } from '../repositories';",
  ])('rejects mutation authority through the selected re-export: %s', (sourceText) => {
    const path = 'packages/core/queries/ProofQueries.ts';
    const result = checkTransactionArchitecture(
      [
        {
          path,
          sourceText: `import type { HiddenRepository } from '../helpers/types';
            export async function getProofs(repository: HiddenRepository) {
              await repository.deleteProofs('mint', ['secret']);
              return [];
            }`,
        },
        { path: 'packages/core/helpers/types.ts', sourceText },
      ],
      [],
    );
    expect(result.unexpectedViolations).toContainEqual(
      expect.objectContaining({
        importer: path,
        rule: 'read-capability-effect',
        importedNames: ['ProofRepository'],
      }),
    );
  });

  it.each([
    "export type { QueryOptions as Options } from '../models/QueryOptions';",
    "import type { QueryOptions as LocalOptions } from '../models/QueryOptions'; export type { LocalOptions as Options };",
    "import type LocalOptions from '../models/QueryOptions'; export type { LocalOptions as Options };",
  ])('accepts the selected harmless type from a mixed barrel: %s', (sourceText) => {
    const result = checkTransactionArchitecture(
      [
        {
          path: 'packages/core/queries/ProofQueries.ts',
          sourceText: "import type { Options } from '../helpers/types';",
        },
        {
          path: 'packages/core/helpers/types.ts',
          sourceText: `${sourceText}
            export type { ProofRepository } from '../repositories';`,
        },
        {
          path: 'packages/core/models/QueryOptions.ts',
          sourceText:
            'export interface QueryOptions { limit: number; } export type { QueryOptions as default };',
        },
      ],
      [],
    );
    expect(result.unexpectedViolations).toEqual([]);
  });

  it('preserves selected type bindings through star and value re-exports', () => {
    const path = 'packages/core/queries/ProofQueries.ts';
    const barrels: SourceModule[] = [
      { path: 'packages/core/helpers/types.ts', sourceText: "export * from './inner';" },
      {
        path: 'packages/core/helpers/inner.ts',
        sourceText: `export { QueryOptions as Options } from '../models/QueryOptions';
          export type { ProofRepository } from '../repositories';`,
      },
      {
        path: 'packages/core/models/QueryOptions.ts',
        sourceText: `export class QueryOptions { limit = 10; }
          const request = () => fetch('https://mint.invalid');`,
      },
    ];
    const inspect = (importedName: string) =>
      checkTransactionArchitecture(
        [
          { path, sourceText: `import type { ${importedName} } from '../helpers/types';` },
          ...barrels,
        ],
        [],
      ).unexpectedViolations;
    expect(inspect('Options')).toEqual([]);
    expect(inspect('ProofRepository')).toContainEqual(
      expect.objectContaining({ importer: path, rule: 'read-capability-effect' }),
    );
  });

  it.each([
    "export type * as Repositories from '../repositories';",
    "import type * as LocalRepositories from '../repositories'; export type { LocalRepositories as Repositories };",
  ])('retains repository authority through namespace re-exports: %s', (sourceText) => {
    expect(
      checkTransactionArchitecture(
        [
          {
            path: scoped,
            sourceText: "import type { Repositories } from '../../../helpers/types';",
          },
          { path: 'packages/core/helpers/types.ts', sourceText },
        ],
        [],
      ).unexpectedViolations,
    ).toContainEqual(
      expect.objectContaining({ importer: scoped, rule: 'transaction-scope-root-repositories' }),
    );
  });

  it('rejects hidden persistence in a shared preflight capability', () => {
    const root = 'packages/core/capabilities/Signer.ts';
    const modules = [
      { path: root, sourceText: "import { key } from '../helpers/getKey';" },
      {
        path: 'packages/core/helpers/getKey.ts',
        sourceText:
          "import { CoreKeyRingTransactions } from '../transactions/keypairs/KeyRingTransactions';",
      },
    ];
    expect(checkTransactionArchitecture(modules, []).unexpectedViolations).toContainEqual(
      expect.objectContaining({ importer: root, rule: 'read-capability-effect' }),
    );
  });

  it('permits shared scoped commands and harmless comments without granting transaction authority', () => {
    const modules = [
      {
        path: 'packages/core/transactions/scoped/proofs/types.ts',
        sourceText: "export { type ProofRepository } from '@core/repositories';",
      },
      {
        path: scoped,
        sourceText: "import type { ProofRepository } from '@core/repositories'; // fetch('url');",
      },
      {
        path: 'packages/core/transactions/scoped/send/ScopedSendCommands.ts',
        sourceText: "import { reserve } from '../proofs/ScopedProofCommands';",
      },
    ];
    expect(checkTransactionArchitecture(modules, []).unexpectedViolations).toEqual([]);
  });

  it('permits the own gateway through the root barrel but rejects a foreign gateway', () => {
    const path = 'packages/core/operations/send/SendOperationService.ts';
    const gateways: SourceModule[] = [
      {
        path: 'packages/core/transactions/index.ts',
        sourceText: `export type { SendTransactions } from './send/SendTransactions';
          export type { ReceiveTransactions } from './receive/ReceiveTransactions';`,
      },
      {
        path: 'packages/core/transactions/send/SendTransactions.ts',
        sourceText: "import type { CoreTransactionRunner } from '../CoreTransaction';",
      },
      {
        path: 'packages/core/transactions/receive/ReceiveTransactions.ts',
        sourceText: "import type { CoreTransactionRunner } from '../CoreTransaction';",
      },
    ];
    expect(
      checkTransactionArchitecture(
        [
          { path, sourceText: "import type { SendTransactions } from '@core/transactions';" },
          ...gateways,
        ],
        [],
      ).unexpectedViolations,
    ).toEqual([]);
    expect(
      checkTransactionArchitecture(
        [
          { path, sourceText: "import type { ReceiveTransactions } from '@core/transactions';" },
          ...gateways,
        ],
        [],
      ).unexpectedViolations,
    ).toContainEqual(
      expect.objectContaining({ rule: 'operation-service-foreign-application-gateway' }),
    );
  });

  it('rejects every forbidden dependency category', () => {
    const cases: Array<{
      module: SourceModule;
      rule: TransactionArchitectureRule;
    }> = [
      {
        module: {
          path: 'packages/core/transactions/scoped/proofs/ScopedProofCommands.ts',
          sourceText: "import type { ProofService } from '@core/services/ProofService.ts';",
        },
        rule: 'transaction-scope-service',
      },
      {
        module: {
          path: 'packages/core/transactions/scoped/proofs/ScopedProofCommands.ts',
          sourceText: "import type { MintAdapter } from '@core/infra';",
        },
        rule: 'transaction-scope-remote-infrastructure',
      },
      {
        module: {
          path: 'packages/core/transactions/scoped/proofs/ScopedProofCommands.ts',
          sourceText: "import type { EventBus } from '@core/events';",
        },
        rule: 'transaction-scope-live-event-bus',
      },
      {
        module: {
          path: 'packages/core/transactions/scoped/proofs/ScopedProofCommands.ts',
          sourceText: "import type { SendTransactions } from '@core/transactions/send/index.ts';",
        },
        rule: 'transaction-scope-application-gateway',
      },
      {
        module: {
          path: 'packages/core/transactions/scoped/proofs/ScopedProofCommands.ts',
          sourceText: "import type { CoreTransactionRunner } from '../../CoreTransaction.ts';",
        },
        rule: 'transaction-scope-runner',
      },
      {
        module: {
          path: 'packages/core/transactions/send/SendTransactions.ts',
          sourceText: "import type { ProofService } from '@core/services/ProofService.ts';",
        },
        rule: 'application-gateway-service',
      },
      {
        module: {
          path: 'packages/core/transactions/send/SendTransactions.ts',
          sourceText: "import type { MintAdapter } from '@core/infra';",
        },
        rule: 'application-gateway-remote-infrastructure',
      },
      {
        module: {
          path: 'packages/core/transactions/send/SendTransactions.ts',
          sourceText: "import type { EventBus } from '@core/events';",
        },
        rule: 'application-gateway-live-event-bus',
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
          sourceText: "import type { ProofService } from '@core/services/ProofService.ts';",
        },
        rule: 'operation-service-service',
      },
      {
        module: {
          path: 'packages/core/operations/send/SendOperationService.ts',
          sourceText:
            "import type { ReceiveTransactions } from '@core/transactions/receive/index.ts';",
        },
        rule: 'operation-service-foreign-application-gateway',
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

  it("accepts an Operation Service's own transaction gateway", () => {
    const module: SourceModule = {
      path: 'packages/core/operations/send/SendOperationService.ts',
      sourceText: "import type { SendTransactions } from '@core/transactions/send/index.ts';",
    };

    const result = checkTransactionArchitecture([module], []);

    expect(result.violations).toEqual([]);
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
