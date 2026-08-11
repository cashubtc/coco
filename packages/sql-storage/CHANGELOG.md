# @cashu/coco-sql-storage

## 2.0.0-rc.3

### Major Changes

- fbd5d60: Add payer-side NUT-18 P2PK payment request support.

  Core now exposes normalized P2PK payment request requirements, filters payable
  mints to those advertising NUT-11, and prepares payment request sends through
  the general P2PK send handler with structured NUT-11 options from cashu-ts.
  Adapter packages now require cashu-ts 4.6.1, and adapter contract coverage
  checks that structured send method data remains persisted.

### Patch Changes

- dc28d1f: Upgrade to cashu-ts 5.0.0-rc.4 and consume normalized v5 mint quote snapshots at Coco's quote
  lifecycle boundary. BLS v3 keysets are temporarily excluded from wallet keysets, and tokens using
  v3 proofs are rejected until Coco supports curve-aware proof-state handling. P2PK sends now enforce
  cashu-ts v5's requirement for valid compressed secp256k1 public keys.
- f15b83c: Add canonical BOLT11 accounting predicates and opt-in NUT-20 locked quote handling with readable
  diagnostics. Keep SQL and IndexedDB quote state projections aligned with the canonical accounting
  fields.
- Updated dependencies [766696d]
- Updated dependencies [ac1925b]
- Updated dependencies [faa00d7]
- Updated dependencies [3d96047]
- Updated dependencies [dc28d1f]
- Updated dependencies [d2c3b07]
- Updated dependencies [37dd447]
- Updated dependencies [92e5329]
- Updated dependencies [fbd5d60]
- Updated dependencies [f15b83c]
- Updated dependencies [a00bbbc]
- Updated dependencies [5aef692]
  - @cashu/coco-core@2.0.0-rc.3

## 2.0.0-rc.2

### Patch Changes

- Updated dependencies [ddbdc97]
- Updated dependencies [be23636]
- Updated dependencies [d4c8a99]
  - @cashu/coco-core@2.0.0-rc.2

## 2.0.0-rc.1

### Patch Changes

- Updated dependencies [af4b491]
- Updated dependencies [5598750]
- Updated dependencies [d787fa1]
  - @cashu/coco-core@2.0.0-rc.1

## 2.0.0-rc.0

### Patch Changes

- Updated dependencies [b2ffef1]
- Updated dependencies [1dfdebf]
- Updated dependencies [3ba8af3]
- Updated dependencies [2601aee]
- Updated dependencies [0e25ddc]
- Updated dependencies [b910b5f]
- Updated dependencies [a8e029e]
- Updated dependencies [e6c780a]
- Updated dependencies [f9db334]
- Updated dependencies [0a2a8ce]
- Updated dependencies [203ebf4]
- Updated dependencies [34c16d3]
- Updated dependencies [71993c2]
- Updated dependencies [eefce1c]
- Updated dependencies [ab0fd42]
- Updated dependencies [e45cef2]
- Updated dependencies [167dec6]
- Updated dependencies [5e78860]
- Updated dependencies [6b8a896]
- Updated dependencies [737b993]
- Updated dependencies [d76264c]
- Updated dependencies [ab8be2d]
- Updated dependencies [9275ab7]
- Updated dependencies [a7c49ff]
- Updated dependencies [fe8ef00]
- Updated dependencies [00ed073]
- Updated dependencies [703a1b4]
- Updated dependencies [9342e56]
- Updated dependencies [c0e8d4f]
- Updated dependencies [16fc82c]
- Updated dependencies [06deb29]
- Updated dependencies [c8cee3c]
- Updated dependencies [0aa9a9f]
- Updated dependencies [9dd896d]
- Updated dependencies [9dc7be3]
- Updated dependencies [d25551a]
- Updated dependencies [fe4b820]
- Updated dependencies [ad67dbe]
- Updated dependencies [616f7f9]
- Updated dependencies [c489ac4]
- Updated dependencies [807ae19]
  - @cashu/coco-core@2.0.0-rc.0
