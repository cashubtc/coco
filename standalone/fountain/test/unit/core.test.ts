import { expect, test } from 'bun:test';
import { Buffer } from 'buffer';
import { FountainDecoder, FountainEncoder } from '../../src/core.ts';
import { serializeFrame } from '../../src/internal/core/wire.ts';

test('changing a Buffer input after encoder construction preserves the original message', () => {
  const input = Buffer.from([1, 2, 3]);
  const encoder = new FountainEncoder(input, { fragmentSize: 3 });
  input.fill(0);
  const decoder = new FountainDecoder();
  decoder.receive(encoder.nextFrame());
  expect(decoder.result).toEqual(Uint8Array.of(1, 2, 3));
});

test("changing a received Buffer frame cannot alter the reader's stored message", () => {
  const encoder = new FountainEncoder(Uint8Array.of(1, 2, 3, 4), { fragmentSize: 2 });
  const firstFrame = Buffer.from(encoder.nextFrame());
  const decoder = new FountainDecoder();
  decoder.receive(firstFrame);
  firstFrame.fill(0);
  decoder.receive(Buffer.from(encoder.nextFrame()));
  expect(decoder.result).toEqual(Uint8Array.of(1, 2, 3, 4));
});

test("receiving dependent Buffer frames leaves the caller's bytes unchanged", () => {
  const encoder = new FountainEncoder(Uint8Array.of(1, 2, 3, 4), { fragmentSize: 2 });
  const firstFrame = Buffer.from(encoder.nextFrame());
  const duplicate = Buffer.from(firstFrame);
  const originalFrame = new Uint8Array(firstFrame);
  const decoder = new FountainDecoder();
  decoder.receive(firstFrame);
  expect(decoder.receive(duplicate)).toBe(false);
  expect(duplicate).toEqual(Buffer.from(originalFrame));
  expect(firstFrame).toEqual(Buffer.from(originalFrame));
  decoder.receive(encoder.nextFrame());
  expect(decoder.result).toEqual(Uint8Array.of(1, 2, 3, 4));
});

test('arbitrary bytes round-trip through fountain frames', () => {
  const message = Uint8Array.from([0, 255, 1, 128, 7, 0, 12]);
  const encoder = new FountainEncoder(message, { fragmentSize: 3 });
  const decoder = new FountainDecoder();
  expect(encoder.fragmentCount).toBe(3);
  expect(decoder.result).toBeUndefined();
  for (let i = 0; i < encoder.fragmentCount; i++) decoder.receive(encoder.nextFrame());
  expect(decoder.isComplete).toBe(true);
  expect(decoder.result).toEqual(message);
});

test('mixed repair frames recover lost source frames', () => {
  const message = Uint8Array.from({ length: 73 }, (_, i) => i * 13);
  const encoder = new FountainEncoder(message, { fragmentSize: 10 });
  const decoder = new FountainDecoder();
  for (let i = 0; i < encoder.fragmentCount; i++) {
    const frame = encoder.nextFrame();
    if (i !== 1 && i !== 4) decoder.receive(frame);
  }
  for (let i = 0; i < 100 && !decoder.isComplete; i++) decoder.receive(encoder.nextFrame());
  expect(decoder.result).toEqual(message);
});

test('malformed, unsupported, and damaged frames are rejected without poisoning the reader', () => {
  const message = Uint8Array.of(5, 0, 255);
  const frame = new FountainEncoder(message).nextFrame();
  const damaged = frame.slice();
  damaged[damaged.length - 5] = damaged[damaged.length - 5]! ^ 1;
  const unsupported = frame.slice();
  unsupported[2] = 2;
  const decoder = new FountainDecoder();
  for (const invalid of [new Uint8Array(), frame.slice(0, -1), damaged, unsupported]) {
    expect(() => decoder.receive(invalid)).toThrow();
    expect(decoder.isComplete).toBe(false);
  }
  decoder.receive(frame);
  expect(decoder.result).toEqual(message);
});

test('a reader rejects another message until reset, including after completion', () => {
  const first = new FountainEncoder(Uint8Array.of(1, 2), { fragmentSize: 1 });
  const second = new FountainEncoder(Uint8Array.of(3, 4), { fragmentSize: 1 });
  const otherFrame = second.nextFrame();
  const decoder = new FountainDecoder();
  decoder.receive(first.nextFrame());
  expect(() => decoder.receive(otherFrame)).toThrow();
  decoder.receive(first.nextFrame());
  expect(decoder.result).toEqual(Uint8Array.of(1, 2));
  expect(() => decoder.receive(otherFrame)).toThrow();
  decoder.reset();
  expect(decoder.result).toBeUndefined();
  expect(decoder.isComplete).toBe(false);
  decoder.receive(otherFrame);
  decoder.receive(second.nextFrame());
  expect(decoder.result).toEqual(Uint8Array.of(3, 4));
});

test('unsupported sizes and non-byte inputs fail before encoding', () => {
  for (const fragmentSize of [0, -1, 1.5, NaN, Infinity, 4097]) {
    expect(() => new FountainEncoder(Uint8Array.of(1), { fragmentSize })).toThrow();
  }
  expect(() => new FountainEncoder(new Uint8Array(1025), { fragmentSize: 1 })).toThrow(
    /1024 fragments/,
  );
  expect(() => new FountainEncoder(new Uint8Array(1048577), { fragmentSize: 4096 })).toThrow(
    /1048576 bytes/,
  );
  expect(() => new FountainEncoder([1, 2] as unknown as Uint8Array)).toThrow();
  expect(() => new FountainDecoder().receive([1, 2] as unknown as Uint8Array)).toThrow();
});

test('an empty byte message completes after one fountain frame', () => {
  const encoder = new FountainEncoder(new Uint8Array());
  const decoder = new FountainDecoder();
  expect(encoder.fragmentCount).toBe(1);
  expect(decoder.receive(encoder.nextFrame())).toBe(true);
  expect(decoder.isComplete).toBe(true);
  expect(decoder.result).toEqual(new Uint8Array());
});

test('reordered and duplicate frames recover bytes without exposing mutable state', () => {
  const original = Uint8Array.of(7, 0, 8, 255, 9);
  const input = original.slice();
  const encoder = new FountainEncoder(input, { fragmentSize: 2 });
  input.fill(0);
  const frames = Array.from({ length: encoder.fragmentCount }, () => encoder.nextFrame());
  const decoder = new FountainDecoder();
  expect(decoder.receive(frames[2]!)).toBe(true);
  expect(decoder.receive(frames[2]!)).toBe(false);
  decoder.receive(frames[0]!);
  frames[0]!.fill(0);
  decoder.receive(frames[1]!);
  expect(decoder.receive(frames[1]!)).toBe(false);
  expect(decoder.result).toEqual(original);
  decoder.result!.fill(0);
  expect(decoder.result).toEqual(original);
});

test.each([256, 1024])('repair frames alone recover %i source fragments', (count) => {
  const message = Uint8Array.from(
    { length: count * 128 - 7 },
    (_, i) => (i * 13 + (i >>> 8)) & 255,
  );
  const encoder = new FountainEncoder(message, { fragmentSize: 128 });
  const decoder = new FountainDecoder();
  for (let i = 0; i < encoder.fragmentCount; i++) encoder.nextFrame();
  for (let i = 0; i < count * 2 && !decoder.isComplete; i++) decoder.receive(encoder.nextFrame());
  expect(decoder.result).toEqual(message);
});

test.each([257, 1024])(
  'recovers %i source fragments with loss, reordering and duplicates',
  (count) => {
    const message = Uint8Array.from(
      { length: count * 128 - 7 },
      (_, i) => (i * 13 + (i >>> 8)) & 255,
    );
    const encoder = new FountainEncoder(message, { fragmentSize: 128 });
    expect(encoder.fragmentCount).toBe(count);
    const frames = Array.from({ length: count }, () => encoder.nextFrame());
    const decoder = new FountainDecoder();
    for (let i = count - 1; i >= 0; i--) {
      if (i % 3 === 0) continue;
      decoder.receive(frames[i]!);
    }
    const rank = decoder.independentFrames;
    expect(decoder.receive(frames[1]!)).toBe(false);
    expect(decoder.independentFrames).toBe(rank);
    expect(decoder.fragmentCount).toBe(count);
    for (let i = 0; i < count * 2 && !decoder.isComplete; i++) decoder.receive(encoder.nextFrame());
    expect(decoder.result).toEqual(message);
    expect(decoder.progress).toBe(1);
  },
);

test('the 1 MiB message limit is accepted with 1024 source fragments', () => {
  const message = Uint8Array.from({ length: 1_048_576 }, (_, i) => (i * 13 + (i >>> 8)) & 255);
  const encoder = new FountainEncoder(message, { fragmentSize: 1024 });
  expect(encoder.fragmentCount).toBe(1024);
  const decoder = new FountainDecoder();
  for (let i = 0; i < encoder.fragmentCount; i++) decoder.receive(encoder.nextFrame());
  expect(decoder.result).toEqual(message);
});

test('over-limit metadata with a valid frame CRC is rejected before establishing a transfer', () => {
  // Each frame has a consistent count/length/size tuple and exceeds only one bound.
  const frames = [
    serializeFrame({
      sequence: 1,
      count: 1025,
      length: 1025,
      checksum: 0,
      data: new Uint8Array(1),
    }),
    serializeFrame({
      sequence: 1,
      count: 257,
      length: 1_048_577,
      checksum: 0,
      data: new Uint8Array(4096),
    }),
  ];
  const decoder = new FountainDecoder();
  for (const frame of frames) {
    expect(() => decoder.receive(frame)).toThrow(/metadata/);
    expect(decoder.fragmentCount).toBeUndefined();
    expect(decoder.independentFrames).toBe(0);
  }
  decoder.receive(new FountainEncoder(Uint8Array.of(42)).nextFrame());
  expect(decoder.result).toEqual(Uint8Array.of(42));
});

test('the public encoder and reader match an independently calculated version-1 wire vector', () => {
  // Header encoded with Python struct.pack('>IIII', ...), CRCs with Python zlib.crc32.
  const frame = Uint8Array.from(
    '4e46010000000001000000010000000355bc801d010203a3b35f2d'.match(/../g)!,
    (hex) => parseInt(hex, 16),
  );
  const message = Uint8Array.of(1, 2, 3);
  expect(new FountainEncoder(message, { fragmentSize: 3 }).nextFrame()).toEqual(frame);
  const decoder = new FountainDecoder();
  decoder.receive(frame);
  expect(decoder.result).toEqual(message);
});

test('a valid frame checksum cannot bypass the reconstructed message checksum', () => {
  // Independent frame CRC is valid, but its payload is 01 02 04 instead of 01 02 03.
  const frame = Uint8Array.from(
    '4e46010000000001000000010000000355bc801d0102043dd7ca8e'.match(/../g)!,
    (hex) => parseInt(hex, 16),
  );
  const decoder = new FountainDecoder();
  expect(() => decoder.receive(frame)).toThrow(/message checksum/);
  expect(decoder.isComplete).toBe(false);
  expect(decoder.fragmentCount).toBe(1);
  expect(decoder.independentFrames).toBe(0);
  expect(decoder.progress).toBe(0);
  decoder.receive(new FountainEncoder(Uint8Array.of(1, 2, 3), { fragmentSize: 3 }).nextFrame());
  expect(decoder.result).toEqual(Uint8Array.of(1, 2, 3));
});

test('progress tracks independent information through loss, duplicates, rejection, completion and reset', () => {
  const encoder = new FountainEncoder(Uint8Array.of(1, 2, 3, 4), { fragmentSize: 1 });
  const frames = Array.from({ length: 4 }, () => encoder.nextFrame());
  const decoder = new FountainDecoder();
  expect(decoder.fragmentCount).toBeUndefined();
  expect(decoder.independentFrames).toBe(0);
  expect(decoder.progress).toBe(0);
  expect(() => decoder.receive(new Uint8Array())).toThrow();
  expect(decoder.fragmentCount).toBeUndefined();
  decoder.receive(frames[2]!);
  expect(decoder.fragmentCount).toBe(4);
  expect(decoder.independentFrames).toBe(1);
  expect(decoder.progress).toBe(0.25);
  decoder.receive(frames[0]!);
  expect(decoder.progress).toBe(0.5);
  decoder.receive(frames[2]!);
  const damaged = frames[1]!.slice();
  damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
  expect(() => decoder.receive(damaged)).toThrow();
  expect(() => decoder.receive(new FountainEncoder(Uint8Array.of(9)).nextFrame())).toThrow();
  expect(decoder.independentFrames).toBe(2);
  expect(decoder.progress).toBe(0.5);
  // The remaining two source frames are lost; use only repair frames from now on.
  let previous = decoder.progress;
  for (let i = 0; i < 100 && !decoder.isComplete; i++) {
    decoder.receive(encoder.nextFrame());
    expect(decoder.progress).toBeGreaterThanOrEqual(previous);
    expect(decoder.progress).toBe(decoder.independentFrames / 4);
    expect(decoder.progress === 1).toBe(decoder.isComplete);
    previous = decoder.progress;
  }
  expect(decoder.result).toEqual(Uint8Array.of(1, 2, 3, 4));
  expect(decoder.independentFrames).toBe(4);
  expect(decoder.progress).toBe(1);
  decoder.receive(frames[0]!);
  expect(decoder.progress).toBe(1);
  decoder.reset();
  expect(decoder.fragmentCount).toBeUndefined();
  expect(decoder.independentFrames).toBe(0);
  expect(decoder.progress).toBe(0);
  decoder.receive(new FountainEncoder(new Uint8Array()).nextFrame());
  expect(decoder.fragmentCount).toBe(1);
  expect(decoder.independentFrames).toBe(1);
  expect(decoder.progress).toBe(1);
});
