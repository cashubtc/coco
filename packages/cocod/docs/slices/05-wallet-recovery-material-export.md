# Slice 5: Wallet Recovery Material Export

Depends on [Slice 4](./04-v1-wallet-and-session-lifecycle.md).

## Outcome

The Cocod Owner can repeatably back up host-generated Wallet Recovery Material without changing
Coco Session state.

## Module interface

`CocodRuntime` exposes one retrieval operation that returns the mnemonic or a safe domain error. It
owns configuration access, passphrase requirements, decryption, and error normalization. The route
owns authorization, response caching policy, and serialization.

## Includes

- Add a `CocodRuntime` operation that retrieves the mnemonic independently of session state.
- Add `POST /v1/admin/wallet/recovery-material` with `Cache-Control: no-store`.
- Extend the runtime schemas and generated interface description with the sensitive response rules.
- Require the Wallet passphrase for encrypted Wallets even when a Coco Session is running.
- Cover missing, correct, and incorrect passphrases in every session state, including `failed`.
- Verify request and response bodies never reach logs.

## Excludes

- Wallet Import.
- A persistent decrypted copy of Wallet Recovery Material.
- Treating a Client Credential as Wallet Seed Access.

## Acceptance

- Retrieval is repeatable, non-cacheable, and independent of Coco Session state.
- Retrieval preserves reported Wallet Seed Access and does not start or stop a Coco Session.
- A running session never bypasses the passphrase requirement.
- Sensitive request and response values are absent from logs and error documents.
