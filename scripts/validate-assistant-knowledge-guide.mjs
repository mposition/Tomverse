import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const VIDEO_PATH =
  "public/guides/assistant-knowledge/assistant-knowledge.mp4";
const EXPECTED_SHA256 =
  "2e20a5191a0c3449f1a1507b21f02b72653680f487374b86bb4d2e2e4bb40123";

const buffer = await readFile(VIDEO_PATH);
const sha256 = createHash("sha256").update(buffer).digest("hex");

if (sha256 !== EXPECTED_SHA256) {
  throw new Error(
    `Unexpected tutorial digest: ${sha256}; expected ${EXPECTED_SHA256}.`
  );
}

const topLevelBoxes = [];
for (let offset = 0; offset + 8 <= buffer.length; ) {
  const declaredSize = buffer.readUInt32BE(offset);
  const type = buffer.toString("ascii", offset + 4, offset + 8);
  const headerSize = declaredSize === 1 ? 16 : 8;
  const size =
    declaredSize === 0
      ? buffer.length - offset
      : declaredSize === 1
        ? Number(buffer.readBigUInt64BE(offset + 8))
        : declaredSize;

  if (!Number.isSafeInteger(size) || size < headerSize || offset + size > buffer.length) {
    throw new Error(`Invalid ${type || "unknown"} box at byte ${offset}.`);
  }

  topLevelBoxes.push({ offset, size, type });
  offset += size;
}

const moov = topLevelBoxes.find(({ type }) => type === "moov");
const mdat = topLevelBoxes.find(({ type }) => type === "mdat");
if (!moov || !mdat) throw new Error("Tutorial MP4 must contain moov and mdat boxes.");
if (moov.offset > mdat.offset) {
  throw new Error("Tutorial MP4 must place moov before mdat for fast-start playback.");
}

const handlerTypes = [];
const handlerMarker = Buffer.from("hdlr", "ascii");
for (
  let markerOffset = buffer.indexOf(handlerMarker);
  markerOffset >= 4;
  markerOffset = buffer.indexOf(handlerMarker, markerOffset + handlerMarker.length)
) {
  const boxOffset = markerOffset - 4;
  const boxSize = buffer.readUInt32BE(boxOffset);
  if (boxSize >= 20 && boxOffset + boxSize <= buffer.length) {
    handlerTypes.push(buffer.toString("ascii", boxOffset + 16, boxOffset + 20));
  }
}

if (handlerTypes.filter((type) => type === "vide").length !== 1) {
  throw new Error(`Expected one video handler; received ${handlerTypes.join(", ")}.`);
}
if (handlerTypes.includes("soun")) {
  throw new Error("Tutorial MP4 must be silent and contain no audio handler.");
}
if (!buffer.includes(Buffer.from("avc1", "ascii"))) {
  throw new Error("Tutorial MP4 must contain an H.264 avc1 sample entry.");
}

console.log(
  JSON.stringify(
    {
      bytes: buffer.length,
      sha256,
      codec: "H.264/avc1",
      handlerTypes,
      fastStart: true,
    },
    null,
    2
  )
);
console.log("Assistant + Knowledge tutorial validation passed.");
