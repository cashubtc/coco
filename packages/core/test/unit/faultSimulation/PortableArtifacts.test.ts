import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exportPortableArtifacts,
  findProhibitedContent,
  inspectPrivateRetention,
} from '../../fault-simulation/artifacts.ts';
import { RedactionError } from '../../fault-simulation/trace.ts';

const fixtureText = (name: string) =>
  readFileSync(new URL(`../../fault-simulation/fixtures/${name}`, import.meta.url), 'utf8');

const fixtures = [
  'v1-receive-lost-response-crash-restart.trace.json',
  'v1-negative-control-no-restart.trace.json',
  'v2-generated-seed-2-false-deficit.trace.json',
];

// Synthetic secrets in the shapes the harness handles. None is a real Wallet Seed or token.
const walletSeedHex = '5e'.repeat(64);
const proofSecret = '7a'.repeat(32);
const rawToken = `cashuB${'o2FteCJodHRwOi8vbG9jYWxob3N0OjMzMzhhdWNzYXRhdIGiYWlI'.repeat(2)}`;

let root: string;
let runDir: string;
let outDir: string;

/** Snapshot of every file under a directory, to show it is left untouched. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[path] = readFileSync(path, 'base64');
  }
  return files;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coco-faultsim-artifacts-'));
  runDir = join(root, 'runs', 'generated-seed-2');
  outDir = join(root, 'portable');
  mkdirSync(join(runDir, 'private'), { recursive: true });
  chmodSync(join(runDir, 'private'), 0o700);
  writeFileSync(join(runDir, 'trace.json'), fixtureText(fixtures[2]!));
  writeFileSync(join(runDir, 'private', 'alice.seed'), walletSeedHex, { mode: 0o600 });
  writeFileSync(join(runDir, 'private', 'alice.sqlite'), 'store');
  writeFileSync(join(runDir, 'gateway-mint-a.log'), 'listening on 127.0.0.1\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('prohibited content', () => {
  it('finds nothing in real redacted traces, including keyset IDs and image digests', () => {
    for (const name of fixtures) expect(findProhibitedContent(fixtureText(name))).toEqual([]);
  });

  it('flags raw tokens, Wallet Seed hex, proof secrets and secret fields without echoing them', () => {
    const findings = findProhibitedContent(
      JSON.stringify({
        token: rawToken,
        seed: walletSeedHex,
        note: `x ${proofSecret} y`,
        secret: 'abc',
      }),
    );

    expect(findings.map((finding) => finding.kind).sort()).toEqual([
      'proof_secret',
      'raw_token',
      'secret_field',
      'seed_field',
      'wallet_seed',
    ]);
    const reported = JSON.stringify(findings);
    for (const secret of [rawToken, walletSeedHex, proofSecret]) {
      expect(reported).not.toContain(secret.slice(0, 16));
    }
  });
});

describe('portable artifact export', () => {
  it('exports the trace and reports, never private inputs, and leaves the run untouched', () => {
    const before = snapshot(runDir);

    const exported = exportPortableArtifacts(runDir, outDir);

    expect(exported.files.sort()).toEqual([
      'gateway-mint-a.log',
      'report.json',
      'report.md',
      'trace.json',
    ]);
    expect(existsSync(join(outDir, 'private'))).toBe(false);
    expect(readFileSync(join(outDir, 'trace.json'), 'utf8')).toBe(fixtureText(fixtures[2]!));
    const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
    expect(report).toMatchObject({ outcome: 'wallet_failure', expectationMet: false });
    expect(readFileSync(join(outDir, 'report.md'), 'utf8')).toContain('value_deficit');
    for (const file of exported.files) {
      expect(readFileSync(join(outDir, file), 'utf8')).not.toContain(walletSeedHex);
    }
    expect(snapshot(runDir)).toEqual(before);
  });

  it('withholds a log that would leak a token and says why', () => {
    writeFileSync(join(runDir, 'gateway-mint-b.log'), `forwarding ${rawToken}\n`);

    const exported = exportPortableArtifacts(runDir, outDir);

    expect(exported.files).not.toContain('gateway-mint-b.log');
    expect(exported.withheld).toEqual([{ file: 'gateway-mint-b.log', reasons: ['raw_token'] }]);
    expect(existsSync(join(outDir, 'gateway-mint-b.log'))).toBe(false);
  });

  it('refuses to export a trace that contains a retained private Wallet Seed', () => {
    const opaqueSeed = 'opaque-wallet-seed-without-a-recognizable-shape';
    writeFileSync(join(runDir, 'private', 'bob.seed'), opaqueSeed, { mode: 0o600 });
    const trace = JSON.parse(fixtureText(fixtures[2]!));
    trace.events[0].data.note = opaqueSeed;
    writeFileSync(join(runDir, 'trace.json'), JSON.stringify(trace));

    expect(() => exportPortableArtifacts(runDir, outDir)).toThrow(RedactionError);
    expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([]);
  });
});

describe('private input retention', () => {
  it('reports retained private inputs and whether only the owner can read them', () => {
    expect(inspectPrivateRetention(runDir)).toEqual({
      retained: true,
      protected: true,
      files: ['alice.seed', 'alice.sqlite'],
    });

    chmodSync(join(runDir, 'private'), 0o755);
    expect(inspectPrivateRetention(runDir)).toMatchObject({ retained: true, protected: false });
  });

  it('reports a run whose private inputs were removed', () => {
    rmSync(join(runDir, 'private'), { recursive: true });

    expect(inspectPrivateRetention(runDir)).toEqual({
      retained: false,
      protected: true,
      files: [],
    });
  });
});
