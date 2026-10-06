# @cashu/coco-fountain implementation guide

This guide explains the current TypeScript package: how its encoder and decoder work, how its APIs behave, and how Cashu and UR adapters fit around the byte core. The separate [version-1 protocol specification](protocol.md) defines the language-neutral interoperability requirements. If you are implementing the wire format in another language, start there.

This guide is descriptive, not an additional conformance requirement. Gaussian elimination, typed arrays, session handling, defaults, and API return values describe this implementation. The format and package remain experimental.

## Contents

- [Layers and terminology](#layers-and-terminology)
- [Turning a message into source fragments](#turning-a-message-into-source-fragments)
- [Selecting fragments from the sequence number](#selecting-fragments-from-the-sequence-number)
- [Wire format in the library](#wire-format-in-the-library)
- [How the decoder solves the equations](#how-the-decoder-solves-the-equations)
- [Worked transfer: frame 5 arrives first](#worked-transfer-frame-5-arrives-first)
- [Decoder state, progress, and errors](#decoder-state-progress-and-errors)
- [Cashu conversion and encoding helpers](#cashu-conversion-and-encoding-helpers)
- [Inbound UR compatibility](#inbound-ur-compatibility)
- [Automatic format routing](#automatic-format-routing)
- [Using the public API](#using-the-public-api)
- [Costs, limits, and transport responsibilities](#costs-limits-and-transport-responsibilities)
- [Implementation map and verification](#implementation-map-and-verification)

## Layers and terminology

```text
Cashu V4 string or cashu-ts Token object
    │ tokenToBytes
    ▼
UTF8("crawB") || CBOR                 ← one possible message
    │ FountainEncoder
    ▼
versioned binary fountain frames     ← arbitrary transport, e.g. QR byte mode
    │ FountainDecoder
    ▼
exact original message bytes
    │ bytesToTokenString / bytesToToken
    ▼
Cashu V4 string / cashu-ts Token object
```

`||` means byte concatenation. The core neither interprets nor adds a Cashu marker: if its input is something other than a Cashu token, it transports those bytes unchanged. CBOR, base64, UR, QR rendering, and camera scanning are outside the binary core.

| Term / symbol              | Meaning in this document                                                      |
| -------------------------- | ----------------------------------------------------------------------------- |
| Message, `M`               | The original byte array supplied to the encoder.                              |
| Message length, `L`        | Number of original bytes, before padding.                                     |
| Fragment size, `S`         | Number of payload bytes in every frame of this transfer.                      |
| Source fragment, `F[i]`    | Consecutive piece of the message, padded to `S` bytes. Indexes start at zero. |
| Source fragment count, `N` | Number of source fragments, also the number of independent equations needed.  |
| Fountain frame             | Header, one encoded fragment payload, and frame checksum.                     |
| Sequence number, `q`       | Frame number starting at 1; determines which fragments are selected.          |
| Coefficient, `c[i]`        | `1` if source fragment `i` is included, `0` otherwise.                        |
| Equation                   | A coefficient vector together with its encoded payload bytes.                 |
| Rank                       | Number of independent equations retained by the decoder.                      |
| Pivot                      | First nonzero coefficient in a stored equation; identifies its row.           |

The **fountain format version** describes the frame format and decoding rules. The **token version** describes the message contents. Our fountain version `1` and Cashu version `B` are independent.

## Turning a message into source fragments

`new FountainEncoder(message, { fragmentSize })` performs these steps:

1. Require a `Uint8Array` input.
2. Choose `S`: the default is `128`; an explicit size must be an integer from `1` through `4096`.
3. Calculate `N = max(1, ceil(L / S))`.
4. Reject messages longer than `1,048,576` bytes or requiring more than `1024` source fragments.
5. Copy the message and calculate its CRC32. Later changes to the caller's array cannot change the transfer.

Conceptually, fragment `i` contains message bytes `[i*S, (i+1)*S)`, followed by zero bytes if necessary. The implementation does not allocate all padded source fragments ahead of time: it starts each output payload at zero and XORs the available source bytes into it.

For example, `L = 1000` and `S = 128` give `N = 8`. The final fragment contains 104 message bytes and 24 zero bytes. The original length lets the reader remove padding after reconstruction.

Empty input is allowed: `L = 0`, `N = 1`, and its one source fragment is entirely zero. One valid source frame completes an empty transfer. The frame still carries `S` payload bytes.

Each `nextFrame()` increments the sequence number and returns a newly allocated frame. The first sequence is `1`; the last possible sequence is `0xffffffff` (`4,294,967,295`). The next call after that throws. Sequences never wrap, and the public encoder has no seek or reset method; create another encoder to restart.

## Selecting fragments from the sequence number

### What coefficients mean

For four fragments `A, B, C, D`, coefficients `[0, 1, 0, 1]` simply mean “include B and D.” The frame payload is therefore `B XOR D`.

XOR operates on corresponding bits of corresponding bytes. In particular:

```text
X XOR X = zero bytes
X XOR zero bytes = X
(A XOR B) XOR B = A
```

The formal name GF(2) means the coefficients are 0 or 1, addition is XOR, and multiplying a fragment by 0 excludes it while multiplying by 1 includes it. The same coefficient vector applies to every byte position in a fragment.

### Systematic frames and repair frames

For `q <= N`, choose only source fragment `q - 1`. These first `N` frames are called systematic frames. Receiving all of them, in any order, completes the transfer without needing repair frames.

For `q > N`, run a deterministic pseudorandom calculation seeded with `q`. Generate one include/skip bit per source fragment. If every bit is zero, select fragment `(q - 1) % N` instead. Thus every frame includes at least one source fragment.

Both encoder and decoder run the same function with the same `q` and `N`. **The coefficient vector is not transmitted.** The header carries the sequence number and source fragment count, from which the receiver recreates it.

The generator starts afresh for each frame. It is not a continuing random stream that a receiver must follow from frame 1. Missing earlier frames therefore does not prevent interpreting a later frame.

### Implementing the selection algorithm in JavaScript

The language-neutral [selection algorithm](protocol.md#3-deterministic-fragment-selection) is normative. The current [coefficients function](../src/internal/core/equations.ts) implements it using the integer output step of Mulberry32.

In that implementation, `>>>` is a zero-filling right shift, `Math.imul` keeps the low 32 multiplication bits, and bitwise operations coerce their operands to 32-bit integers. `>>> 0` interprets the bit pattern as unsigned. The final `& 1` extracts its low bit. These operations implement the specification's unsigned arithmetic; another language should implement those arithmetic definitions without needing JavaScript semantics.

The message checksum does **not** seed selection. Messages with the same `N` and `q` have the same coefficient vector, although their payload bytes differ.

Actual selections for `N = 4` are:

| Sequence | Coefficients for A, B, C, D | Payload             |
| -------- | --------------------------- | ------------------- |
| 1        | `1000`                      | A                   |
| 2        | `0100`                      | B                   |
| 3        | `0010`                      | C                   |
| 4        | `0001`                      | D                   |
| 5        | `0101`                      | B XOR D             |
| 6        | `1011`                      | A XOR C XOR D       |
| 7        | `0010`                      | C                   |
| 8        | `1111`                      | A XOR B XOR C XOR D |

Repair frames can be singletons, repeats of earlier selections, or combinations of many fragments. The calculation tends to select roughly half the fragments; it does not promise that every repair frame is useful.

### Constructing the payload

Allocate `S` zero bytes. For every selected fragment, XOR its bytes into that array. The result is exactly `S` bytes regardless of how many fragments were selected. There is no compression, encryption, CBOR wrapping, or text encoding at this step.

## Wire format in the library

The [specification](protocol.md#4-frame-layout) defines every field, byte order, and checksum. Our parser and serializer implement those rules in [wire.ts](../src/internal/core/wire.ts); [crc32.ts](../src/internal/crc32.ts) implements the checksum.

At the library's default fragment size of 128 bytes, a frame is 152 bytes. The default is a library choice; any protocol-valid fragment size works. The exact selection, CRC arithmetic, and normative wire vectors live in the specification so they have one authoritative definition.

## How the decoder solves the equations

This section describes our solver, not a mandated decoding algorithm. Other implementations can choose a different solver that satisfies the specification.

The reader uses incremental Gaussian elimination. It retains a map from pivot index to equation. Each equation stores a `Uint8Array` of `N` coefficients and a `Uint8Array` of `S` payload bytes. Although the coefficients are logically bits, this implementation stores one byte per coefficient.

### Adding an equation

After frame validation and transfer matching:

1. Recreate the initial coefficients from `q` and `N`.
2. Copy the coefficients and payload into a new equation.
3. Walk coefficient indexes from `0` through `N - 1`.
4. Skip zero coefficients.
5. At a nonzero coefficient, if a row with that pivot already exists, XOR that row's coefficients **and** payload into the new equation. This cancels that pivot, then scanning continues.
6. Otherwise, store the new equation at that pivot and stop. Rank increases by one.
7. If all coefficients cancel, discard the equation as dependent. Rank stays unchanged.

The XOR must affect coefficients and payload together: the coefficients track which source fragments the transformed payload represents. Stored equations can therefore have different coefficients from the original frame's selection.

Insertion stops at the first unused pivot. It does not eagerly simplify every existing row or immediately expose individually recoverable fragments. Stored rows form an upper triangular system: their first nonzero coefficient is at the pivot, and remaining nonzero coefficients can only be to its right.

Current edge behavior: when all coefficients cancel, the solver returns “dependent” without checking whether the reduced payload is also zero. A contradictory redundant equation with a valid frame CRC is consequently ignored. CRCs and this solver are not an adversarial consistency or authenticity mechanism.

### Recovering the original message

When rank reaches `N`, every pivot is present. The reader performs back-substitution:

1. Allocate `N*S` output bytes.
2. Visit pivots from `N - 1` down to `0`.
3. Copy that row's payload.
4. For each nonzero coefficient to the pivot's right, XOR the already recovered source fragment out of the copy.
5. Store what remains as source fragment `F[pivot]`.
6. Take the first `L` bytes as the decoded message.
7. Verify its CRC32 and require every remaining padding byte to equal zero.
8. Only after both checks succeed, set the completed result.

The solver is an implementation choice. Another decoder could use a different solver, provided it follows the same wire format, fragment selection, and integrity rules and reconstructs the same bytes.

## Worked transfer: frame 5 arrives first

Use the four-byte message `10 20 30 40` (hexadecimal) and `S = 1`:

```text
A = 10    B = 20    C = 30    D = 40
N = 4     L = 4     message CRC32 = e08ab900
```

The sender generates frames 1 onward. Suppose the reader has not received any of frames 1–4 when frame 5 arrives. It checks the header and checksum, derives `0101`, and stores:

```text
pivot 1:  0101  |  60       B XOR D = 60
```

It does not know B or D separately. Rank is 1, so progress is 25%.

Now suppose frame 2 arrives out of order with payload `20`. Its coefficients start as `0100`. Pivot 1 is already occupied, so the solver cancels that row:

```text
0100 | 20                  incoming B
0101 | 60                  stored B XOR D
--------- XOR
0001 | 40                  D
```

The result is stored at pivot 3. Rank is 2 and progress is 50%. D is identifiable in that row, but the public `result` remains undefined until the whole message is complete. Repeating frame 2 now adds no information and returns `false`.

Frame 6 arrives next. Its selection is `1011` and its payload is `10 XOR 30 XOR 40 = 60`. Pivot 0 is unused, so it is stored there immediately. Rank is 3 and progress is 75%.

Finally frame 3 arrives, selecting only C with payload `30`. Pivot 2 is unused. The rows are now:

| Pivot | Coefficients | Payload | Equation      |
| ----- | ------------ | ------- | ------------- |
| 0     | `1011`       | `60`    | A XOR C XOR D |
| 1     | `0101`       | `60`    | B XOR D       |
| 2     | `0010`       | `30`    | C             |
| 3     | `0001`       | `40`    | D             |

Back-substitution recovers D = `40`, C = `30`, B = `60 XOR 40 = 20`, and A = `60 XOR 30 XOR 40 = 10`. The message CRC matches; there is no padding in this example. Progress becomes 100%, `isComplete` becomes `true`, and `result` returns `10 20 30 40`.

The [mixed-frame vectors](protocol.md#mixed-frames-and-reordered-reception) contain the complete frame bytes for this example, including checksums. Their layout and CRC values were independently calculated and compared against encoder output.

## Decoder state, progress, and errors

### Parsing and transfer matching

`FountainDecoder.receive(frame)` first checks, in this order:

1. Input is a `Uint8Array`.
2. Total frame length is greater than 24 and at most 4120.
3. The first four bytes are exactly `4e 46 01 00`.
4. Metadata is valid: `q != 0`, `1 <= N <= 1024`, `L <= 1,048,576`, and `N == max(1, ceil(L / S))`, where `S = frame.length - 24`.
5. The trailing frame CRC matches the preceding bytes.
6. If a transfer is already established, `(N, L, S, messageCRC)` matches the active transfer's tuple.

Parsing checks happen before allocating solver equations. The parser respects a typed array's byte offset and length, so views into larger arrays are supported. Retained data is copied; modifying a received array afterward cannot alter stored equations.

The transfer tuple is an accidental-mixup guard, not a unique cryptographic identity. Same-length messages with equal fragment sizes and colliding CRC32 values are indistinguishable at this layer.

### Public state and return values

| Property            | Initial / reset state | Active / complete state                                         |
| ------------------- | --------------------- | --------------------------------------------------------------- |
| `fragmentCount`     | `undefined`           | `N`, once an independent frame establishes metadata.            |
| `independentFrames` | `0`                   | Solver rank.                                                    |
| `progress`          | `0`                   | Rank / N; `1` after validated completion.                       |
| `isComplete`        | `false`               | `true` only after reconstruction, checksum, and padding checks. |
| `result`            | `undefined`           | A fresh copy of the original message on every access.           |

`receive()` returns `true` for a new independent equation, including successful completion. It returns `false` for dependent equations and valid same-transfer input after completion. Completion is reported by `isComplete`, not by the boolean return alone.

There is no sequence-number set in the binary decoder: redundancy is identified algebraically. Distinct sequence numbers can carry dependent equations, and repeating a valid frame contributes no extra rank.

Progress measures information retained, not bytes already returned or time remaining. Receiving N arbitrary frames need not produce N independent equations. Lost frames do nothing to the reader's state, and future frames can be redundant. Receiving all N systematic frames suffices; no fixed repair-frame count guarantees recovery under arbitrary reception/loss.

### Failures and reset

Malformed input and different-transfer metadata throw, leaving the accumulated equations and metadata unchanged. Parsing and transfer matching still happen after completion: a malformed or foreign frame can throw even then.

If a newly added equation reaches full rank but reconstructed-message CRC or padding validation fails, the decoder removes **only that newly inserted pivot** and throws. It retains the metadata and earlier rows, leaves `result` undefined, and does not report completion. Earlier bad rows may remain, so `reset()` can be necessary. For a failed first one-fragment message, this means `fragmentCount` can already be 1 while rank is 0.

`reset()` drops the solver, metadata, and result. There is no automatic timeout or transfer switching. A caller must reset to abandon a transfer or receive another message.

## Cashu conversion and encoding helpers

Cashu mapping lives outside the fountain framing:

```text
text:    "cashuB" + base64url(CBOR)
binary:  UTF8("crawB") || CBOR
```

`tokenToBytes(cashuB)` decodes the text's base64url suffix, prepends the five `crawB` bytes, and checks the resulting token through `bytesToToken`. It preserves the original CBOR bytes; it does not decode and reserialize the CBOR to make this conversion.

`tokenToBytes(tokenObject)` delegates to `getEncodedTokenBinary` in pinned `@cashu/cashu-ts@5.0.0-rc.4`, then checks the result through `bytesToToken`. A local compatibility fix removes the extra JSON layer that cashu-ts 5.0.0-rc.4 adds to already serialized witness strings, preserving their original text without changing scanned CBOR. Object conversion promises equivalent supported token contents, not byte-identical serialization. cashu-ts supplies `Amount` handling, defaults an absent unit to `sat`, and normalizes object witness metadata to serialized JSON. Full keyset IDs provided by objects are preserved; shortened IDs already present in input cannot be expanded without external information.

`bytesToToken` accepts `crawB` binary or UTF-8 `cashuB` bytes (the latter also occur in UR transfers). It normalizes text to binary, delegates binary decoding to cashu-ts, and separately decodes the CBOR payload to reject trailing data. Its explicit additional checks require a nonempty string mint and unit, at least one proof, a string memo if present, and string proof secrets. These are the current checks, not exhaustive semantic validation of every optional proof field or verification that proofs are spendable. It makes no mint calls.

`bytesToTokenString` accepts those same two representations, validates through `bytesToToken`, and returns `cashuB` plus unpadded base64url of the original CBOR. Valid padded text therefore returns in unpadded form. `cashuA` is unsupported.

The independent `encoding` entry point provides:

- `encodeCbor` / `decodeCbor`: delegate to `cborg`; decoding consumes exactly one item and rejects truncation or trailing bytes.
- `encodeBase64Url`: uses the URL-safe `-` and `_` alphabet and omits `=` padding.
- `decodeBase64Url`: accepts valid padded or unpadded URL-safe input, checks alphabet, length, padding placement, and zero pad bits by re-encoding. Empty input decodes to empty bytes. Whitespace and the standard `+` / `/` alphabet are rejected.

The core format itself does not require either CBOR or base64. It never tries to validate a Cashu token.

## Inbound UR compatibility

`UrDecoder` is a separate adapter with different framing and fragment selection. It shares the Gaussian solver, but our `NF` frames are not UR output. The package exposes no UR encoder; `@gandlaf21/bc-ur@1.1.12` is used only in development tests.

### Accepted representation

The adapter accepts complete `ur:bytes` strings. It lowercases input, so uppercase and mixed-case UR strings work. It does not trim whitespace. Only minimal Bytewords is decoded: each byte is represented by the first and last letters of its entry in the 256-word dictionary in [bytewords.ts](../src/internal/ur/bytewords.ts). The decoded suffix is a four-byte big-endian CRC32 over the preceding bytes. The minimal Bytewords body must contain an even number of characters, at least 10, with valid pairs and checksum.

Single-part form:

```text
ur:bytes/<minimal Bytewords of CBOR byte string plus Bytewords CRC>
```

The CBOR value must be a byte string. Its contents become the result. An active multipart session refuses a single-part message until reset.

Multipart form:

```text
ur:bytes/<sequence>-<count>/<minimal Bytewords of CBOR part plus Bytewords CRC>
CBOR part = [sequence, count, wrappedMessageLength, messageCRC, fragmentBytes]
```

The array must have exactly five elements. Sequence, count, length, and checksum must be unsigned 32-bit integer numbers; sequence, count, and length must be nonzero. The URI sequence/count spelling must exactly match the CBOR values in ordinary decimal, with no leading zeros. Fragment bytes must be a nonempty byte string, with `count == ceil(wrappedMessageLength / fragmentBytes.length)`.

Here the reconstructed message is itself a CBOR byte string, so UR's length and message CRC refer to that wrapper **including the CBOR header**. On completion the adapter checks the reconstructed message CRC, decodes its CBOR, requires a byte string, and exposes the unwrapped payload. Unlike the binary reader, it does not separately require the discarded padding bytes to be zero.

The Cashu helpers support two unwrapped payload conventions: UTF-8 `cashuB` text and `crawB` binary. `UrDecoder` itself also accepts arbitrary non-Cashu payload bytes; interpreting them is the caller's responsibility. This describes tested conventions rather than a claim about every wallet's UR payload.

### UR fragment selection

Sequences `1..count` select their individual source fragments. Later sequences use the implementation in [fragments.ts](../src/internal/ur/fragments.ts):

1. Concatenate sequence and message CRC as two big-endian uint32 values; SHA-256 those eight bytes.
2. Read the digest as four big-endian uint64 state words for Xoshiro256**. State arithmetic uses native `BigInt` modulo 2^64; each output is converted to a JavaScript number and divided by `2 ** 64`.
3. Choose the number of fragments (the degree) with a Walker-Vose alias table whose weights are `1, 1/2, ..., 1/count`. Table construction order and IEEE-754 arithmetic order matter for compatibility. The implementation initializes the small/large lists by scanning indexes in descending order and pops from their ends. Degree selection consumes two random outputs: one for the column, then one for its probability/alias decision.
4. Starting with indexes `0..count-1`, repeatedly remove the element at `floor(random() * remaining.length)` until the selected degree is reached. Set the corresponding coefficients to 1. A Fisher-Yates shuffle is not interchangeable with this removal procedure.

Unlike our binary algorithm, UR's repair selections depend on the message checksum as well as sequence and count. The exact local arithmetic and Bytewords dictionary are in the linked source files; this compatibility adapter does not redefine UR as part of the new binary format.

### UR limits and state behavior

| Limit                                                    | Value              |
| -------------------------------------------------------- | ------------------ |
| Wrapped message size                                     | 1,048,576 bytes    |
| Source fragments                                         | 1024               |
| Complete input string                                    | 131,072 characters |
| Accepted distinct multipart sequence numbers per session | 8192               |
| Cumulative accepted multipart fragment bytes per session | 16,777,216 bytes   |

The character bound also limits single-part input. There is no separate 4096-byte fragment-size bound in this adapter. Dependent but newly accepted multipart sequences count toward the session's part/byte limits, even though they do not increase rank.

The active multipart identity is `(count, wrappedMessageLength, messageCRC, fragmentSize)`. Invalid, foreign, duplicate-sequence, over-limit, and post-completion input returns `false`. A newly accepted part returns `true`, even if its equation is dependent. Invalid individual parts ordinarily leave the session intact. A bad reconstructed checksum, malformed reconstructed CBOR, or reconstructed value that is not a byte string resets the whole UR session and returns `false`.

`progress` is rank/count for multipart UR, including fragments of the CBOR wrapper. Single-part success reports rank 1/count 1. Failed reconstruction resets progress to zero. Results are copied on access, and `reset()` clears every session field and counter.

## Automatic format routing

`AutoDecoder.receive(input)` accepts a `Uint8Array` or string:

| Input prefix                                       | Action                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| Byte input starting `4e 46` (`NF`)                 | Delegate to `FountainDecoder`; it validates version and flags.        |
| String starting `ur:` (case-insensitive)           | Delegate to `UrDecoder`.                                              |
| Byte input starting ASCII `ur:` (case-insensitive) | Decode the whole input as strict UTF-8, then delegate to `UrDecoder`. |
| Other prefix                                       | Return `false`.                                                       |
| Other input type                                   | Throw `TypeError`.                                                    |

Binary fountain frames never pass through a text decoder. Bare Cashu tokens, base64-wrapped fountain frames, and a string beginning `NF` are not routed as binary input.

The first call that returns accepted/`true` retains its decoder and selects `format`, either `'binary'` or `'ur'`. Before that, `format` is undefined. A recognized different format throws once selection has occurred, even if the new input would later fail that format's validation. Unknown prefixes still return `false`.

The router delegates scoped return values and errors: binary validation errors throw, UR text rejection returns `false`, and invalid UTF-8 in UR byte input throws. Count `progress`, not `true` returns, because UR accepts dependent parts. If a selected UR reader resets internally after failed reconstruction, the router remains selected as `'ur'`; `AutoDecoder.reset()` is needed to clear format selection. That reset also clears the retained reader and all exposed progress/result state.

## Using the public API

This local example sends all systematic frames without loss:

```ts
import { FountainEncoder, FountainDecoder } from '@cashu/coco-fountain/core';

const message = Uint8Array.of(0x10, 0x20, 0x30, 0x40);
const sender = new FountainEncoder(message, { fragmentSize: 1 });
const reader = new FountainDecoder();
for (let i = 0; i < sender.fragmentCount; i++) {
  reader.receive(sender.nextFrame());
}
if (!reader.isComplete) throw new Error('Transfer incomplete');
const recovered = reader.result!; // 10 20 30 40, as bytes
```

For Cashu, pass `tokenToBytes(token)` as the message and use `bytesToTokenString(reader.result!)` or `bytesToToken(reader.result!)` afterward. For a scanner that should accept existing UR as well, use `AutoDecoder` instead of `FountainDecoder`. In a real transfer, the sender generates frames independently while scanner callbacks feed received frames to the reader.

| Entry point                     | Exports                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `@cashu/coco-fountain/core`     | `FountainEncoder`, `FountainDecoder`                               |
| `@cashu/coco-fountain/cashu`    | `tokenToBytes`, `bytesToToken`, `bytesToTokenString`, type `Token` |
| `@cashu/coco-fountain/ur`       | `UrDecoder`                                                        |
| `@cashu/coco-fountain/auto`     | `AutoDecoder`, type `DecoderFormat`                                |
| `@cashu/coco-fountain/encoding` | CBOR and base64url helpers                                         |
| `@cashu/coco-fountain`          | All the above                                                      |

The core can be imported without Cashu or UR dependencies. The library supports browser bundlers without a global Node `Buffer` or `process`; the UR implementation requires native `BigInt` support.

## Costs, limits, and transport responsibilities

The 4096-byte fragment, 1024-fragment, and independent 1,048,576-byte message limits are part of the [current version-1 profile](protocol.md#2-version-1-bounds-and-fragmentation) and are enforced by the library. They originated as resource bounds, but the wire fields' larger capacity does not extend the supported profile. Earlier version-1 readers enforce a 256-fragment limit and reject larger transfers. The 128-byte default, allocation strategy, solver, and progress API are implementation choices. UR's separate limits are local compatibility-adapter limits and do not apply to the binary profile.

The library currently exposes the following settings and derived limits:

| Setting                           | Value                                                    |
| --------------------------------- | -------------------------------------------------------- |
| Default fragment size             | 128 bytes                                                |
| Allowed fragment size             | 1–4096 bytes                                             |
| Source fragment count             | 1–1024                                                   |
| Largest message with default size | 131,072 bytes                                            |
| Largest message overall           | 1,048,576 bytes, using fragment sizes of 1024–4096 bytes |
| Per-frame overhead                | 24 bytes                                                 |
| Last sequence                     | 4,294,967,295                                            |

For lossless systematic transmission, total emitted bytes are `N * (S + 24)`. Relative to `L` original bytes, the extra bytes are `N*S - L` padding plus `24*N` framing. For `L = 1000`, `S = 128`, this is 1216 bytes: **21.6%** extra transport bytes. This calculation excludes QR overhead and all extra repair frames; it is not an efficiency comparison with UR.

Increasing S reduces the number of source fragments and per-payload framing overhead, but makes individual frames larger for the transport. Increasing N increases computational work. In this implementation, a dense repair frame takes O(N*S) byte work to construct. A decoder insertion can take O(N*(N+S)) work, and the stored row data occupies O(N*(N+S)) bytes plus object/map overhead. Recovery takes O(N²*S) work in the worst case. These are implementation-based upper bounds, not measured device performance claims.

The sender has no receiver feedback, rate negotiation, timeout, retransmission request, or completion signal. Applications decide frame rate, when to stop sending, and when to reset a reader. One call to `receive` consumes one complete frame; a stream transport must preserve or supply frame boundaries. Frame length is used to infer S, so concatenated frames cannot simply be passed as one input.

QR byte mode can carry these binary frames directly. Rendering and scanning are outside the protocol. QR error correction repairs damage inside an individual QR symbol; fountain repair frames address whole missing frames. A scanner must preserve raw bytes rather than force binary frames through UTF-8 or base64. This binary format has no claim of universal compatibility with existing wallets.

## Implementation map and verification

| Implementation detail                  | Source                                            | Existing checks                                                                                                                  |
| -------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Encoder, decoder, progress, reset      | [core.ts](../src/core.ts)                         | [core.test.ts](../test/unit/core.test.ts)                                                                                        |
| Wire layout, parser, limits            | [wire.ts](../src/internal/core/wire.ts)           | Core wire-vector, corruption, bounds, and ownership checks                                                                       |
| Binary coefficients                    | [equations.ts](../src/internal/core/equations.ts) | Core loss and repair-only recovery checks                                                                                        |
| Shared elimination / back-substitution | [fountain.ts](../src/internal/fountain.ts)        | Core and UR reconstruction checks                                                                                                |
| CRC32                                  | [crc32.ts](../src/internal/crc32.ts)              | Independent binary wire vector and UR fixtures                                                                                   |
| Cashu mapping                          | [cashu.ts](../src/cashu.ts)                       | [cashu.test.ts](../test/unit/cashu.test.ts)                                                                                      |
| Encoding helpers                       | [encoding.ts](../src/encoding.ts)                 | [encoding.test.ts](../test/unit/encoding.test.ts)                                                                                |
| UR parsing and state                   | [ur.ts](../src/ur.ts)                             | [ur.test.ts](../test/unit/ur.test.ts)                                                                                            |
| UR selection and Bytewords             | [UR internals](../src/internal/ur)                | [ur-vectors.test.ts](../test/unit/ur-vectors.test.ts), including independent URKit fixtures and reference-encoder repair streams |
| Automatic routing                      | [auto.ts](../src/auto.ts)                         | [auto.test.ts](../test/unit/auto.test.ts)                                                                                        |

Run the package's existing checks from the repository root:

```sh
bun run --cwd standalone/fountain test
bun run --cwd standalone/fountain typecheck
bun run --cwd standalone/fountain test:browser
```

The browser command requires Playwright's Chromium installation. See the [validation record](validation.md) for the broader project test setup. No finite test suite proves every input correct. Wire changes should update the specification and its independent vectors; API or solver changes should update this guide without redefining the wire format.

Protocol background and attribution: [Cashu binary tokens](https://github.com/cashubtc/nuts/blob/main/00.md#binary-token), [NUT-16](https://github.com/cashubtc/nuts/blob/main/16.md), [UR multipart specification](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2024-001-multipart-ur.md), and [third-party notices](../NOTICE.md). The behavior described above was checked against this repository's implementation and tests.
