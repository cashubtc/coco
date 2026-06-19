import { describe, expect, it } from 'bun:test';
import { MeltHandlerProvider } from '../../infra/handlers/melt';
import { MintHandlerProvider } from '../../infra/handlers/mint';
import type { MeltMethodHandler } from '../../operations/melt';
import type { MintMethodHandler } from '../../operations/mint';

describe('method handler providers', () => {
  it('routes mint built-in methods through the built-in registry and generic methods through the generic handler', () => {
    const builtInHandler = {} as MintMethodHandler<'bolt11'>;
    const genericHandler = {} as MintMethodHandler<'fedimint'>;
    const registeredGenericHandler = {} as MintMethodHandler<'fedimint-v2'>;
    const provider = new MintHandlerProvider({ bolt11: builtInHandler });

    provider.registerGeneric(genericHandler);

    expect(provider.get('bolt11')).toBe(builtInHandler);
    expect(provider.get('fedimint')).toBe(genericHandler);
    expect(() => provider.get('bolt12')).toThrow('No mint handler registered for method bolt12');
    expect(provider.getAll().bolt11).toBe(builtInHandler);

    provider.register('fedimint-v2', registeredGenericHandler);

    expect(provider.get('fedimint-v2')).toBe(registeredGenericHandler);
  });

  it('routes melt built-in methods through the built-in registry and generic methods through the generic handler', () => {
    const builtInHandler = {} as MeltMethodHandler<'bolt11'>;
    const genericHandler = {} as MeltMethodHandler<'gift-card'>;
    const registeredGenericHandler = {} as MeltMethodHandler<'gift-card-v2'>;
    const provider = new MeltHandlerProvider({ bolt11: builtInHandler });

    provider.registerGeneric(genericHandler);

    expect(provider.get('bolt11')).toBe(builtInHandler);
    expect(provider.get('gift-card')).toBe(genericHandler);
    expect(() => provider.get('bolt12')).toThrow('No melt handler registered for method bolt12');
    expect(provider.getAll().bolt11).toBe(builtInHandler);

    provider.register('gift-card-v2', registeredGenericHandler);

    expect(provider.get('gift-card-v2')).toBe(registeredGenericHandler);
  });
});
