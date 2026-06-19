import { describe, expect, it } from 'bun:test';
import {
  hasPreparedData,
  isExecutingOperation,
  isFinalizedOperation,
  isInitOperation,
  isPendingOperation,
  isPreparedOperation,
  isRolledBackOperation,
  isRollingBackOperation,
  isTerminalOperation,
  type MeltOperation,
} from '../../operations/melt';

const operationWithState = (state: MeltOperation['state']): MeltOperation =>
  ({ state }) as MeltOperation;

describe('MeltOperation guards', () => {
  it('narrows individual melt operation states', () => {
    expect(isInitOperation(operationWithState('init'))).toBe(true);
    expect(isPreparedOperation(operationWithState('prepared'))).toBe(true);
    expect(isExecutingOperation(operationWithState('executing'))).toBe(true);
    expect(isPendingOperation(operationWithState('pending'))).toBe(true);
    expect(isFinalizedOperation(operationWithState('finalized'))).toBe(true);
    expect(isRollingBackOperation(operationWithState('rolling_back'))).toBe(true);
    expect(isRolledBackOperation(operationWithState('rolled_back'))).toBe(true);

    expect(isInitOperation(operationWithState('prepared'))).toBe(false);
    expect(isPendingOperation(operationWithState('executing'))).toBe(false);
  });

  it('detects prepared-or-later and terminal melt operation states', () => {
    expect(hasPreparedData(operationWithState('init'))).toBe(false);
    expect(hasPreparedData(operationWithState('prepared'))).toBe(true);

    expect(isTerminalOperation(operationWithState('finalized'))).toBe(true);
    expect(isTerminalOperation(operationWithState('rolled_back'))).toBe(true);
    expect(isTerminalOperation(operationWithState('failed'))).toBe(true);
    expect(isTerminalOperation(operationWithState('pending'))).toBe(false);
  });
});
