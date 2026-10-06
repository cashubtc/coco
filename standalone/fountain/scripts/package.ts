import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

// Pack the current source through prepack, then test the artifact without workspace symlinks.
const packageRoot = resolve(import.meta.dir, '..');
const temp = await mkdtemp(join(tmpdir(), 'coco-fountain-package-'));
async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'inherit' });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`${command.join(' ')} failed\n${output}`);
  return output.trim();
}
const tarball = join(temp, 'coco-fountain.tgz');
await run(['bun', 'pm', 'pack', '--filename', tarball], packageRoot);
const packedRoot = join(temp, 'packed');
await mkdir(packedRoot);
await run(['tar', '-xzf', tarball, '-C', packedRoot], packageRoot);
const paths = new Set(
  (await run(['tar', '-tzf', tarball], packageRoot))
    .split('\n')
    .map((path) => path.replace(/^package\//, '')),
);
const metadata = await Bun.file(join(packedRoot, 'package/package.json')).json();
assert.equal(metadata.name, '@cashu/coco-fountain');
for (const entry of Object.values(metadata.exports) as { types: string; import: string }[]) {
  for (const path of [entry.types, entry.import])
    assert.ok(paths.has(path.replace(/^\.\//, '')), `Missing export ${path}`);
}
for (const path of ['LICENSE', 'NOTICE.md', 'CHANGELOG.md']) assert.ok(paths.has(path));
assert.ok(!paths.has('README.md'));
assert.ok(![...paths].some((path) => /^(docs|src|test|scripts|node_modules|apps)\//.test(path)));
assert.equal(metadata.license, 'MIT');
const consumer = join(temp, 'consumer');
await mkdir(consumer);
await Bun.write(
  join(consumer, 'package.json'),
  JSON.stringify({
    private: true,
    type: 'module',
    dependencies: { '@cashu/coco-fountain': `file:${tarball}` },
  }),
);
await Bun.write(join(consumer, 'bunfig.toml'), Bun.file(join(packageRoot, 'bunfig.toml')));
await run(['bun', 'install', '--production'], consumer);
for (const dependency of [
  '@gandlaf21/bc-ur',
  'buffer',
  'jsbi',
  'bignumber.js',
  '@apocentre/alias-sampling',
  'typescript',
]) {
  assert.equal(
    await Bun.file(join(consumer, 'node_modules', dependency, 'package.json')).exists(),
    false,
    `Unexpected runtime dependency ${dependency}`,
  );
}
const vectors = await Bun.file(join(packageRoot, 'test/unit/fixtures/urkit.json')).json();
await Bun.write(
  join(consumer, 'consumer.ts'),
  `
import * as api from '@cashu/coco-fountain';
import { FountainEncoder, FountainDecoder } from '@cashu/coco-fountain/core';
import { tokenToBytes, bytesToToken, bytesToTokenString, type Token } from '@cashu/coco-fountain/cashu';
import { UrDecoder } from '@cashu/coco-fountain/ur';
import { AutoDecoder } from '@cashu/coco-fountain/auto';
import { encodeCbor, decodeCbor, encodeBase64Url, decodeBase64Url } from '@cashu/coco-fountain/encoding';
function check(value: boolean, message: string) { if (!value) throw new Error(message); }
check(api.FountainEncoder === FountainEncoder && api.AutoDecoder === AutoDecoder, 'root exports');
const message = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
const encoder = new FountainEncoder(message, { fragmentSize: 100 });
const strict = new FountainDecoder(), auto = new AutoDecoder();
for (let i = 0; i < encoder.fragmentCount; i++) encoder.nextFrame();
for (let i = 0; i < 500 && !strict.isComplete; i++) {
  const frame = encoder.nextFrame(); if (i % 3 === 0) continue;
  strict.receive(frame); auto.receive(frame);
}
check(strict.isComplete && auto.isComplete, 'repair decoding');
check(strict.result!.every((value, i) => value === message[i]), 'exact bytes');
check(encodeBase64Url(decodeBase64Url(encodeBase64Url(message))) === encodeBase64Url(message), 'base64');
check((decodeCbor(encodeCbor([1, 2])) as number[])[1] === 2, 'CBOR');
const text = 'cashuB' + encodeBase64Url(encodeCbor({m:'https://mint.example',u:'sat',t:[{i:new Uint8Array(8),p:[{a:1,s:'synthetic',c:Uint8Array.of(2,...new Uint8Array(32))}]}]}));
const binary = tokenToBytes(text); const token: Token = bytesToToken(binary);
check(token.mint === 'https://mint.example' && bytesToTokenString(binary) === text, 'Cashu');
const ur = new UrDecoder(); ur.receive(${JSON.stringify(vectors.single)});
auto.reset(); auto.receive(${JSON.stringify(vectors.single)});
check(ur.isComplete && auto.isComplete, 'UR routing');
check(Array.from(ur.result!, b => b.toString(16).padStart(2, '0')).join('') === ${JSON.stringify(vectors.singlePayloadHex)}, 'UR payload');
if (typeof window !== 'undefined') check(!('Buffer' in globalThis) && !('process' in globalThis), 'no Node polyfills');
console.log('All six package entry points pass');
`,
);
const tsc = join(packageRoot, 'node_modules/typescript/bin/tsc');
const flags = ['--strict', '--skipLibCheck', 'false', '--target', 'ES2022', '--lib', 'ES2022,DOM'];
await run(
  [
    'node',
    tsc,
    'consumer.ts',
    ...flags,
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--outDir',
    'node-output',
  ],
  consumer,
);
await run(['node', 'node-output/consumer.js'], consumer);
await run(
  [
    'node',
    tsc,
    'consumer.ts',
    ...flags,
    '--module',
    'ESNext',
    '--moduleResolution',
    'Bundler',
    '--noEmit',
  ],
  consumer,
);
const bundle = await Bun.build({
  entrypoints: [join(consumer, 'consumer.ts')],
  target: 'browser',
  format: 'esm',
});
if (!bundle.success) throw new AggregateError(bundle.logs, 'Isolated browser bundle failed');
const javascript = await bundle.outputs[0]!.text();
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    return new URL(request.url).pathname === '/consumer.js'
      ? new Response(javascript, { headers: { 'content-type': 'text/javascript' } })
      : new Response('<!doctype html><title>Package acceptance</title>');
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
  await page.evaluate(async () => {
    const path = '/consumer.js';
    await import(path);
  });
} finally {
  await browser?.close();
  await server.stop(true);
}
console.log(
  JSON.stringify(
    {
      tarball,
      files: paths.size,
      prepack: true,
      productionOnlyInstall: true,
      nodeRuntime: true,
      types: ['NodeNext', 'Bundler'],
      chromium: true,
    },
    null,
    2,
  ),
);
