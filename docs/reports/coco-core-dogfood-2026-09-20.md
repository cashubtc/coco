# Coco core dogfood — 2026-09-20

**Usability verdict:** Coco core was usable through its public APIs in the tested
browser, Node HTTP and Bun terminal applications, including persistence and process
restart. The experiment exposed one severe SQLite concurrency defect and payment-request
diagnostic/documentation friction, addressed in the fixes below. Deterministic mint
simulators supported the application flows; production mint interoperability remains
outside the verified scope.

The requested [dog-food workflow](https://github.com/stencil-hq/slab/blob/main/.omp/skills/dog-food/SKILL.md)
produced three independent external Wallet Workbench apps, 26 original findings,
four subsystem fix assignments, and verified runtime/documentation changes. This
report retains 30 rows including parent orchestration and validation findings.
It is **not an all-platform/interoperability completion claim**: six rows retain
coverage prerequisites or explicitly substituted tooling, detailed below.

## Outcome

- Fixed severe same-thread SQLite contention in Bun and Node adapters. The original
  public two-connection repro took 5.44 seconds for two keys and exceeded 15 seconds
  for twenty. Final results: **0.37 seconds for two, 0.44 seconds for twenty**, all
  successful and unique. Worker-thread coordination, path aliases, unrelated memory
  databases, rollback, timeout restoration, and typed conflicts pass regression tests.
- Malformed/oversized payment request codecs now throw existing `PaymentRequestError`
  with context and original cause. Failed encoding/JSON parsing does not create a
  request/attempt. Explicit creqA retry succeeds without silently changing encoding.
- Corrected receive and key-import examples, mint execute/checkPayment semantics,
  duplicate receive and cancellation guidance, and repeated resume semantics. Expanded
  the existing payment-request guide and added Amount/JSON boundary examples.
- Preserved baseline reports/source/logs and reran all three actual interfaces.
  Core units, storage contracts, Chromium/Firefox, React, host tests, docs compilation,
  build/typecheck and extracted core package imports passed.

## Experiment and artifacts

Source revision: `b7aac78c780f2e50607fe332186619e856dbd38d`; initially clean `master`.
Packages identify as `2.0.0`; Bun `1.3.14`, Node `22.22.1`, cashu-ts `5.0.0-rc.4`.
No commits, tags, release publication, GitHub issues, or deployment were performed
during the original experiment. Its fixes are submitted in two independent pull
requests: SQLite contention and core payment-request diagnostics/documentation.
The results below describe the combined experiment; each PR records its own
validation after the split. This report is carried by the core PR and does not
imply that the SQLite fix is included in that branch.

Artifact links beginning with `/tmp/` refer to the original local execution
environment and are unavailable from GitHub. The findings, commands, results and
limitations are recorded here; the temporary apps and raw evidence are not
included in these pull requests.

| Consumer | Actual interface and storage                                                | Report / app                                                                                               | Final evidence                                                                                                                                                                                                                        |
| -------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser  | Live Chromium UI, Playwright role/label interaction, IndexedDB              | [Report](/tmp/coco-dog-food-20260920/web/REPORT.md), [app](/tmp/coco-dog-food-20260920/web/app.ts)         | [44-action timeline](/tmp/coco-dog-food-20260920/web/evidence/timeline.json), [screenshot](/tmp/coco-dog-food-20260920/web/evidence/workbench-full.png), [semantic tree](/tmp/coco-dog-food-20260920/web/evidence/semantic-final.txt) |
| Node     | Running HTTP service, HTTP requests, actual process restart, better-sqlite3 | [Report](/tmp/coco-dog-food-20260920/node/REPORT.md), [server](/tmp/coco-dog-food-20260920/node/server.ts) | [95 observations](/tmp/coco-dog-food-20260920/node/logs/results.json), [HTTP transcript](/tmp/coco-dog-food-20260920/node/logs/http-transcript.jsonl), [driver log](/tmp/coco-dog-food-20260920/evidence/node-driver-final.log)       |
| Bun      | Running readline app in PTY, actual process restart, bun:sqlite             | [Report](/tmp/coco-dog-food-20260920/bun/REPORT.md), [app](/tmp/coco-dog-food-20260920/bun/app.ts)         | [first process](/tmp/coco-dog-food-20260920/bun/final-run/session-1.log), [second process](/tmp/coco-dog-food-20260920/bun/final-run/session-2.log), [2/20-key repro](/tmp/coco-dog-food-20260920/evidence/bun-repro-verified.log)    |

The shared brief is [BRIEF.md](/tmp/coco-dog-food-20260920/BRIEF.md). Builders remained
independent until all reports were finished and did not change product source.
App state, serialization, server/UI policy and deterministic mint simulators stayed
in the hosts; Coco owned Wallet behavior and persistence. All seeds/tokens in the
artifacts are synthetic test data; no real funds were used.

Explicit deviations: built local HEAD public exports replaced registry packages;
Node HTTP and Bun PTY represent supported SDK runtimes rather than a native GUI.
There was no supplied browser MCP or tui-debug skill, so local Playwright and Python
3 PTY drove the actual interfaces. Local server/browser/subprocess execution needed
approved access outside the sandbox. The final core tarball was separately extracted
and imported in Node and Bun, reusing installed external dependencies; this is not a
clean registry installation. App simulators do not establish production mint,
Lightning, fee, auth, WebSocket, P2PK, onchain or BOLT12 interoperability.

Original source/report snapshots and unsuccessful logs remain in `web/baseline-source`,
`web/baseline-evidence`, `node/baseline-source`, `node/baseline-evidence`, and Bun's
original files/`baseline-source`/`multi-session-stall`. Final runs have separate parent
logs or were copied only after baseline preservation. Evidence is under `/tmp` and
must be archived before that directory is cleared.

## Coverage matrix

Every original numbered report row is present; duplicate evidence is linked, not
removed. Six rows retain unverified prerequisites (N09, N10, B07, B09, P02, P03).
The remaining 24 have verified code/docs resolutions or observed harness mitigations.

| Source row | Concern                                                                   | Evidence / repro                                                                                                            | Classification                                                   | Owner   | Observable resolution                                                                                                                                                         | Status                                                                        |
| ---------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| W01        | Keyring receive example reads amount on void                              | [web report #1](/tmp/coco-dog-food-20260920/web/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/docs.md)         | documentation defect                                             | docs    | Compile corrected example                                                                                                                                                     | Resolved and verified                                                         |
| W02        | Oversized creqB description produces uncontextual TypeError               | [web report #2](/tmp/coco-dog-food-20260920/web/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/errors.md)       | client API diagnostic                                            | errors  | Contextual domain error with cause and encoding mitigation                                                                                                                    | Resolved and verified                                                         |
| W03        | Existing payment-request guide insufficiently discoverable and incomplete | [web report #3](/tmp/coco-dog-food-20260920/web/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/docs.md)         | documentation defect                                             | docs    | Public create/parse example and guide link                                                                                                                                    | Resolved and verified                                                         |
| W04        | Cloned rich Amount objects fail JSON serialization                        | [web report #4](/tmp/coco-dog-food-20260920/web/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/docs.md)         | external harness serialization mistake, documented host boundary | docs    | Deterministic repro, upstream-ready note, documented JSON DTO recipe                                                                                                          | Resolved and verified                                                         |
| W05        | Sandbox server bind fails misleadingly                                    | [web report #5](/tmp/coco-dog-food-20260920/web/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/harness.md)      | external harness environment                                     | harness | Repro, environment issue draft and approved-loopback rerun                                                                                                                    | Mitigation verified; original evidence retained                               |
| W06        | Malformed payment-request decoder errors lack context                     | [web report #6](/tmp/coco-dog-food-20260920/web/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/errors.md)       | client API diagnostic                                            | errors  | Contextual parse error preserving cause                                                                                                                                       | Resolved and verified                                                         |
| N01        | Mint execute may return pending and uses canonical cached observation     | [node report #1](/tmp/coco-dog-food-20260920/node/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/docs.md)       | documentation defect                                             | docs    | Document actual return states and check/refresh effects                                                                                                                       | Resolved and verified                                                         |
| N02        | Repeated completed receive prepares new attempt                           | [node report #2](/tmp/coco-dog-food-20260920/node/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/docs.md)       | intentional design limitation                                    | docs    | Explain preparation/dedup policy and safe spent rollback                                                                                                                      | Resolved and verified                                                         |
| N03        | Cancel after automatic receive rollback rejects                           | [node report #3](/tmp/coco-dog-food-20260920/node/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/docs.md)       | intentional lifecycle contract                                   | docs    | Error handling example reloads state before cancel                                                                                                                            | Resolved and verified                                                         |
| N04        | Keyring receive example reads amount on void                              | [node report #4](/tmp/coco-dog-food-20260920/node/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/docs.md)       | documentation defect; duplicate W01                              | docs    | Same corrected compiled example, retain both evidence sources                                                                                                                 | Resolved and verified                                                         |
| N05        | Zero-filled key import example fails                                      | [node report #5](/tmp/coco-dog-food-20260920/node/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/docs.md)       | documentation defect                                             | docs    | Use explicitly supplied valid secret                                                                                                                                          | Resolved and verified                                                         |
| N06        | JSON roundtrip erases Amount methods in payment request                   | [node report #6](/tmp/coco-dog-food-20260920/node/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/docs.md)       | external host type erasure, documented host boundary             | docs    | Repro, upstream-ready note and encoded-request/ID DTO example                                                                                                                 | Resolved and verified                                                         |
| N07        | Simulator point conversion API misuse                                     | [node report #7](/tmp/coco-dog-food-20260920/node/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/harness.md)    | external harness mistake                                         | harness | Minimal repro, upstream-ready harness patch/note, corrected workflow                                                                                                          | Mitigation verified; original evidence retained                               |
| N08        | Node sandbox listener EPERM                                               | [node report #8](/tmp/coco-dog-food-20260920/node/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/harness.md)    | external environment; duplicate W05                              | harness | Preserve repro plus loopback mitigation                                                                                                                                       | Mitigation verified; original evidence retained                               |
| N09        | Concurrent dist clean and local-link distribution coverage gap            | [node report #9](/tmp/coco-dog-food-20260920/node/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/harness.md)    | orchestration/distribution limit                                 | harness | Sequential build workflow and packed-artifact smoke                                                                                                                           | Packed artifact verified; clean registry installation unverified              |
| N10        | Real mint interoperability unverified                                     | [node report #10](/tmp/coco-dog-food-20260920/node/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/harness.md)   | unavailable external prerequisite                                | harness | Deterministic prerequisite check, actionable followup and simulator limits                                                                                                    | Open: configured real mint/auth interoperability prerequisites                |
| B01        | Separate SQLite handles stall concurrent key allocations                  | [bun report #1](/tmp/coco-dog-food-20260920/bun/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/storage.md)      | confirmed performance defect                                     | storage | Same-thread physical-file contention hint suppresses native waiting; SQLite exclusion and external-worker waiting preserved; 20 keys 0.44s, worker and alias regressions pass | Resolved and verified                                                         |
| B02        | Oversized creqB generic encoder exception                                 | [bun report #2](/tmp/coco-dog-food-20260920/bun/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/errors.md)       | client API diagnostic; duplicate W02                             | errors  | Same contextual domain error and encoding guidance                                                                                                                            | Resolved and verified                                                         |
| B03        | Mixed malformed-input errors and invalid zero-key example                 | [bun report #3](/tmp/coco-dog-food-20260920/bun/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/errors.md)       | validation/docs friction                                         | errors  | Contextual request boundary errors; document other domain errors; coordinate zero-key docs with docs owner                                                                    | Resolved and verified                                                         |
| B04        | Repeated resume emits while pause event is deduplicated                   | [bun report #4](/tmp/coco-dog-food-20260920/bun/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/docs.md)         | intentional reconnect semantics clarified                        | docs    | Document resume reconnect/event semantics explicitly                                                                                                                          | Resolved and verified                                                         |
| B05        | Mint execute nonterminal and checkPayment can issue value                 | [bun report #5](/tmp/coco-dog-food-20260920/bun/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/docs.md)         | documentation defect; related N01                                | docs    | Explain execute/checkPayment return states and side effects                                                                                                                   | Resolved and verified                                                         |
| B06        | Existing payment-request guide insufficiently discoverable and incomplete | [bun report #6](/tmp/coco-dog-food-20260920/bun/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/docs.md)         | documentation defect; duplicate W03                              | docs    | Linked public guide with complete inputs                                                                                                                                      | Resolved and verified                                                         |
| B07        | tui-debug skill unavailable                                               | [bun report #7](/tmp/coco-dog-food-20260920/bun/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/harness.md)      | external driver prerequisite                                     | harness | Availability repro, provisioning issue draft, truthful standard PTY fallback                                                                                                  | PTY fallback verified; tui-debug-specific driver unavailable                  |
| B08        | Bun sandbox listener EADDRINUSE                                           | [bun report #8](/tmp/coco-dog-food-20260920/bun/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/harness.md)      | external environment; duplicate W05                              | harness | Retain baseline and successful approved rerun                                                                                                                                 | Mitigation verified; original evidence retained                               |
| B09        | Local symlinks and no real mint coverage                                  | [bun report #9](/tmp/coco-dog-food-20260920/bun/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/harness.md)      | distribution/external limitation                                 | harness | Packed public entry smoke plus explicit remaining real-mint prerequisite                                                                                                      | Packed artifact and simulated flows verified; registry/real mint unverified   |
| B10        | python alias unavailable                                                  | [bun report #10](/tmp/coco-dog-food-20260920/bun/REPORT.md); [fix review](/tmp/coco-dog-food-20260920/fixes/harness.md)     | external host tooling                                            | harness | Repro and upstream-ready driver change using python3                                                                                                                          | Mitigation verified; original evidence retained                               |
| P01        | Initial typecheck raced prerequisite rebuild                              | /tmp/coco-dog-food-20260920/evidence/PARENT-NOTES.md; [fix review](/tmp/coco-dog-food-20260920/fixes/harness.md)            | parent orchestration defect                                      | harness | Preserve failure; sequential build then typecheck                                                                                                                             | Mitigation verified; original evidence retained                               |
| P02        | Full core integration fails without mint/auth infrastructure              | /tmp/coco-dog-food-20260920/evidence/PARENT-NOTES.md; [fix review](/tmp/coco-dog-food-20260920/fixes/harness.md)            | unavailable external prerequisite; related N10                   | harness | Preserve full-gate failure and service preflight; isolated public-mint case passes with 30s hook budget; actual configured mint/auth gate still required                      | Open: full integration gate fails; isolated longer-timeout pause probe passed |
| D02        | Mint failed-state documentation treated quote expiry as terminal          | packages/docs/pages/mint-operations.md; ADR-0008; [fix review](/tmp/coco-dog-food-20260920/fixes/docs.md)                   | documentation defect discovered during fixes                     | docs    | Align state table with advisory expiry contract                                                                                                                               | Resolved and verified                                                         |
| P03        | Cached WebKit cannot launch without system libraries                      | /tmp/coco-dog-food-20260920/evidence/browser-contract-final.log; [fix review](/tmp/coco-dog-food-20260920/fixes/harness.md) | unavailable external browser prerequisite                        | harness | Provision matching WebKit libraries; retain issue-ready repro and passing two-browser mitigation                                                                              | Open: WebKit system libraries missing; Chromium/Firefox 154 passed            |

## Validation

Commands use repository root unless a working directory is specified. No fixer ran
builds/checks during the concurrent edit wave. The parent formatted and integrated
once, then addressed actual validation failures and reran affected gates.

| Command / working directory                                                                                                                                                                                                                                                               | Observed result                                                                                                           | Log                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run build`; final adapter `bun run --filter='@cashu/coco-sqlite-bun' build` and corresponding `@cashu/coco-sqlite` build                                                                                                                                                             | Passed; final adapter configs explicitly externalize node:fs                                                              | [root](/tmp/coco-dog-food-20260920/evidence/build-verified.log), [Bun](/tmp/coco-dog-food-20260920/evidence/bun-adapter-build-final.log), [Node](/tmp/coco-dog-food-20260920/evidence/node-adapter-build-final.log) |
| `bun run typecheck`                                                                                                                                                                                                                                                                       | Entire workspace passed                                                                                                   | [log](/tmp/coco-dog-food-20260920/evidence/typecheck-complete.log)                                                                                                                                                  |
| `bun test test/unit` in `packages/core`                                                                                                                                                                                                                                                   | 1,824 pass, 0 fail                                                                                                        | [log](/tmp/coco-dog-food-20260920/evidence/core-unit-verified.log)                                                                                                                                                  |
| `bun test packages/sql-storage/src/test packages/sqlite-bun/src/test/contract.test.ts packages/expo-sqlite/src/test/contract.test.ts`                                                                                                                                                     | 194 pass, 0 fail, including unchanged worker allocation contract                                                          | [log](/tmp/coco-dog-food-20260920/evidence/storage-contracts-verified.log)                                                                                                                                          |
| `bun run test -- src/test/contract.test.ts` in `packages/sqlite3`                                                                                                                                                                                                                         | 81 pass                                                                                                                   | [log](/tmp/coco-dog-food-20260920/evidence/node-contract-verified.log)                                                                                                                                              |
| `CI=1 bun run test:browser -- src/test/contract.test.ts --project chromium --project firefox` in `packages/indexeddb`                                                                                                                                                                     | 154 pass                                                                                                                  | [log](/tmp/coco-dog-food-20260920/evidence/browser-contract-final-available.log)                                                                                                                                    |
| `bun run test` in `packages/react`                                                                                                                                                                                                                                                        | 50 pass                                                                                                                   | [log](/tmp/coco-dog-food-20260920/evidence/react-final.log)                                                                                                                                                         |
| `bun test packages/cocod/test scripts`                                                                                                                                                                                                                                                    | 101 pass                                                                                                                  | [log](/tmp/coco-dog-food-20260920/evidence/host-verified.log)                                                                                                                                                       |
| `bun run docs:build`; `bun node_modules/typescript/bin/tsc -p /tmp/coco-dog-food-20260920/fixes/docs-consumer.tsconfig.json`                                                                                                                                                              | Docs build and corrected public snippets passed                                                                           | [build](/tmp/coco-dog-food-20260920/evidence/docs-build-final.log), [consumer](/tmp/coco-dog-food-20260920/evidence/docs-consumer-final.log)                                                                        |
| `bun pm pack --ignore-scripts --destination /tmp/coco-dog-food-20260920/mitigations/pack-final` in `packages/core`; `node /tmp/coco-dog-food-20260920/mitigations/packed-core-smoke.mjs /tmp/coco-dog-food-20260920/mitigations/pack-final/cashu-coco-core-2.0.0.tgz /root/projects/coco` | Extracted core, plugin and adapter entries imported in Node/Bun; initialization/key generation and strict consumer passed | [log](/tmp/coco-dog-food-20260920/evidence/packed-consumer-final-unsandboxed.log)                                                                                                                                   |
| `python3 /tmp/coco-dog-food-20260920/bun/repro-driver.py`                                                                                                                                                                                                                                 | 2/20 allocations completed; all fulfilled and unique                                                                      | [log](/tmp/coco-dog-food-20260920/evidence/bun-repro-verified.log)                                                                                                                                                  |
| `python3 /tmp/coco-dog-food-20260920/evidence/assert-platform-results.py`                                                                                                                                                                                                                 | Browser, Node and Bun durable results asserted                                                                            | [log](/tmp/coco-dog-food-20260920/evidence/platform-assertions-final.log)                                                                                                                                           |

These passing test gates total **2,404 tests**; they are not the unavailable complete
mint/auth/WebKit matrix. Node's original driver still labels two initial expectations
as false: duplicate receive preparation is allowed, and cancel rejects after automatic
rollback. The unchanged driver observations are retained; final assertions check those
specific safe outcomes rather than editing them into apparent original successes.

The final full core integration command returned **3 pass, 5 fail, 3 errors**: unset
MINT_URL/auth configuration, refused local mint connection, and a public-mint hook
timeout. An isolated multiple-pause/resume run with `--timeout 30000` passed in about
12.27 seconds. That diagnostic does not make the original gate pass. Three-browser CI
aborted on missing WebKit libraries; Chromium and Firefox were rerun separately.
See [environment prerequisites and ready-to-file followups](./coco-core-dogfood-environment.md),
[approved service preflight](/tmp/coco-dog-food-20260920/evidence/environment-final-approved.log),
[full integration log](/tmp/coco-dog-food-20260920/evidence/core-integration-final.log), and
[longer-timeout diagnostic](/tmp/coco-dog-food-20260920/evidence/live-pause-hook-probe.log).

Other original failures and mitigations were executed: rich Amount JSON loss and
structured-clone serialization, simulator point-shape misuse, missing-dist window in
an isolated tarball copy with restoration, and paired denied/approved loopback probes.
The [combined upstream-ready notes](/tmp/coco-dog-food-20260920/mitigations/UPSTREAM-READY.md)
and [host serialization note](/tmp/coco-dog-food-20260920/fixes/amount-json-host-note.md)
are ready to file with the relevant environment/harness owner; none was published.
The original standalone Node duplicate-receive repro was also rerun: unpaid execute remained pending, duplicate execution rolled back, and recipient total stayed 4. Its [final log](/tmp/coco-dog-food-20260920/evidence/node-duplicate-repro-final.log) preserves the result.

Old broken documentation repros remain immutable; the corrected equivalent compiles
in `docs-consumer.ts`.

## Exact app replay commands

Browser, from `/tmp/coco-dog-food-20260920/web`: `bun run build`, `bun run typecheck`,
then `bun server.ts`. In a separate approved shell in that directory, `node driver.mjs`.
The server listens on 4173. Stop any previous instance before starting it.

Node: `bash /tmp/coco-dog-food-20260920/node/run.sh` (loopback ports 39411/39412).
It resets only its local test databases; preserve earlier logs first.

Bun: `OUTPUT_DIR=/tmp/coco-dog-food-20260920/bun/fresh-run python3 /tmp/coco-dog-food-20260920/bun/drive.py`
(loopback port 33983); use a new output directory. Individual builder reports contain
hands-on commands and the exact unsuccessful attempts. Each major live flow was
replayed against the final relevant package build, not only through a test file.

## Transaction and compatibility review

Reviewed `KeyRingService → CoreKeyRingTransactions → RepositoryCoreTransactionRunner →
SqlStorageRepositories.withTransaction → SqliteDb.transaction`. Each gateway attempt
still owns one immediate adapter transaction; authoritative key/index reads and writes
share its scope. Stable preflight inputs, synchronous derivation, bounded runner retries,
rollback, scoped lifetime and post-commit event ownership are unchanged.

Each concrete synchronous adapter records local transaction activity by physical
main-database device/inode, with native-handle identity for separate memory databases.
It suppresses native waiting only while another same-thread transaction on that file
needs the JS thread to progress. The map is a scheduling hint, not a lock or mutation
authority. SQLite still arbitrates writers, including other workers/processes; native
waiting remains configured for those. Registration, timeout restoration and hint cleanup
stay under existing per-handle queue ownership, before release, including failed BEGIN.
This covers immediate and deferred adapter transactions. No scoped module receives a
transaction opener, and no remote I/O or live event moved inside a transaction.

Initial zero-wait and 10ms-cap fixes passed local repros but failed the existing worker
contract. Those failures were preserved and corrected without weakening its success
expectation. The final worker, alias, memory, commit/rollback and typed-conflict tests pass.

Payment-request codec wrappers run before request/attempt persistence and do not change
remote effects or event timing. Existing Payment Request parent/attempt/child atomicity
and other legacy gateway migrations remain deferred under TRANSACTION_DESIGN/ADR-0011;
this work neither migrates them nor adds a new deviation. Universal nested-transaction
rejection remains an existing documented limitation. No architectural contract changed.

No public signatures, exports, schemas or operation lifecycle states changed. Codec
callers that previously matched dependency exception classes now receive the existing
public `PaymentRequestError` and may inspect `cause`. Repeated receive preparation still
creates an attempt; definitive spent rejection rolls it back without duplicate credit.
Mint check/refresh can still issue value; repeated resume still reconnects. These are
explicit retained product decisions, now documented. All generated dist output came
from build scripts and remains untracked build output; no checked-in generated artifact
needed manual edits. The core patch changeset is
[clear-wallet-consumer-boundaries.md](../../.changeset/clear-wallet-consumer-boundaries.md).
The independent SQLite PR carries `coordinate-local-sqlite-writers.md` for both
synchronous adapters.
