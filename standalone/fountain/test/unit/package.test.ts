import { expect, test } from 'bun:test';
import { FountainDecoder, FountainEncoder } from '@cashu/coco-fountain/core';

test('built byte entry point reconstructs an arbitrary message', () => {
  const message = Uint8Array.of(0, 255, 12, 128, 3);
  const encoder = new FountainEncoder(message, { fragmentSize: 2 });
  const decoder = new FountainDecoder();
  for (let i = 0; i < encoder.fragmentCount; i++) decoder.receive(encoder.nextFrame());
  expect(decoder.result).toEqual(message);
});
