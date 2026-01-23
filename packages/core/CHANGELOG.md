# coco-cashu-core

## 1.1.2-rc.42

### Patch Changes

- 7f02bb8: Bumped Cashu-TS to major version 3, added typechecks and fixed them

## 1.1.2-rc.41

### Patch Changes

- Upgraded build dependencies to resolve issue with type declaration files

## 1.1.2-rc.40

### Patch Changes

- 7394e3d: Added Melt Saga for safer melt operations through MeltOperationService. This Service is hooked up through the new prepare and execure methods of the quotes API. It supports generic handlers for future Bolt12 support
- ce556d0: Added pause and resume events to the lifecycle methods of manager, mostly so that plugins can react to those events and manage their own lifecycle accordingly

## 1.1.2-rc.39

### Patch Changes

- 9d9e798: Bumped the main Cashu dependency Cashu-ts

## 1.1.2-rc.38

### Patch Changes

- aa97572: fixed an issue where paymentRequestService was still missing from the ServiceKeys list and made that list a keyof ServiceMap

## 1.1.2-rc.37

### Patch Changes

- f32a8a7: Added paymentRequestService to servicemap for plugins

## 1.1.2-rc.36

### Patch Changes

- 027449f: Added PluginExtension system for coco-plugins to register their own API on the manager instance

## 1.1.2-rc.35

### Patch Changes

- 406c470: patch: make sure parsing secret does not throw on missing tags key
- 59693b5: Make sure missing transport keys on PRs are treated as inband

## 1.1.2-rc.34

## 1.1.2-rc.33

### Patch Changes

- c444053: Fixed an issue where rolling back a SendOperation would not emit proofs:saved events
- 0c191e6: Moved from Ws-focussed transport to HybridTransport
- d985f02: Added checkPendingOperaiton to SendAPI
- 05ce81d: Adjusted the PaymentRequest API for ergonomics. Also change SendAPI state naming (BREAKING)

## 1.1.2-rc.32

### Patch Changes

- b8d70c5: Added auto-recovery on throws inside SendOperationService

## 1.1.2-rc.31

### Patch Changes

- 3d270d4: Refactored Send to use saga/statemachine for state management and consistency

## 1.1.2-rc.30

### Patch Changes

- Fixed the mintservice not emitting events when re-trusting an already added mint

## 1.1.2-rc.29

### Patch Changes

- fixed build issue

## 1.1.2-rc.28

### Patch Changes

- d300ecd: Make sure that untrusted mints don't have active subscriptions

## 1.1.2-rc.27

### Patch Changes

- Fixed a build issue

## 1.1.2-rc.26

### Patch Changes

- b0a4428: Added URL normalization and respective migration
- 0fb58a0: Added PaymentRequestServices and API layer to read and handle payment requests
- e2e3374: Fix a bug in Indexeddb adapter for getLatestDerivationIndex

## 1.0.0-rc.25

### Patch Changes

- c803f3e: Added keyring / p2pk support

## 1.0.0-rc.24

### Patch Changes

- 67c25bb: Made sure WalletApi.receive has all necessary data to work on keyset v2

## 1.0.0-rc.23

### Patch Changes

- 63ea8d6: bumped cashu-ts

## 1.0.0-rc.22

## 1.0.0-rc.21

### Patch Changes

- 3904f75: Upgraded cashu-ts to fix a bug with base64 keyset ids

## 1.0.0-rc.20

### Patch Changes

- 8daa9bd: Added WalletApi.sweep method and tests

## 1.0.0-rc.19

### Patch Changes

- be6737f: Made sure that WalletApi.send does an offline send (no swap) if the coin selection satisfies the exact amount
- 0729533: Fix: made sure websocket does not subscribe twice on resume

## 1.0.0-rc.18

### Patch Changes

- d40ba84: Fixes output creation for melt flow with proper fee handling

## 1.0.0-rc.17

### Patch Changes

- make sure to respect fees on receive

## 1.0.0-rc.16

### Patch Changes

- Made sure proof pre-selection takes fees into account

## 1.0.0-rc.15

### Patch Changes

- fixed build bug

## 1.0.0-rc.14

### Patch Changes

- Added unit to keyset and filtered for sats

## 1.0.0-rc.13

### Patch Changes

- Fixed an issue with async transaction in both sqlite adapters

## 1.0.0-rc.12

### Patch Changes

- changeset init
