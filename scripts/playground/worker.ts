/// <reference lib="webworker" />
import * as core from '@cashu/coco-core';
import * as adapter from '@cashu/coco-core/adapter';
import * as plugin from '@cashu/coco-core/plugin';
import { assert as chaiAssert } from 'chai';
import { Evaluator } from './evaluator';
import { errorText } from './format';
import { createOutputChannel } from './output';
import type { Output, Request, Response } from './protocol';
import { eventNames } from 'virtual:playground-types';

const worker = self as unknown as DedicatedWorkerGlobalScope;
const send = (message: Response) => worker.postMessage(message);
const emit = (output: Output, id?: number) => send({ type: 'output', id, output });
const background = createOutputChannel(emit);
const capturedConsole = background.console;
// Match the convenient strict-assert spellings used by playground examples.
const assert = Object.assign(
  (condition: unknown, message?: string) => chaiAssert.isOk(condition, message),
  chaiAssert,
  {
    equal: chaiAssert.strictEqual,
    notEqual: chaiAssert.notStrictEqual,
    deepEqual: chaiAssert.deepEqual,
  },
);
const modules: Record<string, unknown> = {
  '@cashu/coco-core': core,
  '@cashu/coco-core/adapter': adapter,
  '@cashu/coco-core/plugin': plugin,
};
async function start() {
  let initialized = false;
  const seed = crypto.getRandomValues(new Uint8Array(64));
  const coco = await core.initializeCoco({
    repo: new core.MemoryRepositories(),
    seedGetter: async () => seed.slice(),
    logger: {
      debug: (...values) => {
        if (initialized) capturedConsole.debug(...values);
      },
      info: (...values) => {
        if (initialized) capturedConsole.info(...values);
      },
      warn: capturedConsole.warn,
      error: capturedConsole.error,
    },
    watchers: {
      mintOperationWatcher: { disabled: true },
      proofStateWatcher: { disabled: true },
      meltQuoteWatcher: { disabled: true },
    },
    processors: {
      mintOperationProcessor: { disabled: true },
      meltSettlementProcessor: { disabled: true },
    },
  });
  initialized = true;
  const evaluator = new Evaluator(
    { ...core, core, coco, assert, console: capturedConsole },
    async (name) => {
      if (Object.hasOwn(modules, name)) return modules[name];
      throw new Error(
        `Module '${name}' is not bundled. Available: ${Object.keys(modules).join(', ')}. Browser snippets cannot import Node or Bun modules.`,
      );
    },
  );
  // Subscribe through the public Manager API; persistence stays owned by core.
  for (const name of eventNames)
    coco.on(name, (payload) => {
      background.write('event', name, payload);
    });
  let busy = false;
  worker.onmessage = async ({ data }: MessageEvent<Request>) => {
    if (busy) {
      send({ type: 'done', id: data.id, prepared: false, error: 'A snippet is already running.' });
      return;
    }
    busy = true;
    const channel = createOutputChannel(emit, data.id);
    let prepared = false;
    try {
      const result = await evaluator.execute(
        data.source,
        () => {
          prepared = true;
        },
        { console: channel.console },
      );
      channel.result(result);
      send({ type: 'done', id: data.id, prepared });
    } catch (error) {
      send({ type: 'done', id: data.id, prepared, error: errorText(error) });
    } finally {
      busy = false;
    }
  };
  worker.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    background.write('error', errorText(event.reason));
  });
  worker.addEventListener('error', (event) => {
    // A timer/listener exception belongs to the snippet, not to worker startup.
    // Keep the session usable just as for an unhandled promise rejection.
    event.preventDefault();
    background.write('error', errorText(event.error ?? event.message));
  });
  send({ type: 'ready' });
}
start().catch((error) => send({ type: 'fatal', error: errorText(error) }));
