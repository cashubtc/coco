import { describe, expect, it } from 'bun:test';
import { assertGenericMeltMethod, isBuiltInMeltMethod } from '../../infra/handlers/melt';
import { assertGenericMintMethod, isBuiltInMintMethod } from '../../infra/handlers/mint';

describe('payment method routing guards', () => {
  it('identifies built-in mint and melt methods', () => {
    expect(isBuiltInMintMethod('bolt11')).toBe(true);
    expect(isBuiltInMintMethod('bolt12')).toBe(true);
    expect(isBuiltInMintMethod('onchain')).toBe(true);
    expect(isBuiltInMintMethod('nostr-zap')).toBe(false);

    expect(isBuiltInMeltMethod('bolt11')).toBe(true);
    expect(isBuiltInMeltMethod('bolt12')).toBe(true);
    expect(isBuiltInMeltMethod('onchain')).toBe(true);
    expect(isBuiltInMeltMethod('lnurl-pay')).toBe(false);
  });

  it('rejects built-in methods from generic routing paths', () => {
    expect(() => assertGenericMintMethod('bolt11')).toThrow(
      'Built-in mint method bolt11 must use its built-in handler path',
    );
    expect(() => assertGenericMeltMethod('onchain')).toThrow(
      'Built-in melt method onchain must use its built-in handler path',
    );

    expect(() => assertGenericMintMethod('nostr-zap')).not.toThrow();
    expect(() => assertGenericMeltMethod('lnurl-pay')).not.toThrow();
  });
});
