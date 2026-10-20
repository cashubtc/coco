/** INTERNAL: no compatibility or versioning guarantees, including patch/minor releases. */
import { version } from './package.json';
import type { Repositories } from './repositories/index.ts';
import type { CocoStorage } from './storage.ts';

// A shared key allows separate installations of the same core release to interoperate.
// This is an API boundary, not a security boundary.
const integration = Symbol.for('@cashu/coco/storage');
interface StorageIntegration {
  version: string;
  repositories(): Repositories;
}

export const storageIntegrationVersion = version;

export function assertStorageVersion(actual: string): void {
  if (actual !== version) {
    throw new Error(
      `Incompatible Coco storage version ${actual}; core requires ${version}. Install matching Coco package versions.`,
    );
  }
}

/** Internal composition helper. Construction is lazy so version checks precede database access. */
export function createStorageHandle<T extends object = Record<never, never>>(
  createRepositories: () => Repositories,
  implementationVersion: string = version,
  lifecycle?: T,
): CocoStorage & T {
  assertStorageVersion(implementationVersion);
  let repositories: Repositories | undefined;
  let initialization: Promise<void> | undefined;
  const state: StorageIntegration = {
    version: implementationVersion,
    repositories() {
      assertStorageVersion(implementationVersion);
      return (repositories ??= createRepositories());
    },
  };
  const handle = {
    ...lifecycle,
    async init(): Promise<void> {
      assertStorageVersion(implementationVersion);
      initialization ??= Promise.resolve()
        .then(() => state.repositories().init())
        .catch((error) => {
          initialization = undefined;
          throw error;
        });
      await initialization;
    },
  };
  Object.defineProperty(handle, integration, { value: state });
  return Object.freeze(handle) as unknown as CocoStorage & T;
}

export function resolveStorage(storage: CocoStorage): Repositories {
  const state = (storage as unknown as { [integration]?: StorageIntegration })?.[integration];
  if (!state) throw new Error('Use a Coco storage factory to create storage.');
  assertStorageVersion(state.version);
  return state.repositories();
}
