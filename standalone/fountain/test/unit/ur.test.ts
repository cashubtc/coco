import { describe, expect, test } from 'bun:test';
import { Buffer } from 'buffer';
import { UR, UREncoder } from '@gandlaf21/bc-ur/dist/lib/es6/index.js';
import { decode, encode } from 'cborg';
import bytewords from '@gandlaf21/bc-ur/dist/lib/es6/bytewords.js';
import { UrDecoder } from '../../src/ur.ts';

describe('existing UR input', () => {
  test('rejects malformed parts during an active transfer without discarding good data', () => {
    const payload = Uint8Array.from({ length: 200 }, (_, i) => i);
    const reference = new UREncoder(UR.fromBuffer(Buffer.from(payload)), 40);
    const parts = Array.from({ length: reference.fragmentsLength }, () => reference.nextPart());
    const reader = new UrDecoder();
    expect(reader.receive(parts[0]!)).toBe(true);
    const second = parts[1]!;
    const invalid = [
      second + 'a',
      second + '/aa',
      second.replace('/2-', '/1-'),
      second.replace('/2-', '/02-'),
      second.replace('ur:bytes/', 'ur:crypto-seed/'),
      'ur:bytes/zz',
    ];
    for (const part of invalid) expect(reader.receive(part)).toBe(false);
    for (const part of parts.slice(1)) reader.receive(part);
    expect(reader.result).toEqual(payload);
  });

  test('supports UR transfers with more than 256 source fragments', () => {
    const payload = Uint8Array.from({ length: 4096 }, (_, i) => i % 256);
    const reference = new UREncoder(UR.fromBuffer(Buffer.from(payload)), 10);
    expect(reference.fragmentsLength).toBeGreaterThan(256);
    const reader = new UrDecoder();
    for (let i = 0; i < reference.fragmentsLength; i++) {
      const part = reference.nextPart();
      if (i !== 0) reader.receive(part);
    }
    for (let i = 0; i < 100 && !reader.isComplete; i++) reader.receive(reference.nextPart());
    expect(reader.result).toEqual(payload);
  });

  test('unwraps a complete uppercase single-part UR into exact payload bytes', () => {
    const payload = new TextEncoder().encode('cashuBexample');
    const encoder = new UREncoder(UR.fromBuffer(Buffer.from(payload)), 100);
    const reader = new UrDecoder();
    expect(reader.isComplete).toBe(false);
    expect(reader.result).toBeUndefined();
    expect(reader.receive(encoder.nextPart().toUpperCase())).toBe(true);
    expect(reader.isComplete).toBe(true);
    expect(reader.result).toEqual(payload);
  });

  test('recovers multipart binary input with loss, reordering and duplicates, then resets', () => {
    const payload = new Uint8Array(500);
    payload.set(new TextEncoder().encode('crawB'));
    for (let i = 5; i < payload.length; i++) payload[i] = i % 251;
    const encoder = new UREncoder(UR.fromBuffer(Buffer.from(payload)), 40);
    const parts = Array.from({ length: 200 }, () => encoder.nextPart());
    const reader = new UrDecoder();
    const first = parts[25]!;
    expect(reader.receive(first)).toBe(true);
    expect(reader.receive(first.toUpperCase())).toBe(false);
    // Drop every systematic fragment and use only shuffled fountain mixtures.
    for (const part of parts.slice(30).reverse()) {
      reader.receive(part);
      if (reader.isComplete) break;
    }
    expect(reader.result).toEqual(payload);
    const result = reader.result!;
    result.fill(0);
    expect(reader.result).toEqual(payload);
    expect(reader.receive(parts[0]!)).toBe(false);
    reader.reset();
    expect(reader.isComplete).toBe(false);
    expect(reader.result).toBeUndefined();
    for (const part of parts) {
      reader.receive(part);
      if (reader.isComplete) break;
    }
    expect(reader.result).toEqual(payload);
  });

  test('rejects wrong types, damaged checksums and non-byte payloads without poisoning a session', () => {
    const payload = new TextEncoder().encode('cashuBvalid');
    const valid = new UREncoder(UR.fromBuffer(Buffer.from(payload))).nextPart();
    const notBytes = new UREncoder(new UR(Buffer.from(encode({ token: 'wrong' })))).nextPart();
    const reader = new UrDecoder();
    for (const invalid of [
      valid.replace('ur:bytes/', 'ur:crypto-seed/'),
      valid + 'aa',
      notBytes,
      'ur:bytes/',
      'https://example.com',
    ]) {
      expect(reader.receive(invalid)).toBe(false);
      expect(reader.isComplete).toBe(false);
    }
    expect(reader.receive(valid)).toBe(true);
    expect(reader.result).toEqual(payload);
  });

  test('bounds untrusted metadata before allocating fountain state', () => {
    const payload = new TextEncoder().encode('cashuBbounded');
    const valid = new UREncoder(UR.fromBuffer(Buffer.from(payload))).nextPart();
    const frames: unknown[][] = [
      [1, 1025, 1025, 0, new Uint8Array(1)],
      [1, 2, 1_048_577, 0, new Uint8Array(1)],
      [1, 2, 20, 0, new Uint8Array(1)],
      [1, 2, 20, 0, 'not bytes'],
      [1, 2, 20, -1, new Uint8Array(10)],
      [1.5, 2, 20, 0, new Uint8Array(10)],
    ];
    for (const fields of frames) {
      const frame = `ur:bytes/${fields[0]}-${fields[1]}/${bytewords.encode(Buffer.from(encode(fields)).toString('hex'))}`;
      const reader = new UrDecoder();
      expect(reader.receive(frame)).toBe(false);
      expect(reader.receive(valid)).toBe(true);
      expect(reader.result).toEqual(payload);
    }
    const reader = new UrDecoder();
    expect(reader.receive('ur:bytes/' + 'aa'.repeat(65_536))).toBe(false);
    expect(reader.receive(valid)).toBe(true);
  });

  test('recovers after a multipart message whose reconstructed CBOR is malformed', () => {
    const malformed = new UREncoder(new UR(Buffer.alloc(200, 0xff)), 40);
    const reader = new UrDecoder();
    for (let i = 0; i < malformed.fragmentsLength; i++) reader.receive(malformed.nextPart());
    expect(reader.isComplete).toBe(false);
    const payload = new TextEncoder().encode('cashuBrecovered');
    expect(reader.receive(new UREncoder(UR.fromBuffer(Buffer.from(payload))).nextPart())).toBe(
      true,
    );
    expect(reader.result).toEqual(payload);
  });

  test('rejects a bad message checksum and ignores a different active transfer', () => {
    const payload = new TextEncoder().encode('cashuB' + 'a'.repeat(200));
    const encoder = new UREncoder(UR.fromBuffer(Buffer.from(payload)), 40);
    const parts = Array.from({ length: encoder.fragmentsLength }, () => encoder.nextPart());
    const reader = new UrDecoder();
    expect(reader.receive(parts[0]!)).toBe(true);
    const foreign = new UREncoder(UR.fromBuffer(Buffer.from('cashuB' + 'b'.repeat(200))), 40);
    expect(reader.receive(foreign.nextPart())).toBe(false);
    for (const part of parts.slice(1)) reader.receive(part);
    expect(reader.result).toEqual(payload);

    reader.reset();
    for (const part of parts) {
      const components = part.split('/');
      const fields = decode(Buffer.from(bytewords.decode(components[2]!), 'hex')) as unknown[];
      fields[3] = ((fields[3] as number) ^ 1) >>> 0;
      const changed = bytewords.encode(Buffer.from(encode(fields)).toString('hex'));
      reader.receive(`${components[0]}/${components[1]}/${changed}`);
    }
    expect(reader.isComplete).toBe(false);
    expect(reader.progress).toBe(0);
    expect(reader.independentFrames).toBe(0);
    expect(reader.fragmentCount).toBeUndefined();
    for (const part of parts) reader.receive(part);
    expect(reader.result).toEqual(payload);
  });
});

test('UR progress counts independent equations and resets after completion', () => {
  const payload = Uint8Array.from({ length: 200 }, (_, i) => i);
  const reference = new UREncoder(UR.fromBuffer(Buffer.from(payload)), 40);
  const reader = new UrDecoder();
  expect(reader.fragmentCount).toBeUndefined();
  expect(reader.progress).toBe(0);
  const parts = Array.from({ length: reference.fragmentsLength }, () => reference.nextPart());
  reader.receive(parts[0]!);
  expect(reader.fragmentCount).toBe(parts.length);
  expect(reader.independentFrames).toBe(1);
  expect(reader.progress).toBe(1 / parts.length);
  reader.receive(parts[0]!);
  reader.receive('ur:bytes/zz');
  expect(reader.independentFrames).toBe(1);
  expect(reader.progress).toBe(1 / parts.length);
  for (const part of parts.slice(1)) reader.receive(part);
  expect(reader.progress).toBe(1);
  expect(reader.independentFrames).toBe(parts.length);
  reader.reset();
  expect(reader.progress).toBe(0);
  expect(reader.fragmentCount).toBeUndefined();
  expect(reader.independentFrames).toBe(0);
  reader.receive(new UREncoder(UR.fromBuffer(Buffer.from(payload)), 4096).nextPart());
  expect(reader.fragmentCount).toBe(1);
  expect(reader.independentFrames).toBe(1);
  expect(reader.progress).toBe(1);
});
