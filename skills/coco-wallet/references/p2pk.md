# P2PK locked ecash

Read with [Send ecash](ecash-send.md) when creating a locked token, or
[Receive ecash](ecash-receive.md) when claiming one. The normal operation lifecycle still applies.

## Keys and mint support

The mint must advertise NUT-11 support. Lock, cosigner, and refund public keys must be valid
compressed secp256k1 keys: 66 hexadecimal characters beginning with `02` or `03`.
Coco-generated keys use this format.

```ts
const { publicKeyHex } = await coco.keyring.generateKeyPair();
```

Share the public key with the sender. Import an existing spending key through
`coco.keyring.addKeyPair(secretKey)` when needed; keep secret keys out of UI logs and delivery
payloads. Built-in adapters persist keypairs without encryption at rest, so protect the database
according to the app's storage model. Imported keys need their own backup; restoring a seed does
not reconstruct them. Preserve derivation high-water metadata with keypairs in database backups.

## Send with a recipient lock

```ts
const prepared = await coco.ops.send.prepare({
  mintUrl,
  amount: 100,
  target: { type: 'p2pk', pubkey: recipientPublicKey },
});
```

Review and execute this prepared operation through the send flow. Structured `target.options`
also supports multiple keys, required signatures, locktime, refund keys, and signature flags.
Read the [KeyRing guide](https://cashubtc.github.io/coco/pages/keyring) before assembling those
conditions. A refund path changes who can claim the token after its locktime; display that policy
as part of payment review.

## Receive a locked token

Have the required keypairs available in Coco before preparing and executing a normal receive.
Coco handles the spending-condition signing through its receive flow. A missing key or unmet
signature threshold is an actionable receive error; use the actual operation result rather than
assuming that having one key satisfies every lock.

Keep a key while tokens may still require it. Removing it with `keyring.removeKeyPair()` can make
those tokens unspendable until the key is restored.

For a payer-side P2PK payment request, use the [payment-request flow](payment-requests.md).
It derives the send target from the parsed requirement and validates eligible mints; recreating
the request as an ordinary unlocked send would discard the receiver's condition.

**Done when:** the token enforces the reviewed recipient/refund policy, the recipient can claim
with the required keys, and missing-key or unsupported-mint cases give clear outcomes.
