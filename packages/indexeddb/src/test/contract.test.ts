import { describe, it, expect } from 'vitest';
import {
  runRepositoryTransactionContract,
  runAuthSessionRepositoryContract,
  runProofRepositoryContract,
} from '@cashu/coco-adapter-tests';
import { IndexedDbRepositories } from '../index.ts';

let dbCounter = 0;

async function createRepositories() {
  const dbName = `coco_cashu_contract_${Date.now()}_${dbCounter++}`;
  const repositories = new IndexedDbRepositories({ name: dbName });
  await repositories.init();
  return {
    repositories,
    dispose: async () => {},
  };
}

runRepositoryTransactionContract(
  {
    createRepositories,
  },
  { describe, it, expect },
);

runAuthSessionRepositoryContract({ createRepositories }, { describe, it, expect });

runProofRepositoryContract({ createRepositories }, { describe, it, expect });
