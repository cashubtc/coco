import { expect, it } from 'bun:test';
import { awaitStartup, InfrastructureFailure } from '../../fault-simulation/environment.ts';

it('waits for late startup resources to register before propagating a failure to teardown', async () => {
  const late = Promise.withResolvers<void>();
  const failure = new InfrastructureFailure('first mint failed');
  const registered: string[] = [];
  let settled = false;
  const starting = awaitStartup([
    Promise.reject(failure),
    late.promise.then(() => {
      registered.push('late mint and gateway');
    }),
  ]);
  void starting.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Bun.sleep(0);
  expect(settled).toBe(false);
  late.resolve();
  await expect(starting).rejects.toBe(failure);
  expect(registered).toEqual(['late mint and gateway']);
});
