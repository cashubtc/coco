import { expect, test } from 'bun:test';
import { Buffer } from 'buffer';
import { UR, UREncoder } from '@gandlaf21/bc-ur/dist/lib/es6/index.js';
import { UrDecoder } from '../../src/ur.ts';
import vectors from './fixtures/urkit.json';

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));

test('decodes the published URKit single-part vector', () => {
  const reader = new UrDecoder();
  expect(reader.receive(vectors.single)).toBe(true);
  expect(reader.result).toEqual(fromHex(vectors.singlePayloadHex));
});

test('recovers the published URKit multipart vector with loss and mixed frames', () => {
  const reader = new UrDecoder();
  // The published repair subset is not full rank on its own, in either reader.
  reader.receive(vectors.parts[3]!);
  reader.receive(vectors.parts[4]!);
  for (const part of vectors.parts.slice(9).reverse()) reader.receive(part);
  expect(reader.result).toEqual(fromHex(vectors.payloadHex));
});

describeReferenceTransfers();

function describeReferenceTransfers() {
  for (const length of [0, 1, 31, 255, 1024, 4096]) {
    for (const fragmentSize of [17, 63, 128]) {
      for (const start of [0, 0x7fffffff, 0xfffff000]) {
        test(`reference repair recovery: ${length} bytes, ${fragmentSize} fragment bytes, sequence ${start}`, () => {
          const payload = Uint8Array.from({ length }, (_, i) => (i * 37 + length) % 256);
          const reference = new UREncoder(UR.fromBuffer(Buffer.from(payload)), fragmentSize, start);
          const reader = new UrDecoder();
          // Start after systematic transmission; discard every third repair part,
          // reverse each batch, and repeat parts to mimic a scanning receiver.
          if (start === 0 && reference.fragmentsLength > 1) {
            for (let i = 0; i < reference.fragmentsLength; i++) reference.nextPart();
          }
          let completed = false;
          for (let batch = 0; batch < reference.fragmentsLength * 2 + 20 && !completed; batch++) {
            const parts = Array.from({ length: 6 }, () => reference.nextPart())
              .filter((_, i) => i % 3 !== 0)
              .reverse();
            for (const part of parts) {
              reader.receive(part);
              reader.receive(part.toUpperCase());
              if (reader.isComplete) {
                completed = true;
                break;
              }
            }
          }
          expect(
            reader.result,
            `length=${length}, fragment=${fragmentSize}, start=${start}`,
          ).toEqual(payload);
        });
      }
    }
  }
}
