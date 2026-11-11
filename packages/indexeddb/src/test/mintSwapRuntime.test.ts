import { describe, expect, it } from 'vitest';
import { IndexedDbRepositories } from '../index.ts';
import { mintSwapFixture } from '../../../adapter-tests/src/internal/mintSwap/fixture.ts';
import { MintSwapOpsApi } from '../../../core/api/MintSwapOpsApi.ts';
import { MintSwapOperationProcessor } from '../../../core/services/watchers/MintSwapOperationProcessor.ts';
import { EventBus } from '../../../core/events/EventBus.ts';
import type { CoreEvents } from '../../../core/events/types.ts';

describe('Mint Swap recovery runtime in IndexedDB', () => {
  for (const paid of [true, false]) {
    it(`recovers ${paid ? 'PAID' : 'UNPAID'} after reopen with lost hints`, async () => {
      const name = `mint-swap-runtime-${crypto.randomUUID()}`;
      let repositories = new IndexedDbRepositories({ name });
      let processor: MintSwapOperationProcessor | undefined;
      const disposal = new AbortController();
      try {
        let fixture = await mintSwapFixture(repositories);
        await fixture.create();
        await fixture.prepare();
        fixture.setSourceState('PENDING');
        const previous = fixture.service();
        await previous.execute('swap');
        await previous.cancel('swap');
        await previous.dispose();
        repositories.db.close();

        repositories = new IndexedDbRepositories({ name });
        fixture = await mintSwapFixture(repositories, { initialize: false });
        fixture.setTime(30_000);
        fixture.setSourceState(paid ? 'PAID' : 'UNPAID');
        fixture.setDestinationState('ISSUED');
        const service = fixture.service();
        // Deliberately drop every coordinator event from the observer's bus.
        const api = new MintSwapOpsApi(service, new EventBus<CoreEvents>(), disposal.signal);
        const waiting = api.waitForOutcome('swap', { pollIntervalMs: 10, timeoutMs: 5000 });
        processor = new MintSwapOperationProcessor(
          service,
          repositories.mintSwap.operationRepository,
          fixture.events,
        );
        await processor.start();
        expect((await waiting).status).toBe(paid ? 'completed' : 'cancelled');
        expect(fixture.requests).not.toContain('melt');
        await processor.stop();
        await service.dispose();
      } finally {
        disposal.abort(new Error('test disposal'));
        await processor?.stop();
        await repositories.db.delete();
      }
    });
  }
});
