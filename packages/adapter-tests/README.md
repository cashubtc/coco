# @cashu/coco-adapter-tests

This package exports reusable test helpers that verify whether a storage adapter
conforms to the `Repositories` contract from `@cashu/coco-core`.

## Install

```bash
npm install -D @cashu/coco-adapter-tests @cashu/coco-core
```

## Usage

Install the package as a devDependency inside an adapter package and wire the
contract suites into your test runner:

```ts
import { describe, it, expect } from 'bun:test';
import {
  runRepositoryTransactionContract,
  runKeypairAllocationContract,
  runAuthSessionRepositoryContract,
} from '@cashu/coco-adapter-tests';
import { MyAdapterRepositories } from './src';

runRepositoryTransactionContract(
  {
    createRepositories: async () => {
      const repositories = new MyAdapterRepositories(options);
      await repositories.init();
      return {
        repositories,
        dispose: async () => repositories.close?.(),
      };
    },
  },
  { describe, it, expect },
);

runAuthSessionRepositoryContract(
  {
    createRepositories: async () => {
      const repositories = new MyAdapterRepositories(options);
      await repositories.init();
      return {
        repositories,
        dispose: async () => repositories.close?.(),
      };
    },
  },
  { describe, it, expect },
);

runKeypairAllocationContract(
  {
    createRepositories: createFreshRepositories,
    // Returns { first, second, dispose } using one physical store and independent roots.
    createSharedRepositories: createTwoRootsForOneStore,
  },
  { describe, it, expect },
);
```

The factory is responsible for providing a fresh, isolated repositories
instance for every test and for cleaning up via `dispose()`.

Transaction contract options:

- `createSharedRepositories` supplies two independent roots for one physical store and enables
  cross-root writer contention coverage.
- `createIsolationRepositories` supplies independent transaction/root-operation actors when an
  adapter's ambient transaction context cannot represent a concurrent same-root call.
- `holdTransactionOpen` adapts the release promise for stores such as IndexedDB that otherwise
  auto-close a transaction while the contract deliberately holds it open.
- `testConcurrentRootOperationIsolation` enables root-operation isolation cases.
- `testWriterOwnershipAtEntry` verifies that a conflicting writer either waits or reports a typed
  transient conflict before its callback runs. It requires `createSharedRepositories`.

- `runRepositoryTransactionContract()` verifies transactional behavior across the
  repository set, including grouped keypair and high-water-mark writes.
- `runKeypairAllocationContract()` exercises the real key-management gateway for purpose isolation, concurrency,
  transactional rollback, committed-key deletion behavior, exhaustion, and—when
  `createSharedRepositories` is supplied—coordination between independent roots sharing one
  physical store.
- `allocateKeypairForTest(repositories, purpose)` generates a deterministic key through key management
  on an initialized adapter. It creates and disposes its Coco Session without starting background
  watchers; allocation logic remains in core's scoped command.
- `runAuthSessionRepositoryContract()` verifies the NUT-21/22 auth session
  persistence contract.
