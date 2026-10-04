# Core coding standards research

Research snapshot: 2026-10-04, commit `d5dcadbb`. This records the evidence and interview that informed
[CODING_STANDARDS.md](../../../CODING_STANDARDS.md), which is the authoritative review guidance.
Research recommendations below describe the initial analysis; the interview decisions record what was
adopted or revised. Source references describe the inspected commit and may age. No runtime changes
were made during this work.

## Scope and method

Reviewed the core production tree: 170 TypeScript files, approximately 32,000 lines, excluding tests,
generated output, and build configuration. Work covered public APIs and composition; models, amounts,
keys and utilities; every operation, repository and transaction module; services and quotes; handlers,
transports, watchers, events and logging. Inventoried all 85 test files (80 unit, five integration), read
shared fixtures, and inspected representative assertions across every major subsystem. This does not
claim a line-by-line reading of every test or a runtime correctness audit.

Read package/root configuration, relevant CI, CONTRIBUTING, AGENTS, the context map and core context,
all eight core ADRs, and TRANSACTION_DESIGN. The analysis distinguishes explicit contracts, repeated
conventions, and legacy exceptions. Existing tests were inspected, not executed. Other packages were
inspected only where necessary to understand core contracts and verification; their full coding style
has not been researched.

## Findings that shape the standards

### 1. Existing documents already own important rules

[AGENTS](../../../AGENTS.md) routes agents to executable configuration, CONTRIBUTING and conditional
domain/design documents. [CONTRIBUTING](../../../CONTRIBUTING.md#style-guide) already covers ESM,
type-only imports, restrained use of `any`, JSDoc, early validation, domain errors, preserved causes,
structured logging and URL normalization. Its workflows and release guidance should remain there.

[CONTEXT-MAP](../../../CONTEXT-MAP.md) and [core CONTEXT](../../../packages/core/CONTEXT.md) own domain
language. [TRANSACTION_DESIGN](../../../TRANSACTION_DESIGN.md) and
[ADR-0011](../../../packages/core/docs/adr/0011-use-domain-transaction-gateways.md) own transaction
authority, composition, naming and review steps. ADR-0011's filename retains “gateways,” but its current
content revises that design and rejects mandatory gateway wrappers.

**Recommendation:** make standards a concise set of review judgments with conditional links to these
authorities. Repeating their detailed contracts would create another source that can drift.

### 2. New architecture and legacy implementations coexist

Send and Mint use coordinator-owned transactions, branded transitions and scoped capabilities. KeyRing
mutations and mint metadata refresh also use the shared runner. The coordinator performs preflight,
commits authorization, makes remote calls, commits results, then publishes effects. Review must inspect
the concrete dependencies and captured helpers, not just narrow TypeScript interfaces.

Evidence: [SendOperationService](../../../packages/core/operations/send/SendOperationService.ts#L210),
[MintTransitions](../../../packages/core/operations/mint/MintTransitions.ts#L34),
[CoreTransaction](../../../packages/core/transactions/CoreTransaction.ts#L47), and
[Manager wiring](../../../packages/core/Manager.ts#L919).

The design explicitly leaves Receive, Melt, Mint Swap orchestration, Payment Request Receive atomicity,
and several MintService mutations to separate migrations. Legacy ProofService combines allocation,
remote preparation, persistence and events. WalletRestoreService explicitly documents nontransactional
restoration. Even a single class can contain both generations: MintService's explicit metadata refresh
commits independently, while add/update/trust/delete retain older boundaries.

Evidence: [migration list](../../../TRANSACTION_DESIGN.md#migration-and-verification),
[ProofService](../../../packages/core/services/ProofService.ts#L186),
[WalletRestoreService](../../../packages/core/services/WalletRestoreService.ts#L180), and
[MintService](../../../packages/core/services/MintService.ts#L234).

QuoteLifecycle combines strong canonical observation semantics with older persistence seams. Production
Manager injects a transaction for mint observation resolution; direct construction can fall back to
root repositories. Mint creation and Melt observation persistence use older shapes. Accepted semantic
ownership does not mean every implementation follows the new transaction composition model.

Evidence: [QuoteLifecycle](../../../packages/core/quotes/QuoteLifecycle.ts#L384),
[production injection](../../../packages/core/Manager.ts#L1055), and
[Melt observation resolution](../../../packages/core/quotes/QuoteLifecycle.ts#L1460).

**Decision needed:** whether touching legacy code requires migration, or narrow fixes may preserve its
boundary while reporting relevant deviations. The existing migration list supports incremental adoption.

### 3. Recovery and identity are central review concerns

Current transaction design requires persisted, exact requests before remote submission. Ambiguous
outcomes retain recovery material and owned resources; a timeout is not evidence that no remote effect
occurred. Recovery reuses settlement logic and must preserve outputs already spent or reserved by later
operations. In-memory locks reduce contention; durable transactions and conditional updates establish
cross-session correctness.

Evidence: [Send execution](../../../packages/core/operations/send/SendOperationService.ts#L312),
[Send transitions](../../../packages/core/operations/send/SendTransitions.ts#L296), and
[ScopedProofs](../../../packages/core/transactions/proofs/ScopedProofs.ts#L53).

`createdByOperationId` means output attribution; `usedByOperationId` means input reservation. These are
distinct facts, not interchangeable “ownership.” Parent payment-request attempts likewise retain child
identity and reconcile persisted child state after interruption instead of assuming that an exception
means the child failed. The legacy parent implementation is evidence of recovery intent, not a template
for new transaction boundaries.

Evidence: [CoreProof](../../../packages/core/types.ts#L44),
[payment-request recovery](../../../packages/core/services/PaymentRequestReceiveService.ts#L339), and
[claim reconciliation](../../../packages/core/services/PaymentRequestReceiveService.ts#L660).

Error classification is not uniform: newer Send requires positive evidence for terminal remote
rejection, while legacy Receive has broader tested terminal classification. A standards sentence must
not silently change either operation's contract. The same applies to retry policy: polling, processors,
WebSocket reconnect and transaction conflict retries have different owners and limits.

Evidence: [Send classification](../../../packages/core/operations/send/SendOperationService.ts#L77),
[Receive classification](../../../packages/core/operations/receive/ReceiveOperationService.ts#L48),
[transaction retry](../../../packages/core/transactions/CoreTransaction.ts#L47), and
[Mint processor](../../../packages/core/services/watchers/MintOperationProcessor.ts#L436).

### 4. Normalize at boundaries and keep domain distinctions visible

The amount helpers explicitly distinguish ergonomic public input parsing from canonical internal
`UnitAmount`. Amount arithmetic preserves integer precision; units remain attached to amounts.
Compatibility hydration and quote-derived units are intentional exceptions to simplistic “no defaults”
or “every method takes the same amount shape” rules.

Evidence: [amount helpers](../../../packages/core/amounts.ts#L55),
[Send API](../../../packages/core/api/SendOpsApi.ts#L75),
[serialization](../../../packages/core/utils.ts#L195), and
[balance aggregation](../../../packages/core/services/ProofService.ts#L414).

cashu-ts owns live quote wire normalization; Coco owns canonical accounting, identity and lifecycle.
Canonical quote observations precede operation advancement. Explicit quote checks remain isolated from
background batching. Mint expiry is advisory, while Melt has different rules. These are already ADR
contracts and should be linked, not generalized into one generic quote policy.

Evidence: core ADRs
[0004](../../../packages/core/docs/adr/0004-quote-observations-precede-operation-advancement.md),
[0006](../../../packages/core/docs/adr/0006-target-isolate-explicit-quote-checks.md),
[0007](../../../packages/core/docs/adr/0007-cashu-ts-owns-wire-quote-normalization.md), and
[0008](../../../packages/core/docs/adr/0008-treat-mint-quote-expiry-as-advisory.md).

Pure resolvers use explicit result distinctions when callers need them: meaningful acceptance,
freshness-only acceptance, stale/conflicting observations, and per-identity polling outcomes. Polling
matches response identity rather than array position and can preserve valid independent outcomes when
others fail. “Every batch must be atomic” would contradict this policy.

Evidence: [MintQuoteObservation](../../../packages/core/quotes/MintQuoteObservation.ts#L66),
[polling result types](../../../packages/core/quotes/MintQuotePolling.ts#L22), and
[polling attribution](../../../packages/core/quotes/QuoteLifecycle.ts#L657).

### 5. Abstractions earn their place through responsibility

Public API classes are intentionally thin facades. Internal seams separate authority, effects or a
substantial shared domain rule. Read-only metadata queries explicitly avoid refresh/repair, while
`refreshAndCommitIfStale` names its independently committing effect. Pure proof validation, keyset
selection and observation resolution are small domain modules. A single-implementation interface can
still express an important authority boundary.

Evidence: [AuthApi](../../../packages/core/api/AuthApi.ts#L6),
[MintMetadata](../../../packages/core/mints/MintMetadata.ts#L32),
[OutputProofs](../../../packages/core/proofs/OutputProofs.ts#L7), and
[ProofQueries](../../../packages/core/proofs/ProofQueries.ts#L3).

There is no demonstrated universal preference for tiny files, one class per file, inheritance, generic
registries, dependency objects, positional constructors, interfaces over type aliases, or mandatory
explicit return annotations. New Send/Mint use dependency objects; older services use positional
constructors. Pure functions coexist with stateful services. Whole transition lifecycles remain together
in large files. Separate method registries and protocol handlers tolerate some duplication.

**Recommendation:** judge cohesion, meaningful authority boundaries and navigation cost. Do not reward
more layers or fewer lines by themselves. Preserve thin public compatibility facades as an explicit case.

### 6. Compatibility has more than one public surface

Core publishes root, `/adapter` and `/plugin` entry points. Other source barrels are private. The plugin
`ServiceMap` explicitly makes removal, renaming or narrowing of a service key a public API change, so a
service signature can be compatibility-sensitive without being a root runtime export. Persisted formats,
events and recovery behavior also constrain refactors.

Evidence: [exports](../../../packages/core/package.json#L18),
[ServiceMap contract](../../../packages/core/plugins/types.ts#L27), and
[public/private surface documentation](../../../packages/core/README.md#L482).

Legacy regression cases seed old durable shapes, including missing revisions, partially saved outputs
and already-spent proofs. There is no single repository-wide compatibility horizon documented by this
research. Establishing how far back changes must preserve stored data requires a product decision.

Evidence: [Send compatibility tests](../../../packages/core/test/unit/SendTransitions.test.ts#L452) and
[persistent recovery tests](../../../packages/core/test/unit/CoreTransactionSqlite.test.ts#L159).

### 7. Lifecycle ownership includes late async completion

Newer lifecycle tests force stop-during-subscribe, stale timer callbacks after reopen, in-flight pause,
and updates arriving while work is already running. Cleanup must account for resources acquired after
an await, not only resources present when stop began. PluginHost coalesces lifecycle calls and attempts
all cleanup before reporting aggregate failure.

Evidence: [Melt watcher](../../../packages/core/services/watchers/MeltQuoteWatcherService.ts#L415),
[polling scheduler](../../../packages/core/infra/PollingTransport.ts#L343),
[late acquisition tests](../../../packages/core/test/unit/MeltQuoteWatcherService.test.ts#L544), and
[PluginHost](../../../packages/core/plugins/PluginHost.ts#L141).

These guarantees are not universal today. Some older watcher and request-limiter paths have weaker
cleanup contracts. Quote watcher/processor separation is also specific: ProofStateWatcher still
advances Send. Expanding it to all watchers would be an architectural decision, not documentation of
current practice.

Wallet post-commit publication should not replay remote effects or misreport committed state because a
listener fails. The transaction design establishes this explicitly. Generic EventBus supports other
error modes, so “events never reject” would be inaccurate.

Evidence: [ProofStateWatcher](../../../packages/core/services/watchers/ProofStateWatcherService.ts#L251),
[EventBus](../../../packages/core/events/EventBus.ts#L56), and
[Send publication](../../../packages/core/operations/send/SendOperationService.ts#L1200).

### 8. Tests should exercise the owner of the guarantee

New transaction tests use real repositories and transaction runners with narrow remote doubles. Some
run the same behavior against memory and SQLite; others force real persistence failures. Assertions
cover stored outcomes, rollback, retained resources, concurrency and event ordering. Mocked repository
calls alone cannot establish these guarantees. Thin API delegation tests appropriately use spies.

Evidence: [SendEnvironment](../../../packages/core/test/fixtures/SendEnvironment.ts#L18),
[SendRemote fixture](../../../packages/core/test/fixtures/SendRemote.ts#L4),
[SendComposition](../../../packages/core/test/unit/SendComposition.test.ts#L43), and
[SQLite rollback](../../../packages/core/test/unit/CoreTransactionSqlite.test.ts#L122).

Controlled gates/clocks and bounded completion conditions make races reproducible. Older tests still
use fixed sleeps and broad casts. Typed doubles are a stronger recent pattern, but malformed-input and
negative compile-time tests deliberately need invalid inputs. A universal no-mock or no-cast rule would
erase useful distinctions.

Evidence: [controlled polling clock](../../../packages/core/test/unit/PollingTransport.test.ts#L58),
[transaction gates](../../../packages/core/test/unit/CoreTransaction.test.ts#L12),
[bounded wait helper](../../../packages/core/test/waitFor.ts), and
[negative API typing](../../../packages/core/test/unit/QuoteApi.test.ts#L16).

## Style observations that should not become accidental policy

- Discriminated unions and plain data models are common; Amount and errors are classes. Existing
  method/state differences should remain visible rather than forced into a generic lifecycle.
- Guard clauses, local validation helpers, named input/result shapes, `private readonly` dependencies,
  `try/finally` resource release and optional contextual logging recur throughout the package.
- Useful comments explain authority, replay constraints, ordering and compatibility. Other comments
  narrate implementation or are stale. Comment volume is not evidence of quality.
- Import aliases, relative paths, `.ts` extensions, type aliases/interfaces, constructor syntax and
  explicit returns vary. CONTRIBUTING describes intent, but code does not demonstrate one universal
  syntax for each choice.
- Generic Error, TypeError and domain errors coexist. Prefer a meaningful caller-visible category and
  preserved cause; an “every throw requires its own class” rule would be new policy.
- Memory repository defensive-copy behavior and timestamp ownership differ. Universal independent
  snapshots or one timestamp-generation layer are proposed changes, not existing guarantees.
- Structured logging is established; no uniform redaction contract was found. Any stronger policy
  should define safe metadata and its adoption scope, including debug diagnostics. This investigation
  did not test security exposure and does not publish sensitive runtime material.

## Existing automation and concrete follow-ups

[Package scripts](../../../packages/core/package.json), [root scripts](../../../package.json),
[TypeScript config](../../../packages/core/tsconfig.json), [Prettier](../../../.prettierrc),
[build CI](../../../.github/workflows/build-packages.yml),
[unit CI](../../../.github/workflows/core_tests.yml), and [coverage config](../../../codecov.yml)
already own commands and numerical requirements. Core has no wired ESLint config/script despite its
typescript-eslint dependency. Formatting, compilation, coverage, adapter contracts and transaction
guards already automate substantial checks.

The [Transition export guard](../../../packages/core/test/unit/Transition.test.ts#L21) already exists.
Lifetime and runner tests cover scope revocation, caught failures, dropped promise draining and typed
bounded retries. New prose should not imply those guards are missing. Static imports can be checked by
tooling; authority captured through runtime wiring still needs review.

The following were observed drift or possible follow-up work at the inspected commit. The accompanying
documentation changes correct the Bun reference, export guidance, plugin descriptions, payment-request
amount signature and WalletApi decoding comment. The remaining items are separate follow-ups:

| Area                        | Evidence and implication                                                                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bun version                 | CONTRIBUTING names 1.2.18 while CI uses 1.3.11. Route commands/settings to executable config.                                                                                                                                                         |
| Export guidance             | CONTRIBUTING says public APIs go through `index.ts`; core deliberately supports three entry points. Clarify audience-specific exports.                                                                                                                |
| Plugin docs                 | README says hooks must return cleanup, but hook types allow void and examples return none. Cleanup follows acquired resources. README failure descriptions also differ from PluginHost's surfaced disposal failures.                                  |
| API docs/comments           | README's PaymentRequestsApi amount signature predates `UnitAmountLike`; WalletApi.decodeToken JSDoc describes behavior/types absent from its current implementation.                                                                                  |
| Accepted versus implemented | ADR-0009/0010 describe accepted Batch Mint behavior absent from this checkout's public API and operations. Accepted design status does not establish feature availability.                                                                            |
| Integration discovery       | The main script selects files literally named `integration.test.ts`; auth has a separate explicit selection. ReceiveOperationIntegration and PauseResumeIntegration are not selected by those CI commands. Do not claim CI runs the entire directory. |
| Cross-package CI            | Core unit workflow path filters omit SQL-storage-only changes, although some core tests import SQL storage. Adapter jobs overlap but are not identical coverage.                                                                                      |
| Navigation                  | `MintOperationProcessor` tests are named `MintQuoteProcessor.test.ts`; handler contracts live in operations while implementations live in infra. Exact pointers are more useful than guessed paths.                                                   |
| Potential guards            | No comprehensive public-export compatibility guard or core documentation-example compilation was found. If desired, implement checks rather than adding prose-only mechanical requirements.                                                           |

Primary references for that table: [CONTRIBUTING](../../../CONTRIBUTING.md#L23),
[PluginHost](../../../packages/core/plugins/PluginHost.ts#L182),
[plugin hook types](../../../packages/core/plugins/types.ts#L66),
[README](../../../packages/core/README.md#L312),
[PaymentRequestsApi](../../../packages/core/api/PaymentRequestsApi.ts#L97),
[WalletApi](../../../packages/core/api/WalletApi.ts#L141),
[integration selector](../../../scripts/test-integration.sh#L123), and
[auth selector](../../../scripts/auth_mint/test-auth-integration.sh#L112).

## Interview decision tree

The user agreed to all three first-round recommendations on 2026-10-04:

1. **Incremental adoption:** new or substantially reworked flows follow the accepted design. Narrow
   fixes may retain existing boundaries, avoid worsening them, and report relevant deviations. Merely
   touching a file does not require migrating the module.
2. **Authority:** codify established contracts and strong conventions, plus individually agreed
   improvements. Recent implementations alone do not establish new policy.
3. **Focused documentation corrections:** include verified stale plugin cleanup/error guidance,
   public-entry-point guidance, API descriptions and the Bun version reference. Changes to linting,
   CI selection and architecture remain separate work.

In the second round, the user accepted the abstraction, error and lifecycle recommendations and
refined compatibility, testing and logging:

4. **Abstractions:** extract shared domain rules or meaningful responsibility boundaries, not merely
   similar-looking code. Allow intentional public facades. Avoid arbitrary file-size limits and
   mandatory generic frameworks.
5. **Legacy inconsistencies:** do not require repairs for every theoretical state that an old
   implementation might have produced during a very small crash window. Assess severity and
   likelihood before deciding whether a fix is warranted. The small current userbase informs that
   assessment; it does not prove that no affected records exist. In the final round the user confirmed:
   preserve ordinary older records; assess exceptional inconsistent crash states case by case, weighing
   impact, plausible occurrence, recovery options and fix complexity/risk. Neither theoretical
   reachability nor severity alone automatically requires a repair or blocks a change.
6. **Errors:** use meaningful categories where callers need different behavior, preserve causes,
   permit ordinary errors for internal preconditions, and isolate/test unavoidable message-matching
   compatibility logic.
7. **Lifecycle:** after stop/dispose resolves, the owner must not start new work or deliver late
   callbacks; release resources acquired during shutdown and await owned work where necessary.
   Already-submitted remote requests may complete. Pause/resume has its own explicit contract.
8. **Behavior tests:** prefer real behavior tests such as the integration suite. Focused unit tests
   are valuable for complex behavior; do not add tests merely to mirror implementation or trivial
   delegation. The earlier proposal for mandatory test ingredients is superseded by choosing evidence
   that demonstrates the behavior under change, without mocking away its essential guarantees.
9. **Logging:** no general log sanitization requirement is wanted. Never log the seed returned by
   `seedGetter`; this includes the same seed carried through copies, cached values or encodings. The
   earlier proposed broad redaction policy is not adopted.

The user confirmed the remaining compatibility distinction, completing the interview. These decisions
are captured in the root reviewer-facing standards document, with a review pointer in AGENTS.md.

Domain terminology changes belong in the existing context documents when agreed. An ADR is warranted
only for a consequential architectural trade-off, not merely for choosing a standards-file layout.

## Verification of this research

Source/configuration inspection only; runtime tests were not run because no runtime behavior changed.
Markdown formatting and local reference targets are checked separately. Public exports, tests and
persisted formats are unchanged. A changeset was considered and omitted: the work adds repository review
guidance and corrects descriptions of existing published behavior, with no runtime or API change.
