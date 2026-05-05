# @cashu/coco-sqlite

## 1.0.0

### Patch Changes

- 7f9cd39: Track receive history entries through prepared, finalized, and rolled-back
  operation states, and persist the correct receive unit across storage adapters.

  Core now emits explicit receive operation lifecycle events and updates history
  entries incrementally instead of only recording receives once a token has been
  created. The persistent adapters now support receive history lookups and
  updates, and receive operations persist their unit so non-sat history entries
  stay correct through recovery and restart flows.

- 34d5925: Repair SQLite migration compatibility for databases that were opened by adapters with swapped
  send/receive operation migration IDs.
- fe1cabb: Serialize root repository operations while SQLite adapter transactions are active.
- Updated dependencies [7f9cd39]
- Updated dependencies [dabef01]
- Updated dependencies [1daa3ce]
- Updated dependencies [dad73ba]
- Updated dependencies [3e6b339]
- Updated dependencies [660cb8e]
- Updated dependencies [505e1af]
- Updated dependencies [a57cb82]
  - @cashu/coco-core@1.0.0

## 1.0.0-rc.5

### Patch Changes

- @cashu/coco-core@1.0.0-rc.5

## 1.0.0-rc.4

### Patch Changes

- 7f9cd39: Track receive history entries through prepared, finalized, and rolled-back
  operation states, and persist the correct receive unit across storage adapters.

  Core now emits explicit receive operation lifecycle events and updates history
  entries incrementally instead of only recording receives once a token has been
  created. The persistent adapters now support receive history lookups and
  updates, and receive operations persist their unit so non-sat history entries
  stay correct through recovery and restart flows.

- Updated dependencies [7f9cd39]
- Updated dependencies [1daa3ce]
- Updated dependencies [660cb8e]
  - @cashu/coco-core@1.0.0-rc.4

## 1.0.0-rc.3

### Patch Changes

- Updated dependencies [dabef01]
- Updated dependencies [505e1af]
  - @cashu/coco-core@1.0.0-rc.3

## 1.0.0-rc.1

### Patch Changes

- Updated dependencies [a57cb82]
  - @cashu/coco-core@1.0.0-rc.1

## 1.0.0-rc.0

- Initial RC release under the `@cashu` namespace.
- Legacy changelog: `../../history/changelogs/legacy/sqlite3.md`
