import { expect, test } from 'bun:test';
import { AutoDecoder } from '@cashu/coco-fountain/auto';
import { FountainDecoder, FountainEncoder } from '@cashu/coco-fountain/core';
import { UrDecoder } from '@cashu/coco-fountain/ur';
import * as root from '@cashu/coco-fountain';
import { Buffer } from 'buffer';
import { UR, UREncoder } from '@gandlaf21/bc-ur/dist/lib/es6/index.js';

const bytes = new TextEncoder();
const reference = (payload: Uint8Array, size = 4096) =>
  new UREncoder(UR.fromBuffer(Buffer.from(payload)), size);

test('root and subpath exports expose the same automatic and scoped decoders', () => {
  expect(root.AutoDecoder).toBe(AutoDecoder);
  expect(root.FountainDecoder).toBe(FountainDecoder);
  expect(root.UrDecoder).toBe(UrDecoder);
  expect(() => new FountainDecoder().receive('ur:bytes/zz' as unknown as Uint8Array)).toThrow();
  expect(new UrDecoder().receive(new Uint8Array() as unknown as string)).toBe(false);
});

test('automatic binary decoding preserves arbitrary bytes, progress and defensive results', () => {
  const payload = Uint8Array.from({ length: 256 }, (_, i) => i);
  const encoder = new FountainEncoder(payload, { fragmentSize: 64 });
  const decoder = new AutoDecoder();
  expect(decoder.format).toBeUndefined();
  expect(decoder.fragmentCount).toBeUndefined();
  expect(decoder.progress).toBe(0);
  const first = Buffer.from(encoder.nextFrame());
  decoder.receive(first);
  expect(decoder.format).toBe('binary');
  expect(decoder.fragmentCount).toBe(4);
  expect(decoder.progress).toBe(0.25);
  expect(decoder.receive(first)).toBe(false);
  first.fill(0);
  for (let i = 1; i < 4; i++) decoder.receive(encoder.nextFrame());
  expect(decoder.independentFrames).toBe(4);
  expect(decoder.isComplete).toBe(true);
  expect(decoder.progress).toBe(1);
  expect(decoder.result).toEqual(payload);
  decoder.result!.fill(0);
  expect(decoder.result).toEqual(payload);
});

test('automatic UR decoding accepts mixed text and QR bytes with repair loss and duplicates', () => {
  const payload = bytes.encode('cashuB' + 'a'.repeat(200));
  const encoder = reference(payload, 40);
  for (let i = 0; i < encoder.fragmentsLength; i++) encoder.nextPart();
  const parts = Array.from({ length: 120 }, () => encoder.nextPart())
    .filter((_, i) => i % 3 !== 0)
    .reverse();
  const decoder = new AutoDecoder();
  for (let i = 0; i < parts.length && !decoder.isComplete; i++) {
    const part = parts[i]!.toUpperCase();
    decoder.receive(i % 2 ? part : bytes.encode(part));
    const progress = decoder.progress;
    expect(decoder.receive(part)).toBe(false);
    expect(decoder.progress).toBe(progress);
  }
  expect(decoder.format).toBe('ur');
  expect(decoder.fragmentCount).toBe(encoder.fragmentsLength);
  expect(decoder.progress).toBe(1);
  expect(decoder.result).toEqual(payload);
});

test('rejected initial input never selects a format or poisons the next valid transfer', () => {
  const decoder = new AutoDecoder();
  for (const input of [
    'cashuBnot-framed',
    'ur:bytes/zz',
    'UR:CRYPTO-SEED/aa',
    new Uint8Array(),
    bytes.encode('ur:bytes/zz'),
  ]) {
    expect(decoder.receive(input)).toBe(false);
    expect(decoder.format).toBeUndefined();
  }
  for (const input of [
    Uint8Array.of(0x4e, 0x46),
    Uint8Array.of(0x75, 0x72, 0x3a, 0xff),
    null,
    {},
  ]) {
    expect(() => decoder.receive(input as Uint8Array)).toThrow();
    expect(decoder.format).toBeUndefined();
    expect(decoder.progress).toBe(0);
  }
  // Valid frame CRC but incorrect reconstructed-message checksum.
  const bad = Uint8Array.from(
    '4e46010000000001000000010000000355bc801d0102043dd7ca8e'.match(/../g)!,
    (hex) => parseInt(hex, 16),
  );
  expect(() => decoder.receive(bad)).toThrow(/checksum/);
  expect(decoder.format).toBeUndefined();
  const payload = Uint8Array.of(0, 255);
  decoder.receive(reference(payload).nextPart());
  expect(decoder.format).toBe('ur');
  expect(decoder.result).toEqual(payload);
});

test('reset clears format and progress and permits switching in both directions', () => {
  const decoder = new AutoDecoder();
  const payload = Uint8Array.of(1, 2, 3, 4);
  const encoder = new FountainEncoder(payload, { fragmentSize: 2 });
  const first = encoder.nextFrame();
  const ur = reference(payload).nextPart();
  decoder.receive(first);
  expect(() => decoder.receive(ur)).toThrow(/reset/);
  expect(() => decoder.receive(new FountainEncoder(Uint8Array.of(9)).nextFrame())).toThrow(
    /another message/,
  );
  expect(decoder.progress).toBe(0.5);
  decoder.reset();
  expect(decoder.format).toBeUndefined();
  expect(decoder.fragmentCount).toBeUndefined();
  expect(decoder.independentFrames).toBe(0);
  expect(decoder.progress).toBe(0);
  expect(decoder.result).toBeUndefined();
  expect(decoder.isComplete).toBe(false);
  decoder.receive(ur);
  expect(decoder.receive(ur)).toBe(false);
  expect(() => decoder.receive(first)).toThrow(/reset/);
  decoder.reset();
  decoder.receive(first);
  decoder.receive(encoder.nextFrame());
  expect(decoder.result).toEqual(payload);
});

test('failed UR reconstruction clears progress while format remains selected until reset', () => {
  const encoder = new UREncoder(new UR(Buffer.alloc(200, 0xff)), 40);
  const decoder = new AutoDecoder();
  for (let i = 0; i < encoder.fragmentsLength; i++) decoder.receive(encoder.nextPart());
  expect(decoder.format).toBe('ur');
  expect(decoder.isComplete).toBe(false);
  expect(decoder.progress).toBe(0);
  expect(decoder.fragmentCount).toBeUndefined();
  const frame = new FountainEncoder(Uint8Array.of(1)).nextFrame();
  expect(() => decoder.receive(frame)).toThrow(/reset/);
  decoder.reset();
  decoder.receive(frame);
  expect(decoder.result).toEqual(Uint8Array.of(1));
});
