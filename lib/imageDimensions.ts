// Reads the pixel dimensions out of the bytes a provider actually returned.
//
// Policy section 12.1: the product picks a resolution tier plus an aspect
// ratio, each provider translates that its own way, and what comes back is
// therefore not deducible from the request. Google's 1K landscape is not
// 1536x1024; xAI names its tiers rather than sizing them. The only honest
// answer to "how big is this image" is the one in the file's own header, and
// the result screen shows it (section 12.1) so nobody has to infer it from a
// tier name.
//
// Header parsing only -- no decode, no dependency. These are the three
// container formats the registry's `outputMimeTypes` allow, and reading a
// fixed offset in the first few dozen bytes cannot be a decompression bomb.
//
// Returns null rather than guessing. A dimension nobody could read is
// recorded as absent, which is a fact; a fabricated one would silently
// contradict the file it claims to describe.

export type ImageDimensions = { width: number; height: number };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const readPngDimensions = (bytes: Buffer): ImageDimensions | null => {
  // 8-byte signature, then the IHDR chunk: 4-byte length, 4-byte type, then
  // width and height as big-endian uint32.
  if (bytes.length < 24) return null;
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

const readJpegDimensions = (bytes: Buffer): ImageDimensions | null => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    // SOF0..SOF15, excluding the DHT/JPG/DAC markers interleaved in that
    // range. Height precedes width, which is the detail this parser exists to
    // get right -- transposing them would report every landscape as portrait.
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      if (offset + 9 >= bytes.length) return null;
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
};

const readWebpDimensions = (bytes: Buffer): ImageDimensions | null => {
  if (bytes.length < 30) return null;
  if (bytes.toString("ascii", 0, 4) !== "RIFF") return null;
  if (bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    // 24-bit little-endian, stored as value minus one.
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return {
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >> 14) & 0x3fff),
    };
  }
  if (chunk === "VP8 ") {
    // Lossy: the 14-bit dimensions follow the 3-byte start code at offset 23.
    if (bytes.length < 30) return null;
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
};

/**
 * Dimensions of the image, or null when the bytes are not one of the three
 * allowed containers or the header is truncated.
 *
 * `mimeType` selects the parser rather than being trusted on its own: a
 * provider that mislabels its own output would otherwise produce dimensions
 * read at the wrong offsets, which is worse than none. Every parser
 * re-checks the container signature and refuses on mismatch.
 */
export const readImageDimensions = (
  bytes: Buffer,
  mimeType: string
): ImageDimensions | null => {
  const dimensions = (() => {
    switch (mimeType.trim().toLowerCase()) {
      case "image/png":
        return readPngDimensions(bytes);
      case "image/jpeg":
      case "image/jpg":
        return readJpegDimensions(bytes);
      case "image/webp":
        return readWebpDimensions(bytes);
      default:
        return null;
    }
  })();
  if (!dimensions) return null;
  // A zero or absurd dimension means the header was misread, not that the
  // image is that size. 65,535 is the largest either JPEG or WebP can state.
  if (
    !Number.isSafeInteger(dimensions.width) ||
    !Number.isSafeInteger(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    dimensions.width > 65_535 ||
    dimensions.height > 65_535
  ) {
    return null;
  }
  return dimensions;
};
