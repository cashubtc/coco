import { format } from './format';
import type { Output } from './protocol';

/** A channel belongs to one run (or the session's background activity). */
export function createOutputChannel(emit: (output: Output, id?: number) => void, id?: number) {
  let budget = 64000;
  const write = (level: Output['level'], ...values: unknown[]) => {
    if (budget <= 0) return;
    const text = values.map(format).join(' ').slice(0, budget);
    budget -= text.length + 1;
    emit({ level, text }, id);
    if (budget <= 0)
      emit(
        {
          level: 'warn',
          text:
            id === undefined
              ? 'Background output limit reached. Reset to resume background logging.'
              : 'Output limit reached for this run. Later runs have their own log budget.',
        },
        id,
      );
  };
  return {
    write,
    // A bounded final result must remain visible even after logs exhaust their budget.
    result: (value: unknown) => emit({ level: 'result', text: format(value) }, id),
    console: {
      log: (...values: unknown[]) => write('log', ...values),
      info: (...values: unknown[]) => write('info', ...values),
      warn: (...values: unknown[]) => write('warn', ...values),
      error: (...values: unknown[]) => write('error', ...values),
      debug: (...values: unknown[]) => write('log', ...values),
      dir: (value: unknown) => write('log', value),
      table: (value: unknown) => write('log', value),
      assert: (condition: unknown, ...values: unknown[]) => {
        if (!condition) write('error', 'Assertion failed:', ...values);
      },
    },
  };
}
