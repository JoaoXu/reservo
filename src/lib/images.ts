// Just enough of JPEG, PNG and WebP to trust an upload: identify the format
// from its bytes (never the file name or Content-Type), read the size without
// decoding pixels, and drop metadata (EXIF can carry the GPS position where a
// phone photo was taken). The browser already re-encodes photos before
// upload; this is the server's own check.

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';
export const IMAGE_EXT: Record<ImageType, 'jpg' | 'png' | 'webp'> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const MAX_SIDE = 10_000;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffImage(b: Buffer): ImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export class ImageError extends Error {}

// --- JPEG: a sequence of FF xx segments, then entropy-coded scan data -------------
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
// APP1 (EXIF, XMP), APP13 (Photoshop/IPTC), COM. APP0 (JFIF) and APP2 (ICC colour) stay.
const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]);

function walkJpeg(b: Buffer, keep: (marker: number, seg: Buffer) => void): { width: number; height: number } {
  let pos = 2;
  let size: { width: number; height: number } | null = null;
  while (pos < b.length) {
    if (b[pos] !== 0xff) throw new ImageError('corrupt JPEG');
    while (b[pos] === 0xff && pos < b.length) pos++;
    const marker = b[pos];
    const start = pos - 1;
    pos++;
    if (marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { keep(marker, b.subarray(start, pos)); continue; }
    if (pos + 2 > b.length) throw new ImageError('truncated JPEG');
    const len = b.readUInt16BE(pos);
    const end = pos + len;
    if (len < 2 || end > b.length) throw new ImageError('truncated JPEG');
    if (SOF.has(marker) && len >= 7) size = { height: b.readUInt16BE(pos + 3), width: b.readUInt16BE(pos + 5) };
    if (marker === 0xda) { keep(marker, b.subarray(start)); break; } // start of scan: the rest is image data
    keep(marker, b.subarray(start, end));
    pos = end;
  }
  if (!size) throw new ImageError('JPEG without a frame header');
  return size;
}

// --- PNG: signature, then length/type/data/crc chunks -------------------------------
const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

function walkPng(b: Buffer, keep: (type: string, chunk: Buffer) => void): { width: number; height: number } {
  let pos = 8;
  let size: { width: number; height: number } | null = null;
  while (pos + 12 <= b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + len;
    if (end > b.length) throw new ImageError('truncated PNG');
    if (type === 'IHDR') size = { width: b.readUInt32BE(pos + 8), height: b.readUInt32BE(pos + 12) };
    keep(type, b.subarray(pos, end));
    pos = end;
    if (type === 'IEND') break;
  }
  if (!size) throw new ImageError('PNG without IHDR');
  return size;
}

// --- WebP: RIFF container with VP8 / VP8L / VP8X chunks ----------------------------
const WEBP_DROP = new Set(['EXIF', 'XMP ']);

function walkWebp(b: Buffer, keep: (type: string, chunk: Buffer) => void): { width: number; height: number } {
  let pos = 12;
  let size: { width: number; height: number } | null = null;
  while (pos + 8 <= b.length) {
    const type = b.toString('latin1', pos, pos + 4);
    const len = b.readUInt32LE(pos + 4);
    const data = pos + 8;
    const end = data + len + (len & 1);
    if (data + len > b.length) throw new ImageError('truncated WebP');
    if (type === 'VP8X' && len >= 10) {
      size = { width: 1 + b.readUIntLE(data + 4, 3), height: 1 + b.readUIntLE(data + 7, 3) };
    } else if (!size && type === 'VP8 ' && len >= 10 && b[data + 3] === 0x9d && b[data + 4] === 0x01 && b[data + 5] === 0x2a) {
      size = { width: b.readUInt16LE(data + 6) & 0x3fff, height: b.readUInt16LE(data + 8) & 0x3fff };
    } else if (!size && type === 'VP8L' && len >= 5 && b[data] === 0x2f) {
      const bits = b.readUInt32LE(data + 1);
      size = { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    keep(type, b.subarray(pos, Math.min(end, b.length)));
    pos = end;
  }
  if (!size) throw new ImageError('WebP without an image chunk');
  return size;
}

export interface CheckedImage { type: ImageType; width: number; height: number; data: Buffer }

/** Identifies, measures and cleans an uploaded image. Throws ImageError if it isn't one we accept. */
export function checkImage(input: Buffer): CheckedImage {
  const type = sniffImage(input);
  if (!type) throw new ImageError('not a JPEG, PNG or WebP image');
  const parts: Buffer[] = [];
  let size: { width: number; height: number };
  if (type === 'image/jpeg') {
    parts.push(input.subarray(0, 2));
    size = walkJpeg(input, (marker, seg) => { if (!JPEG_DROP.has(marker)) parts.push(seg); });
  } else if (type === 'image/png') {
    parts.push(PNG_SIG);
    size = walkPng(input, (t, chunk) => { if (!PNG_DROP.has(t)) parts.push(chunk); });
  } else {
    size = walkWebp(input, (t, chunk) => {
      if (WEBP_DROP.has(t)) return;
      if (t === 'VP8X') {
        const c = Buffer.from(chunk);
        c[8] &= ~(0x08 | 0x04); // clear the EXIF and XMP flags
        parts.push(c);
      } else parts.push(chunk);
    });
    const body = Buffer.concat(parts);
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(body.length + 4, 4);
    header.write('WEBP', 8, 'latin1');
    parts.splice(0, parts.length, header, body);
  }
  if (!size.width || !size.height || size.width > MAX_SIDE || size.height > MAX_SIDE) throw new ImageError('image size out of range');
  return { type, ...size, data: Buffer.concat(parts) };
}
