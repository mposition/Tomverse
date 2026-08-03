/**
 * Incremental parser for a JSON file whose top level is one huge array.
 *
 * docs/policy/external-conversation-import-and-memory.md §5.1: ChatGPT's
 * `conversations.json` is a single array holding every conversation a person
 * has ever had. `JSON.parse` on that means the whole string *and* the whole
 * object graph resident at once, which is how a browser tab dies on a real
 * export. Entries at or under `maxSyncJsonParseBytes` may still use plain
 * `JSON.parse`; anything larger comes through here.
 *
 * This yields one top-level array item at a time and forgets it immediately,
 * so peak memory is one item, not the file. It is a scanner, not a validator:
 * it finds item boundaries by tracking string/escape state and nesting depth,
 * then hands the item text to `JSON.parse`, which is what actually decides
 * whether the item is valid JSON.
 *
 * Pure and isomorphic — the worker and the tests run the same code.
 */

export class ExternalImportJsonStreamError extends Error {
    constructor(
        message: string,
        public readonly reason:
            | "not_an_array"
            | "item_too_large"
            | "truncated"
            | "trailing_content"
    ) {
        super(message);
        this.name = "ExternalImportJsonStreamError";
    }
}

type ParserPhase = "before_array" | "between_items" | "in_item" | "after_array";

export type JsonArrayStreamOptions = {
    /**
     * Hard ceiling for one item's raw text. A single conversation larger than
     * this is refused rather than buffered — without it, a malformed file
     * with no closing bracket would be accumulated in full, which is the
     * failure mode this parser exists to prevent.
     */
    maxItemCharacters?: number;
};

const DEFAULT_MAX_ITEM_CHARACTERS = 64 * 1024 * 1024;

export class JsonArrayStreamParser {
    private phase: ParserPhase = "before_array";
    private item = "";
    private depth = 0;
    private inString = false;
    private escaped = false;
    private readonly maxItemCharacters: number;

    constructor(options: JsonArrayStreamOptions = {}) {
        this.maxItemCharacters =
            options.maxItemCharacters ?? DEFAULT_MAX_ITEM_CHARACTERS;
    }

    /** Feeds one chunk and returns every item completed by it. */
    push(chunk: string): unknown[] {
        const completed: unknown[] = [];
        for (let index = 0; index < chunk.length; index += 1) {
            const character = chunk[index];

            if (this.phase === "before_array") {
                if (isWhitespace(character)) continue;
                if (character !== "[") {
                    throw new ExternalImportJsonStreamError(
                        "The export's top level is not a JSON array.",
                        "not_an_array"
                    );
                }
                this.phase = "between_items";
                continue;
            }

            if (this.phase === "after_array") {
                if (isWhitespace(character)) continue;
                throw new ExternalImportJsonStreamError(
                    "Unexpected content after the top-level array.",
                    "trailing_content"
                );
            }

            if (this.phase === "between_items") {
                if (isWhitespace(character) || character === ",") continue;
                if (character === "]") {
                    this.phase = "after_array";
                    continue;
                }
                this.phase = "in_item";
                this.item = "";
                this.depth = 0;
                this.inString = false;
                this.escaped = false;
                // Fall through to item handling for this same character.
            }

            // phase === "in_item"
            this.item += character;
            if (this.item.length > this.maxItemCharacters) {
                throw new ExternalImportJsonStreamError(
                    "A single conversation entry exceeds the parser limit.",
                    "item_too_large"
                );
            }

            if (this.escaped) {
                this.escaped = false;
                continue;
            }
            if (this.inString) {
                if (character === "\\") this.escaped = true;
                else if (character === '"') this.inString = false;
                continue;
            }
            if (character === '"') {
                this.inString = true;
                continue;
            }
            // A scalar item (number, true, null…) has no brackets of its own,
            // so at depth 0 the array's own closing bracket is what ends it.
            // This has to be checked before the depth bookkeeping below, which
            // would otherwise read the terminator as closing a container.
            if (character === "]" && this.depth === 0) {
                const text = this.item.slice(0, -1).trim();
                if (text) completed.push(JSON.parse(text));
                this.phase = "after_array";
                this.item = "";
                continue;
            }
            if (character === "{" || character === "[") {
                this.depth += 1;
                continue;
            }
            if (character === "}" || character === "]") {
                this.depth -= 1;
                if (this.depth === 0) {
                    completed.push(JSON.parse(this.item));
                    this.phase = "between_items";
                    this.item = "";
                }
                continue;
            }
            if (character === "," && this.depth === 0) {
                const text = this.item.slice(0, -1).trim();
                if (text) completed.push(JSON.parse(text));
                this.phase = "between_items";
                this.item = "";
            }
        }
        return completed;
    }

    /**
     * Asserts the array actually closed. A pending item here means the file
     * was cut short — emitting it would turn a truncated download into a
     * silently partial import.
     */
    end(): void {
        if (this.phase !== "after_array") {
            throw new ExternalImportJsonStreamError(
                "The export ended before the top-level array closed.",
                "truncated"
            );
        }
    }
}

const isWhitespace = (character: string) =>
    character === " " ||
    character === "\n" ||
    character === "\r" ||
    character === "\t";
