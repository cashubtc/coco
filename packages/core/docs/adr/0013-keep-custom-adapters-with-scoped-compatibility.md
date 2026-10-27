---
status: accepted
---

# Keep custom adapters with scoped compatibility

Keep repository interfaces public so consumers can implement storage backends beyond the supplied
adapters. Adopt the [repository compatibility policy](../../README.md#repository-compatibility) to let
persistence interfaces evolve without requiring a major release for every adapter change.

Hiding repositories behind a new storage abstraction would constrain custom backends and add another
contract to maintain. Keeping the existing extension point preserves that flexibility, at the cost of
requiring independent adapter authors to validate compatibility when upgrading. Most users rely on
the supplied adapters and do not implement these interfaces themselves.

This decision changes versioning policy only. Runtime refactoring and adapter improvements remain
separate work.
