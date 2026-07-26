import { describe, it, expect } from 'vitest';
import { readImageDimensions } from './dimensions';

/** Minimal but real headers — the same bytes the decoders see in production. */
const png = (w: number, h: number) => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8); // length + "IHDR"
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};

const gif = (w: number, h: number) => {
  const b = new Uint8Array(10);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // "GIF89a"
  new DataView(b.buffer).setUint16(6, w, true);
  new DataView(b.buffer).setUint16(8, h, true);
  return b;
};

const jpeg = (w: number, h: number, { withPreamble = true } = {}) => {
  const parts: number[] = [0xff, 0xd8];
  if (withPreamble) {
    // A JFIF APP0 segment, so the walker has to skip a real segment first.
    parts.push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0);
  }
  parts.push(0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff);
  parts.push(...new Array(8).fill(0));
  return new Uint8Array(parts);
};

const webpVP8X = (w: number, h: number) => {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  b.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  const cw = w - 1;
  const ch = h - 1;
  b.set([cw & 0xff, (cw >> 8) & 0xff, (cw >> 16) & 0xff], 24);
  b.set([ch & 0xff, (ch >> 8) & 0xff, (ch >> 16) & 0xff], 27);
  return b;
};

const webpVP8 = (w: number, h: number) => {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  b.set([0x9d, 0x01, 0x2a], 23); // keyframe start code
  b.set([w & 0xff, (w >> 8) & 0x3f], 26);
  b.set([h & 0xff, (h >> 8) & 0x3f], 28);
  return b;
};

describe('readImageDimensions', () => {
  it('reads PNG from the IHDR chunk', () => {
    expect(readImageDimensions(png(1200, 630))).toEqual({ width: 1200, height: 630 });
  });

  it('reads GIF from the logical screen descriptor (little-endian)', () => {
    expect(readImageDimensions(gif(300, 200))).toEqual({ width: 300, height: 200 });
  });

  it('reads JPEG from the frame header, skipping earlier segments', () => {
    expect(readImageDimensions(jpeg(242, 209))).toEqual({ width: 242, height: 209 });
    expect(readImageDimensions(jpeg(242, 209, { withPreamble: false }))).toEqual({
      width: 242,
      height: 209,
    });
  });

  it('reads both WebP layouts', () => {
    expect(readImageDimensions(webpVP8X(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(readImageDimensions(webpVP8(640, 480))).toEqual({ width: 640, height: 480 });
  });

  // A missing dimension costs a layout shift; a thrown error costs the upload.
  // Everything unparseable must degrade to null.
  it('returns null rather than throwing on junk, truncation, or empty input', () => {
    expect(readImageDimensions(new Uint8Array(0))).toBeNull();
    expect(readImageDimensions(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
    expect(readImageDimensions(png(10, 10).slice(0, 12))).toBeNull();
    expect(readImageDimensions(gif(10, 10).slice(0, 7))).toBeNull();
    expect(readImageDimensions(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    // RIFF container that is not WebP.
    const wav = new Uint8Array(30);
    wav.set([0x52, 0x49, 0x46, 0x46], 0);
    wav.set([0x57, 0x41, 0x56, 0x45], 8);
    expect(readImageDimensions(wav)).toBeNull();
  });

  it('rejects zero and out-of-range values instead of storing nonsense', () => {
    expect(readImageDimensions(png(0, 100))).toBeNull();
    expect(readImageDimensions(gif(0, 0))).toBeNull();
    expect(readImageDimensions(png(70000, 10))).toBeNull();
  });
});
