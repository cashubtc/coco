import type { Plugin, ServiceKey, ServiceMap } from './types.ts';

export class PluginHost {
  private readonly plugins: Plugin[] = [];
  private readonly cleanups: Array<() => void | Promise<void>> = [];
  private services?: ServiceMap;
  private initialized = false;
  private readyPhase = false;

  use(plugin: Plugin): void {
    this.plugins.push(plugin);
    if (this.initialized && this.services) {
      void this.runInit(plugin, this.services);
      if (this.readyPhase) void this.runReady(plugin, this.services);
    }
  }

  async init(services: ServiceMap): Promise<void> {
    this.services = services;
    this.initialized = true;
    for (const p of this.plugins) {
      await this.runInit(p, services);
    }
  }

  async ready(): Promise<void> {
    if (!this.services) return;
    this.readyPhase = true;
    for (const p of this.plugins) {
      await this.runReady(p, this.services);
    }
  }

  async dispose(): Promise<void> {
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
  }

  private async runInit(plugin: Plugin, services: ServiceMap): Promise<void> {
    const ctx = this.createContext(plugin, services);
    try {
      const cleanup = await plugin.onInit?.(ctx as any);
      if (typeof cleanup === 'function') this.cleanups.push(cleanup);
    } catch (err) {
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
      // eslint-disable-next-line no-console
      console.error('Plugin ready error', { plugin: plugin.name, err });
    }
  }

  private createContext(
    plugin: Plugin,
    services: ServiceMap,
  ): {
    services: Partial<ServiceMap>;
    registerCleanup: (fn: () => void | Promise<void>) => void;
  } {
    const required = (plugin.required ?? []) as readonly ServiceKey[];
    const selected: Partial<ServiceMap> = {};
    for (const k of required) {
      // @ts-expect-error - dynamic key selection
      selected[k] = services[k];
    }
    return {
      services: selected,
      registerCleanup: (fn: () => void | Promise<void>) => {
        this.cleanups.push(fn);
      },
    };
  }
}
