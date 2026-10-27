---
'@cashu/coco-core': major
---

Starting with v3, keep custom storage adapters as a public extension point while marking the
repository implementation contract unstable. Repository interfaces, transaction scopes, and
repository-only helper types and functions may change incompatibly in minor or major releases;
patch releases preserve compatibility. Every incompatible change requires an adapter migration note.
This policy does not apply retroactively to v2.

Adapter migration: no interface, runtime, or persisted-data migration is required by this change.
Independent adapter authors should declare the Coco versions they support and run the relevant
`@cashu/coco-adapter-tests` suites against their backend before expanding that range; do not assume
that a future minor release is compatible.

Shared public domain models, Wallet APIs, events, plugin service interfaces, and supplied-adapter
construction, configuration, initialization, and normal `initializeCoco` usage retain normal semantic
versioning guarantees. See the repository compatibility section in the core README for the full policy.
