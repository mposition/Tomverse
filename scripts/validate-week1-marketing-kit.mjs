import { readFile, stat } from "node:fs/promises";

const assets = {
  video: "public/marketing-launch/week1/tomverse-business-risk-review-ko.webm",
  poster: "public/marketing-launch/week1/tomverse-business-risk-review-poster-ko.png",
  comparison: "public/marketing-launch/week1/model-answer-comparison-ko.png",
  review: "public/marketing-launch/week1/ai-review-result-ko.png",
  copy: "docs/marketing/week1/Tomverse-week1-marketing-kit-ko.md",
};

for (const [name, path] of Object.entries(assets)) {
  const info = await stat(path);
  if (info.size <= 0) throw new Error(`${name} is empty: ${path}`);
}

const readVint = (buffer, offset) => {
  const first = buffer[offset];
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8) throw new Error("Invalid EBML variable-length integer.");
  let value = first & (mask - 1);
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + buffer[offset + index];
  }
  return { length, value };
};

const findBytes = (buffer, sequence) => {
  for (let offset = 0; offset <= buffer.length - sequence.length; offset += 1) {
    let matches = true;
    for (let index = 0; index < sequence.length; index += 1) {
      if (buffer[offset + index] !== sequence[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return offset;
  }
  return -1;
};

const readEbmlNumber = (buffer, id, type) => {
  const offset = findBytes(buffer, id);
  if (offset < 0) throw new Error(`Missing EBML element ${id.map((byte) => byte.toString(16)).join("")}.`);
  const size = readVint(buffer, offset + id.length);
  const payloadOffset = offset + id.length + size.length;
  if (type === "float") {
    if (size.value === 4) return buffer.readFloatBE(payloadOffset);
    if (size.value === 8) return buffer.readDoubleBE(payloadOffset);
    throw new Error(`Unsupported EBML float size: ${size.value}.`);
  }
  let value = 0;
  for (let index = 0; index < size.value; index += 1) {
    value = value * 256 + buffer[payloadOffset + index];
  }
  return value;
};

const pngDimensions = async (path) => {
  const buffer = await readFile(path);
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") throw new Error(`Not a PNG: ${path}`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

const videoBuffer = await readFile(assets.video);
const metadataBuffer = videoBuffer.subarray(0, Math.min(videoBuffer.length, 1024 * 1024));
const timecodeScale = readEbmlNumber(metadataBuffer, [0x2a, 0xd7, 0xb1], "integer");
const durationUnits = readEbmlNumber(metadataBuffer, [0x44, 0x89], "float");
const duration = (durationUnits * timecodeScale) / 1_000_000_000;
const comparison = await pngDimensions(assets.comparison);
const review = await pngDimensions(assets.review);
const poster = await pngDimensions(assets.poster);

if (duration < 30 || duration > 45) {
  throw new Error(`Video duration must be 30–45 seconds; received ${duration.toFixed(2)}.`);
}
for (const [name, dimensions] of Object.entries({ comparison, review, poster })) {
  if (dimensions.width !== 1280 || dimensions.height !== 720) {
    throw new Error(`Unexpected ${name} dimensions: ${dimensions.width}x${dimensions.height}.`);
  }
}

console.log(
  JSON.stringify(
    {
      durationSeconds: Number(duration.toFixed(2)),
      videoBytes: videoBuffer.length,
      comparison,
      review,
      poster,
    },
    null,
    2
  )
);
console.log("Week-one marketing kit validation passed.");
