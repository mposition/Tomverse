import { getModel } from "@/lib/models";

type ExportMessage = {
    role: string;
    content: string;
    modelId?: string | null;
    createdAt?: Date | string;
};

type ExportConversation = {
    title: string;
    createdAt?: Date | string;
    messages: ExportMessage[];
};

// Hand-maintained names for ids that predate the model registry and are no
// longer in the catalogue at all. Everything still in the catalogue -- including
// every RETIRED model, which is exactly why retirement never deletes an entry --
// resolves through getModel below, so an export of an old conversation prints
// "Llama 3.3" or "Grok 3 Mini" rather than a bare id.
const legacyModelNames: Record<string, string> = {
    "gpt-4o": "GPT-4o",
    "gemini-1-5": "Gemini 1.5",
};

const displayNameFor = (modelId: string) =>
    getModel(modelId)?.name || legacyModelNames[modelId] || modelId;

function formatDate(value?: Date | string) {
    if (!value) return "";
    const date = typeof value === "string" ? new Date(value) : value;
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function formatConversationAsText(conversation: ExportConversation) {
    return [
        formatConversationHeader(conversation),
        ...conversation.messages.map(formatExportMessage),
    ].join("\n");
}

export function formatConversationHeader(
    conversation: Pick<ExportConversation, "title" | "createdAt">,
    /**
     * The §13.3 notice, when an answer here could have been influenced by the
     * author's account memory. Passed in rather than read here: this module is
     * pure, and the caller is the one that knows whether injection was
     * available. Omitted entirely when it was not — a notice about a feature
     * that could not have run is noise, not disclosure.
     */
    personalizationNotice?: string,
    /**
     * The provenance lines a conversation continued from an imported chat
     * carries (docs/policy/external-conversation-continuation.md §9), built by
     * `continuationExportProvenance`.
     *
     * In the header rather than beside the first message, because it is a fact
     * about the whole document: every answer below it was produced with an
     * excerpt this file does not contain. Empty for every ordinary
     * conversation, which is nearly all of them.
     */
    continuationProvenance: readonly string[] = []
) {
    return [
        "Tomverse Review Export",
        `Conversation: ${headerLineText(conversation.title)}`,
        `Created: ${formatDate(conversation.createdAt)}`,
        ...(personalizationNotice ? [personalizationNotice] : []),
        ...continuationProvenance,
        "",
    ].join("\n");
}

export function formatExportMessage(message: ExportMessage) {
    const label =
        message.role === "user"
            ? "User"
            : message.modelId
              ? displayNameFor(message.modelId)
              : "Assistant";

    return [
        "==================================================",
        `[${label}]${
            message.createdAt ? ` ${formatDate(message.createdAt)}` : ""
        }`,
        "--------------------------------------------------",
        message.content,
        "",
    ].join("\n");
}

/**
 * A title as one header line.
 *
 * A title may contain line breaks, and written verbatim they would let it
 * start a line of its own -- a forged `Created:` or provenance line in a file
 * whose header is otherwise the server's word. The words stay; only the breaks
 * become spaces. This is the document's title, not a filename, so nothing else
 * is substituted here.
 */
function headerLineText(title: string) {
    return title.replace(/[\r\n\u2028\u2029]+/g, " ");
}

const FILE_NAME_MAX_CODE_POINTS = 80;
const FILE_NAME_FALLBACK = "conversation";
const TEXT_EXTENSION = ".txt";

// Names Windows refuses for a file whatever its extension: "CON.txt" is still
// the console device.
const RESERVED_WINDOWS_NAMES = new Set([
    "con",
    "prn",
    "aux",
    "nul",
    ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * A conversation title as a filename base (no extension).
 *
 * Cut by code point, not by UTF-16 unit: `slice()` on a string can split an
 * emoji's surrogate pair, and the lone half then makes `encodeURIComponent`
 * throw -- which turned an export of such a title into a 500.
 *
 * Removed rather than kept: control characters (a line break in a header value
 * is a header injection), bidirectional controls (an RLO can make "txt.exe"
 * display as "exe.txt"), leading dots (a hidden file) and trailing dots and
 * spaces (Windows drops them, so the name on disk would differ from the one
 * sent). The characters no filesystem accepts become "-".
 */
export function sanitizeFileName(name: string) {
    const cleaned = Array.from(
        name
            .replace(/[\x00-\x1f\x7f]/g, " ")
            .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
            .replace(/[/\\?%*:|"<>]/g, "-")
            .trim()
    )
        .slice(0, FILE_NAME_MAX_CODE_POINTS)
        .join("")
        .replace(/^[.\s]+/, "")
        .replace(/[.\s]+$/, "");
    if (!cleaned) return FILE_NAME_FALLBACK;
    const stem = cleaned.split(".")[0].trim().toLowerCase();
    return RESERVED_WINDOWS_NAMES.has(stem)
        ? `${cleaned}-${FILE_NAME_FALLBACK}`
        : cleaned;
}

/**
 * RFC 5987 `ext-value` encoding. `encodeURIComponent` leaves `'`, `(`, `)` and
 * `*` alone, and `'` is the delimiter of the `UTF-8''` prefix itself.
 */
function encodeRfc5987(value: string) {
    return encodeURIComponent(value).replace(
        /['()*]/g,
        (character) =>
            `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
}

/**
 * `Content-Disposition` for a single conversation's TXT export.
 *
 * Two fields, because one cannot do both jobs. A quoted `filename` is literal
 * and ASCII, so a Korean title percent-encoded into it arrived as the escapes
 * themselves -- `%ED%95%9C.txt` on disk. RFC 5987's `filename*` carries the
 * real name, and the quoted one is only the fallback for anything that ignores
 * it. Stripping a Korean title to ASCII used to leave ".txt", a hidden file
 * with no name; a fallback with nothing of the title left in it is the generic
 * name instead, the same rule `asciiArtifactFilename()` settled on.
 */
export function conversationExportContentDisposition(title: string) {
    const fileName = `${sanitizeFileName(title)}${TEXT_EXTENSION}`;
    // Sanitised again after the strip: removing "한" from "CON한" leaves a
    // reserved name, and removing a trailing word can leave a trailing dot.
    const asciiBase = sanitizeFileName(
        fileName.slice(0, -TEXT_EXTENSION.length).replace(/[^\x20-\x7e]/g, "")
    );
    const asciiFileName = /[A-Za-z0-9]/.test(asciiBase)
        ? `${asciiBase}${TEXT_EXTENSION}`
        : `${FILE_NAME_FALLBACK}${TEXT_EXTENSION}`;
    return `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}
