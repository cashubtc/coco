# coco-cashu adapter contract tests

This package exports reusable test helpers that verify whether a storage adapter
conforms to the `Repositories` contract from `coco-cashu-core`.

## Usage

Install the package as a devDependency inside an adapter package and wire the
contract suite into your test runner:

```ts
import { describe, it, expect } from 'bun:test';
import { runRepositoryTransactionContract } from 'coco-cashu-adapter-tests';
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
```

The factory is responsible for providing a fresh, isolated repositories
instance for every test and for cleaning up via `dispose()`.
