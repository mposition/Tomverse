/**
 * Text out of an Excel 97-2003 `.xls`.
 *
 * Contract: docs/policy/chat-attachment-formats.md.
 *
 * A BIFF8 workbook is a flat stream of typed records: a globals substream
 * holding the sheet names and the shared string table, then one substream per
 * sheet holding its cells. Values are spread across half a dozen record types
 * because Excel encodes an integer, a small decimal, a full double and a
 * string in four different ways to save bytes, so a reader that handles only
 * the obvious one silently returns a spreadsheet with most of its numbers
 * missing.
 *
 * The shared string table is the awkward part and the reason this is not a
 * fifty-line parser. A record's payload is capped at about 8KB, so the table
 * is split across CONTINUE records -- and a single string may straddle the
 * boundary, with a flag byte re-emitted at the start of the next block saying
 * whether the *rest* of it is one byte per character or two. Concatenating
 * the blocks first, which is the natural thing to write, corrupts every
 * string that happens to sit on a boundary.
 *
 * Formulas are read from their cached results, never evaluated. Nothing here
 * computes anything a spreadsheet asked for, and the macro storage is never
 * opened.
 */

import {
    LegacyOfficeError,
    type LegacyParseBudget,
} from "@/lib/legacyOffice/budget";
import { openCompoundFile, readCompoundStream } from "@/lib/legacyOffice/cfbf";
import { decodeCp1252 } from "@/lib/legacyOffice/codepage";

const RECORD_BOF = 0x0809;
const RECORD_EOF = 0x000a;
const RECORD_FILEPASS = 0x002f;
const RECORD_BOUNDSHEET = 0x0085;
const RECORD_SST = 0x00fc;
const RECORD_CONTINUE = 0x003c;
const RECORD_LABELSST = 0x00fd;
const RECORD_LABEL = 0x0204;
const RECORD_RSTRING = 0x00d6;
const RECORD_NUMBER = 0x0203;
const RECORD_RK = 0x027e;
const RECORD_MULRK = 0x00bd;
const RECORD_FORMULA = 0x0006;
const RECORD_STRING = 0x0207;
const RECORD_BOOLERR = 0x0205;

/** BOF substream types. */
const SUBSTREAM_WORKSHEET = 0x0010;

const utf16le = new TextDecoder("utf-16le");

const viewOf = (bytes: Uint8Array) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Named `BiffRecord`, not `Record`: the latter is the TypeScript utility. */
type BiffRecord = { type: number; data: Uint8Array };

/** Splits the workbook stream into records, bounded by the budget. */
const readRecords = (stream: Uint8Array, budget: LegacyParseBudget): BiffRecord[] => {
    const view = viewOf(stream);
    const records: BiffRecord[] = [];
    let at = 0;
    while (at + 4 <= stream.length) {
        budget.tick();
        const type = view.getUint16(at, true);
        const length = view.getUint16(at + 2, true);
        const start = at + 4;
        if (start + length > stream.length) break;
        records.push({ type, data: stream.subarray(start, start + length) });
        at = start + length;
    }
    if (records.length === 0) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    return records;
};

/**
 * A cursor over the shared string table's blocks that knows where one ends.
 *
 * Reads that straddle a boundary are the whole reason this exists, so the
 * boundary is a first-class thing here rather than something the caller has
 * to remember.
 */
class SharedStringCursor {
    private blockIndex = 0;
    private offset = 0;

    constructor(
        private readonly blocks: readonly Uint8Array[],
        private readonly budget: LegacyParseBudget
    ) {}

    private get block() {
        return this.blocks[this.blockIndex];
    }

    get exhausted() {
        return this.blockIndex >= this.blocks.length;
    }

    /** True when the current block has nothing left in it. */
    private atBlockEnd() {
        return this.exhausted || this.offset >= this.block.length;
    }

    private advanceBlock() {
        this.blockIndex += 1;
        this.offset = 0;
    }

    /** Moves to the next block when the current one cannot satisfy `count`. */
    private ensure(count: number) {
        while (!this.exhausted && this.block.length - this.offset < count) {
            this.advanceBlock();
        }
        if (this.exhausted) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }

    u8() {
        this.ensure(1);
        const value = this.block[this.offset];
        this.offset += 1;
        return value;
    }

    u16() {
        this.ensure(2);
        const value = viewOf(this.block).getUint16(this.offset, true);
        this.offset += 2;
        return value;
    }

    u32() {
        this.ensure(4);
        const value = viewOf(this.block).getUint32(this.offset, true);
        this.offset += 4;
        return value;
    }

    skip(count: number) {
        let remaining = count;
        while (remaining > 0 && !this.exhausted) {
            this.budget.tick();
            const available = this.block.length - this.offset;
            const take = Math.min(remaining, available);
            this.offset += take;
            remaining -= take;
            if (remaining > 0) this.advanceBlock();
        }
    }

    /**
     * One `XLUnicodeRichExtendedString`.
     *
     * The character data may cross into the next block, and when it does the
     * next block opens with a fresh one-byte flag: the second half of a
     * string can be stored differently from the first.
     */
    readString(): string {
        const characterCount = this.u16();
        let flags = this.u8();
        let wide = (flags & 0x01) !== 0;
        const rich = (flags & 0x08) !== 0;
        const extended = (flags & 0x04) !== 0;
        const runCount = rich ? this.u16() : 0;
        const extendedBytes = extended ? this.u32() : 0;

        let out = "";
        let remaining = characterCount;
        while (remaining > 0) {
            this.budget.tick();
            if (this.atBlockEnd()) {
                this.advanceBlock();
                if (this.exhausted) break;
                flags = this.u8();
                wide = (flags & 0x01) !== 0;
            }
            const available = this.block.length - this.offset;
            const readable = wide ? Math.floor(available / 2) : available;
            if (readable <= 0) {
                // An odd trailing byte in a wide run: the block cannot supply
                // another character, so move on rather than spin.
                this.advanceBlock();
                if (this.exhausted) break;
                flags = this.u8();
                wide = (flags & 0x01) !== 0;
                continue;
            }
            const take = Math.min(remaining, readable);
            const width = wide ? 2 : 1;
            const slice = this.block.subarray(this.offset, this.offset + take * width);
            out += wide ? utf16le.decode(slice) : decodeCp1252(slice);
            this.offset += take * width;
            remaining -= take;
        }

        this.skip(runCount * 4);
        this.skip(extendedBytes);
        return out;
    }
}

/**
 * The shared string table.
 *
 * Returns an array indexed the way `LABELSST` cells reference it. A table
 * that runs out mid-way yields the strings it had rather than failing the
 * workbook: the cells that reference the missing tail render as blank, which
 * is a better answer than none of the sheet at all.
 */
const readSharedStrings = (
    records: readonly BiffRecord[],
    sstIndex: number,
    budget: LegacyParseBudget
): string[] => {
    const blocks: Uint8Array[] = [records[sstIndex].data.subarray(8)];
    for (let index = sstIndex + 1; index < records.length; index += 1) {
        if (records[index].type !== RECORD_CONTINUE) break;
        blocks.push(records[index].data);
    }

    const header = viewOf(records[sstIndex].data);
    const uniqueCount = records[sstIndex].data.length >= 8 ? header.getUint32(4, true) : 0;
    const cursor = new SharedStringCursor(blocks, budget);
    const strings: string[] = [];
    for (let index = 0; index < uniqueCount; index += 1) {
        budget.tick();
        if (cursor.exhausted) break;
        try {
            strings.push(cursor.readString());
        } catch (error) {
            if (error instanceof LegacyOfficeError && error.code === "LEGACY_OFFICE_CORRUPT") {
                break;
            }
            throw error;
        }
    }
    return strings;
};

/**
 * An `RkNumber`: Excel's four-byte encoding for a value that would otherwise
 * need eight. Two flag bits say whether the payload is a 30-bit integer or
 * the top half of a double, and whether the result is divided by a hundred.
 */
const decodeRk = (raw: number): number => {
    const isInteger = (raw & 0x02) !== 0;
    const dividedBy100 = (raw & 0x01) !== 0;
    let value: number;
    if (isInteger) {
        value = raw >> 2;
    } else {
        const buffer = new ArrayBuffer(8);
        new DataView(buffer).setUint32(4, raw & 0xfffffffc, true);
        value = new DataView(buffer).getFloat64(0, true);
    }
    return dividedBy100 ? value / 100 : value;
};

/**
 * The seven error values a cell can hold, spelled the way the spreadsheet
 * spells them on screen.
 *
 * Rendered rather than dropped: "this column totals to #REF!" is a fact about
 * the workbook the person may well be asking about, and a blank cell where
 * Excel shows an error is the reader quietly disagreeing with the file.
 */
const ERROR_VALUES: Readonly<Record<number, string>> = {
    0x00: "#NULL!",
    0x07: "#DIV/0!",
    0x0f: "#VALUE!",
    0x17: "#REF!",
    0x1d: "#NAME?",
    0x24: "#NUM!",
    0x2a: "#N/A",
};

/**
 * How a number reaches the model.
 *
 * Trimmed to twelve significant digits because dividing an RK by a hundred
 * reintroduces binary floating-point noise that was never in the
 * spreadsheet: 678 stored as an RK comes back as 678, and 12.34 must not come
 * back as 12.340000000000001.
 */
const formatNumber = (value: number) => {
    if (!Number.isFinite(value)) return "";
    if (Number.isInteger(value)) return String(value);
    return String(Number(value.toPrecision(12)));
};

/**
 * A BIFF8 string whose length is a byte or a word depending on the record it
 * sits in. `BOUNDSHEET` uses a byte and `LABEL` uses a word, and reading a
 * sheet name with the wrong one produces a plausible-looking name from the
 * wrong bytes rather than an error.
 */
const readBiffString = (
    data: Uint8Array,
    at: number,
    lengthBytes: 1 | 2
): string => {
    if (at + lengthBytes + 1 > data.length) return "";
    const view = viewOf(data);
    const characterCount =
        lengthBytes === 1 ? data[at] : view.getUint16(at, true);
    const wide = (data[at + lengthBytes] & 0x01) !== 0;
    const start = at + lengthBytes + 1;
    const end = start + characterCount * (wide ? 2 : 1);
    if (end > data.length) return "";
    const slice = data.subarray(start, end);
    return wide ? utf16le.decode(slice) : decodeCp1252(slice);
};

const readInlineString = (data: Uint8Array, at: number) =>
    readBiffString(data, at, 2);

type SheetCells = Map<number, Map<number, string>>;

export function extractXlsText(
    bytes: Uint8Array,
    budget: LegacyParseBudget
): string {
    const container = openCompoundFile(bytes, budget);
    // Excel 97 wrote "Workbook"; Excel 5/95 wrote "Book". Both appear in the
    // wild inside files a user will call `.xls`.
    const stream =
        readCompoundStream(container, "Workbook") ?? readCompoundStream(container, "Book");
    if (!stream) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");

    const records = readRecords(stream, budget);
    if (records[0].type !== RECORD_BOF) {
        throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }

    // FILEPASS anywhere means the workbook is protected. Checked before
    // anything is interpreted, because every record after it is ciphertext
    // that would otherwise be read as structure.
    if (records.some((record) => record.type === RECORD_FILEPASS)) {
        throw new LegacyOfficeError("LEGACY_OFFICE_ENCRYPTED");
    }

    const sstIndex = records.findIndex((record) => record.type === RECORD_SST);
    const sharedStrings =
        sstIndex >= 0 ? readSharedStrings(records, sstIndex, budget) : [];

    const sheetNames: string[] = [];
    for (const record of records) {
        if (record.type !== RECORD_BOUNDSHEET) continue;
        // BoundSheet8: lbPlyPos (4), hsState (1), dt (1), then a string whose
        // length is a single byte.
        sheetNames.push(
            readBiffString(record.data, 6, 1) || `Sheet${sheetNames.length + 1}`
        );
    }

    const sheets: SheetCells[] = [];
    let current: SheetCells | null = null;
    const put = (row: number, column: number, value: string) => {
        if (!current || !value) return;
        let line = current.get(row);
        if (!line) {
            line = new Map();
            current.set(row, line);
        }
        line.set(column, value);
    };

    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        budget.tick();

        if (record.type === RECORD_BOF) {
            const substream =
                record.data.length >= 4 ? viewOf(record.data).getUint16(2, true) : 0;
            if (substream === SUBSTREAM_WORKSHEET) {
                current = new Map();
                sheets.push(current);
            } else {
                current = null;
            }
            continue;
        }
        if (record.type === RECORD_EOF) {
            current = null;
            continue;
        }
        if (!current) continue;

        const view = viewOf(record.data);
        switch (record.type) {
            case RECORD_LABELSST: {
                if (record.data.length < 10) break;
                const stringIndex = view.getUint32(6, true);
                put(
                    view.getUint16(0, true),
                    view.getUint16(2, true),
                    sharedStrings[stringIndex] ?? ""
                );
                break;
            }
            case RECORD_LABEL:
            case RECORD_RSTRING: {
                if (record.data.length < 6) break;
                put(
                    view.getUint16(0, true),
                    view.getUint16(2, true),
                    readInlineString(record.data, 6)
                );
                break;
            }
            case RECORD_NUMBER: {
                if (record.data.length < 14) break;
                put(
                    view.getUint16(0, true),
                    view.getUint16(2, true),
                    formatNumber(view.getFloat64(6, true))
                );
                break;
            }
            case RECORD_RK: {
                if (record.data.length < 10) break;
                put(
                    view.getUint16(0, true),
                    view.getUint16(2, true),
                    formatNumber(decodeRk(view.getUint32(6, true)))
                );
                break;
            }
            case RECORD_MULRK: {
                if (record.data.length < 6) break;
                const row = view.getUint16(0, true);
                const firstColumn = view.getUint16(2, true);
                const count = Math.floor((record.data.length - 6) / 6);
                for (let cell = 0; cell < count; cell += 1) {
                    budget.tick();
                    put(
                        row,
                        firstColumn + cell,
                        formatNumber(decodeRk(view.getUint32(4 + cell * 6 + 2, true)))
                    );
                }
                break;
            }
            case RECORD_FORMULA: {
                if (record.data.length < 14) break;
                const row = view.getUint16(0, true);
                const column = view.getUint16(2, true);
                // A cached result whose two high bytes are 0xFFFF is not a
                // number: its first byte says which kind, and a string result
                // arrives in the STRING record that follows.
                const isSpecial = view.getUint16(12, true) === 0xffff;
                if (!isSpecial) {
                    put(row, column, formatNumber(view.getFloat64(6, true)));
                    break;
                }
                const kind = record.data[6];
                if (kind === 0x00) {
                    const next = records[index + 1];
                    if (next?.type === RECORD_STRING) {
                        put(row, column, readInlineString(next.data, 0));
                    }
                } else if (kind === 0x01) {
                    put(row, column, record.data[8] ? "TRUE" : "FALSE");
                } else if (kind === 0x02) {
                    put(row, column, ERROR_VALUES[record.data[8]] ?? "#ERR");
                }
                break;
            }
            case RECORD_BOOLERR: {
                if (record.data.length < 8) break;
                put(
                    view.getUint16(0, true),
                    view.getUint16(2, true),
                    record.data[7] === 0
                        ? record.data[6]
                            ? "TRUE"
                            : "FALSE"
                        : (ERROR_VALUES[record.data[6]] ?? "#ERR")
                );
                break;
            }
            default:
                break;
        }
    }

    const lines: string[] = [];
    sheets.forEach((sheet, index) => {
        if (sheet.size === 0) return;
        const name = sheetNames[index] || `Sheet${index + 1}`;
        lines.push(`[Sheet: ${name}]`);
        for (const row of [...sheet.keys()].sort((a, b) => a - b)) {
            budget.tick();
            const cells = sheet.get(row);
            if (!cells) continue;
            const text = [...cells.keys()]
                .sort((a, b) => a - b)
                .map((column) => cells.get(column) ?? "")
                .join("\t");
            if (!text.trim()) continue;
            budget.claimCharacters(text.length + 1);
            lines.push(text);
        }
        lines.push("");
    });

    return lines.join("\n").trim();
}
