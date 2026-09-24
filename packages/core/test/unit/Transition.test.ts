import { Glob } from 'bun';
import { describe, expect, it } from 'bun:test';
import { relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  defineTransition,
  getTransitionBody,
  type Transition,
} from '../../transactions/Transition.ts';

describe('Transition', () => {
  it('defines a frozen value without a call signature or public body property', () => {
    const transition = defineTransition(async (_tx, input: number) => input + 1);

    expect(typeof transition).toBe('object');
    expect(Object.isFrozen(transition)).toBe(true);
    expect(Object.keys(transition)).toEqual([]);
    expect(typeof getTransitionBody(transition)).toBe('function');
  });

  it('exports only transitions from every workflow transition module', async () => {
    const directory = fileURLToPath(new URL('../../transactions/transitions/', import.meta.url));
    const files = [...new Glob('**/*.ts').scanSync({ cwd: directory, absolute: true })].sort();
    let transitions = 0;

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const exports: Record<string, unknown> = await import(pathToFileURL(file).href);
      for (const [name, value] of Object.entries(exports)) {
        const description = `${relative(directory, file)}: ${name}`;
        expect(typeof value, description).toBe('object');
        expect(value, description).not.toBeNull();
        expect(Object.isFrozen(value), description).toBe(true);
        expect(typeof getTransitionBody(value as Transition<never, unknown>), description).toBe(
          'function',
        );
        transitions++;
      }
    }
    expect(transitions).toBeGreaterThan(0);
  });
});
