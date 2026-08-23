/**
 * Reading a GIF's block structure, to answer one question: how many frames?
 *
 * The product supports still GIFs and refuses animated ones, and the
 * difference has to be a stated refusal rather than a silent first-frame
 * substitution. Someone attaching an animation is asking about the animation;
 * handing the model one frame and saying nothing answers a question they did
 * not ask, and they have no way to notice.
 *
 * `sharp` can report a page count, but only where the installed libvips was
 * built with GIF support -- and an image feature whose safety property
 * depends on how a native library was compiled is not a safety property. The
 * block walk below is a few dozen lines of the 1989 specification and gives
 * the same answer everywhere, so it is the one that decides. The `sharp` pass
 * that follows still re-encodes and bounds the pixels.
 *
 * Pure: bytes in, a count out, no decoding of image data at all. The LZW
 * payload is walked as sub-block lengths and never expanded.
 */

export type GifStructure = {
    readonly frames: number;
    readonly width: number;
    readonly height: number;
    readonly version: "GIF87a" | "GIF89a";
};

export class GifStructureError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GifStructureError";
    }
}

const HEADER_BYTES = 6;
const SCREEN_DESCRIPTOR_BYTES = 7;
const BLOCK_EXTENSION = 0x21;
const BLOCK_IMAGE_DESCRIPTOR = 0x2c;
const BLOCK_TRAILER = 0x3b;

/** A colour table is 3 bytes per entry, 2^(n+1) entries. */
const colorTableBytes = (packed: number) => 3 * 2 ** ((packed & 0x07) + 1);

const fail = (message: string): never => {
    throw new GifStructureError(message);
};

/** Walks a run of length-prefixed sub-blocks and returns the offset after it. */
const skipSubBlocks = (bytes: Uint8Array, start: number) => {
    let at = start;
    for (;;) {
        if (at >= bytes.length) fail("The GIF sub-block run is truncated.");
        const length = bytes[at];
        at += 1;
        if (length === 0) return at;
        at += length;
        if (at > bytes.length) fail("The GIF sub-block run is truncated.");
    }
};

export function readGifStructure(bytes: Uint8Array): GifStructure {
    if (bytes.length < HEADER_BYTES + SCREEN_DESCRIPTOR_BYTES) {
        fail("The GIF is too short to contain a header.");
    }

    let version: GifStructure["version"];
    const header = String.fromCharCode(...bytes.subarray(0, HEADER_BYTES));
    if (header === "GIF87a") version = "GIF87a";
    else if (header === "GIF89a") version = "GIF89a";
    else return fail("The GIF signature is invalid.");

    const width = bytes[6] | (bytes[7] << 8);
    const height = bytes[8] | (bytes[9] << 8);
    const packed = bytes[10];
    if (width === 0 || height === 0) fail("The GIF has no pixels.");

    let at = HEADER_BYTES + SCREEN_DESCRIPTOR_BYTES;
    if ((packed & 0x80) !== 0) at += colorTableBytes(packed);
    if (at > bytes.length) fail("The GIF global colour table is truncated.");

    let frames = 0;
    for (;;) {
        if (at >= bytes.length) fail("The GIF ends without a trailer.");
        const block = bytes[at];
        at += 1;

        if (block === BLOCK_TRAILER) break;

        if (block === BLOCK_EXTENSION) {
            if (at >= bytes.length) fail("The GIF extension block is truncated.");
            // The label byte, then the extension's own sub-block run.
            at = skipSubBlocks(bytes, at + 1);
            continue;
        }

        if (block === BLOCK_IMAGE_DESCRIPTOR) {
            if (at + 9 > bytes.length) fail("The GIF image descriptor is truncated.");
            const imagePacked = bytes[at + 8];
            at += 9;
            if ((imagePacked & 0x80) !== 0) at += colorTableBytes(imagePacked);
            if (at >= bytes.length) fail("The GIF image data is truncated.");
            // The LZW minimum code size, then the compressed sub-block run.
            at = skipSubBlocks(bytes, at + 1);
            frames += 1;
            // Two frames is already the answer; the caller only asks whether
            // this is an animation, and a hostile file should not be able to
            // make this walk long by adding a million of them.
            if (frames > 1) return { frames, width, height, version };
            continue;
        }

        return fail("The GIF contains an unknown block.");
    }

    if (frames === 0) fail("The GIF contains no image.");
    return { frames, width, height, version };
}

/** True for a GIF with more than one image block. */
export const isAnimatedGif = (bytes: Uint8Array) =>
    readGifStructure(bytes).frames > 1;
