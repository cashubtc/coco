# @cashu/coco-fountain

An experimental, browser-compatible TypeScript package for developing a binary fountain transport specification. It encodes arbitrary bytes into versioned binary fountain frames, reconstructs those bytes, and provides Cashu V4 helpers and an inbound UR reader. This package is versioned independently from Coco core. Its APIs and wire compatibility remain experimental and may change.

QR rendering and camera scanning live in the separate [device playground](https://github.com/Egge21M/nut-fountain/tree/main/apps/playground), outside this library. Wallet integration and comparative performance claims are outside this implementation. Its new dense GF(2) fountain protocol differs from the earlier POC; that POC's efficiency measurements do not establish this protocol's performance.

Read the [protocol specification](docs/protocol.md) for language-neutral interoperability rules and the [implementation guide](docs/implementation.md) for the solver, worked examples, API behavior, and adapters.

## Install

```sh
bun add @cashu/coco-fountain
```

ESM only. Supports modern browser bundlers and Node.js 22.4+; TypeScript consumers can use Bundler or NodeNext resolution. No TypeScript runtime dependency is required. QR rendering and camera access remain application responsibilities.

## Build and verify

Run these commands from this package directory. Install workspace dependencies from the Coco repository root with `bun install`. For device testing, use the separate [upstream playground](https://github.com/Egge21M/nut-fountain#readme).

```sh
bun run build
bun run typecheck
bun run test
bun run playwright install chromium # Needed only if Chromium is not already cached.
bun run test:browser
```

`build` produces ESM and declaration files in `dist/`. Browser applications should consume the package through an ESM-capable bundler; its dependencies are external in the package artifacts and resolved by the application bundler. The browser test does exactly this using the package export map. No global `Buffer` or `process` polyfill is required. `@cashu/coco-fountain/core` can be imported without pulling in Cashu or UR code.

The [validation record](docs/validation.md) lists versions, commands, and coverage. `bun pm pack` rebuilds artifacts through `prepack`. Run `bun run test:package` to verify the current source tarball in isolated Node, TypeScript and browser consumers.

Browser checks normally use Playwright's installed Chromium. For a managed environment
with an existing compatible browser, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its
executable path for `test:browser` and `test:package`.

## Choose a decoder

| Decoder           | Accepted input                                                           | Import                      |
| ----------------- | ------------------------------------------------------------------------ | --------------------------- |
| `FountainDecoder` | Only our binary fountain frames (`Uint8Array`)                           | `@cashu/coco-fountain/core` |
| `UrDecoder`       | Only complete `ur:bytes` strings                                         | `@cashu/coco-fountain/ur`   |
| `AutoDecoder`     | Binary fountain frames or UR text, including UR encoded as scanned bytes | `@cashu/coco-fountain/auto` |

All three are also exported from `@cashu/coco-fountain`. The scoped decoders keep their existing behavior; the automatic router is optional. Importing `@cashu/coco-fountain/core` still avoids UR and Cashu dependencies.

```ts
import { AutoDecoder } from '@cashu/coco-fountain/auto';
import { bytesToTokenString } from '@cashu/coco-fountain/cashu';

const decoder = new AutoDecoder();
function onScan(scanned: Uint8Array | string) {
  decoder.receive(scanned);
  console.log(decoder.format, decoder.progress); // 'binary' | 'ur' | undefined; 0–1
  if (decoder.isComplete) return bytesToTokenString(decoder.result!);
}
// Before receiving another transfer:
decoder.reset();
```

`AutoDecoder` selects its format only after an accepted frame. `format` is `undefined` before then and after `reset()`. It exposes `isComplete`, defensive-copy `result`, `independentFrames`, `fragmentCount`, and `progress` from the selected decoder. Results are arbitrary payload bytes; Cashu interpretation remains in the Cashu helpers. The router recognizes fountain framing, not bare tokens, base64-wrapped binary frames, or arbitrary text encodings.

It handles one transfer at a time. Call `reset()` to switch transfers or formats. Unknown prefixes return `false` without selecting a format. Once selected, a different format throws. Within the selected format, validation and `receive()` return values follow the scoped decoder: binary errors throw and `true` means a new independent equation; UR rejects invalid/foreign parts with `false` and `true` means a newly accepted part (possibly dependent). Invalid UTF-8 in UR byte input throws. Use `progress` and `isComplete`, rather than counting `true` returns. Failed UR message reconstruction clears UR progress but keeps the router's format selection until `reset()`.

## Arbitrary bytes

```ts
import { FountainEncoder, FountainDecoder } from '@cashu/coco-fountain/core';

const message = new TextEncoder().encode('hello');
const encoder = new FountainEncoder(message, { fragmentSize: 128 });
const decoder = new FountainDecoder();

// A local round trip. In an application, send each frame through your transport.
for (let i = 0; i < encoder.fragmentCount; i++) {
  decoder.receive(encoder.nextFrame());
}
if (!decoder.isComplete) throw new Error('Transfer incomplete');
const restored = decoder.result!; // Exact original bytes; a defensive copy.
```

`nextFrame()` first emits source fragments, then repair frames. A receiver can accept reordering and duplicates and recover from lost source frames using repair frames. A real sender continues generating frames until the receiver completes or the application stops the transfer; there is no fixed completion bound under arbitrary loss. The example sends all source frames without loss.

Binary transfers support up to 1024 source fragments, 1–4096 bytes per fragment, and a maximum message size of 1 MiB. The default 128-byte fragment size supports messages up to 128 KiB. Earlier version-1 readers reject transfers above 256 source fragments; see the [protocol bounds and compatibility notes](docs/protocol.md#2-version-1-bounds-and-fragmentation).

`FountainDecoder.receive()` returns whether the frame added an independent equation, **not** whether decoding is complete. Malformed frames and frames belonging to another message throw. Use `isComplete` and `result` for completion, and `reset()` before another transfer. See the [protocol specification](docs/protocol.md) for wire bounds and checksums, and the [implementation guide](docs/implementation.md#decoder-state-progress-and-errors) for exact API and error behavior.

### Decoding progress

`FountainDecoder` exposes three read-only properties:

- `independentFrames`: the number of independent equations retained (initially `0`). Duplicate or redundant frames do not increase it.
- `fragmentCount`: the required number of independent equations, known from the first accepted frame; `undefined` before a transfer starts or after `reset()`.
- `progress`: `independentFrames / fragmentCount`, or `0` before the total is known. It reaches `1` only after reconstruction, message checksum and padding validation succeed.

```ts
const percent = Math.floor(decoder.progress * 100);
console.log(`${percent}%`, decoder.independentFrames, decoder.fragmentCount);
```

This measures information collected toward reconstruction, not recovered bytes or time remaining. Lost frames leave progress unchanged; future frames can be redundant. Rejected frames do not advance progress, including a final equation rejected by message validation. `reset()` clears progress. The wire format is unchanged. `UrDecoder` exposes the same properties. Its count includes the UR CBOR wrapper; single-part UR completes at 1/1. Unlike the binary decoder, failed UR message validation resets the session and its progress to zero. Accepted but linearly dependent UR parts do not advance progress.

## Cashu V4 tokens

```ts
import { Amount, type Token } from '@cashu/cashu-ts';
import { FountainEncoder, FountainDecoder } from '@cashu/coco-fountain/core';
import { tokenToBytes, bytesToToken, bytesToTokenString } from '@cashu/coco-fountain/cashu';

// A structurally valid fixture, not spendable money.
const token: Token = {
  mint: 'https://mint.example',
  unit: 'sat',
  proofs: [
    {
      id: '009a1f293253e41e',
      amount: Amount.from(1),
      secret: 'not-spendable',
      C: '02' + '11'.repeat(32),
    },
  ],
};
// A cashuB string is also accepted in place of token.
const encoder = new FountainEncoder(tokenToBytes(token));
const decoder = new FountainDecoder();
for (let i = 0; i < encoder.fragmentCount; i++) decoder.receive(encoder.nextFrame());
if (!decoder.isComplete) throw new Error('Transfer incomplete');
const recoveredToken = bytesToToken(decoder.result!);
const cashuB = bytesToTokenString(decoder.result!);
```

`tokenToBytes` returns `crawB` binary bytes. Text conversion preserves the original CBOR and produces unpadded base64url text. Object input uses the public `Token` shape in pinned `@cashu/cashu-ts@5.0.0-rc.4`, including `Amount` values. Object conversions promise equivalent contents rather than identical serialization: cashu-ts defaults missing units to `sat`; object witnesses normalize to JSON strings, while already serialized witness strings retain their original text. Full keyset IDs from objects are preserved; already shortened IDs in input cannot be expanded without additional information. Helpers do not contact a mint or validate whether proofs are spendable. `cashuA` is unsupported.

## Existing UR input

```ts
import { UrDecoder } from '@cashu/coco-fountain/ur';
import { bytesToToken, bytesToTokenString } from '@cashu/coco-fountain/cashu';

export function readUrParts(parts: Iterable<string>) {
  const reader = new UrDecoder();
  for (const part of parts) {
    reader.receive(part); // The complete UR string, including ur:bytes/.
    if (reader.isComplete) {
      return {
        token: bytesToToken(reader.result!),
        cashuB: bytesToTokenString(reader.result!),
      };
    }
  }
  throw new Error('More UR parts are needed');
}
```

The supported convention is `ur:bytes` carrying a CBOR byte string whose payload is either UTF-8 `cashuB` text or `crawB` binary. Single-part and multipart inputs, including uppercase strings, are accepted. `UrDecoder` removes UR/Bytewords/CBOR framing and returns payload bytes; the Cashu helpers interpret either payload representation. The package does not encode UR. Its local decoder uses native `BigInt` and `Uint8Array`, with `cborg` for CBOR and `@noble/hashes` for SHA-256. `@gandlaf21/bc-ur` is development-only and generates interoperability fixtures; it is not in the runtime import graph. See [third-party notices](NOTICE.md) for protocol material and fixture attribution.

`UrDecoder.receive()` returns whether a new part was accepted; it returns `false` for malformed, duplicate, foreign, over-limit, or post-completion input. It does **not** indicate completion. Use `isComplete`, `result`, and `reset()` as with the binary reader. A failed reconstructed UR message resets the session; a successfully reconstructed non-Cashu byte payload is rejected by the Cashu helper. [NUT-16](https://github.com/cashubtc/nuts/blob/main/16.md) does not fix the exact UR payload mapping, so these conventions do not establish compatibility with every wallet.

## Entry points

| Import                          | Exports                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `@cashu/coco-fountain/core`     | `FountainEncoder`, `FountainDecoder`                               |
| `@cashu/coco-fountain/cashu`    | `tokenToBytes`, `bytesToToken`, `bytesToTokenString`, type `Token` |
| `@cashu/coco-fountain/ur`       | `UrDecoder`                                                        |
| `@cashu/coco-fountain/auto`     | `AutoDecoder`, type `DecoderFormat`                                |
| `@cashu/coco-fountain/encoding` | `encodeCbor`, `decodeCbor`, `encodeBase64Url`, `decodeBase64Url`   |
| `@cashu/coco-fountain`          | All of the above                                                   |

CBOR helpers encode CBOR-compatible values and decode exactly one item. Base64 helpers use the URL-safe alphabet; encoding omits padding and decoding accepts valid padded or unpadded input. Invalid input throws.

## License

MIT, copyright (c) 2026 Egge21M. See [LICENSE](LICENSE). Third-party material retains the notices in [NOTICE.md](NOTICE.md).

## Migration from nut-fountain

Replace `nut-fountain` with `@cashu/coco-fountain` in dependencies and imports;
all six entry points retain their names. The alpha.1 source raises the fragment limit
to 1024 while retaining the version-1 frame layout. Earlier readers support only
transfers of at most 256 fragments.
Cashu object helpers now use Coco's `@cashu/cashu-ts@5.0.0-rc.4`; use matching
`Token` and `Amount` values, or pass a `cashuB` string to preserve its encoded CBOR.
The package does not depend on Coco core and does not start a Coco Session.

The source was imported from [Egge21M/nut-fountain v0.1.0-alpha.1 at 130fb2c](https://github.com/Egge21M/nut-fountain/tree/130fb2c1bba617a1a5d4f0bb08898a29099a64fc/packages/nut-fountain).
The original MIT license and third-party notices are retained. The device playground
remains in that repository. See Coco's [animated QR guide](https://cashubtc.github.io/coco/starting/animated-qr)
for integration with send and receive operations.
