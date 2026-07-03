---
name: stryker-triage
description: Stryker frontier triage for cashubtc/coco mutation reports. Use when Codex needs to turn Stryker JSON, mutation testing results, survived mutants, no-coverage mutants, or mutation-score improvement work into a small set of low-hanging, agent-ready test slices.
---

# Stryker Triage

Turn a Stryker JSON report into the next mutation-testing frontier: a few small,
behavior-focused slices that agents can pick up without inheriting the whole report.

## Frontier Loop

1. Find the report.
   Prefer `reports/mutation/core-unit/mutation.json`. If it is missing, use the
   newest `mutation.json` under `reports/mutation/`. Do not parse HTML unless no JSON
   report exists.
   Completion criterion: one concrete report path is selected.

2. Generate the frontier.
   Run:

   ```bash
   node .agents/skills/stryker-triage/scripts/triage-mutation-report.mjs \
     --report <report-path> \
     --max-slices 3
   ```

   Completion criterion: the output has a `Current Frontier` section, or it states
   why no frontier candidates were found.

3. Convert evidence into behavior.
   For each frontier candidate, read the named source file and the suggested test
   file. Name the user-visible or domain behavior that should be asserted. Do not
   make a slice whose real task is "kill mutants at lines X-Y."
   Completion criterion: every selected candidate has a behavior name and a test seam.

4. Draft only the current frontier.
   Produce at most the requested number of slice drafts. Each draft must include:
   title, why this is low-hanging fruit, expected behavior to assert, mutation report
   context, acceptance criteria, and validation commands.
   Completion criterion: no deferred cluster is promoted into a draft.

5. Hand off through the repo workflow.
   If the user wants GitHub issues, pass the drafts to `$to-issues`. If the user wants
   implementation, use `$pickup-issue` for published issues or `$tdd` for a single
   local slice.
   Completion criterion: the next step is explicit: issue drafting, implementation,
   or rerun Stryker after completed slices.

## Frontier Rules

- Default to 1-3 slices per run.
- Prefer clusters with existing nearby unit tests, one source file, one behavior seam,
  and 10-50 undetected mutants.
- Prefer no-coverage branches before weak assertions.
- Prefer meaningful branch/state/error mutants over pure logging or message text.
- Defer transport lifecycle, websocket, timer, and broad orchestration clusters unless
  they are the only high-impact candidates.
- Treat the Stryker report as evidence. Tests must assert public behavior through the
  highest practical seam.

## Slice Template

```markdown
## Title

<behavior-focused title>

## Why this is low-hanging fruit

- Existing test seam: <test file or public API>
- Narrow hotspot: <file and line window>
- Main gap: <NoCoverage or Survived>

## Mutation report context

- Report: <path>
- File: <source file>
- Lines: <start-end>
- Undetected mutants: <count>
- Dominant mutators: <mutator list>

## Acceptance criteria

- [ ] Add behavior-focused tests at the highest practical seam.
- [ ] Cover the missing branch or strengthen the weak assertion named above.
- [ ] Run the relevant unit test file.
- [ ] Run a narrowed Stryker pass for the touched source file when practical.

## Validation

- `bun run --filter='@cashu/coco-core' test -- <test-file>`
- `<narrowed Stryker command, if available>`
```
