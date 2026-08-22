/**
 * A minimal Compound File Binary Format writer, for tests.
 *
 * Contract: docs/policy/chat-attachment-formats.md.
 *
 * The legacy Office parsers are read-only, so the hostile cases they exist to
 * refuse -- a sector chain that loops, a stream that points past the end of
 * the file, an encrypted workbook -- cannot be produced by any tool that
 * writes valid documents. They have to be built, field by field, which is
 * what this is for.
 *
 * It is also what strips the 442KB preview thumbnail out of the committed
 * `.ppt` fixture: the record stream in that file is exactly the one
 * LibreOffice wrote, and only the streams no parser opens were dropped.
 *
 * Deliberately not in `lib/`. Nothing in the product writes one of these, and
 * a writer sitting next to a reader is an invitation to test the reader
 * against its own assumptions instead of against a real file -- which is why
 * the happy paths are tested against documents a real word processor
 * produced, and this builds only the shapes one never would.
 */

const SECTOR_BYTES = 512;
const MINI_SECTOR_BYTES = 64;
const MINI_STREAM_CUTOFF = 4096;
const DIRECTORY_ENTRY_BYTES = 128;
const ENTRIES_PER_SECTOR = SECTOR_BYTES / DIRECTORY_ENTRY_BYTES;
const FAT_ENTRIES_PER_SECTOR = SECTOR_BYTES / 4;

export const FREESECT = 0xffffffff;
export const ENDOFCHAIN = 0xfffffffe;
export const FATSECT = 0xfffffffd;

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const pad = (data, multiple) => {
  const size = Math.ceil(data.length / multiple) * multiple;
  const out = new Uint8Array(size);
  out.set(data);
  return out;
};

/**
 * Builds a container.
 *
 * `streams` is `[{ name, data }]`. Anything smaller than the 4096-byte cutoff
 * goes through the mini stream, exactly as a real file does -- which is not a
 * detail worth skipping, since a `.doc`'s WordDocument stream is usually
 * below it.
 *
 * `corrupt` opts one shape at a time out of being valid:
 *   - `loopFirstStreamChain`  the first stream's chain points back at itself
 *   - `streamPastEnd`         the first stream claims a sector that is not there
 *   - `badSignature`          the magic number is wrong
 *   - `sectorShift`           an unsupported sector size in the header
 */
export function buildCompoundFile(streams, corrupt = {}) {
  const miniStreams = streams.filter(
    (stream) => stream.data.length > 0 && stream.data.length < MINI_STREAM_CUTOFF
  );
  const bigStreams = streams.filter((stream) => !miniStreams.includes(stream));

  // The mini stream: every small stream, each padded to a mini sector.
  const miniFat = [];
  const miniChunks = [];
  const miniStart = new Map();
  for (const stream of miniStreams) {
    const padded = pad(stream.data, MINI_SECTOR_BYTES);
    const first = miniFat.length;
    const count = padded.length / MINI_SECTOR_BYTES;
    for (let index = 0; index < count; index += 1) {
      miniFat.push(index === count - 1 ? ENDOFCHAIN : first + index + 1);
    }
    miniStart.set(stream, first);
    miniChunks.push(padded);
  }
  const miniStreamBytes = new Uint8Array(
    miniChunks.reduce((total, chunk) => total + chunk.length, 0)
  );
  {
    let at = 0;
    for (const chunk of miniChunks) {
      miniStreamBytes.set(chunk, at);
      at += chunk.length;
    }
  }

  const sectors = [];
  const fat = [];
  const allocate = (data) => {
    if (data.length === 0) return ENDOFCHAIN;
    const padded = pad(data, SECTOR_BYTES);
    const count = padded.length / SECTOR_BYTES;
    const first = sectors.length;
    for (let index = 0; index < count; index += 1) {
      sectors.push(padded.subarray(index * SECTOR_BYTES, (index + 1) * SECTOR_BYTES));
      fat.push(index === count - 1 ? ENDOFCHAIN : first + index + 1);
    }
    return first;
  };

  // The directory is allocated first so its own start sector is known, and
  // filled once every other start sector is.
  const directoryEntryCount = 1 + streams.length;
  const directorySectorCount = Math.ceil(directoryEntryCount / ENTRIES_PER_SECTOR);
  const directoryBytes = new Uint8Array(directorySectorCount * SECTOR_BYTES);
  const directoryStart = allocate(directoryBytes);

  const miniFatBytes = new Uint8Array(
    Math.max(1, Math.ceil(miniFat.length / FAT_ENTRIES_PER_SECTOR)) * SECTOR_BYTES
  );
  {
    const view = new DataView(miniFatBytes.buffer);
    for (let index = 0; index < miniFatBytes.length / 4; index += 1) {
      view.setUint32(index * 4, miniFat[index] ?? FREESECT, true);
    }
  }
  const miniFatStart = miniFat.length > 0 ? allocate(miniFatBytes) : ENDOFCHAIN;
  const miniStreamStart =
    miniStreamBytes.length > 0 ? allocate(miniStreamBytes) : ENDOFCHAIN;

  const bigStart = new Map();
  for (const stream of bigStreams) {
    bigStart.set(stream, allocate(stream.data));
  }

  // The FAT describes itself, so its size and the total sector count settle
  // on each other.
  let fatSectorCount = 1;
  for (let round = 0; round < 8; round += 1) {
    const total = sectors.length + fatSectorCount;
    const needed = Math.max(1, Math.ceil(total / FAT_ENTRIES_PER_SECTOR));
    if (needed === fatSectorCount) break;
    fatSectorCount = needed;
  }
  const fatSectorNumbers = [];
  for (let index = 0; index < fatSectorCount; index += 1) {
    fatSectorNumbers.push(sectors.length);
    sectors.push(new Uint8Array(SECTOR_BYTES));
    fat.push(FATSECT);
  }

  // --- The directory entries ---------------------------------------------
  const writeEntry = (index, { name, type, start, size, child, right }) => {
    const at = index * DIRECTORY_ENTRY_BYTES;
    const view = new DataView(directoryBytes.buffer, directoryBytes.byteOffset);
    for (let code = 0; code < name.length; code += 1) {
      view.setUint16(at + code * 2, name.charCodeAt(code), true);
    }
    view.setUint16(at + 64, (name.length + 1) * 2, true);
    directoryBytes[at + 66] = type;
    directoryBytes[at + 67] = 1; // black
    view.setUint32(at + 68, FREESECT, true); // left sibling
    view.setUint32(at + 72, right ?? FREESECT, true);
    view.setUint32(at + 76, child ?? FREESECT, true);
    view.setUint32(at + 116, start, true);
    view.setUint32(at + 120, size, true);
    view.setUint32(at + 124, 0, true);
  };

  writeEntry(0, {
    name: "Root Entry",
    type: 5,
    start: miniStreamStart,
    size: miniStreamBytes.length,
    child: streams.length > 0 ? 1 : FREESECT,
  });
  streams.forEach((stream, index) => {
    writeEntry(index + 1, {
      name: stream.name,
      type: 2,
      start: miniStreams.includes(stream)
        ? miniStart.get(stream)
        : (bigStart.get(stream) ?? ENDOFCHAIN),
      size: stream.data.length,
      right: index + 2 <= streams.length ? index + 2 : FREESECT,
    });
  });
  for (let index = 0; index < directorySectorCount; index += 1) {
    sectors[directoryStart + index].set(
      directoryBytes.subarray(index * SECTOR_BYTES, (index + 1) * SECTOR_BYTES)
    );
  }

  // --- Deliberate damage ---------------------------------------------------
  const firstStream = streams[0];
  if (corrupt.loopFirstStreamChain && firstStream && bigStart.has(firstStream)) {
    const start = bigStart.get(firstStream);
    fat[start] = start;
  }
  if (corrupt.streamPastEnd && firstStream && bigStart.has(firstStream)) {
    fat[bigStart.get(firstStream)] = sectors.length + 500;
  }

  // --- The FAT sectors -----------------------------------------------------
  for (let index = 0; index < fatSectorCount; index += 1) {
    const sector = sectors[fatSectorNumbers[index]];
    const view = new DataView(sector.buffer, sector.byteOffset);
    for (let slot = 0; slot < FAT_ENTRIES_PER_SECTOR; slot += 1) {
      const entry = index * FAT_ENTRIES_PER_SECTOR + slot;
      view.setUint32(slot * 4, fat[entry] ?? FREESECT, true);
    }
  }

  // --- The header ----------------------------------------------------------
  const header = new Uint8Array(SECTOR_BYTES);
  const headerView = new DataView(header.buffer);
  header.set(corrupt.badSignature ? [1, 2, 3, 4, 5, 6, 7, 8] : SIGNATURE, 0);
  headerView.setUint16(24, 0x003e, true); // minor version
  headerView.setUint16(26, 3, true); // major version
  headerView.setUint16(28, 0xfffe, true); // little endian
  headerView.setUint16(30, corrupt.sectorShift ?? 9, true);
  headerView.setUint16(32, 6, true); // mini sector shift
  headerView.setUint32(44, fatSectorCount, true);
  headerView.setUint32(48, directoryStart, true);
  headerView.setUint32(56, MINI_STREAM_CUTOFF, true);
  headerView.setUint32(60, miniFatStart, true);
  headerView.setUint32(
    64,
    miniFat.length > 0 ? miniFatBytes.length / SECTOR_BYTES : 0,
    true
  );
  headerView.setUint32(68, ENDOFCHAIN, true); // no DIFAT sectors
  headerView.setUint32(72, 0, true);
  for (let index = 0; index < 109; index += 1) {
    headerView.setUint32(
      76 + index * 4,
      index < fatSectorCount ? fatSectorNumbers[index] : FREESECT,
      true
    );
  }

  const out = new Uint8Array(SECTOR_BYTES + sectors.length * SECTOR_BYTES);
  out.set(header, 0);
  sectors.forEach((sector, index) => {
    out.set(sector, SECTOR_BYTES + index * SECTOR_BYTES);
  });
  return out;
}

/** One BIFF record: type, little-endian length, payload. */
export const biffRecord = (type, payload = new Uint8Array(0)) => {
  const out = new Uint8Array(4 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, type, true);
  view.setUint16(2, payload.length, true);
  out.set(payload, 4);
  return out;
};

export const concatBytes = (chunks) => {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};
