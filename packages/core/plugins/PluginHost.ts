import type { Plugin, ServiceKey, ServiceMap } from './types.ts';
import { DuplicatePluginRegistrationError, ExtensionRegistrationError } from './types.ts';

export class PluginHost {
  private readonly plugins: Plugin[] = [];
  private readonly cleanups: Array<() => void | Promise<void>> = [];
  private readonly extensions: Record<string, unknown> = {};
  private readonly registeredPlugins = new WeakSet<Plugin>();
  private readonly initializedPlugins = new WeakSet<Plugin>();
  private readonly readyPlugins = new WeakSet<Plugin>();
  private readonly initPromises = new WeakMap<Plugin, Promise<void>>();
  private readonly readyPromises = new WeakMap<Plugin, Promise<void>>();
  private readonly lifecyclePromises = new Set<Promise<void>>();
  private services?: ServiceMap;
  private initialized = false;
  private readyPhase = false;
  private disposed = false;
  private disposePromise?: Promise<void>;

  use(plugin: Plugin): void {
    if (this.disposePromise || this.disposed) {
      throw new Error('Cannot register plugin after disposal has started');
    }

    if (this.registeredPlugins.has(plugin)) {
      throw new DuplicatePluginRegistrationError(plugin.name);
    }

    this.registeredPlugins.add(plugin);
    this.plugins.push(plugin);
    if (this.initialized && this.services) {
      const services = this.services;
      void this.trackLifecycle(this.initializeRuntimePlugin(plugin, services));
    }
  }

  async init(services: ServiceMap): Promise<void> {
    if (this.disposePromise || this.disposed) {
      throw new Error('Cannot initialize plugins after disposal has started');
    }

    this.services = services;
    this.initialized = true;
    for (const p of this.plugins) {
      await this.ensureInitialized(p, services);
    }
  }

  async ready(): Promise<void> {
    if (this.disposePromise || this.disposed) {
      throw new Error('Cannot mark plugins ready after disposal has started');
    }

    if (!this.services) return;
    this.readyPhase = true;
    for (const p of this.plugins) {
      await this.ensureReady(p, this.services);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) {
      await this.disposePromise;
      return;
    }
    if (this.disposed) return;

    this.disposePromise = this.runDispose();
    await this.disposePromise;
  }

  private async runDispose(): Promise<void> {
    await this.waitForLifecycle();

    const errors: unknown[] = [];
    for (const p of this.plugins) {
      try {
        await p.onDispose?.();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Plugin dispose error', { plugin: p.name, err });
        errors.push(err);
      }
    }
    while (this.cleanups.length) {
      const fn = this.cleanups.pop()!;
      try {
        await fn();
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      // eslint-disable-next-line no-console
      console.error('One or more plugin dispose/cleanup handlers failed');
    }
    this.disposed = true;
  }

  private async initializeRuntimePlugin(plugin: Plugin, services: ServiceMap): Promise<void> {
    await this.ensureInitialized(plugin, services);
    if (this.readyPhase) {
      await this.ensureReady(plugin, services);
    }
  }

  private trackLifecycle(promise: Promise<void>): Promise<void> {
    this.lifecyclePromises.add(promise);
    void promise.then(
      () => {
        this.lifecyclePromises.delete(promise);
      },
      () => {
        this.lifecyclePromises.delete(promise);
      },
    );
    return promise;
  }

  private async waitForLifecycle(): Promise<void> {
    while (this.lifecyclePromises.size > 0) {
      await Promise.allSettled([...this.lifecyclePromises]);
    }
  }

  /**
   * Get all registered plugin extensions
   */
  getExtensions(): Record<string, unknown> {
    return this.extensions;
  }

  private async ensureInitialized(plugin: Plugin, services: ServiceMap): Promise<void> {
    if (this.initializedPlugins.has(plugin)) return;

    const existing = this.initPromises.get(plugin);
    if (existing) {
      await existing;
      return;
    }

    const promise = this.trackLifecycle(
      this.runInit(plugin, services)
        .then(() => {
          this.initializedPlugins.add(plugin);
        })
        .finally(() => {
          this.initPromises.delete(plugin);
        }),
    );

    this.initPromises.set(plugin, promise);
    await promise;
  }

  private async ensureReady(plugin: Plugin, services: ServiceMap): Promise<void> {
    await this.ensureInitialized(plugin, services);
    if (this.readyPlugins.has(plugin)) return;

    const existing = this.readyPromises.get(plugin);
    if (existing) {
      await existing;
      return;
    }

    const promise = this.trackLifecycle(
      this.runReady(plugin, services)
        .then(() => {
          this.readyPlugins.add(plugin);
        })
        .finally(() => {
          this.readyPromises.delete(plugin);
        }),
    );

    this.readyPromises.set(plugin, promise);
    await promise;
  }

  private async runInit(plugin: Plugin, services: ServiceMap): Promise<void> {
    const ctx = this.createContext(plugin, services);
    try {
      const cleanup = await plugin.onInit?.(ctx as any);
      if (typeof cleanup === 'function') this.cleanups.push(cleanup);
    } catch (err) {
      if (err instanceof ExtensionRegistrationError) {
        throw err;
      }
      // eslint-disable-next-line no-console
      console.error('Plugin init error', { plugin: plugin.name, err });
    }
  }

  private async runReady(plugin: Plugin, services: ServiceMap): Promise<void> {
    const ctx = this.createContext(plugin, services);
    try {
      const cleanup = await plugin.onReady?.(ctx as any);
      if (typeof cleanup === 'function') this.cleanups.push(cleanup);
    } catch (err) {
      if (err instanceof ExtensionRegistrationError) {
        throw err;
      }
      // eslint-disable-next-line no-console
      console.error('Plugin ready error', { plugin: plugin.name, err });
    }
  }

  private createContext(
    plugin: Plugin,
    services: ServiceMap,
  ): {
    services: Partial<ServiceMap>;
    registerExtension: <K extends string>(key: K, api: unknown) => void;
  } {
    const required = (plugin.required ?? []) as readonly ServiceKey[];
    const selected: Partial<ServiceMap> = {};
    for (const k of required) {
      // @ts-expect-error - dynamic key selection
      selected[k] = services[k];
    }

    const registerExtension = <K extends string>(key: K, api: unknown): void => {
      if (key in this.extensions) {
        throw new ExtensionRegistrationError(plugin.name, key);
      }
      this.extensions[key] = api;
    };

    return {
      services: selected,
      registerExtension,
    };
  }
}
