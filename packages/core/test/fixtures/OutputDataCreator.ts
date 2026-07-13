import type { OutputDataCreator } from '@cashu/cashu-ts';

export function makeOutputDataCreator(
  overrides: Partial<OutputDataCreator> = {},
): OutputDataCreator {
  const unexpected = (): never => {
    throw new Error('Unexpected output creator method call');
  };

  return {
    createP2PKData: unexpected,
    createSingleP2PKData: unexpected,
    createRandomData: unexpected,
    createSingleRandomData: unexpected,
    createDeterministicData: unexpected,
    createSingleDeterministicData: unexpected,
    ...overrides,
  };
}
