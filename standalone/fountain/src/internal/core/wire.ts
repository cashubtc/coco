import { crc32 } from '../crc32.js';

export const MAX_FRAGMENT_SIZE = 4096;
export const MAX_FRAGMENTS = 1024;
export const MAX_MESSAGE_LENGTH = 1_048_576;
const PREFIX = Uint8Array.of(0x4e, 0x46, 1, 0);
const SEQUENCE_OFFSET = 4;
const COUNT_OFFSET = 8;
const LENGTH_OFFSET = 12;
const CHECKSUM_OFFSET = 16;
const DATA_OFFSET = 20;
const CRC_SIZE = 4;
const OVERHEAD = DATA_OFFSET + CRC_SIZE;

export type Metadata = { count: number; length: number; size: number; checksum: number };

type Frame = Metadata & { sequence: number; data: Uint8Array };

export function serializeFrame({
  sequence,
  count,
  length,
  checksum,
  data,
}: Omit<Frame, 'size'>): Uint8Array {
  const frame = new Uint8Array(OVERHEAD + data.length);
  frame.set(PREFIX);
  const view = new DataView(frame.buffer);
  view.setUint32(SEQUENCE_OFFSET, sequence);
  view.setUint32(COUNT_OFFSET, count);
  view.setUint32(LENGTH_OFFSET, length);
  view.setUint32(CHECKSUM_OFFSET, checksum);
  frame.set(data, DATA_OFFSET);
  view.setUint32(frame.length - CRC_SIZE, crc32(frame.subarray(0, -CRC_SIZE)));
  return frame;
}

export function parseFrame(frame: Uint8Array): Frame {
  if (!(frame instanceof Uint8Array)) throw new TypeError('Frame must be a Uint8Array');
  if (frame.length <= OVERHEAD || frame.length > OVERHEAD + MAX_FRAGMENT_SIZE) {
    throw new Error('Invalid fountain frame size');
  }
  if (PREFIX.some((byte, index) => frame[index] !== byte)) {
    throw new Error('Unsupported fountain frame format, version, or flags');
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const sequence = view.getUint32(SEQUENCE_OFFSET);
  const count = view.getUint32(COUNT_OFFSET);
  const length = view.getUint32(LENGTH_OFFSET);
  const checksum = view.getUint32(CHECKSUM_OFFSET);
  const size = frame.length - OVERHEAD;
  if (
    sequence === 0 ||
    count < 1 ||
    count > MAX_FRAGMENTS ||
    length > MAX_MESSAGE_LENGTH ||
    count !== Math.max(1, Math.ceil(length / size))
  ) {
    throw new Error('Invalid fountain frame metadata');
  }
  if (crc32(frame.subarray(0, -CRC_SIZE)) !== view.getUint32(frame.length - CRC_SIZE)) {
    throw new Error('Fountain frame checksum mismatch');
  }
  return {
    sequence,
    count,
    length,
    size,
    checksum,
    data: new Uint8Array(frame.subarray(DATA_OFFSET, -CRC_SIZE)),
  };
}
