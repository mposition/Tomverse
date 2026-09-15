import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const EXPECTED_SHA256 = {
  ko: "d5d89ac2a2c7c94f9f9e01bf42899d645c2e2c0988032b7b13b6a55816de2d9e",
  en: "bbb1b34e1b6d746540ff60efc2b7e45c9b81bdc45c9099c70e4c25ff528261be",
  zh: "4e72b08624ef37c492a13ce51c546d273443903c4564df6aa765b73a114e8070",
};

const EXPECTED_DURATION_SECONDS = 44.04;
const EXPECTED_WIDTH = 1920;
const EXPECTED_HEIGHT = 1080;

const validate = async (language, expectedSha256) => {
  const path =
    `public/guides/assistant-knowledge/assistant-knowledge.${language}.mp4`;
  const buffer = await readFile(path);
  const sha256 = createHash("sha256").update(buffer).digest("hex");

  if (sha256 !== expectedSha256) {
    throw new Error(
      `Unexpected ${language} tutorial digest: ${sha256}; expected ${expectedSha256}.`
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

    if (
      !Number.isSafeInteger(size) ||
      size < headerSize ||
      offset + size > buffer.length
    ) {
      throw new Error(
        `Invalid ${type || "unknown"} box at byte ${offset} in ${path}.`
      );
    }

    topLevelBoxes.push({ offset, size, type });
    offset += size;
  }

  const moov = topLevelBoxes.find(({ type }) => type === "moov");
  const mdat = topLevelBoxes.find(({ type }) => type === "mdat");
  if (!moov || !mdat) {
    throw new Error(`${path} must contain moov and mdat boxes.`);
  }
  if (moov.offset > mdat.offset) {
    throw new Error(`${path} must place moov before mdat for fast start.`);
  }

  const handlerTypes = [];
  const handlerMarker = Buffer.from("hdlr", "ascii");
  for (
    let markerOffset = buffer.indexOf(handlerMarker);
    markerOffset >= 4;
    markerOffset = buffer.indexOf(
      handlerMarker,
      markerOffset + handlerMarker.length
    )
  ) {
    const boxOffset = markerOffset - 4;
    const boxSize = buffer.readUInt32BE(boxOffset);
    if (boxSize >= 20 && boxOffset + boxSize <= buffer.length) {
      handlerTypes.push(
        buffer.toString("ascii", boxOffset + 16, boxOffset + 20)
      );
    }
  }

  if (handlerTypes.filter((type) => type === "vide").length !== 1) {
    throw new Error(
      `${path} needs one video handler; received ${handlerTypes.join(", ")}.`
    );
  }
  if (handlerTypes.filter((type) => type === "soun").length !== 1) {
    throw new Error(
      `${path} needs one audio handler; received ${handlerTypes.join(", ")}.`
    );
  }
  if (!buffer.includes(Buffer.from("avc1", "ascii"))) {
    throw new Error(`${path} must contain an H.264 avc1 sample entry.`);
  }
  if (!buffer.includes(Buffer.from("mp4a", "ascii"))) {
    throw new Error(`${path} must contain an AAC mp4a sample entry.`);
  }

  const moovEnd = moov.offset + moov.size;
  const mvhdMarker = buffer.indexOf(Buffer.from("mvhd", "ascii"), moov.offset + 8);
  const mvhdOffset = mvhdMarker - 4;
  const mvhdSize = mvhdMarker >= 4 ? buffer.readUInt32BE(mvhdOffset) : 0;
  if (
    mvhdMarker < 0 ||
    mvhdSize < 32 ||
    mvhdOffset < moov.offset + 8 ||
    mvhdOffset + mvhdSize > moovEnd
  ) {
    throw new Error(`${path} must contain a valid movie header.`);
  }
  const mvhdVersion = buffer.readUInt8(mvhdOffset + 8);
  const timescaleOffset = mvhdOffset + (mvhdVersion === 1 ? 28 : 20);
  const durationOffset = mvhdOffset + (mvhdVersion === 1 ? 32 : 24);
  const timescale = buffer.readUInt32BE(timescaleOffset);
  const durationUnits =
    mvhdVersion === 1
      ? Number(buffer.readBigUInt64BE(durationOffset))
      : buffer.readUInt32BE(durationOffset);
  const durationSeconds = durationUnits / timescale;
  if (
    timescale === 0 ||
    !Number.isFinite(durationSeconds) ||
    Math.abs(durationSeconds - EXPECTED_DURATION_SECONDS) > 0.01
  ) {
    throw new Error(
      `${path} must be ${EXPECTED_DURATION_SECONDS}s; received ${durationSeconds}s.`
    );
  }

  let videoDimensions = null;
  const avc1Marker = Buffer.from("avc1", "ascii");
  for (
    let markerOffset = buffer.indexOf(avc1Marker, moov.offset + 8);
    markerOffset >= 4 && markerOffset < moovEnd;
    markerOffset = buffer.indexOf(avc1Marker, markerOffset + avc1Marker.length)
  ) {
    const boxOffset = markerOffset - 4;
    const boxSize = buffer.readUInt32BE(boxOffset);
    if (boxSize >= 36 && boxOffset + boxSize <= moovEnd) {
      const width = buffer.readUInt16BE(boxOffset + 32);
      const height = buffer.readUInt16BE(boxOffset + 34);
      if (width > 0 && height > 0) {
        videoDimensions = { width, height };
        break;
      }
    }
  }
  if (
    videoDimensions?.width !== EXPECTED_WIDTH ||
    videoDimensions?.height !== EXPECTED_HEIGHT
  ) {
    throw new Error(
      `${path} must be ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}; received ${videoDimensions?.width ?? "unknown"}x${videoDimensions?.height ?? "unknown"}.`
    );
  }

  return {
    language,
    bytes: buffer.length,
    sha256,
    videoCodec: "H.264/avc1",
    audioCodec: "AAC/mp4a",
    handlerTypes,
    width: videoDimensions.width,
    height: videoDimensions.height,
    durationSeconds,
    fastStart: true,
  };
};

const reports = [];
for (const [language, sha256] of Object.entries(EXPECTED_SHA256)) {
  reports.push(await validate(language, sha256));
}

console.log(JSON.stringify(reports, null, 2));
console.log(
  "Localized Assistant + Knowledge tutorial validation passed."
);
