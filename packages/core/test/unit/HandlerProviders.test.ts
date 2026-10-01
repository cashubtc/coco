import { describe, expect, it } from 'bun:test';
import { MeltHandlerProvider } from '../../infra/handlers/melt/MeltHandlerProvider.ts';
import { MintHandlerProvider } from '../../infra/handlers/mint/MintHandlerProvider.ts';
import { SendHandlerProvider } from '../../infra/handlers/send/SendHandlerProvider.ts';
import type { MeltMethodHandlerRegistry } from '../../operations/melt/MeltMethodHandler.ts';
import type { MintMethodHandlerRegistry } from '../../operations/mint/MintMethodHandler.ts';
import type { SendMethodHandlerRegistry } from '../../operations/send/SendMethodHandler.ts';

const unused = async () => {
  throw new Error('Handler execution is outside the lookup tests');
};

const mintHandler = {
  createQuote: unused,
  fetchRemoteQuote: unused,
  execute: unused,
  recoverExecuting: unused,
  checkPending: unused,
} satisfies MintMethodHandlerRegistry['bolt11'];

const meltHandler = {
  createQuote: unused,
  fetchRemoteQuote: unused,
  prepare: unused,
  execute: unused,
  recoverExecuting: unused,
} satisfies MeltMethodHandlerRegistry['bolt11'];

const sendHandler = {
  canReclaim: true,
  prepare: () => ({ forceSwap: false }),
} satisfies SendMethodHandlerRegistry['default'];

describe('Constructor-configured handler lookups', () => {
  it('keeps send dispatch fixed when the original handler map changes', () => {
    const handlers: Partial<SendMethodHandlerRegistry> = { default: sendHandler };
    const provider = new SendHandlerProvider(handlers);
    handlers.default = { ...sendHandler, canReclaim: false };
    handlers.p2pk = sendHandler;

    expect(provider.get('default')).toBe(sendHandler);
    expect(() => provider.get('p2pk')).toThrow('No send handler registered for method p2pk');
  });

  it('keeps mint dispatch fixed when the original handler map changes', () => {
    const handlers: Partial<MintMethodHandlerRegistry> = { bolt11: mintHandler };
    const provider = new MintHandlerProvider(handlers);
    handlers.bolt11 = { ...mintHandler };
    handlers.bolt12 = mintHandler;

    expect(provider.get('bolt11')).toBe(mintHandler);
    expect(() => provider.get('bolt12')).toThrow('No mint handler registered for method bolt12');
  });

  it('keeps melt dispatch fixed when the original handler map changes', () => {
    const handlers: Partial<MeltMethodHandlerRegistry> = { bolt11: meltHandler };
    const provider = new MeltHandlerProvider(handlers);
    handlers.bolt11 = { ...meltHandler };
    handlers.bolt12 = meltHandler;

    expect(provider.get('bolt11')).toBe(meltHandler);
    expect(() => provider.get('bolt12')).toThrow('No melt handler registered for method bolt12');
  });

  it('preserves missing-handler errors for empty lookups', () => {
    expect(() => new SendHandlerProvider().get('default')).toThrow(
      'No send handler registered for method default',
    );
    expect(() => new MintHandlerProvider().get('bolt11')).toThrow(
      'No mint handler registered for method bolt11',
    );
    expect(() => new MeltHandlerProvider().get('bolt11')).toThrow(
      'No melt handler registered for method bolt11',
    );
  });
});
