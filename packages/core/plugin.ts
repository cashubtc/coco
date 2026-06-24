import type { ServiceMap } from './plugins/types.ts';

export type {
  Cleanup,
  CleanupFn,
  Plugin,
  PluginContext,
  PluginExtensions,
  ServiceKey,
  ServiceMap,
} from './plugins/types.ts';
export type PluginEventBus = ServiceMap['eventBus'];
export { DuplicatePluginRegistrationError, ExtensionRegistrationError } from './plugins/types.ts';
