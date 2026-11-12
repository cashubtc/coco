import { describe, expect, it } from 'bun:test';
import { InfrastructureFailure } from '../../fault-simulation/environment.ts';
import { ScenarioPreconditionError, waitForFaultTrigger } from '../../fault-simulation/faults.ts';

describe('fault trigger failures', () => {
  it('preserves infrastructure failures instead of reporting an unfired fault', async () => {
    const failure = new InfrastructureFailure('Transport link process exited');
    await expect(
      waitForFaultTrigger('open WebSocket', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it('reports an unobserved trigger as unresolved and preserves its timeout cause', async () => {
    const failure = await waitForFaultTrigger('open WebSocket', async () => false, 1, 1).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ScenarioPreconditionError);
    expect((failure as Error).cause).toBeInstanceOf(Error);
    expect(((failure as Error).cause as Error).message).toContain('Timed out waiting');
  });
});
