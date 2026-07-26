/**
 * Pixel dimensions read straight out of an image's header bytes.
 *
 * Workers have no `canvas` and no `createImageBitmap`, and the Cloudflare Images
 * binding is optional in this template — a store without it must still record
 * dimensions. Every format we accept states its size in a fixed, well-documented
 * spot near the start of the file, so parsing the header directly is both the
 * smallest dependency-free option and the only one that always works.
 *
 * Deliberately tolerant: anything unrecognised, truncated, or malformed returns
 * null rather than throwing. A missing dimension costs a layout shift; a thrown
 * error would cost the upload.
 */
export interface ImageDimensions {
  width: number;
  height: number;
}

/** Enough for every header below; WebP's VP8X sits within the first 30 bytes. */
export const HEADER_BYTES = 64 * 1024;

export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return png(bytes) ?? gif(bytes) ?? webp(bytes) ?? jpeg(bytes);
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

const matches = (b: Uint8Array, offset: number, signature: number[]) =>
  b.length >= offset + signature.length && signature.every((v, i) => b[offset + i] === v);

/** PNG: 8-byte signature, then an IHDR chunk whose payload starts with W and H. */
function png(b: Uint8Array): ImageDimensions | null {
  if (!matches(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  if (b.length < 24) return null;
  return valid(u32be(b, 16), u32be(b, 20));
}

/** GIF: "GIF87a"/"GIF89a", then the logical screen descriptor, little-endian. */
function gif(b: Uint8Array): ImageDimensions | null {
  if (!matches(b, 0, [0x47, 0x49, 0x46])) return null;
  if (b.length < 10) return null;
  return valid(u16le(b, 6), u16le(b, 8));
}

/**
 * WebP: "RIFF" .... "WEBP", then one of three chunk layouts.
 *   VP8  — lossy: dimensions are 14-bit values after a 3-byte start code.
 *   VP8L — lossless: 14-bit width/height packed into 32 bits, minus one.
 *   VP8X — extended: 24-bit canvas size, minus one.
 */
function webp(b: Uint8Array): ImageDimensions | null {
  if (!matches(b, 0, [0x52, 0x49, 0x46, 0x46]) || !matches(b, 8, [0x57, 0x45, 0x42, 0x50])) {
    return null;
  }
  const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);

  if (chunk === 'VP8 ' && b.length >= 30) {
    // 0x9d 0x01 0x2a is the keyframe start code; sizes follow it.
    if (!matches(b, 23, [0x9d, 0x01, 0x2a])) return null;
    return valid(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (chunk === 'VP8L' && b.length >= 25) {
    if (b[20] !== 0x2f) return null; // signature byte
    const bits = u32be(b, 21);
    // Stored little-endian as a bit field: 14 bits width, then 14 bits height.
    const packed = ((bits >>> 24) & 0xff) | (((bits >>> 16) & 0xff) << 8) |
      (((bits >>> 8) & 0xff) << 16) | ((bits & 0xff) << 24);
    return valid((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X' && b.length >= 30) {
    return valid(u24le(b, 24) + 1, u24le(b, 27) + 1);
  }
  return null;
}

/**
 * JPEG: walk the marker chain to the frame header (SOF0-SOF15), which carries
 * height then width. DHT/DAC/RST/SOS markers are skipped; DNL and the standalone
 * markers carry no length field.
 */
function jpeg(b: Uint8Array): ImageDimensions | null {
  if (!matches(b, 0, [0xff, 0xd8])) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++; // resynchronise on fill bytes rather than giving up
      continue;
    }
    const marker = b[i + 1];
    // Standalone markers: no payload, no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of header section
    const length = u16be(b, i + 2);
    if (length < 2) return null;
    // SOF0-SOF15, excluding DHT (0xc4), JPG (0xc8) and DAC (0xcc).
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (i + 9 >= b.length) return null;
      return valid(u16be(b, i + 7), u16be(b, i + 5)); // width, height
    }
    i += 2 + length;
  }
  return null;
}

/** Reject zero, negative, and absurd values rather than storing nonsense. */
function valid(width: number, height: number): ImageDimensions | null {
  const sane = (n: number) => Number.isInteger(n) && n > 0 && n <= 65535;
  return sane(width) && sane(height) ? { width, height } : null;
}
