/**
 * Binary viewport frame protocol — shared decode utility.
 *
 * Frame format:
 *   [4 bytes] frameNum  (uint32 BE)
 *   [2 bytes] width     (uint16 BE)
 *   [2 bytes] height    (uint16 BE)
 *   [1 byte]  quality   (uint8)
 *   [rest]    JPEG data
 *
 * Ack format (client → server):
 *   [4 bytes] frameNum  (uint32 BE)
 */

/** Header size in bytes */
export const FRAME_HEADER_SIZE = 9;

/** Ack size in bytes */
export const ACK_SIZE = 4;

export interface FrameHeader {
  frameNum: number;
  width: number;
  height: number;
  quality: number;
  dataOffset: number;
}

/**
 * Decode the header from a binary viewport frame.
 * Works with ArrayBuffer (browser) or Buffer (Node.js).
 */
export function decodeFrameHeader(buffer: ArrayBuffer): FrameHeader {
  if (buffer.byteLength < FRAME_HEADER_SIZE) {
    throw new Error(`Frame too small: ${buffer.byteLength} bytes (need at least ${FRAME_HEADER_SIZE})`);
  }

  const view = new DataView(buffer);
  return {
    frameNum: view.getUint32(0, false),   // big-endian
    width: view.getUint16(4, false),
    height: view.getUint16(6, false),
    quality: view.getUint8(8),
    dataOffset: FRAME_HEADER_SIZE,
  };
}

/**
 * Encode an ack message (4-byte frame number, big-endian).
 */
export function encodeAck(frameNum: number): ArrayBuffer {
  const buf = new ArrayBuffer(ACK_SIZE);
  const view = new DataView(buf);
  view.setUint32(0, frameNum, false);  // big-endian
  return buf;
}
