import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { PluginHost } from '../../plugins/PluginHost.ts';
import type { Plugin } from '../../plugins/types.ts';

describe('PluginHost', () => {
  let host: PluginHost;
  let services: any;
  let originalConsoleError: typeof console.error;
  let errorCalls: any[][];

  beforeEach(() => {
    host = new PluginHost();
    services = {
      mintService: { s: 'mint' },
      walletService: { s: 'wallet' },
      proofService: { s: 'proof' },
      seedService: { s: 'seed' },
      walletRestoreService: { s: 'walletRestore' },
      counterService: { s: 'counter' },
      mintQuoteService: { s: 'mintQuote' },
      meltQuoteService: { s: 'meltQuote' },
      historyService: { s: 'history' },
      subscriptions: { s: 'subs' },
      eventBus: { s: 'bus' },
      logger: { s: 'logger' },
    };
    originalConsoleError = console.error;
    errorCalls = [];
    // eslint-disable-next-line no-console
    console.error = (...args: any[]) => {
      errorCalls.push(args);
    };
  });

  afterEach(() => {
    // eslint-disable-next-line no-console
    console.error = originalConsoleError;
  });

  it('calls onInit with only declared services', async () => {
    const seen: any[] = [];
    const plugin: Plugin<['eventBus', 'logger']> = {
      name: 'subset',
      required: ['eventBus', 'logger'],
      onInit: ({ services: s }) => {
        seen.push(Object.keys(s).sort());
        expect(s.eventBus).toBe(services.eventBus);
        expect(s.logger).toBe(services.logger);
      },
    };
    host.use(plugin);
    await host.init(services);
    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual(['eventBus', 'logger']);
  });

  it('calls onReady after init', async () => {
    const order: string[] = [];
    const plugin: Plugin<['logger']> = {
      name: 'order',
      required: ['logger'],
      onInit: () => {
        order.push('init');
      },
      onReady: () => {
        order.push('ready');
      },
    };
    host.use(plugin);
    await host.init(services);
    await host.ready();
    expect(order).toEqual(['init', 'ready']);
  });

  it('supports only return-style cleanup from onInit', async () => {
    const flags = { cleaned: 0 };
    const plugin: Plugin<['logger']> = {
      name: 'cleanup',
      required: ['logger'],
      onInit: () => () => {
        flags.cleaned += 1;
      },
    };
    host.use(plugin);
    await host.init(services);
    await host.dispose();
    expect(flags.cleaned).toBe(1);
  });

  it('onInit returned cleanup runs on dispose', async () => {
    const flags = { cleaned: 0 };
    const plugin: Plugin<['logger']> = {
      name: 'return-cleanup',
      required: ['logger'],
      onInit: () => {
        return () => {
          flags.cleaned += 1;
        };
      },
    };
    host.use(plugin);
    await host.init(services);
    await host.dispose();
    expect(flags.cleaned).toBe(1);
  });

  it('onReady returned cleanup runs on dispose', async () => {
    const flags = { cleaned: 0 };
    const plugin: Plugin<['logger']> = {
      name: 'ready-cleanup',
      required: ['logger'],
      onReady: () => {
        return () => {
          flags.cleaned += 1;
        };
      },
    };
    host.use(plugin);
    await host.init(services);
    await host.ready();
    await host.dispose();
    expect(flags.cleaned).toBe(1);
  });

  it('late registration after init+ready runs both hooks', async () => {
    const order: string[] = [];
    await host.init(services);
    await host.ready();
    const plugin: Plugin<['logger']> = {
      name: 'late',
      required: ['logger'],
      onInit: () => {
        order.push('init');
      },
      onReady: () => {
        order.push('ready');
      },
    };
    host.use(plugin);
    // hooks execute automatically on use()
    // give microtask queue a tick to settle any async voids
    await Promise.resolve();
    expect(order).toEqual(['init', 'ready']);
  });

  it('calls onDispose and continues running all cleanups', async () => {
    const calls: string[] = [];
    const pluginA: Plugin<['logger']> = {
      name: 'A',
      required: ['logger'],
      onInit: () => {
        return () => {
          void calls.push('cleanupA1');
        };
      },
      onDispose: () => {
        calls.push('disposeA');
      },
    };
    const pluginB: Plugin<['logger']> = {
      name: 'B',
      required: ['logger'],
      onInit: () => {
        return () => {
          calls.push('cleanupB1');
        };
      },
      onDispose: () => {
        calls.push('disposeB');
      },
    };
    host.use(pluginA);
    host.use(pluginB);
    await host.init(services);
    await host.dispose();
    // onDispose for each plugin, plus all cleanups (order of cleanups is not specified)
    expect(calls.includes('disposeA')).toBe(true);
    expect(calls.includes('disposeB')).toBe(true);
    expect(calls.includes('cleanupA1')).toBe(true);
    expect(calls.includes('cleanupB1')).toBe(true);
  });

  it('logs and swallows errors from hooks', async () => {
    const plugin: Plugin<['logger']> = {
      name: 'errors',
      required: ['logger'],
      onInit: () => {
        throw new Error('init failed');
      },
      onReady: () => {
        throw new Error('ready failed');
      },
      onDispose: () => {
        throw new Error('dispose failed');
      },
    };
    host.use(plugin);
    await host.init(services);
    await host.ready();
    await host.dispose();
    // Expect at least one error log per failing phase
    const joined = errorCalls.map((args) => String(args[0] ?? '')).join('\n');
    expect(joined.includes('Plugin init error')).toBe(true);
    expect(joined.includes('Plugin ready error')).toBe(true);
    expect(joined.includes('Plugin dispose error')).toBe(true);
  });

  it('registerExtension stores extension and is retrievable', async () => {
    const api = { foo: 'bar' };
    const plugin: Plugin<['logger']> = {
      name: 'ext-test',
      required: ['logger'],
      onInit: (ctx) => {
        ctx.registerExtension('myExt', api);
      },
    };
    host.use(plugin);
    await host.init(services);
    expect(host.getExtensions()).toEqual({ myExt: api });
  });

  it('registerExtension throws when key already exists', async () => {
    const pluginA: Plugin<['logger']> = {
      name: 'A',
      required: ['logger'],
      onInit: (ctx) => {
        ctx.registerExtension('conflict', { from: 'A' });
      },
    };
    const pluginB: Plugin<['logger']> = {
      name: 'B',
      required: ['logger'],
      onInit: (ctx) => {
        ctx.registerExtension('conflict', { from: 'B' });
      },
    };
    host.use(pluginA);
    host.use(pluginB);
    await expect(host.init(services)).rejects.toThrow(
      'Plugin "B" attempted to register extension "conflict", but it is already registered',
    );
  });

  it('multiple plugins can register different extensions', async () => {
    const pluginA: Plugin<['logger']> = {
      name: 'A',
      required: ['logger'],
      onInit: (ctx) => {
        ctx.registerExtension('extA', { a: 1 });
      },
    };
    const pluginB: Plugin<['logger']> = {
      name: 'B',
      required: ['logger'],
      onInit: (ctx) => {
        ctx.registerExtension('extB', { b: 2 });
      },
    };
    host.use(pluginA);
    host.use(pluginB);
    await host.init(services);
    expect(host.getExtensions()).toEqual({
      extA: { a: 1 },
      extB: { b: 2 },
    });
  });

  it('extension registered in onReady is available', async () => {
    const plugin: Plugin<['logger']> = {
      name: 'ready-ext',
      required: ['logger'],
      onReady: (ctx) => {
        ctx.registerExtension('readyExt', { ready: true });
      },
    };
    host.use(plugin);
    await host.init(services);
    await host.ready();
    expect(host.getExtensions()).toEqual({ readyExt: { ready: true } });
  });
});
