# coco-cashu-indexeddb

## 1.1.2-rc.46

### Patch Changes

- coco-cashu-core@1.1.2-rc.46

## 1.1.2-rc.45

### Patch Changes

- 30aa519: Fix: sqlite-bun package was missing from release pipeline. It's included now
- Updated dependencies [30aa519]
  - coco-cashu-core@1.1.2-rc.45

## 1.1.2-rc.44

### Patch Changes

- Updated dependencies [8bb6f67]
  - coco-cashu-core@1.1.2-rc.44

## 1.1.2-rc.43

### Patch Changes

- ad87919: Feat: Add checkInflightProofs method and wired it up inside proofStateWatcher, so that inflight proofs are state-checked on startup and subscribed to if still inflight
- db2baec: Feat: Add optional token field to ReceiveHistoryEntries
- Updated dependencies [6f0ed09]
- Updated dependencies [ad87919]
- Updated dependencies [2057978]
- Updated dependencies [db2baec]
  - coco-cashu-core@1.1.2-rc.43

## 1.1.2-rc.42

### Patch Changes

- 7f02bb8: Bumped Cashu-TS to major version 3, added typechecks and fixed them
- Updated dependencies [7f02bb8]
  - coco-cashu-core@1.1.2-rc.42

## 1.1.2-rc.41

### Patch Changes

- Upgraded build dependencies to resolve issue with type declaration files
- Updated dependencies
  - coco-cashu-core@1.1.2-rc.41

## 1.1.2-rc.40

### Patch Changes

- Updated dependencies [7394e3d]
- Updated dependencies [ce556d0]
  - coco-cashu-core@1.1.2-rc.40

## 1.1.2-rc.39

### Patch Changes

- Updated dependencies [9d9e798]
  - coco-cashu-core@1.1.2-rc.39

## 1.1.2-rc.38

### Patch Changes

- Updated dependencies [aa97572]
  - coco-cashu-core@1.1.2-rc.38

## 1.1.2-rc.37

### Patch Changes

- Updated dependencies [f32a8a7]
  - coco-cashu-core@1.1.2-rc.37

## 1.1.2-rc.36

### Patch Changes

- Updated dependencies [027449f]
  - coco-cashu-core@1.1.2-rc.36

## 1.1.2-rc.35

### Patch Changes

- Updated dependencies [406c470]
- Updated dependencies [59693b5]
  - coco-cashu-core@1.1.2-rc.35

## 1.1.2-rc.34

### Patch Changes

- Adjusted finalised migration to pass constraint
  - coco-cashu-core@1.1.2-rc.34

## 1.1.2-rc.33

### Patch Changes

- 05ce81d: Adjusted the PaymentRequest API for ergonomics. Also change SendAPI state naming (BREAKING)
- Updated dependencies [c444053]
- Updated dependencies [0c191e6]
- Updated dependencies [d985f02]
- Updated dependencies [05ce81d]
  - coco-cashu-core@1.1.2-rc.33

## 1.1.2-rc.32

### Patch Changes

- Updated dependencies [b8d70c5]
  - coco-cashu-core@1.1.2-rc.32

## 1.1.2-rc.31

### Patch Changes

- 1b3ba7b: Making sure adding keypairs to the keyring will never override the derivation index on conflict
- 3d270d4: Refactored Send to use saga/statemachine for state management and consistency
- Updated dependencies [3d270d4]
  - coco-cashu-core@1.1.2-rc.31

## 1.1.2-rc.30

### Patch Changes

- Updated dependencies
  - coco-cashu-core@1.1.2-rc.30

## 1.1.2-rc.29

### Patch Changes

- fixed build issue
- Updated dependencies
  - coco-cashu-core@1.1.2-rc.29

## 1.1.2-rc.28

### Patch Changes

- Updated dependencies [d300ecd]
  - coco-cashu-core@1.1.2-rc.28

## 1.1.2-rc.27

### Patch Changes

- Updated dependencies
  - coco-cashu-core@1.1.2-rc.27

## 1.1.2-rc.26

### Patch Changes

- b0a4428: Added URL normalization and respective migration
- e2e3374: Fix a bug in Indexeddb adapter for getLatestDerivationIndex
- Updated dependencies [b0a4428]
- Updated dependencies [0fb58a0]
- Updated dependencies [e2e3374]
  - coco-cashu-core@1.1.2-rc.26

## 1.0.0-rc.25

### Patch Changes

- c803f3e: Added keyring / p2pk support
- Updated dependencies [c803f3e]
  - coco-cashu-core@1.0.0-rc.25

## 1.0.0-rc.24

### Patch Changes

- Updated dependencies [67c25bb]
  - coco-cashu-core@1.0.0-rc.24

## 1.0.0-rc.23

### Patch Changes

- Updated dependencies [63ea8d6]
  - coco-cashu-core@1.0.0-rc.23

## 1.0.0-rc.22

### Patch Changes

- 246c67a: Made sure indexeddb transactions are only reused when they are still active
  - coco-cashu-core@1.0.0-rc.22

## 1.0.0-rc.21

### Patch Changes

- Updated dependencies [3904f75]
  - coco-cashu-core@1.0.0-rc.21

## 1.0.0-rc.20

### Patch Changes

- Updated dependencies [8daa9bd]
  - coco-cashu-core@1.0.0-rc.20

## 1.0.0-rc.19

### Patch Changes

- Updated dependencies [be6737f]
- Updated dependencies [0729533]
  - coco-cashu-core@1.0.0-rc.19

## 1.0.0-rc.18

### Patch Changes

- Updated dependencies [d40ba84]
  - coco-cashu-core@1.0.0-rc.18

## 1.0.0-rc.17

### Patch Changes

- make sure to respect fees on receive
- Updated dependencies
  - coco-cashu-core@1.0.0-rc.17

## 1.0.0-rc.16

### Patch Changes

- Made sure proof pre-selection takes fees into account
- Updated dependencies
  - coco-cashu-core@1.0.0-rc.16

## 1.0.0-rc.15

### Patch Changes

- fixed build bug
- Updated dependencies
  - coco-cashu-core@1.0.0-rc.15

## 1.0.0-rc.14

### Patch Changes

- Added unit to keyset and filtered for sats
- Updated dependencies
  - coco-cashu-core@1.0.0-rc.14

## 1.0.0-rc.13

### Patch Changes

- Fixed an issue with async transaction in both sqlite adapters
- Updated dependencies
  - coco-cashu-core@1.0.0-rc.13

## 1.0.0-rc.12

### Patch Changes

- changeset init
- Updated dependencies
  - coco-cashu-core@1.0.0-rc.12
