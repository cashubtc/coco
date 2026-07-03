#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const reportPath = args.report ?? findDefaultReport();
const maxSlices = Number(args['max-slices'] ?? 3);
const windowSize = Number(args.window ?? 25);
const minClusterSize = Number(args['min-cluster-size'] ?? 10);
const maxClusterSize = Number(args['max-cluster-size'] ?? 50);

if (!reportPath) {
  fail('No mutation JSON report found. Expected reports/mutation/core-unit/mutation.json.');
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
if (!report.files || typeof report.files !== 'object') {
  fail(`Report does not look like a Stryker mutation report: ${reportPath}`);
}

const candidates = buildCandidates(report, {
  windowSize,
  minClusterSize,
  maxClusterSize,
}).sort((a, b) => b.score - a.score || b.undetected - a.undetected);

const frontier = candidates.slice(0, maxSlices);
const deferred = candidates.slice(maxSlices, maxSlices + 10);

printSummary(report, reportPath);
printFrontier(frontier, reportPath);
printDeferred(deferred);

function buildCandidates(report, options) {
  const candidates = [];

  for (const [file, data] of Object.entries(report.files)) {
    const source = data.source ?? '';
    const mutants = data.mutants ?? [];
    const undetected = mutants.filter(
      (mutant) => mutant.status === 'Survived' || mutant.status === 'NoCoverage',
    );
    const buckets = new Map();

    for (const mutant of undetected) {
      const line = mutant.location?.start?.line;
      if (!Number.isFinite(line)) continue;
      const start = Math.floor(line / options.windowSize) * options.windowSize;
      const key = `${file}:${start}`;
      const bucket =
        buckets.get(key) ??
        createBucket({
          file,
          source,
          start,
          end: start + options.windowSize - 1,
        });

      bucket.mutants.push(mutant);
      bucket.undetected++;
      bucket.statuses[mutant.status] = (bucket.statuses[mutant.status] ?? 0) + 1;
      bucket.mutators[mutant.mutatorName] = (bucket.mutators[mutant.mutatorName] ?? 0) + 1;
      buckets.set(key, bucket);
    }

    for (const bucket of buckets.values()) {
      if (bucket.undetected < options.minClusterSize) continue;
      if (bucket.undetected > options.maxClusterSize) continue;
      finalizeBucket(bucket);
      bucket.score = scoreBucket(bucket);
      candidates.push(bucket);
    }
  }

  return candidates;
}

function createBucket({ file, source, start, end }) {
  return {
    file,
    source,
    start,
    end,
    mutants: [],
    statuses: {},
    mutators: {},
    undetected: 0,
    suggestedTest: suggestTestFile(file),
    score: 0,
  };
}

function finalizeBucket(bucket) {
  bucket.noCoverage = bucket.statuses.NoCoverage ?? 0;
  bucket.survived = bucket.statuses.Survived ?? 0;
  bucket.topMutators = sortCounts(bucket.mutators).slice(0, 5);
  bucket.samples = bucket.mutants.slice(0, 5).map((mutant) => ({
    status: mutant.status,
    line: mutant.location.start.line,
    mutator: mutant.mutatorName,
    replacement: String(mutant.replacement ?? mutant.description ?? '').slice(0, 80),
  }));
  bucket.hasSuggestedTest = bucket.suggestedTest ? fs.existsSync(bucket.suggestedTest) : false;
  bucket.isTransport = /\/infra\/|WsConnection|Subscription|Transport|Polling/.test(bucket.file);
  bucket.isMostlyText =
    ((bucket.mutators.StringLiteral ?? 0) + (bucket.mutators.ObjectLiteral ?? 0)) /
      bucket.undetected >=
    0.6;
}

function scoreBucket(bucket) {
  let score = bucket.undetected;
  score += bucket.noCoverage * 1.5;
  score += bucket.hasSuggestedTest ? 25 : 0;
  score += /\/api\/|\/services\/|\/operations\//.test(bucket.file) ? 10 : 0;
  score -= bucket.isTransport ? 30 : 0;
  score -= bucket.isMostlyText ? 25 : 0;
  score -= Math.abs(bucket.undetected - 25) * 0.25;
  return score;
}

function suggestTestFile(file) {
  if (!file.startsWith('packages/core/')) return undefined;
  const base = path.basename(file, path.extname(file));
  const exact = `packages/core/test/unit/${base}.test.ts`;
  if (fs.existsSync(exact)) return exact;

  const recovery = `packages/core/test/unit/${base}.recovery.test.ts`;
  if (fs.existsSync(recovery)) return recovery;

  return exact;
}

function printSummary(report, selectedReportPath) {
  const allMutants = Object.values(report.files).flatMap((file) => file.mutants ?? []);
  const counts = countBy(allMutants, (mutant) => mutant.status);
  const killed = counts.Killed ?? 0;
  const timeout = counts.Timeout ?? 0;
  const survived = counts.Survived ?? 0;
  const noCoverage = counts.NoCoverage ?? 0;
  const detected = killed + timeout;
  const valid = detected + survived + noCoverage;
  const score = valid === 0 ? 0 : (detected / valid) * 100;

  console.log('# Stryker Frontier Triage');
  console.log('');
  console.log(`Report: ${selectedReportPath}`);
  console.log(`Mutation score: ${score.toFixed(2)}%`);
  console.log(
    `Valid mutants: ${valid}; detected: ${detected}; survived: ${survived}; no coverage: ${noCoverage}`,
  );
  console.log('');
}

function printFrontier(frontier, selectedReportPath) {
  console.log('## Current Frontier');
  console.log('');

  if (frontier.length === 0) {
    console.log('No low-hanging frontier candidates matched the current thresholds.');
    console.log('');
    return;
  }

  frontier.forEach((candidate, index) => {
    console.log(`${index + 1}. ${titleFor(candidate)}`);
    console.log(`   - File: ${candidate.file}:${candidate.start}-${candidate.end}`);
    console.log(`   - Suggested test seam: ${candidate.suggestedTest}`);
    console.log(
      `   - Undetected: ${candidate.undetected} (${candidate.noCoverage} NoCoverage, ${candidate.survived} Survived)`,
    );
    console.log(`   - Dominant mutators: ${formatCounts(candidate.topMutators)}`);
    console.log(`   - Low-hanging signal: ${why(candidate)}`);
    console.log(`   - Report context: ${selectedReportPath}`);
    console.log('   - Samples:');
    for (const sample of candidate.samples) {
      console.log(
        `     - ${sample.status} L${sample.line} ${sample.mutator}: ${sample.replacement}`,
      );
    }
    console.log('');
  });
}

function printDeferred(deferred) {
  console.log('## Deferred');
  console.log('');

  if (deferred.length === 0) {
    console.log('No additional candidates matched the current thresholds.');
    return;
  }

  for (const candidate of deferred) {
    console.log(
      `- ${candidate.file}:${candidate.start}-${candidate.end}: ${candidate.undetected} undetected; ${formatCounts(candidate.topMutators)}`,
    );
  }
}

function titleFor(candidate) {
  const base = path.basename(candidate.file, path.extname(candidate.file));
  const gap =
    candidate.noCoverage >= candidate.survived ? 'cover missing branch' : 'strengthen assertions';
  return `${base}: ${gap} around lines ${candidate.start}-${candidate.end}`;
}

function why(candidate) {
  const reasons = [];
  if (candidate.hasSuggestedTest) reasons.push('existing unit test file');
  if (candidate.noCoverage >= candidate.survived) reasons.push('mostly no-coverage');
  if (!candidate.isTransport) reasons.push('not transport lifecycle');
  if (!candidate.isMostlyText) reasons.push('not dominated by text/object noise');
  return reasons.join('; ') || 'highest remaining score after filters';
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function sortCounts(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function formatCounts(entries) {
  return entries.map(([name, count]) => `${name}:${count}`).join(', ');
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = rawArgs[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index++;
    }
  }
  return parsed;
}

function findDefaultReport() {
  const primary = 'reports/mutation/core-unit/mutation.json';
  if (fs.existsSync(primary)) return primary;

  const reportsRoot = 'reports/mutation';
  if (!fs.existsSync(reportsRoot)) return undefined;

  const candidates = [];
  walk(reportsRoot, (file) => {
    if (path.basename(file) === 'mutation.json') {
      candidates.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    }
  });
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.file;
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(entryPath, visit);
    else visit(entryPath);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
