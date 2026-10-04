import { expect, test } from 'bun:test';
import { Evaluator } from '../evaluator';
import { createOutputChannel } from '../output';
import type { Output } from '../protocol';

test('older callbacks cannot consume another run’s console budget or final result', async () => {
  const messages: { output: Output; id?: number }[] = [];
  const emit = (output: Output, id?: number) => messages.push({ output, id });
  const first = createOutputChannel(emit, 1);
  const second = createOutputChannel(emit, 2);
  const session = new Evaluator({}, async () => ({}));
  await session.execute(
    `
    const flood = () => { for (let i = 0; i < 20; i++) console.log('x'.repeat(8000)); };
    const callback = () => console.log('old callback');
  `,
    undefined,
    { console: first.console },
  );
  const result = await session.execute(
    `
    await Promise.resolve(); callback(); flood(); console.log('new run'); 42;
  `,
    undefined,
    { console: second.console },
  );
  second.result(result);
  expect(messages.find(({ output }) => output.text === 'old callback')?.id).toBe(1);
  expect(messages.filter(({ output, id }) => id === 1 && output.level === 'warn')).toHaveLength(1);
  expect(messages.filter(({ id }) => id === 2)).toEqual([
    { id: 2, output: { level: 'log', text: 'new run' } },
    { id: 2, output: { level: 'result', text: '42' } },
  ]);
});

test('log limits remain bounded while final results and background output are independent', () => {
  const messages: { output: Output; id?: number }[] = [];
  const emit = (output: Output, id?: number) => messages.push({ output, id });
  const background = createOutputChannel(emit);
  const run = createOutputChannel(emit, 1);
  for (let i = 0; i < 30; i++) {
    background.write('event', 'background'.repeat(2000));
    run.console.log('foreground'.repeat(2000));
  }
  run.result('r'.repeat(100000));
  for (const id of [undefined, 1]) {
    const logs = messages.filter(
      (message) => message.id === id && message.output.level !== 'result',
    );
    expect(logs.filter(({ output }) => output.level === 'warn')).toHaveLength(1);
    expect(
      logs
        .filter(({ output }) => output.level !== 'warn')
        .reduce((length, { output }) => length + output.text.length, 0),
    ).toBeLessThanOrEqual(64000);
  }
  expect(messages.at(-1)?.output.level).toBe('result');
  expect(messages.at(-1)?.output.text.length).toBeLessThanOrEqual(12000);
});
