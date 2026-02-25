import { describe, it, expect } from 'vitest';
import { decodeFrameHeader, encodeAck, FRAME_HEADER_SIZE, ACK_SIZE } from '../viewport-frame.js';

describe('viewport-frame (core)', () => {
  describe('decodeFrameHeader', () => {
    it('should decode a frame header from ArrayBuffer', () => {
      const buf = new ArrayBuffer(FRAME_HEADER_SIZE + 4);
      const view = new DataView(buf);
      view.setUint32(0, 42, false);      // frameNum
      view.setUint16(4, 1280, false);    // width
      view.setUint16(6, 720, false);     // height
      view.setUint8(8, 60);             // quality

      const header = decodeFrameHeader(buf);
      expect(header.frameNum).toBe(42);
      expect(header.width).toBe(1280);
      expect(header.height).toBe(720);
      expect(header.quality).toBe(60);
      expect(header.dataOffset).toBe(FRAME_HEADER_SIZE);
    });

    it('should throw on too-small buffer', () => {
      const buf = new ArrayBuffer(5);
      expect(() => decodeFrameHeader(buf)).toThrow(/Frame too small/);
    });
  });

  describe('encodeAck', () => {
    it('should encode a 4-byte ack', () => {
      const ack = encodeAck(123);
      expect(ack.byteLength).toBe(ACK_SIZE);

      const view = new DataView(ack);
      expect(view.getUint32(0, false)).toBe(123);
    });

    it('should handle max frame number', () => {
      const ack = encodeAck(0xFFFFFFFF);
      const view = new DataView(ack);
      expect(view.getUint32(0, false)).toBe(0xFFFFFFFF);
    });
  });
});
