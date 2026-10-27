---
status: accepted
---

# Keep custom adapters with scoped compatibility

Keep `Repositories`, the `/adapter` entry point, and adapter injection through `initializeCoco`
as public extension points so consumers can implement storage backends beyond the supplied adapters.
Starting with v3, make the repository implementation contract unstable across minor releases to
allow persistence interfaces to evolve without requiring a major release for every adapter change.

The [repository compatibility policy](../../README.md#repository-compatibility) scopes this exception
to repository interfaces, transaction scopes, and repository-only types and helpers. Patch releases
preserve the contract; every incompatible change requires an adapter migration note. Withdrawing the
previous compatibility guarantee takes a major release and does not apply retroactively to v2.

Shared public domain models, Wallet APIs, events, plugin service interfaces, and supplied-adapter
construction, configuration, initialization, and normal `initializeCoco` usage retain normal semantic
versioning guarantees. Importing or re-exporting a shared model through `/adapter` does not make it
unstable. Independent adapters declare their supported Coco versions and validate upgrades with
conformance tests against their backend.

This decision preserves backend flexibility without introducing a new storage abstraction or hiding
the repository interfaces. It changes versioning policy only: transaction semantics, persistence
migrations, and operation recovery remain governed by their existing contracts. Runtime refactoring
and extraction of adapter improvements are separate work.
