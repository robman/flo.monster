/**
 * Binary viewport frame protocol — Node.js encode/decode utilities.
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
 * Encode a viewport frame: 9-byte header + JPEG data.
 */
export function encodeFrame(
  frameNum: number,
  width: number,
  height: number,
  quality: number,
  jpegData: Buffer,
): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_SIZE);
  header.writeUInt32BE(frameNum, 0);
  header.writeUInt16BE(width, 4);
  header.writeUInt16BE(height, 6);
  header.writeUInt8(quality, 8);

  return Buffer.concat([header, jpegData]);
}

/**
 * Decode the header from a binary viewport frame.
 */
export function decodeFrameHeader(buffer: Buffer): FrameHeader {
  if (buffer.length < FRAME_HEADER_SIZE) {
    throw new Error(`Frame too small: ${buffer.length} bytes (need at least ${FRAME_HEADER_SIZE})`);
  }

  return {
    frameNum: buffer.readUInt32BE(0),
    width: buffer.readUInt16BE(4),
    height: buffer.readUInt16BE(6),
    quality: buffer.readUInt8(8),
    dataOffset: FRAME_HEADER_SIZE,
  };
}

/**
 * Decode an ack message (4-byte frame number).
 */
export function decodeAck(buffer: Buffer): number {
  if (buffer.length < ACK_SIZE) {
    throw new Error(`Ack too small: ${buffer.length} bytes (need ${ACK_SIZE})`);
  }
  return buffer.readUInt32BE(0);
}
