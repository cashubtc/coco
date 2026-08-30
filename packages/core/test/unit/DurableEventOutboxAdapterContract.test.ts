import { describe, expect, it } from 'bun:test';
import { runDurableEventOutboxRepositoryContract } from '../../../adapter-tests/src/durableEventOutbox.ts';
import type { DurableEventStorageLimits } from '../../outbox/index.ts';
import { MemoryDurableEventOutboxRepository } from '../../outbox/index.ts';

runDurableEventOutboxRepositoryContract(
  {
    async createRepository(options?: { readonly limits?: DurableEventStorageLimits }) {
      return {
        repository: new MemoryDurableEventOutboxRepository({ limits: options?.limits }),
        async dispose() {},
      };
    },
  },
  { describe, it, expect },
);
