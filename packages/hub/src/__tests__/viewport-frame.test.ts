import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrameHeader, decodeAck, FRAME_HEADER_SIZE, ACK_SIZE } from '../utils/viewport-frame.js';

describe('viewport-frame', () => {
  describe('encodeFrame / decodeFrameHeader', () => {
    it('should round-trip frame header correctly', () => {
      const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]); // minimal JPEG header
      const frame = encodeFrame(42, 1280, 720, 60, jpeg);

      expect(frame.length).toBe(FRAME_HEADER_SIZE + jpeg.length);

      const header = decodeFrameHeader(frame);
      expect(header.frameNum).toBe(42);
      expect(header.width).toBe(1280);
      expect(header.height).toBe(720);
      expect(header.quality).toBe(60);
      expect(header.dataOffset).toBe(FRAME_HEADER_SIZE);

      // Verify JPEG data follows header
      const jpegSlice = frame.subarray(header.dataOffset);
      expect(jpegSlice).toEqual(jpeg);
    });

    it('should handle max values', () => {
      const jpeg = Buffer.from([0xFF]);
      const frame = encodeFrame(0xFFFFFFFF, 65535, 65535, 255, jpeg);

      const header = decodeFrameHeader(frame);
      expect(header.frameNum).toBe(0xFFFFFFFF);
      expect(header.width).toBe(65535);
      expect(header.height).toBe(65535);
      expect(header.quality).toBe(255);
    });

    it('should handle zero values', () => {
      const jpeg = Buffer.alloc(0);
      const frame = encodeFrame(0, 0, 0, 0, jpeg);

      const header = decodeFrameHeader(frame);
      expect(header.frameNum).toBe(0);
      expect(header.width).toBe(0);
      expect(header.height).toBe(0);
      expect(header.quality).toBe(0);
      expect(frame.length).toBe(FRAME_HEADER_SIZE);
    });

    it('should throw on too-small buffer', () => {
      const buf = Buffer.alloc(5);
      expect(() => decodeFrameHeader(buf)).toThrow(/Frame too small/);
    });
  });

  describe('decodeAck', () => {
    it('should decode a 4-byte ack', () => {
      const buf = Buffer.alloc(ACK_SIZE);
      buf.writeUInt32BE(123, 0);
      expect(decodeAck(buf)).toBe(123);
    });

    it('should handle max frame number', () => {
      const buf = Buffer.alloc(ACK_SIZE);
      buf.writeUInt32BE(0xFFFFFFFF, 0);
      expect(decodeAck(buf)).toBe(0xFFFFFFFF);
    });

    it('should throw on too-small buffer', () => {
      const buf = Buffer.alloc(2);
      expect(() => decodeAck(buf)).toThrow(/Ack too small/);
    });
  });
});
