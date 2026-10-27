---
'@cashu/coco-core': major
---

Starting with v3, custom storage adapters remain public extension points, but their repository
implementation contract may change incompatibly in minor or major releases. Patch releases preserve
compatibility. This policy does not apply retroactively to v2; shared public APIs and normal use of
the supplied adapters retain their existing guarantees. See the
[repository compatibility policy](https://github.com/cashubtc/coco/blob/master/packages/core/README.md#repository-compatibility)
for the scope and adapter upgrade requirements.

No interface, runtime, or persisted-data migration is required by this policy change.
