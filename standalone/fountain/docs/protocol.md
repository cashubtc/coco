# Binary fountain protocol specification — version 1

This experimental specification defines a binary fountain transport for a finite sequence of bytes. It specifies the bytes exchanged and the rules needed for independent implementations to interoperate. The format may evolve while the specification is being developed.

The words **must** and **must not** express requirements. Examples are informative. The [implementation guide](implementation.md) describes the current TypeScript library, its solver, APIs, Cashu helpers, and inbound UR support; those implementation choices are not additional protocol requirements.

## 1. Scope and notation

A sender divides one message into source fragments and transmits fountain frames. A frame contains either a source fragment or the bytewise XOR of several source fragments. Its sequence number determines the selection, so no coefficient list is transmitted.

The protocol treats message bytes as opaque. It does not define Cashu serialization, CBOR, base64, UR compatibility, QR encoding, camera scanning, or application APIs. The fountain format version is independent of any token version inside the message.

| Symbol | Meaning                                                |
| ------ | ------------------------------------------------------ |
| `M`    | Original message bytes.                                |
| `L`    | Length of M in bytes, before padding.                  |
| `S`    | Source fragment size in bytes.                         |
| `N`    | Source fragment count.                                 |
| `F[i]` | Source fragment at zero-based index i.                 |
| `q`    | Frame sequence number, starting at 1.                  |
| `c[i]` | Selection coefficient: 1 includes F[i], 0 excludes it. |
| `C`    | CRC32 of the original message.                         |
| `P`    | Encoded fragment payload, exactly S bytes.             |

Bytes are 8-bit unsigned values. All multibyte wire integers are unsigned and big-endian. Hexadecimal values have the prefix `0x` except in complete byte-string vectors. `XOR`, `OR`, and `AND` denote bitwise operations; `||` denotes byte concatenation. Array indexes start at zero.

## 2. Version-1 bounds and fragmentation

This draft defines the following version-1 interoperability bounds:

| Quantity                  | Allowed values                         |
| ------------------------- | -------------------------------------- |
| Fragment size S           | 1 through 4096 bytes                   |
| Source fragment count N   | 1 through 1024                         |
| Original message length L | 0 through 1,048,576 bytes              |
| Sequence number q         | 1 through 4,294,967,295 (`0xffffffff`) |

These are the supported bounds of this version-1 profile, not mathematical limits of fountain coding. The 32-bit count and length fields can represent larger values, but that does not make those values valid in this profile. Changing these bounds is a specification change, not merely a consequence of using a larger integer type. No default fragment size is prescribed.

This revision raises the source fragment limit from 256 to 1024 while retaining the 1,048,576-byte message limit, version byte, frame layout, and selection algorithm. Transfers with at most 256 source fragments remain compatible with earlier version-1 readers. Earlier readers reject transfers with 257 through 1024 source fragments; both endpoints must support the revised bound to use those transfers. The frame format provides no capability negotiation.

Given a message and selected fragment size, the sender must calculate:

```text
N = max(1, ceil(L / S))
```

The resulting L, S, and N must satisfy the bounds above. For `0 <= i < N` and `0 <= j < S`:

```text
F[i][j] = M[i*S + j]    if i*S + j < L
F[i][j] = 0            otherwise
```

Thus every source fragment is exactly S bytes, and any unused tail bytes are zero. The checksum `C = CRC32(M)` excludes padding. L, S, N, and C remain constant throughout a transfer.

Empty input has L = 0 and N = 1, with one all-zero source fragment and C = 0. It still produces a frame with S payload bytes.

The sender's sequence starts at 1 and increases by one for each newly generated frame. Sequence numbers must not wrap or exceed `0xffffffff`. Frames may be lost, repeated, or delivered out of order; a receiver must not require receipt of preceding sequences to interpret a frame.

## 3. Deterministic fragment selection

For `q <= N`, the frame selects only fragment `q - 1`. These first N frames are the systematic frames. Later frames are repair frames selected by the calculation below.

Define these arithmetic operations independently of any programming language:

- `U32(x) = x modulo 2^32`, yielding an integer from 0 through `2^32 - 1`.
- `ADD32(a, b) = U32(a + b)`.
- `MUL32(a, b) = U32(a * b)`; retain exactly the low 32 bits of the product.
- `SHR(a, k) = floor(a / 2^k)` for unsigned 32-bit a; this is a logical, zero-filling right shift.
- Bitwise operations act on 32-bit unsigned bit patterns.

The following pseudocode defines `SELECT(q, N)` exactly. Assignment uses `←`; loop ranges are inclusive.

```text
SELECT(q, N):
    c ← N zero bits
    if q <= N:
        c[q - 1] ← 1
        return c

    state ← q
    for i from 0 through N - 1:
        state ← ADD32(state, 0x6d2b79f5)
        a ← MUL32(state XOR SHR(state, 15), state OR 1)
        b ← MUL32(a XOR SHR(a, 7), a OR 61)
        a ← a XOR ADD32(a, b)
        c[i] ← (a XOR SHR(a, 14)) AND 1

    if every bit of c is zero:
        c[(q - 1) modulo N] ← 1
    return c
```

The state starts afresh with q for each frame. The message checksum does not seed this calculation. A receiver needs only q and N to reproduce the selection. Implementations must use these exact integer operations; a different pseudorandom generator, output bit, rounding rule, or fallback produces incompatible frames.

Given `c = SELECT(q, N)`, the payload is:

```text
P[j] = XOR of F[i][j] for all i where c[i] = 1
       for each j from 0 through S - 1
```

The fallback ensures at least one source fragment is included. P always contains S bytes, regardless of how many fragments are selected. No further encoding is applied to P within this protocol.

For example, the actual selections for N = 4 are:

| q   | c for fragments A, B, C, D | Payload             |
| --- | -------------------------- | ------------------- |
| 1   | `1000`                     | A                   |
| 2   | `0100`                     | B                   |
| 3   | `0010`                     | C                   |
| 4   | `0001`                     | D                   |
| 5   | `0101`                     | B XOR D             |
| 6   | `1011`                     | A XOR C XOR D       |
| 7   | `0010`                     | C                   |
| 8   | `1111`                     | A XOR B XOR C XOR D |

A repair frame can repeat a previous selection or add an equation that is dependent on previous equations. Receiving N frames does not necessarily provide enough independent information.

## 4. Frame layout

A complete fountain frame has exactly `24 + S` bytes:

| Offset | Size in bytes | Meaning                                     |
| ------ | ------------- | ------------------------------------------- |
| 0      | 2             | Magic `0x4e 0x46` (ASCII `NF`).             |
| 2      | 1             | Fountain format version `0x01`.             |
| 3      | 1             | Reserved flags `0x00`.                      |
| 4      | 4             | Sequence number q.                          |
| 8      | 4             | Source fragment count N.                    |
| 12     | 4             | Original message length L.                  |
| 16     | 4             | Original message checksum C.                |
| 20     | S             | Encoded fragment payload P.                 |
| 20 + S | 4             | Frame CRC32 over all preceding frame bytes. |

The payload size is inferred as `S = total frame length - 24`; it is not separately encoded. Valid total sizes range from 25 through 4120 bytes, subject to all other validation rules.

The underlying transport must preserve or supply complete frame boundaries. This format alone cannot delimit concatenated frames in an unframed byte stream. It contains no transfer UUID, coefficient bitmap, acknowledgment, or end-of-transfer marker.

## 5. Checksums

Both checksums use CRC-32/ISO-HDLC, with reflected polynomial `0xedb88320`, initial register `0xffffffff`, and final XOR `0xffffffff`. The following pseudocode fully defines the calculation; `SHR` has the unsigned meaning defined above.

```text
CRC32(bytes):
    crc ← 0xffffffff
    for each byte in bytes, in order:
        crc ← crc XOR byte
        repeat 8 times:
            if (crc AND 1) = 1:
                crc ← SHR(crc, 1) XOR 0xedb88320
            else:
                crc ← SHR(crc, 1)
    return crc XOR 0xffffffff
```

The returned integer is stored big-endian, despite the reflected arithmetic. CRC32 of empty bytes is `0x00000000`; CRC32 of the ASCII bytes `123456789` is `0xcbf43926`.

C covers exactly the original L message bytes. The frame CRC covers the 20-byte header and all S payload bytes, excluding only its own four-byte field.

## 6. Receiver requirements

Before accepting a frame as an equation, a receiver must validate:

1. The total length is between 25 and 4120 bytes.
2. Magic, format version, and flags equal `4e 46 01 00`.
3. q, N, L, and inferred S satisfy the version-1 bounds.
4. `N = max(1, ceil(L / S))`.
5. The frame CRC matches the header and payload.

An invalid frame must not contribute an equation to reconstruction. Error signaling, validation order, and API return values are implementation choices.

Frames combined into one reconstruction must have the same `(N, L, S, C)` tuple. A receiver must not combine differing tuples into one message. Whether it rejects other transfers, maintains separate sessions, or switches sessions is an application or implementation policy.

For an accepted frame, derive `c = SELECT(q, N)` and interpret the payload as the equation:

```text
P = XOR of F[i] for all i where c[i] = 1
```

The reconstruction method and equation storage representation are not specified. Gaussian elimination is one possible solver. With N independent equations over GF(2), the N source fragments are uniquely determined. Neither packet count nor distinct sequence count alone establishes independence.

Before reporting a successfully decoded message, a receiver must:

1. Recover the source fragments in their original index order.
2. Concatenate them and take the first L bytes as the candidate message.
3. Verify that its CRC32 equals C.
4. Verify that every remaining byte through the padded length N\*S is zero.

A failed checksum or padding check must not be reported as a successful decode. The specification does not prescribe which equations to retain after failure, how progress is exposed, or how sessions are reset.

## 7. Interoperability vectors

### Single source frame

For message hex `010203`, S = 3, N = 1, q = 1, and C = `0x55bc801d`, the complete frame is:

```text
4e46010000000001000000010000000355bc801d010203a3b35f2d
```

Its final four bytes are the frame CRC `0xa3b35f2d`.

### Mixed frames and reordered reception

For message hex `10203040`, S = 1, N = 4, and C = `0xe08ab900`, these complete frames are valid:

| q   | Payload hex | Complete frame hex                                   |
| --- | ----------- | ---------------------------------------------------- |
| 5   | `60`        | `4e460100000000050000000400000004e08ab900603bc78017` |
| 2   | `20`        | `4e460100000000020000000400000004e08ab9002028d66b47` |
| 6   | `60`        | `4e460100000000060000000400000004e08ab9006047a6a5cc` |
| 3   | `30`        | `4e460100000000030000000400000004e08ab90030a86e9a55` |

Together they provide four independent equations and reconstruct `10203040`. Repeating any one of these frames contributes no additional independent equation. The guide gives a [step-by-step decoding walkthrough](implementation.md#worked-transfer-frame-5-arrives-first).

## 8. Integrity and transport considerations

The checksums detect accidental corruption; they do not authenticate the sender or guarantee a cryptographically unique message identity. Different messages can collide in CRC32, and a sender can modify data and recompute the checksums. The `(N, L, S, C)` tuple is an accidental-mixup guard.

Receiving every systematic frame suffices to recover a valid transfer. Repair frames also permit recovery when source frames are missing, including joining after systematic transmission. There is no guaranteed completion time or received-frame count under arbitrary loss and redundancy.

Frame scheduling, stopping the sender, feedback, timeouts, and presentation of progress are outside this protocol. An application transporting sensitive contents must provide any required authentication or confidentiality separately.
