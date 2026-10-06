import { chromium } from 'playwright';
import { Amount, getEncodedToken, getEncodedTokenBinary, type Token } from '@cashu/cashu-ts';
import { Buffer } from 'buffer';
import { UR, UREncoder } from '@gandlaf21/bc-ur/dist/lib/es6/index.js';
import type { Fixtures } from '../test/unit/browser/acceptance';

// Only fixture production uses the reference encoder and Node-compatible tools.
// The browser consumer imports the built package through its public export map.
const token: Token = {
  mint: 'https://mint.example',
  unit: 'sat',
  memo: 'Browser experiment',
  proofs: [
    {
      amount: Amount.from(1),
      id: '009a1f293253e41e',
      secret: 'not-spendable',
      C: '02' + '11'.repeat(32),
    },
  ],
};
const cashuB = getEncodedToken(token);
const fixtures: Fixtures = { cashuB, ur: [] };
for (const [name, payload] of [
  ['cashuB text', new TextEncoder().encode(cashuB)],
  ['crawB binary', getEncodedTokenBinary(token)],
] as const) {
  for (const multipart of [false, true]) {
    const encoder = new UREncoder(UR.fromBuffer(Buffer.from(payload)), multipart ? 32 : 4096);
    const parts = Array.from({ length: encoder.fragmentsLength }, () =>
      encoder.nextPart().toUpperCase(),
    );
    if (parts.length > 1 !== multipart) throw new Error('Unexpected reference fixture size');
    fixtures.ur.push({ label: `${multipart ? 'multipart' : 'single-part'} UR ${name}`, parts });
  }
  const repairEncoder = new UREncoder(UR.fromBuffer(Buffer.from(payload)), 32);
  for (let i = 0; i < repairEncoder.fragmentsLength; i++) repairEncoder.nextPart();
  const repairs = Array.from({ length: repairEncoder.fragmentsLength * 6 + 20 }, () =>
    repairEncoder.nextPart(),
  )
    .filter((_, i) => i % 3 !== 0)
    .reverse();
  fixtures.ur.push({
    label: `repair-only UR ${name} with loss, reordering, duplicates and malformed input`,
    parts: ['ur:bytes/zz', ...repairs.flatMap((part) => [part, part.toUpperCase()])],
  });
}

const forbiddenRuntimeDependencies = new Set<string>();
const build = await Bun.build({
  entrypoints: ['test/unit/browser/acceptance.ts'],
  target: 'browser',
  format: 'esm',
  plugins: [
    {
      name: 'production-runtime-boundary',
      setup(build) {
        build.onResolve(
          {
            filter:
              /^(@gandlaf21\/bc-ur|buffer|jsbi|bignumber\.js|@apocentre\/alias-sampling)(\/|$)/,
          },
          (args) => {
            forbiddenRuntimeDependencies.add(args.path);
            return undefined;
          },
        );
      },
    },
  ],
});
if (!build.success) throw new AggregateError(build.logs, 'Browser consumer build failed');
if (forbiddenRuntimeDependencies.size) {
  throw new Error(
    `Development-only dependencies in browser runtime: ${[...forbiddenRuntimeDependencies].join(', ')}`,
  );
}
const bundle = await build.outputs[0]!.text();
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === '/acceptance.js') {
      return new Response(bundle, { headers: { 'Content-Type': 'text/javascript' } });
    }
    return new Response('<!doctype html><title>Coco fountain browser acceptance</title>', {
      headers: { 'Content-Type': 'text/html' },
    });
  },
});
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const page = await browser.newPage();
  await page.goto(server.url.href);
  const result = await page.evaluate(async (fixtures) => {
    if ('Buffer' in globalThis || 'process' in globalThis)
      throw new Error('Unexpected Node globals before import');
    const url = '/acceptance.js';
    const { runAcceptance } = await import(url);
    return { userAgent: navigator.userAgent, passed: runAcceptance(fixtures) as string[] };
  }, fixtures);
  console.log(JSON.stringify({ chromium: browser.version(), ...result }, null, 2));
} finally {
  await browser?.close();
  await server.stop(true);
}
