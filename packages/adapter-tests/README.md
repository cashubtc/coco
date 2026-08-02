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
  runKeyRingAllocationRepositoryContract,
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

runKeyRingAllocationRepositoryContract(
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

- `runRepositoryTransactionContract()` verifies transactional behavior across the
  repository set.
- `runKeyRingAllocationRepositoryContract()` verifies purpose isolation, concurrency,
  permanent gaps, exhaustion, and—when `createSharedRepositories` is supplied—coordination
  between independent roots sharing one physical store.
- `runAuthSessionRepositoryContract()` verifies the NUT-21/22 auth session
  persistence contract.
