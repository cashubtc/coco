# Animated QR Transfers

`@cashu/coco-fountain` is an optional, headless package for transferring Cashu
tokens through binary fountain frames. It reconstructs transfers despite missing,
reordered, or repeated frames and can also read existing `ur:bytes` transfers.
Your application supplies QR rendering, scanning, and animation timing.

::: warning Experimental transport
The package is versioned independently from Coco core. Its APIs and wire format remain
experimental. The binary sender requires a compatible receiver. Inbound UR support
does not guarantee compatibility with every wallet, and this package does not
encode UR. Device performance comparisons are still needed before choosing defaults.
:::

```sh
bun add @cashu/coco-fountain
```

## Send a token

Once the user has confirmed a prepared send, execute it through Coco and create
an encoder from the resulting token:

```ts
import { FountainEncoder } from '@cashu/coco-fountain/core';
import { tokenToBytes } from '@cashu/coco-fountain/cashu';

const { token } = await coco.ops.send.execute(preparedSend.id);
const encoder = new FountainEncoder(tokenToBytes(token), { fragmentSize: 128 });

// Call for each animation frame until the user stops the display.
function nextQrPayload(): Uint8Array {
  return encoder.nextFrame();
}
```

Pass these bytes to a renderer that supports raw QR byte segments. Preserve the
bytes exactly; converting them to text or base64 produces a different transport.
The fragment size above is a starting example, not a measured optimum. Select
density and display rate based on the devices you support.

Binary transfers allow up to 1024 source fragments and a maximum message size of
1 MiB. At the default 128-byte fragment size, messages can be up to 128 KiB.
This matches upstream `nut-fountain@0.1.0-alpha.1`. Earlier version-1 readers
accept only up to 256 fragments, so transfers above that count require updated
receivers. The frame format does not negotiate these capabilities.

The first frames carry source fragments; subsequent frames provide repair data.
Continue emitting frames while the transfer is displayed. The encoder has no
receiver acknowledgment or fixed completion time. Closing the QR display does
not cancel or reclaim the send; use the existing [send lifecycle](../pages/send-operations.md).

## Scan and reconstruct

Create one decoder per transfer. Feed it raw scanned bytes for binary frames or
complete UR strings for UR frames:

```ts
import { AutoDecoder } from '@cashu/coco-fountain/auto';
import { bytesToTokenString } from '@cashu/coco-fountain/cashu';

const decoder = new AutoDecoder();
let reconstructedToken: string | undefined;

function onScan(scanned: Uint8Array | string): string | undefined {
  if (reconstructedToken !== undefined) return undefined;
  decoder.receive(scanned);

  // decoder.progress is 0–1; it measures information collected, not time remaining.
  if (!decoder.isComplete) return undefined;
  reconstructedToken = bytesToTokenString(decoder.result!);
  return reconstructedToken;
}

function resetTransfer() {
  decoder.reset();
  reconstructedToken = undefined;
}
```

Handle scan errors in the application: malformed binary frames and incompatible
transfers can throw. Reset explicitly before switching transfers. `AutoDecoder`
recognizes fountain frames and UR framing; ordinary single-QR `cashuB` strings
should go directly to your application's normal token handling.

## Receive through Coco

Reconstruction yields a token; it does not redeem proofs or establish that they
are spendable. Stop scanning after reconstruction, then pass the completed token
through Coco's normal review flow. The mint must be trusted first.

```ts
if (reconstructedToken !== undefined) {
  const prepared = await coco.ops.receive.prepare({ token: reconstructedToken });

  if (await askUserConfirmation(prepared)) {
    await coco.ops.receive.execute(prepared.id);
  } else {
    await coco.ops.receive.cancel(prepared.id);
  }
}
```

Keep this receive action outside the repeated scanner callback so repeated frames
do not initiate multiple receive operations. See [Receive Operations](../pages/receive-operations.md)
for recovery and cancellation behavior.

## Package entry points

| Import                          | Purpose                                                               |
| ------------------------------- | --------------------------------------------------------------------- |
| `@cashu/coco-fountain/core`     | Encode and decode arbitrary bytes without loading Cashu or UR code    |
| `@cashu/coco-fountain/cashu`    | Convert `cashuB` strings and Cashu V4 token objects to and from bytes |
| `@cashu/coco-fountain/ur`       | Read single-part and animated `ur:bytes` transfers                    |
| `@cashu/coco-fountain/auto`     | Detect and read binary fountain or UR transfers                       |
| `@cashu/coco-fountain/encoding` | CBOR and base64url helpers                                            |
| `@cashu/coco-fountain`          | All exports                                                           |

The package uses the same cashu-ts version as Coco and requires no Coco Session.
When migrating from `nut-fountain`, replace the package name in each import.
The version-1 frame layout is retained, with alpha.1's expanded fragment limit.
