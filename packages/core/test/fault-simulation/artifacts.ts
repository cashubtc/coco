/**
 * What may leave a run directory.
 *
 * A run directory holds the portable redacted `trace.json`, gateway logs and, under `private/`,
 * the Wallet Seeds, Wallet stores and Wallet process logs needed to inspect the original Wallet
 * state. Only portable files may be published or uploaded as CI artifacts; `private/` never is.
 *
 * The trace writer already refuses to write any secret the harness registered. This module adds an
 * independent check for anything exported: a scan for secret-shaped content and for the retained
 * Wallet Seeds themselves. Findings name the kind of content, never its value.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildRunReport, renderReport } from './report.ts';
import { RedactionError, readTrace } from './trace.ts';

export type ProhibitedContentKind =
  | 'raw_token'
  | 'wallet_seed'
  | 'proof_secret'
  | 'secret_field'
  | 'seed_field'
  | 'mnemonic_field'
  | 'retained_private_input';

export interface ProhibitedContent {
  kind: ProhibitedContentKind;
  occurrences: number;
}

const PATTERNS: [ProhibitedContentKind, RegExp][] = [
  // Serialized Cashu tokens (V3 `cashuA`, V4 `cashuB`).
  ['raw_token', /cashu[AB][A-Za-z0-9_\-+/=]{16,}/g],
  // A 64-byte Wallet Seed as hex, as the harness stores it.
  ['wallet_seed', /(?<![0-9a-fA-F])[0-9a-fA-F]{128}(?![0-9a-fA-F])/g],
  // A 32-byte hex proof secret. Image digests (`sha256:` + 64 hex) are public.
  ['proof_secret', /(?<![0-9a-fA-F]|sha256:)[0-9a-fA-F]{64}(?![0-9a-fA-F])/g],
  ['secret_field', /"secret"\s*:\s*"/g],
  ['seed_field', /"seed"\s*:\s*"/g],
  // A mnemonic phrase rather than a description such as "test vector 1".
  ['mnemonic_field', /"mnemonic"\s*:\s*"(?:[a-z]+ ){11,}[a-z]+"/g],
];

/** Kinds of secret-shaped content in `text`, without the matched values. */
export function findProhibitedContent(
  text: string,
  knownSecrets: string[] = [],
): ProhibitedContent[] {
  const found: ProhibitedContent[] = [];
  for (const [kind, pattern] of PATTERNS) {
    const occurrences = text.match(pattern)?.length ?? 0;
    if (occurrences > 0) found.push({ kind, occurrences });
  }
  const retained = knownSecrets.filter((secret) => text.includes(secret)).length;
  if (retained > 0) found.push({ kind: 'retained_private_input', occurrences: retained });
  return found;
}

const privateDir = (runDir: string) => join(runDir, 'private');

/** Wallet Seeds retained beside a run, used to prove they do not reach exported files. */
function retainedSecrets(runDir: string): string[] {
  const dir = privateDir(runDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.seed'))
    .map((name) => readFileSync(join(dir, name), 'utf8').trim())
    .filter((secret) => secret.length > 0);
}

export interface PortableExport {
  /** Files written to the export directory. */
  files: string[];
  /** Run files left out because they contain prohibited content. */
  withheld: { file: string; reasons: ProhibitedContentKind[] }[];
}

/**
 * Copies a run's portable evidence to `outDir`: the trace unchanged, `report.json`, `report.md`
 * and top-level logs and JSON files that pass the scan. Throws {@link RedactionError} and writes
 * nothing when the trace itself contains prohibited content. Never reads Wallet stores, never
 * copies `private/` and never modifies the run directory. The destination must not already exist.
 */
export function exportPortableArtifacts(runDir: string, outDir: string): PortableExport {
  if (existsSync(outDir)) throw new Error('Export destination must be a new directory');
  const secrets = retainedSecrets(runDir);
  const kinds = (text: string) => findProhibitedContent(text, secrets).map(({ kind }) => kind);

  const traceText = readFileSync(join(runDir, 'trace.json'), 'utf8');
  const traceProblems = kinds(traceText);
  if (traceProblems.length > 0) {
    throw new RedactionError(`trace.json contains prohibited content: ${traceProblems.join(', ')}`);
  }
  const report = buildRunReport(readTrace(traceText));
  const outputs = new Map<string, string>([
    ['trace.json', traceText],
    ['report.json', JSON.stringify(report, null, 2)],
    ['report.md', renderReport(report)],
  ]);
  for (const generated of ['report.json', 'report.md']) {
    const problems = kinds(outputs.get(generated)!);
    if (problems.length > 0) {
      throw new RedactionError(`${generated} would contain prohibited content: ${problems}`);
    }
  }

  const withheld: PortableExport['withheld'] = [];
  for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    if (!entry.isFile() || outputs.has(entry.name)) continue;
    if (!/\.(log|json)$/.test(entry.name)) continue;
    const text = readFileSync(join(runDir, entry.name), 'utf8');
    const problems = kinds(text);
    if (problems.length > 0) withheld.push({ file: entry.name, reasons: problems });
    else outputs.set(entry.name, text);
  }

  mkdirSync(dirname(outDir), { recursive: true });
  // Exclusive creation also prevents two exports from publishing into the same destination.
  mkdirSync(outDir);
  for (const [name, text] of outputs) writeFileSync(join(outDir, name), text);
  return { files: [...outputs.keys()], withheld };
}

export interface PrivateRetention {
  /** Private inputs are still present beside the trace. */
  retained: boolean;
  /** The private directory and Wallet Seed files are accessible only to their owner. */
  protected: boolean;
  files: string[];
}

/** Whether a run's private replay inputs and Wallet store snapshots are retained and protected. */
export function inspectPrivateRetention(runDir: string): PrivateRetention {
  const dir = privateDir(runDir);
  if (!existsSync(dir)) return { retained: false, protected: true, files: [] };
  const ownerOnly = (path: string) => (statSync(path).mode & 0o077) === 0;
  const files = readdirSync(dir).sort();
  return {
    retained: true,
    protected:
      ownerOnly(dir) &&
      files.filter((name) => name.endsWith('.seed')).every((name) => ownerOnly(join(dir, name))),
    files,
  };
}

if (import.meta.main) {
  const [runDir, outDir] = process.argv.slice(2);
  if (!runDir || !outDir) {
    console.error('Usage: bun packages/core/test/fault-simulation/artifacts.ts <runDir> <outDir>');
    process.exit(2);
  }
  console.log(
    JSON.stringify(
      {
        ...exportPortableArtifacts(runDir, outDir),
        privateInputs: inspectPrivateRetention(runDir),
      },
      null,
      2,
    ),
  );
}
