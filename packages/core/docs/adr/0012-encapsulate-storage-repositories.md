---
status: accepted
---

# Encapsulate storage repositories

For v3, applications select storage through opaque handles. Coco owns repository contracts and
implementations, while a supported public SQLite driver interface allows independently maintained
runtime bindings. Independent repository implementations remain outside the supported compatibility
contract. This decision defines the accepted design, implemented by the opaque storage factories and the public SQLite driver contract.

## Settled scope

Official packages may use technically importable internal entry points. Internal entry points and
packages carry no consumer-facing versioning or compatibility guarantee: their contracts may
change incompatibly in patch or minor releases. State this explicitly in package documentation
and at internal entry points. Stable factories and application interfaces retain their normal
compatibility guarantees.

Publish a supported SQLite driver interface and a storage factory that accepts it and returns an
opaque handle. Third-party drivers implement SQL execution and transaction behavior; Coco owns
repository methods, SQL queries, serialization, and migrations. The public SQL storage entry point
must not expose repository classes or migration internals. This is an extension point for compatible
SQLite runtimes, not a promise of portable SQL support across engines such as PostgreSQL.

The public driver contract carries normal compatibility guarantees. The absence of versioning
guarantees for internal integration contracts does not apply to this supported driver interface.
Its execution, transaction, and error semantics are part of the public contract, not just its
TypeScript signatures.

Core and Coco-owned storage implementation packages require matching release versions, with an
early runtime mismatch check before storage initialization. This protects their private integration.
Independent drivers declare compatibility with the supported driver contract; their own package
versions do not have to match Coco, and Coco patches do not inherently require driver releases.

Publish `@cashu/coco-sql-storage` with driver types, the opaque storage factory, and driver-facing
errors at its root. Expose driver conformance helpers through `/test`. Repository classes, schema
helpers, and migration lists remain internal.

Drivers own runtime-specific connection configuration. Shared SQL storage owns schema migrations
and respects driver-supplied bound-parameter limits, including parameters outside a batched list.
Addressing these extension requirements from #530 is in scope; a complete Durable Objects adapter
is separate work.

Publish a supported driver conformance suite covering execution results, parameter handling,
transactions, rollback, isolation, and conflicts. Keep repository conformance tests internal.
Existing API constructors and plugin service methods remain supported unless they directly expose
a repository contract. Move `ProofUnitFilter` to public query types without changing its shape.

V3 makes a clean source migration: replace `repo` configuration and public repository classes
with storage factories. Keep the public `Manager` constructor, replacing its repository input
with opaque storage. Preserve manual startup: consumers can obtain a Coco Session before plugin
initialization, reconciliation, recovery, and background startup. Repository encapsulation does
not imply changing the constructor's startup behavior.

`initializeCoco()` is the canonical, recommended application entry point. Present direct
construction as an advanced path for callers who intentionally control startup. The constructor
remains supported public API rather than an internal or deprecated escape hatch.

Handle exclusivity and new concurrent-session restrictions are outside this change. Encapsulation
must preserve existing concurrency behavior rather than impose one active Coco Session per handle.

Every storage handle exposes `init(): Promise<void>` to prepare storage.
`initializeCoco()` calls it automatically. Manual callers await it before using storage through
`Manager`; the synchronous constructor does not start asynchronous initialization.
Successful initialization means storage is ready and required migrations have completed.
IndexedDB initialization must explicitly await opening and migrations; today it only registers
schema versions and opens lazily on first use. Surfacing opening and migration failures during
initialization is an intentional timing change.

Preserve backend-specific connection ownership. SQLite adapters borrow a caller-opened connection,
which the caller closes. IndexedDB opens its connection internally and exposes a narrow `close()`
on its storage handle to replace direct database access. Closing releases the connection without
deleting persisted Wallet data. Callers are responsible for finishing work before closure.
Automatic storage closure through `Manager.dispose()`, new operation-draining behavior, and new
reopening guarantees are outside this change.

Since v2, required nullable mint lookup, conditional Send transitions, and keypair allocation
primitives each triggered a major core changeset because repositories are public implementation
contracts. Keeping these contracts internal allows persistence improvements without requiring
application consumers to migrate their code or custom repository implementations.

## Considered options

A public storage interface that exposes repositories retains the existing compatibility burden.
A lower-level public driver interface preserves independent runtime bindings while Coco owns
repositories. [Issue #530](https://github.com/cashubtc/coco/issues/530) provides concrete demand:
a Durable Objects implementation reusing shared SQL storage, with runtime-specific connection
pragmas and bound-parameter limits. We choose this narrower extension contract over restricting
all supported storage integration to official adapters. Repository implementation contracts remain
internal.

The v2 comparison also exposes a driver-level change: `SqlDatabase.transaction` gained an optional
transaction mode, and shared Wallet transactions now request immediate writer ownership. A driver
that ignores the additional argument can remain structurally assignable while failing the intended
concurrency contract. A supported driver interface must specify execution and transaction behavior,
not merely preserve method signatures.

## Driver transaction contract

Specify atomicity and isolation behavior rather than requiring literal `BEGIN IMMEDIATE` support.
Reads authorizing Wallet writes and their resulting mutations share one transaction. Conflicting
writes serialize or report a retryable conflict; incompatible decisions cannot both commit.
Managed runtimes may provide these guarantees through their host transaction APIs.

Expose a public driver-level transaction-conflict error and translate it to Coco's internal
repository conflict handling. It means the attempt did not commit and rollback has completed.
Preserve ordinary callback failures; uncertain commit outcomes must not be classified as safe
to retry. Coco owns retry policy. Runtime-managed callback replay needs explicit evaluation
against that policy before support is claimed.

## Consequences

The stable `/adapter` contract and concrete repository exposure must be retired deliberately in
v3. Current documentation describes those exports as stable; this decision proposes replacing
that promise, not retroactively treating existing exports as private.

Opaque storage does not remove persisted Wallet compatibility obligations. Existing records and
in-flight operations still require supported migrations and Operation Recovery.

## Implementation and verification

Use explicitly internal integration entry points for official packages to construct and resolve
opaque handles, checking matching Coco release metadata before initialization. Verify the mechanism
with built packages, including duplicate installations of a compatible core version.

Base the public driver on the existing small execution surface: `exec`, `run`, `get`, `all`, and
`transaction`, plus a declared parameter limit. Document script execution, value binding, result
conventions, and affected-row counts. Final signatures must preserve the behavioral contract above.
Preserve nested scoped calls joining their existing transaction and keep unrelated root operations
out of it; this does not introduce new session-concurrency restrictions.

Verify public driver conformance against real official runtimes, including commit/rollback,
conditional-update row counts, concurrent writers, conflicts, callback error preservation, and
parameter limits. Tests must accept both valid serialization and valid conflict rejection.
A complete Durable Objects implementation and claims about its runtime guarantees require separate
validation; the issue's prototype test count alone is not proof of full support.

Document manual startup steps alongside the canonical factory path. The existing `initializeCoco()`
initializes plugins, reconciles legacy quotes, and runs recovery even when every watcher and processor
is disabled; direct construction must retain its deliberate omission of those steps.

Check built-package exports and consumer types for reachable repository implementation contracts,
and verify the old setup paths are removed. Run the affected adapter, initialization, and persistence
migration tests, including existing records and in-flight operations. Keep broader lifecycle,
plugin redesign, and public operation-record redesign outside this change.

## Public type audit

The inspected API constructors and plugin service map accept service instance types, not service
constructor values. Their private repository dependencies do not by themselves expose a supported
repository implementation contract. Preserve these surfaces unless a real public repository path
requires a change; incidental repository declarations in bundled type output are not sufficient
evidence. `ProofUnitFilter` is a query shape used by public plugin methods and should be classified
as a public query type rather than hidden merely because it is currently defined with repositories.
This audit is source-level; built-package consumer checks remain necessary.

## Implementation status

Implemented with `CocoStorage`, runtime-specific factories, internal integration entry points and
matching-version guards. Public driver conformance, startup, migration, restart and built-consumer
checks cover the accepted boundaries, including compatible duplicate core installations.

Validation includes the core unit suite, shared SQL migration/driver tests, Bun and Node SQLite
contracts, Chromium IndexedDB contracts and lifecycle tests, React, Cocod, consumer type/runtime checks,
and workspace build/typechecking. Expo contract tests use the repository's Bun-backed shim; native
Expo runtime verification remains separate. Mint-backed integration tests require Docker, which was
not available in the implementation environment. No Durable Objects runtime support is claimed.
