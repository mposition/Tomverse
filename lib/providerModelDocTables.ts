/**
 * Reading a provider's own pricing table when nobody wrote a parser for that
 * provider.
 *
 * ## Why generic
 *
 * OpenAI and Anthropic each have a parser that knows the shape of their page,
 * and that is affordable for two providers and not for twelve. The cost of not
 * having the other ten was measured on 2026-09-21: Zhipu's models API answers
 * with ids and nothing else, so five GLM candidates reached an operator with no
 * context window, no output ceiling and no price between them -- while
 * `docs.z.ai` published all of it as a markdown table.
 *
 * ## The rule this file follows
 *
 * **A number is read only when the document says what it is.** Not "unless it
 * looks foreign", not "unless the word 1K appears": the currency has to be
 * stated as US dollars and the unit as one million tokens, by the cell, its
 * column heading, or the page. Everything else is refused with a reason.
 *
 * That direction is the point. A missing price is a question an operator
 * answers in a minute; a wrong one is a rate that can reach a registry override
 * and be billed against. An earlier draft listed what to reject instead of what
 * to accept, and review found four ways a number could arrive wrong through it
 * -- a euro column, a per-1K column, a batch-discount table, and a sentence
 * about a different model.
 */

import type {
    DocLongContext,
    ProviderModelDocFields,
    ProviderModelDocParse,
} from "@/lib/providerModelDocsCore";

/**
 * How a provider writes the numbers in its table.
 *
 * `columns` is a column per number, which is what most pages do. `combined` is
 * Groq's single "PRICE PER 1M TOKENS" cell holding `$0.15 input$0.60 output`.
 */
export const DOC_TABLE_SHAPES = ["columns", "combined"] as const;
export type DocTableShape = (typeof DOC_TABLE_SHAPES)[number];

export type DocTable = {
    headers: string[];
    rows: string[][];
    /** The row as the provider wrote it, for finding a model id in any cell. */
    rowText: string[];
    /** Each row's cells before the markdown was flattened. */
    rawRows: string[][];
    /** The nearest heading above the table. */
    heading: string;
    /**
     * The headings this table sits under, outermost first, one per line.
     *
     * A table under "### Text Models" under "## Batch API Pricing" is a batch
     * table, and keeping only the nearest heading lost the word that said so.
     */
    ancestry?: string;
    /** The prose between that heading and the table, where a unit is stated. */
    preamble: string;
};

/** Markdown link, image and escape noise around the text that matters. */
const plainCell = (cell: string) =>
    cell
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*`]/g, "")
        .replace(/\\(.)/g, "$1")
        .replace(/\s+/g, " ")
        .trim();

const rawCells = (line: string) =>
    line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|");

const splitRow = (line: string) => rawCells(line).map((cell) => plainCell(cell));

const isSeparator = (line: string) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line);

/** Every markdown table in a document, with the heading it sits under. */
export const markdownTables = (markdown: string): DocTable[] => {
    const lines = markdown.split("\n");
    const tables: DocTable[] = [];
    let heading = "";
    /** By level, so a deeper heading does not erase the one it sits under. */
    const stack = new Map<number, string>();
    let preamble: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            heading = plainCell(headingMatch[2]);
            for (const deeper of [...stack.keys()]) {
                if (deeper >= level) stack.delete(deeper);
            }
            stack.set(level, heading);
            preamble = [];
            continue;
        }
        if (!line.trim().startsWith("|")) {
            if (line.trim()) preamble.push(plainCell(line));
            continue;
        }
        const next = lines[index + 1];
        if (!next || !isSeparator(next)) continue;
        const headers = splitRow(line);
        const rows: string[][] = [];
        const rowText: string[] = [];
        const raw: string[][] = [];
        let cursor = index + 2;
        while (cursor < lines.length && lines[cursor].trim().startsWith("|")) {
            rows.push(splitRow(lines[cursor]));
            raw.push(rawCells(lines[cursor]));
            rowText.push(lines[cursor]);
            cursor += 1;
        }
        tables.push({
            headers,
            rows,
            rawRows: raw,
            rowText,
            heading,
            ancestry: [...stack.entries()]
                .sort(([a], [b]) => a - b)
                .map(([, text]) => text)
                .join("\n"),
            preamble: preamble.join(" "),
        });
        preamble = [];
        // -1 because the loop increments: a heading on the line directly after
        // a table was skipped, and the discounted table under it inherited the
        // standard section it followed.
        index = cursor - 1;
    }
    return tables;
};

const columnIndex = (headers: readonly string[], match: RegExp) =>
    headers.findIndex((header) => match.test(header));

/** A page that answered 200 with a "page not found" body is not a document. */
export const isNotFoundDocument = (markdown: string) =>
    /^#+\s*4\d\d\b|page not found/im.test(markdown);

export type DocNumber =
    | { kind: "usd"; value: number }
    | { kind: "unreadable"; reason: string };

const PROMOTIONAL_TEXT =
    /free|promotion|limited[- ]time|introductory|temporar|trial/i;

/** Any sign that a number is not United States dollars. */
const FOREIGN_CURRENCY =
    /[¥₩€£₹]|\b(?:cny|rmb|krw|eur|gbp|jpy|aud|cad|nzd|sgd|hkd|twd|inr|chf|brl|mxn)\b|元|(?<![a-z])(?:a|c|ca|au|nz|s|hk|nt)\$|\b(?:euros?|yen|yuan|renminbi|won(?!['\u2019]t)|rupees?|francs?|reais|pesos?|shekels?|ringgit|baht|rupiah|zloty|krona|kronor|krone|kroner|rand|lira)\b|\b(?:australian|canadian|singaporean?|hong\s*kong|new\s*zealand|taiwanese?|british)\s+(?:dollars?|pounds?)\b|\bpounds?\s+sterling\b/i;

/**
 * A sentence that says which currency a table's numbers are in.
 *
 * Listing the currencies to reject cannot close: "New Taiwan dollars", "UAE
 * dirhams" and whatever the next provider writes all read as US dollars
 * because they are not on the list. So the question is turned around -- a
 * sentence that names the currency at all has to name this one.
 */
const PRICING_SENTENCE =
    /\b(?:prices?|priced|pricing|rates?|costs?|fees?|amounts?|billed|charged|denominated|quoted|expressed|listed|shown)\b/i;

/**
 * Where a currency phrase stops.
 *
 * "Prices are in USD per 1M tokens." states this currency and then states the
 * unit; requiring the phrase to be the whole rest of the clause refused it.
 */
const UNIT_TAIL =
    /\s+(?:per|for|when|with|on|at|and|plus|before|after|including|excluding|unless|based|according|across|from|until|up)\b/i;

/**
 * Where the sentence ends.
 *
 * Stopping at the first full stop cut "U.S. dollars" down to "U", and this
 * reader then refused the currency it accepts. A full stop ends the sentence
 * when the text runs out or a new sentence starts after it.
 */
const SENTENCE_END = /\.(?=\s+[A-Z]|\s*$)/;

/**
 * Phrases after "in" that are not a currency, so this one states none.
 *
 * "Prices shown in the table below" would otherwise refuse a perfectly plain
 * page. Missing an entry here costs a refusal rather than a wrong number, so
 * unlike a list of currencies to reject this one may be incomplete and still
 * be safe.
 */
const NOT_A_CURRENCY =
    /^(?:\d|the|this|that|these|those|a|an|our|your|its|their|table|tables|section|sections|page|order|addition|total|full|part|parts|terms|units?|increments?|blocks?|batches|accordance|line|lines|column|columns|row|rows|each|both|either|any|all|every|general|advance|arrears|which|what|effect|future|place|writing|bulk|real|some|most|other|one|two|three|case|practice|most|detail|full|separately|individually|respectively|differently|also|only|both|each|instead|likewise)\b/i;

/**
 * The one currency this reader accepts, however a page spells it.
 *
 * A bare "dollars" is not one of them. That word also ends "Canadian
 * dollars", and the cell reader already refuses it for the same reason.
 */
const USD_PHRASE =
    /^(?:usd|us\s+dollars?|u\.s\.?\s+dollars?|united\s+states\s+dollars?|american\s+dollars?|us\s*\$|\$)$/i;

/**
 * A sentence that gives each column its own currency.
 *
 * "Prices are in USD for input and UAE dirhams for output" states a currency
 * this reader accepts and one it has never heard of, and the second is not
 * introduced by an "in" of its own. A table whose columns are in different
 * currencies is not something this reader can represent, so it refuses rather
 * than reading the half it understood. One side named alone ("in USD for
 * input and output") is not this.
 */
const SIDE_CURRENCY =
    /([A-Za-z$][\w$.]{0,19}(?:\s+[A-Za-z][\w.]{0,19}){0,2})\s+for\s+(?:input|prompt|output|completion)\b/gi;

/**
 * The currency each column is priced in, where the sentence gives one to each.
 *
 * Judging the sentence's shape refused "shown in USD for input and separately
 * for output", which names one currency, and let "USD for input and AED for
 * output" through, which names two -- the second without an "in" of its own.
 * What matters is the words in front of each side.
 */
const sideCurrencyIsForeign = (sentence: string) => {
    for (const match of sentence.matchAll(SIDE_CURRENCY)) {
        const phrase = (match[1] ?? "")
            .replace(
                /^(?:(?:in|are|is|be|will|shown|quoted|listed|expressed|charged|billed|and|or|all|prices?|priced|pricing|rates?|amounts?)\s+)+/i,
                ""
            )
            .trim();
        if (!phrase || NOT_A_CURRENCY.test(phrase)) continue;
        if (!USD_PHRASE.test(phrase)) return true;
    }
    return false;
};

/**
 * Words this reader expects to find beside a price.
 *
 * A price cell is a number and, at most, the words that say what the number
 * is. "1.40 Saudi riyals" has a word this reader does not know in the one
 * place where an unknown word changes what the number means, so it refuses
 * rather than reading the number and dropping the word.
 */
const RECOGNISED_PRICE_WORD =
    /^(?:usd?|us|u\.s\.?|united|states|american|dollars?|mtok|tok|tokens?|token|per|million|thousand|input|output|cached|cache|write|read|storage|and|the|free|price|prices|pricing|rate|rates|cost|costs|standard|model|context|window|max|completion|speed|limits|developer|plan|file|size|sec|id|ids|new|for)$/i;

/**
 * A symbol beside a number that is not the one currency sign this reader
 * accepts.
 *
 * Listing the symbols to reject left "R$", "\u20bd" and the next one a page uses
 * reading as US dollars. What is listed instead is everything a price is
 * allowed to be made of, and a character outside it refuses the cell.
 */
const ALLOWED_PRICE_CHARACTER = /[0-9a-zA-Z$.,\s()/*+~<>=:;'"|[\]{}%-]/;

const usesAnUnknownPriceSymbol = (text: string) => {
    for (const character of text) {
        if (!ALLOWED_PRICE_CHARACTER.test(character)) return true;
    }
    return false;
};

/**
 * A short capitalised token beside a number, which is how a currency is
 * abbreviated when it is not written out: "1.40 SR", "R$ 1.40".
 */
const SHORT_CURRENCY_MARK = /(?:^|[\s(])([A-Z]{2}|[A-Z][a-z]?\$)(?=[\s)0-9]|$)/;

const namesAnUnknownPriceWord = (text: string) => {
    if (usesAnUnknownPriceSymbol(text)) return true;
    const mark = text.match(SHORT_CURRENCY_MARK);
    if (mark && !/^(?:US|us)$/.test(mark[1])) return true;
    for (const word of text.match(/[A-Za-z][A-Za-z']{2,}/g) ?? []) {
        if (!RECOGNISED_PRICE_WORD.test(word)) return true;
    }
    return false;
};

const statedCurrencyIsForeign = (context: string) => {
    for (const sentence of context.split(SENTENCE_END)) {
        if (!PRICING_SENTENCE.test(sentence)) continue;
        if (sideCurrencyIsForeign(sentence)) return true;
        // Every "in", not the first: "Prices shown in the table below are in
        // UAE dirhams" says nothing at the first one and everything at the
        // second, and stopping at the first read it as a plain page.
        for (const at of sentence.matchAll(/\bin\s+/gi)) {
            const rest = sentence.slice((at.index ?? 0) + at[0].length);
            const phrase = rest
                .split(/[,;)\n]/)[0]
                .split(UNIT_TAIL)[0]
                .replace(/\.+$/, "")
                .trim()
                .replace(/\s+/g, " ");
            if (!phrase || NOT_A_CURRENCY.test(phrase)) continue;
            if (!USD_PHRASE.test(phrase)) return true;
        }
    }
    return false;
};

/**
 * A currency code's shape: three capitals, as ISO 4217 writes every one of
 * them.
 *
 * "Input (AED)" is a currency claim whatever this reader has heard of, and a
 * list of codes to reject let every unlisted one through as US dollars.
 * Anything three capitals long that is not USD refuses the cell; a heading
 * that meant something else by it loses a number, which is the safe side.
 */
const CURRENCY_CODE_SHAPE = /\b([A-Z]{3})\b/g;

/**
 * Three capitals that are an English word rather than a currency.
 *
 * Groq writes "PRICE PER 1M TOKENS" in capitals, and "PER" sits against a
 * number exactly where a currency code would. Missing an entry here costs a
 * refused number, not a wrong one, so this list may be incomplete and stay
 * safe -- which is the opposite of listing the currencies to reject.
 */
const NOT_A_CURRENCY_CODE =
    /^(?:PER|AND|FOR|THE|OUT|NEW|MAX|MIN|AVG|SUM|TOK|TPM|RPM|TPS|QPS|API|SDK|SEC|HRS|DAY|ALL|ANY|VIA|USE|SEE|NOT|TBD|N\/A|KEY|IDS?|GPU|CPU|RAM|USA|EUR?OPE|ASIA|AWS|GCP|XML|CSV|PDF|URL|URI|SSL|TLS|JWT|CLI|IDE|LLM|JSON|HTTP|EST|UTC|PST|FAQ|DOC|ZIP|TXT|PNG|JPG|SVG|MP3|MP4|UAE|USA|UAT|DEV|PRD|QPM|TTL|VPC|SSO|SLA|SLO|TOS|GDR)$/;

const claimsAnotherCurrencyCode = (text: string) => {
    for (const match of text.matchAll(CURRENCY_CODE_SHAPE)) {
        const code = match[1] ?? "";
        if (!code || code === "USD" || NOT_A_CURRENCY_CODE.test(code)) continue;
        return true;
    }
    return false;
};

/**
 * A parenthetical in a price column or cell that is not about this currency
 * or this unit.
 *
 * "Input (UAE dirhams) per 1M tokens" names a currency in words, where no
 * code and no sentence appears. A bracket beside a price says something about
 * the price, and this reader refuses what it cannot read.
 */
const PRICE_PARENTHETICAL = /\(([^)]{1,40})\)/g;

const RECOGNISED_PARENTHETICAL =
    /^(?:us\s*\$?|u\.s\.?|usd|\$|us\s*dollars?|u\.?\s?s\.?\s*dollars?|united\s+states\s+dollars?|american\s+dollars?|dollars?|per\s+1\s*m\s*tokens?|usd\s+per\s+1\s*m\s*tokens?|1\s*m\s*tokens?|mtok|input|output|cached|cached\s+input|text|million|per\s+million\s+tokens?)$/i;

const claimsAnotherPriceMeaning = (text: string) => {
    for (const match of text.matchAll(PRICE_PARENTHETICAL)) {
        const inside = (match[1] ?? "").trim().replace(/\s+/g, " ");
        if (!inside || RECOGNISED_PARENTHETICAL.test(inside)) continue;
        return true;
    }
    return false;
};

/**
 * A positive statement that a number is United States dollars.
 *
 * A cell writes the currency as a prefix ("United States dollars 1.40"),
 * not as "in USD". The spellings are the same ones a sentence accepts
 * after "in"; a bare "dollars" is not one of them, because that word also
 * ends "Canadian dollars".
 */
const USD_STATED =
    /(?<![a-z])(?:us\s?\$|\$)|\b(?:united\s+states\s+dollars?|american\s+dollars?|u\.?\s?s\.?\s*dollars?|us\s+dollars?|usd)\b/i;

/** A positive statement that a price is per one million tokens. */
const PER_MILLION_STATED =
    /per\s*(?:1|one)?\s*m(?:illion)?\b|\/\s*1\s*m\b|\b1m\s*tokens?\b|per\s*1[,.]000[,.]000\b|\/\s*1[,.]000[,.]000\b/i;

/** Every "per <quantity> tokens" a piece of text states. */
const PER_TOKEN_QUANTITY = /(?:\bper\b|\/)\s*([^;)\n]{0,20}?)\s*\btokens?\b/gi;

/**
 * The one quantity this reader prices against.
 *
 * Listing the wrong quantities let "per 10,000 tokens" and "per 1 billion
 * tokens" through while refusing "per 1,000,000 tokens", which is what
 * Perplexity actually writes. The quantity has to be this one.
 */
const MILLION_QUANTITY =
    /^(?:(?:1|one)\s*)?m(?:illion)?\b|^1[,.]000[,.]000\b(?![,.]?\d)|^mtok\b/i;

const statesAnotherTokenQuantity = (text: string) => {
    for (const match of text.matchAll(PER_TOKEN_QUANTITY)) {
        const quantity = (match[1] ?? "").trim().replace(/\s+/g, " ");
        if (!MILLION_QUANTITY.test(quantity)) return true;
    }
    return false;
};

/** Any explicit unit other than one million tokens. */
const OTHER_UNIT_STATED =
    /per\s*\d+\s*k\b|\/\s*\d+\s*k\b|per\s*(?:1|one)?\s*k\b|per\s*\d{2,}\s*m\b|per\s*1?[,.]?000\b(?![,.]?\d)|\/\s*1?[,.]?000\b(?![,.]?\d)|per\s*(?:a\s+)?(?:thousand|hundred|dozen)\b|per\s*(?:request|image|call|invocation|character|word|second|minute|page)|\/\s*(?:request|image|call|invocation|character|second|minute|page)/i;

/**
 * Sections whose prices are not the standard rate.
 *
 * A batch or cache-only table prices the same model differently on purpose,
 * and reading the first table with an Input column made a 50%-off batch rate
 * indistinguishable from the rate a request pays.
 */
/**
 * A whole word, not a letter sequence inside another word.
 *
 * `search` used to match `research`, `scale` matched `scales`, and `flex`
 * matched `Flexible`. A heading that prices search still says `search`.
 * `fine-tuning` keeps the prefix, because that is the word providers write.
 */
const NON_STANDARD_SECTION =
    /\b(?:batch(?:es)?|discounts?|cache\s*(?:storage|writes?)|embeddings?|rerank|fine[-\s]?tun\w*|images?|audios?|speech|videos?|tools?|search|enterprises?|volumes?|committed|priority|flex|scale|provisioned|reserved|regions?|regional)\b/i;

/**
 * A rate word modifying a price noun, with at most two words between them.
 *
 * "Batch API prices" and "are discounted rates" name a rate wherever they
 * sit. "Image prices" does not: image is not a rate. A cache column inside
 * a standard table is not a rate either: "Prices below include cache write
 * rates" stays readable. "Caching prices" and "Prices for cache writes"
 * do not.
 */
const RATE_MODIFIES_PRICE =
    /\b(?:turbo|fast|accelerated|instant|rapid|priority|flex|batch(?:es)?|discount(?:ed)?s?|embeddings?|rerank|enterprises?|provisioned|reserved|regional|regions?|scale|committed)\b(?:\s+[a-z0-9.-]+){0,2}\s+(?:pricing|prices?|rates?|costs?|fees?)\b/i;

/**
 * "Prices … apply to batch requests." The subject is the price, and what it
 * applies to is another rate. "Flexible pricing is available" is not this
 * shape: its subject is not the price noun.
 */
const PRICES_APPLY_ELSEWHERE =
    /^(?:(?:the|all|our|these)\s+)*(?:pricing|prices?|rates?|costs?|fees?)\b(?:\s+[a-z0-9.-]+){0,4}?\s+(?:(?:apply|applies)\s+to|are\s+for)\s+(?:the\s+)?(?:turbo|fast|accelerated|instant|rapid|priority|flex|batch(?:es)?|discount(?:ed)?s?|embeddings?|rerank|enterprises?|provisioned|reserved|regional|regions?|scale|committed)\b/i;

const proseNamesAnotherRate = (sentence: string) => {
    if (RATE_MODIFIES_PRICE.test(sentence)) return true;
    // "cache write prices" and "prices for cache writes" name another rate.
    // "Cache hits are billed at 10% of the input rate" does not: cache is
    // not next to the price noun. "Cached input prices" is the standard
    // column, and "cached" is not "cache".
    const cacheRate = sentence.match(
        /\b(?:caching|cache(?:\s+(?:writes?|storage))?)\b(?:\s+[a-z0-9.-]+){0,2}\s+(?:pricing|prices?|rates?|costs?|fees?)\b/i
    );
    if (
        cacheRate &&
        cacheRate.index !== undefined &&
        !/\b(?:include|includes|including)\b/i.test(sentence.slice(0, cacheRate.index))
    ) {
        return true;
    }
    // "Prices for cache writes" names the rate. "Prices below include cache
    // write rates" says the standard table contains that column.
    if (
        /\b(?:pricing|prices?|rates?|costs?|fees?)\s+for\s+(?:caching|cache(?:\s+(?:writes?|storage))?)\b/i.test(
            sentence
        )
    ) {
        return true;
    }
    return PRICES_APPLY_ELSEWHERE.test(sentence);
};

/**
 * Sections a standard token price is published under.
 *
 * Required rather than assumed. Listing only the sections to reject left every
 * new tier name a provider invents -- "Priority processing", "Flex processing"
 * -- reading as the standard rate, and the next one would have to be found in
 * production. A table under a heading this does not recognise is left alone.
 */
const STANDARD_SECTION =
    /\b(?:model|pricing|price|rate|token|text|chat|llm|api|standard)/i;

/**
 * A section that names a rate tier other than the standard one.
 *
 * The allowlist alone cannot see these: a price table's own preamble always
 * says "Prices per 1M tokens", so "## Turbo processing" passed on the strength
 * of the sentence beneath it rather than the heading above it. A tier is
 * recognised by its shape instead -- a word in front of "processing", "tier",
 * "lane" or "queue" -- so a name no one has invented yet is still caught, and
 * only "standard" is the rate a plain request pays.
 */
/**
 * A serving tier: "Turbo processing", "Fast mode", "Fast lane".
 *
 * These words are how a page names a rate that is not the plain request.
 * "prices" is not one of them -- a paragraph says "provides pricing" without
 * naming a tier. A rate word in front of a price noun is judged on its own.
 */
const SERVING_TIER_SECTION =
    /\b([a-z0-9.-]+)\s+(?:processing|tiers?|lanes?|queues?|modes?)\b/gi;

/** The same shape anywhere in a heading: "Grok 4.7 Fast pricing". */
const PRICE_NOUN_SECTION =
    /\b([a-z0-9.-]+)\s+(?:pricing|prices?|rates?|costs?|fees?)\b/gi;

/**
 * What may qualify a price heading and still be the rate a plain request pays.
 *
 * Naming the tiers to reject cannot close -- "Fast mode pricing" is a real
 * heading at twice the standard rate, and the next provider will invent
 * another word. So the qualifier is what is checked: "Standard pricing",
 * "Model pricing" and "Text API Pricing" describe what is priced, while
 * "Fast", "Priority" and "Flex" describe how it is served.
 */
const STANDARD_PRICE_QUALIFIER =
    /^(?:standard|models?|tokens?|text|chat|llm|api|language|list|listed|published|displayed|quoted|stated|shown|our|these|the|usage|base|input|output|latest|all)$/i;

/** A heading that is only a noun: "Pricing", "Rates". */
const GENERIC_PRICE_NOUN = /^(?:pricing|prices?|rates?|costs?|fees?)$/i;

const headingWords = (heading: string) =>
    heading
        .replace(/^#+\s*/, "")
        // The contents, not just the brackets: "### Turbo (preview)" is a
        // one-word heading with a note on it, and counting "preview" as a
        // second word took it out of the rule that would have caught it.
        .replace(/\([^)]*\)/g, " ")
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/[[\]()#*_`]/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);

const qualifierIsStandard = (raw: string) =>
    STANDARD_PRICE_QUALIFIER.test(raw.replace(/[^a-z0-9]+$/i, ""));

const priceNounIsAnotherTier = (text: string, pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) {
        if (!qualifierIsStandard(match[1] ?? "")) return true;
    }
    return false;
};

const namesAnotherRateTier = (heading: string, where: "label" | "prose") => {
    // A provider that puts its tiers in one-word headings -- "Standard",
    // "Batch", "Flex", "Turbo" -- has no qualifier for the noun rule to read,
    // and every one of them passed. The word is the qualifier.
    const words = headingWords(heading);
    if (words.length === 1) {
        // "Pricing:" is the noun "Pricing". The colon is not a second word.
        const word = words[0].replace(/[^a-z0-9]+$/i, "");
        return !(
            STANDARD_PRICE_QUALIFIER.test(word) || GENERIC_PRICE_NOUN.test(word)
        );
    }
    // Every serving-tier match, not the first. "Standard prices … Turbo
    // processing" used to stop at Standard and read the turbo table.
    for (const match of heading.matchAll(
        new RegExp(SERVING_TIER_SECTION.source, "gi")
    )) {
        if (!qualifierIsStandard(match[1] ?? "")) return true;
    }
    // A heading may name the tier after other words: "Grok 4.7 Fast pricing".
    // A paragraph may not: "provides pricing" and "current prices" are
    // ordinary prose. "Turbo pricing per 1M tokens" opens a sentence the
    // way a heading does. Each sentence is judged on its own, so an earlier
    // "Standard prices" cannot hide a later "Turbo pricing".
    if (where === "label") {
        return priceNounIsAnotherTier(
            heading,
            new RegExp(PRICE_NOUN_SECTION.source, "gi")
        );
    }
    for (const sentence of heading.split(SENTENCE_END)) {
        const trimmed = sentence.replace(/^#+\s*/, "").trim();
        if (!trimmed) continue;
        if (proseNamesAnotherRate(trimmed)) return true;
    }
    return false;
};

export type DocumentUnits = {
    usd: boolean;
    perMillion: boolean;
    /** The table named a currency that is not US dollars. */
    foreignCurrency?: boolean;
};

/**
 * What the page itself states about currency and unit.
 *
 * Zhipu writes "All prices are in USD." in its introduction and "Prices per 1M
 * tokens." above the table, and its columns say only "Input". Without reading
 * the page such a table is either refused or read on trust; this is how it is
 * read on evidence.
 */
/**
 * What the page says its prices are in: this currency, another one, or
 * nothing.
 *
 * Both answers come from the same reading. Deciding "is it USD" from any
 * mention in the body while deciding "is it foreign" from a declaration left
 * the two questions answerable in opposite ways by the same page.
 */
/**
 * The prose as sentences, paragraph by paragraph.
 *
 * Headings are dropped rather than joined -- a sentence carrying the heading
 * above it never begins with the word that makes it a declaration -- and the
 * lines of a paragraph are joined, because "All prices are denominated\nin
 * USD." is one sentence a hard wrap split in half.
 */
const declarationSentences = (prose: string) =>
    prose
        .split(/\n\s*\n/)
        .flatMap((paragraph) =>
            paragraph
                .split("\n")
                .filter((line) => !/^\s*#{1,6}\s/.test(line))
                // Emphasis and link syntax are decoration: "**All prices are
                // in USD.**" left a trailing "**" on the currency, and
                // "[USD](url)" left the whole link.
                .map((line) =>
                    plainCell(line).replace(/[*_`]+/g, " ").replace(/^[>\s-]+/, "")
                )
                .join(" ")
                .split(SENTENCE_END)
        );

/**
 * What one sentence says about the currency its prices are in.
 *
 * One reading, used everywhere. The page, a table's heading, a table's
 * preamble and a cell were each asking this question with a different
 * combination of detectors, so a fix in one place left the same defect in the
 * other three -- which is what the reviews kept finding, round after round.
 *
 * `scoped` marks a sentence that ties its claim to part of the page. A scoped
 * sentence may still refuse (refusing is safe wherever it lands) but may not
 * establish this currency for a table it never claimed.
 */
type CurrencyClaim = {
    currency: "usd" | "foreign" | null;
    /** The sentence ties its claim to part of the page. */
    scoped: boolean;
    /**
     * The sentence named a currency and this reader could not say which
     * prices it was about.
     *
     * Different from silence: silence lets a wider declaration stand, and
     * this must not. "All prices, except cached input prices, are in USD."
     * beside a table with a cached-input column is not the page's plain
     * declaration repeated.
     */
    unattributable: boolean;
};

const NOTHING_CLAIMED: CurrencyClaim = {
    currency: null,
    scoped: false,
    unattributable: false,
};

const CANNOT_ATTRIBUTE: CurrencyClaim = {
    currency: null,
    scoped: false,
    unattributable: true,
};

/**
 * Where a sentence names this currency, if it does.
 *
 * A bare "dollars" is not a match. The cell reader refuses that spelling
 * because it is also the end of "Canadian dollars".
 */
const USD_AT =
    /\bin\s+(?:united\s+states\s+dollars?|american\s+dollars?|u\.?\s?s\.?\s*dollars?|us\s+dollars?|usd|us\s*\$)/i;

/** What may follow the currency and leave the claim about the whole page. */
const AFTER_CURRENCY =
    /^\s*(?:\(\s*usd\s*\)\s*)?(?:[,;.:]|\band\b|\bper\b|\bincluding\b|$)/i;

/**
 * The subject a page-wide declaration has.
 *
 * The qualifier is checked, not skipped: "Input prices are in USD." and
 * "Regional prices are in USD." each declare one kind of price, and allowing
 * any word in front of the noun let both stand for the page.
 */
const SUBJECT_IS_PRICES =
    /^\s*(?:(?:all|listed|published|displayed|quoted|stated|shown|api|token|model|our|these|the)\s+){0,2}(?:prices?|amounts?|rates?|fees?|charges?|costs?|payments?)\b/i;

/**
 * Prices named anywhere in front of the currency, however qualified.
 *
 * "pricing" belongs here for the same reason it belongs in a pricing
 * sentence: "## Model pricing in AED" names a currency, and without the
 * word the code after "in" was never asked.
 */
const MENTIONS_PRICES =
    /\b(?:pric(?:es?|ing|ed)|amounts?|rates?|fees?|charges?|costs?|payments?)\b/i;

/**
 * A price this reader can name: the word "prices", or a column.
 *
 * "except cached input" takes a column out without using the word "prices".
 * "excluding taxes" does neither, and the currency still covers the table.
 */
const NAMES_A_PRICE_KIND =
    /\b(?:prices?|amounts?|rates?|fees?|charges?|costs?|payments?|input|output|cached|cache|prompt|completion)\b/i;

/**
 * An inclusion that also takes a price back.
 *
 * "including image and tool prices" widens the subject and is removed before
 * the scope check. "including input but not output prices" widens and then
 * denies a column; stripping it would hide the denial.
 */
const inclusionDeniesAPrice = (text: string) => {
    const pattern = new RegExp(INCLUSION_CLAUSE.source, "gi");
    for (const match of text.matchAll(pattern)) {
        const clause = match[0] ?? "";
        if (
            (DENIES_SOMETHING.test(clause) || EXCEPTION_CLAUSE.test(clause)) &&
            NAMES_A_PRICE_KIND.test(clause)
        ) {
            return true;
        }
    }
    return false;
};

/** An opener that says nothing about which prices: "Unless otherwise noted,". */
const NOTE_PREFIX =
    /^\s*(?:unless\s+otherwise\s+noted|note|please\s+note(?:\s+that)?|n\.?b\.?)\s*[,:]\s*/i;

/** A clause that widens the subject rather than narrowing it. */
const INCLUSION_CLAUSE =
    /\b(?:including|incl\.?|such\s+as|as\s+well\s+as|plus)\b[^.;]*?(?=,\s*(?:are|is|will|shall)\b|[.;]|$)/gi;

/** A clause that takes something out of the subject. */
const EXCEPTION_CLAUSE =
    /\b(?:except|excluding|other\s+than|apart\s+from|aside\s+from|but\s+not)\b/i;

/** The same sentence with the currency denied: a statement of another one. */
const NEGATED_USD_DECLARATION =
    /(?:\b(?:not|never|no\s+longer)|n['\u2019]t)\s+(?:currently\s+|yet\s+)?(?:shown|quoted|listed|displayed|charged|denominated|billed|priced|payable)?\s*in\s+(?:us\s+dollars?|usd)\b/i;

/** Any denial at all, which this reader will not try to attribute. */
const DENIES_SOMETHING =
    /(?:\b(?:not|never|no\s+longer)\b|n['\u2019]t)/i;

/**
 * Words that tie a declaration to part of the page.
 */
/**
 * A declaration scoped to a table near it.
 *
 * "in the table below" is about the table it is written above; at that table
 * it is the declaration, and on the page it is nothing.
 */
const TABLE_SCOPE_FORWARD = /\b(?:table|section|chart|list)\b|\bbelow\b|\bfollowing\b/i;

/** The same, pointing the other way: about a table this is not. */
const TABLE_SCOPE_BACKWARD = /\babove\b|\bpreceding\b|\bearlier\b|\bprevious\b/i;

/**
 * A declaration scoped to something other than a table -- a kind of price, an
 * audience, a tier.
 *
 * This reader cannot check which rows it covers, so it refuses rather than
 * reading the table as if the sentence had not narrowed anything.
 */
const OTHER_SCOPE_WORD =
    /\b(?:tool|tools|image|images|video|audio|voice|speech|search|batch|tier|tiers|plan|plans|embedding|embeddings|rerank|fine[-\s]?tun\w*|customer|customers|region|regional|enterprise|priority|flex|account|accounts)\b/i;

type ScopeKind = "none" | "table" | "elsewhere";

const scopeKind = (text: string): ScopeKind => {
    if (TABLE_SCOPE_BACKWARD.test(text) || OTHER_SCOPE_WORD.test(text)) {
        return "elsewhere";
    }
    return TABLE_SCOPE_FORWARD.test(text) ? "table" : "none";
};

/** The columns a "for …" tail names, when it names any. */
const namedSides = (text: string) => ({
    input: /\b(?:input|prompt)\b/i.test(text),
    output: /\b(?:output|completion)\b/i.test(text),
});

/** Whether prices are the subject of the clause that reaches this point. */
const pricesInClauseBefore = (sentence: string, index: number) =>
    MENTIONS_PRICES.test(sentence.slice(0, index).split(/\band\b|[,;]/i).pop() ?? "");

const foreignCodeAt = (sentence: string) => {
    for (const match of sentence.matchAll(/\bin\s+([A-Z]{3})\b/g)) {
        const code = match[1] ?? "";
        if (code !== "USD" && !NOT_A_CURRENCY_CODE.test(code)) return match.index ?? -1;
    }
    return -1;
};

/**
 * Where a sentence names a currency this reader does not accept.
 *
 * The question turned around: a sentence that names the currency at all has
 * to name this one. Listing the currencies to reject never closed -- "New
 * Taiwan dollars", "UAE dirhams" and whatever a page writes next all read as
 * US dollars because they were not on the list.
 *
 * Only where prices are the subject, so "Models are shown in OCI." names a
 * cloud rather than a currency.
 */
const otherCurrencyPhraseAt = (sentence: string) => {
    for (const at of sentence.matchAll(/\bin\s+/gi)) {
        const index = at.index ?? 0;
        // In the same clause, not merely earlier in the sentence: "Prices are
        // listed below, and models are available in OCI." names a cloud in a
        // clause of its own.
        if (!pricesInClauseBefore(sentence, index)) continue;
        const phrase = sentence
            .slice(index + at[0].length)
            .split(/[,;:)\n]/)[0]
            .split("(")[0]
            .split(UNIT_TAIL)[0]
            .replace(/[.:;]+$/, "")
            .trim()
            .replace(/\s+/g, " ");
        if (!phrase || NOT_A_CURRENCY.test(phrase)) continue;
        if (USD_PHRASE.test(phrase)) continue;
        return index;
    }
    return -1;
};

const readCurrencyClaim = (raw: string): CurrencyClaim => {
    const sentence = raw.replace(NOTE_PREFIX, "");
    // A table whose columns are in different currencies is not something this
    // reader can represent, so it refuses rather than reading the half it
    // understood.
    const usdAt = sentence.search(USD_AT);
    const codeAt = foreignCodeAt(sentence);
    // The side rule reads the words in front of each column's name, so it
    // only applies to a sentence that names a currency at all -- in any
    // position, not only after an "in". Without that guard "Discounts are
    // available for input and output." read "available" as a currency; with
    // too narrow a guard "Prices: USD for input and AED for output" stopped
    // being caught.
    const namesAnyCurrency =
        USD_STATED.test(sentence) ||
        FOREIGN_CURRENCY.test(sentence) ||
        claimsAnotherCurrencyCode(sentence);
    if (namesAnyCurrency && sideCurrencyIsForeign(sentence)) {
        return { currency: "foreign", scoped: false, unattributable: false };
    }
    if (otherCurrencyPhraseAt(sentence) >= 0) {
        return { currency: "foreign", scoped: false, unattributable: false };
    }
    if (usdAt < 0 && codeAt < 0) return NOTHING_CLAIMED;

    // A code is a currency only where prices are the subject: "Models are
    // shown in OCI." names a cloud, and reading it as a currency refused a
    // page that had already declared this one.
    if (codeAt >= 0 && (usdAt < 0 || codeAt < usdAt)) {
        // In the clause that reaches the code, not merely earlier in the
        // sentence: "Prices are listed below, and models are available in
        // OCI." names a cloud in a clause of its own.
        return pricesInClauseBefore(sentence, codeAt)
            ? { currency: "foreign", scoped: false, unattributable: false }
            : NOTHING_CLAIMED;
    }

    if (NEGATED_USD_DECLARATION.test(sentence)) {
        return { currency: "foreign", scoped: false, unattributable: false };
    }
    if (!SUBJECT_IS_PRICES.test(sentence)) return NOTHING_CLAIMED;
    const tail = sentence.slice(usdAt).replace(USD_AT, "");
    // "in USD for input and output" gives both columns one currency; "in USD
    // for the table below" gives one table this one. Both start with "for",
    // and only the second names something to be scoped to.
    // A "for" tail is still a declaration; which prices it covers is what
    // scopeKind decides below.
    const tailForOk = /^\s*for\b/i.test(tail);
    if (!AFTER_CURRENCY.test(tail) && !tailForOk) {
        // "in USD excluding cached input" is the comma form without the
        // comma. Returning silence here let the page's plain declaration
        // stand for a table the nearer sentence had just taken a column
        // out of. "excluding taxes" names no column, and the currency stands.
        const takesAPriceBack =
            (EXCEPTION_CLAUSE.test(tail) || DENIES_SOMETHING.test(tail)) &&
            NAMES_A_PRICE_KIND.test(tail);
        if (takesAPriceBack) return CANNOT_ATTRIBUTE;
        if (!(EXCEPTION_CLAUSE.test(tail) || DENIES_SOMETHING.test(tail))) {
            return NOTHING_CLAIMED;
        }
    }

    // "including input but not output prices" has to be judged before the
    // inclusion is stripped, or the denial leaves with it.
    if (inclusionDeniesAPrice(sentence)) return CANNOT_ATTRIBUTE;

    // What follows the currency qualifies it as much as what precedes it:
    // "in USD, except cached input prices" and "in USD, for the table below"
    // were both read as plain declarations because a comma was all the tail
    // check looked at.
    const tailClean = tail.replace(INCLUSION_CLAUSE, " ");
    if (EXCEPTION_CLAUSE.test(tailClean) && NAMES_A_PRICE_KIND.test(tailClean)) {
        return CANNOT_ATTRIBUTE;
    }
    // "in USD, but cached input prices are not" takes a kind of price back
    // out after naming the currency.
    if (DENIES_SOMETHING.test(tailClean) && NAMES_A_PRICE_KIND.test(tailClean)) {
        return CANNOT_ATTRIBUTE;
    }
    // "for input and output" covers both columns. "for the table below"
    // names the table it is written above. Any other "for" names a slice
    // this reader cannot price the rest of the table from.
    if (/^\s*for\b/i.test(tail)) {
        const sides = namedSides(tailClean);
        const about = scopeKind(tailClean);
        const bothColumns = sides.input && sides.output;
        if (about === "elsewhere" || (!bothColumns && about !== "table")) {
            return CANNOT_ATTRIBUTE;
        }
    }
    const tailScope = scopeKind(tailClean);
    if (tailScope === "elsewhere") return CANNOT_ATTRIBUTE;

    const lead = sentence.slice(0, usdAt).replace(INCLUSION_CLAUSE, " ");
    const clauses = lead.split(/\band\b|[,;]/i);
    // A denial silences the declaration only when it is in the clause that
    // reaches the currency. "All prices do not include taxes and are in USD"
    // denies the taxes in a clause of their own; "Prices are not
    // tax-inclusive in USD" denies something this reader cannot name, right
    // where the currency is.
    if (DENIES_SOMETHING.test(clauses[clauses.length - 1] ?? "")) {
        return CANNOT_ATTRIBUTE;
    }
    // An exception silences it when it takes away a kind of price.
    // "excluding taxes" does not; "except cached input prices" does.
    if (
        clauses.some(
            (clause) => EXCEPTION_CLAUSE.test(clause) && NAMES_A_PRICE_KIND.test(clause)
        )
    ) {
        return CANNOT_ATTRIBUTE;
    }
    const leadScope = scopeKind(lead);
    if (leadScope === "elsewhere") return CANNOT_ATTRIBUTE;
    return {
        currency: "usd",
        scoped: leadScope === "table" || tailScope === "table",
        unattributable: false,
    };
};

/** What a stretch of prose says its prices are in. */
/**
 * What a stretch of prose says, at the position it was found.
 *
 * `blocked` is not silence. A context that named a currency and could not say
 * which prices it meant must not fall through to a wider declaration
 * elsewhere on the page, because the wider one is what the nearer sentence
 * was qualifying.
 *
 * A scoped declaration counts where the thing it scopes to is the thing being
 * read: "All prices in the table below are in USD." above this table is about
 * this table. On the page, away from any table, the same sentence establishes
 * nothing.
 */
type ProseCurrency = "usd" | "foreign" | "blocked" | null;

const proseCurrency = (text: string, about: "page" | "table"): ProseCurrency => {
    let usd = false;
    let blocked = false;
    for (const sentence of declarationSentences(text)) {
        const claim = readCurrencyClaim(sentence);
        if (claim.currency === "foreign") return "foreign";
        if (claim.currency === "usd" && (about === "table" || !claim.scoped)) {
            usd = true;
        }
        if (claim.unattributable) blocked = true;
    }
    // Blocked outranks a plain declaration in the same prose: the sentence
    // that could not be attributed was qualifying the one beside it.
    if (blocked) return "blocked";
    return usd ? "usd" : null;
};

const pageDeclaredCurrency = (prose: string): "usd" | "foreign" | null => {
    const declared = proseCurrency(prose, "page");
    if (declared === "foreign") return "foreign";
    // A currency word anywhere on the page refuses it, whatever the sentence
    // was about. Deciding which table a loose sentence meant is the question
    // with no finite answer.
    if (FOREIGN_CURRENCY.test(prose)) return "foreign";
    return declared === "usd" ? "usd" : null;
};

export const documentUnits = (markdown: string | null): DocumentUnits => {
    if (!markdown) return { usd: false, perMillion: false };
    const prose = markdown
        .split("\n")
        .filter((line) => !line.trim().startsWith("|"))
        .join("\n");
    const declared = pageDeclaredCurrency(prose);
    return {
        // A currency declared once covers the page, in either direction:
        // "All prices are in USD." and "All prices are in Canadian dollars."
        // are the same sentence with different answers.
        usd: declared === "usd",
        foreignCurrency: declared === "foreign",
        // The unit does not. The same page prices tokens per million and tools
        // per invocation, so the unit is read from the table's own heading and
        // the line above it.
        perMillion: false,
    };
};

/** What the table's own heading and preamble state, over the page's currency. */
const tableUnits = (table: DocTable, page: DocumentUnits): DocumentUnits => {
    const context = `${table.heading} ${table.preamble}`;
    // Nearest first, and each on its own. Joining the heading to the preamble
    // made one sentence out of two and let a word from either qualify the
    // other.
    const claim =
        proseCurrency(table.preamble, "table") ?? proseCurrency(table.heading, "table");
    const foreignCurrency =
        page.foreignCurrency === true ||
        claim === "foreign" ||
        FOREIGN_CURRENCY.test(context) ||
        claimsAnotherPriceMeaning(table.heading) ||
        claimsAnotherPriceMeaning(table.preamble);
    return {
        // This context's own claim outranks the page's, and silence here
        // falls back to the page. There is no reading of a bare "USD" as a
        // declaration any more: that fallback is what kept reviving the
        // sentences this reader had decided it could not attribute.
        // This context's own claim outranks the page's, and only silence
        // here falls back to it. A context that could not attribute what it
        // read blocks the fallback rather than deferring to it.
        usd: !foreignCurrency && (claim === "usd" || (claim === null && page.usd)),
        perMillion:
            PER_MILLION_STATED.test(context) && !OTHER_UNIT_STATED.test(context),
        foreignCurrency,
    };
};

/**
 * One price cell as a number, or the reason it is not one.
 *
 * The heading and the page are part of the reading. A bare `0.15` under
 * `Input (EUR)` is fifteen euro cents, under `Input / 1K tokens` it is a
 * thousandth of what it looks like, and with nothing stated anywhere it is a
 * number this reader has no business turning into a rate.
 *
 * `Free` is refused rather than read as zero: a free tier is a commercial state
 * that ends, and a zero rate would make a model look costless to every credit
 * calculation downstream.
 */
export const docPriceCell = (
    raw: string,
    header = "",
    document: DocumentUnits = { usd: false, perMillion: false }
): DocNumber => {
    const cell = plainCell(raw);
    const heading = plainCell(header);
    if (!cell || cell === "-" || cell === "—" || /^n\/?a$/i.test(cell)) {
        return { kind: "unreadable", reason: "empty" };
    }
    if (
        document.foreignCurrency ||
        FOREIGN_CURRENCY.test(cell) ||
        FOREIGN_CURRENCY.test(heading) ||
        claimsAnotherCurrencyCode(cell) ||
        claimsAnotherCurrencyCode(heading) ||
        statedCurrencyIsForeign(cell) ||
        statedCurrencyIsForeign(heading) ||
        claimsAnotherPriceMeaning(cell) ||
        claimsAnotherPriceMeaning(heading)
    ) {
        return { kind: "unreadable", reason: "not_usd" };
    }
    if (/contact|sales|enterprise|quote/i.test(cell)) {
        return { kind: "unreadable", reason: "not_published" };
    }
    if (PROMOTIONAL_TEXT.test(cell)) {
        return { kind: "unreadable", reason: "promotional_or_free" };
    }
    if (
        OTHER_UNIT_STATED.test(cell) ||
        OTHER_UNIT_STATED.test(heading) ||
        statesAnotherTokenQuantity(cell) ||
        statesAnotherTokenQuantity(heading)
    ) {
        return { kind: "unreadable", reason: "unit_not_per_million" };
    }
    if (!USD_STATED.test(cell) && !USD_STATED.test(heading) && !document.usd) {
        return { kind: "unreadable", reason: "currency_unstated" };
    }
    if (
        !PER_MILLION_STATED.test(heading) &&
        !PER_MILLION_STATED.test(cell) &&
        !document.perMillion
    ) {
        return { kind: "unreadable", reason: "unit_unstated" };
    }
    // "USD 1.40 per 1M tokens" holds one price and one quantity. Counting the
    // quantity as a second price made the cell ambiguous to itself.
    const priced = cell
        .replace(PER_MILLION_STATED, " ")
        .replace(/\bper\s+(?:1\s*)?m(?:illion)?\b/gi, " ")
        .replace(/\btokens?\b/gi, " ");
    const numbers = priced.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
    if (numbers.length === 0) return { kind: "unreadable", reason: "unparsed" };
    // A cell holding two numbers is a cell this reader cannot choose from: a
    // struck-through old price beside the new one, a regional range, a
    // "was/now" pair. Picking the first is how the old price wins.
    if (numbers.length > 1) {
        return { kind: "unreadable", reason: "ambiguous_value" };
    }
    const value = Number.parseFloat((numbers[0] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(value) || value < 0) {
        return { kind: "unreadable", reason: "unparsed" };
    }
    // Last, because everything above says something more specific. A word
    // this reader does not know, sitting where a word changes what the number
    // means, is the difference between "1.40" and "1.40 Saudi riyals".
    if (namesAnUnknownPriceWord(cell) || namesAnUnknownPriceWord(heading)) {
        return { kind: "unreadable", reason: "not_usd" };
    }
    return { kind: "usd", value };
};

/** `131,072`, `500k`, `1M`, `1M tokens` as a token count. */
export const docTokenCell = (raw: string): number | null => {
    const cell = plainCell(raw).toLowerCase();
    const match = cell.match(/(\d[\d,]*(?:\.\d+)?)\s*([km])?/);
    if (!match) return null;
    const value = Number.parseFloat(match[1].replace(/,/g, ""));
    if (!Number.isFinite(value) || value <= 0) return null;
    const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
    const tokens = Math.round(value * scale);
    return tokens > 0 ? tokens : null;
};

const escapeRegExp = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, (match) => `\\${match}`);

/**
 * Whether a piece of text names this model id.
 *
 * The id has to appear whole, with an identifier boundary on both sides. That
 * boundary excludes `-` and `_` as well as letters and digits, which is the
 * difference between `glm-5.3` and `glm-5.3-flash`: without it every Flash row
 * also answers to the base model's id and the two prices swap.
 */
export const textNamesModel = (apiModel: string, text: string) => {
    const lower = text.toLowerCase();
    const full = apiModel.trim().toLowerCase();
    const variants = Array.from(
        new Set([full, full.slice(full.lastIndexOf("/") + 1)].filter(Boolean))
    );
    return variants.some((variant) =>
        new RegExp(
            `(^|[^a-z0-9._-])${escapeRegExp(variant)}([^a-z0-9._-]|$)`,
            "i"
        ).test(lower)
    );
};

export type PricingRowMatch = {
    cells: string[];
    text: string;
    headers: string[];
    /** What this row's own table says about currency and unit. */
    units: DocumentUnits;
};

export type GenericPricingRead = {
    matches: PricingRowMatch[];
    problems: string[];
};

const MODEL_COLUMN = /^\s*models?(?:\s*id)?\s*$/i;

/**
 * Whether a model column's cell names this model.
 *
 * A link destination is not what the row says the model is. Groq writes
 * "[![Meta](logo)Llama 3.1 8B](/docs/model/llama-3.1-8b-instant)llama-3.1-8b-instant"
 * and the id it means is the one printed after the link, so the destinations
 * come out first; what remains has to name the model either with an
 * identifier boundary on both sides -- xAI's "grok-4.7 (< 200k prompt
 * tokens)" -- or by ending the cell, which is how Groq glues the id to the
 * display name in front of it.
 */
const cellNamesModel = (apiModel: string, cell: string) => {
    const shown = cell.replace(/\]\([^)]*\)/g, "]").trim();
    const bare = apiModel.trim().toLowerCase();
    const lower = shown.toLowerCase();
    // A document cell that carries a namespace has to carry this one.
    // "vendor-b/target-1" and "xvendor-a/target-1" are other models, and
    // matching the last segment on its own let either answer for
    // "vendor-a/target-1". A query that carries a prefix the document omits
    // is still the same model, so that relaxation survives only where the
    // cell names no namespace at all.
    if (shown.includes("/")) {
        const found = lower.lastIndexOf(bare);
        if (found >= 0) {
            const before = found === 0 ? "" : shown[found - 1] ?? "";
            // Both ends: "vendor-a/target-1-pro" and "vendor-a/target-10" are
            // other models, and checking only what came before let either
            // answer for "vendor-a/target-1".
            const after = shown[found + bare.length] ?? "";
            if (
                !/[A-Za-z0-9._/-]/.test(before) &&
                !/[A-Za-z0-9._/-]/.test(after)
            ) {
                return true;
            }
        }
    } else if (textNamesModel(apiModel, shown)) {
        return true;
    }
    const at = lower.length - bare.length;
    if (at < 0 || lower.slice(at) !== bare) return false;
    if (at === 0) return true;
    // Groq glues the id to the display name in front of it, but only in two
    // shapes: after a capital that ends the display name ("GPT OSS
    // 120Bopenai/gpt-oss-120b"), or after a badge word ("Enterprisellama-...").
    // Allowing any letter let "pretendtarget-1" answer for "target-1".
    const before = shown[at - 1] ?? "";
    if (/[A-Z]/.test(before)) return true;
    return /(?:enterprise|preview|beta|new|deprecated|production|featured)$/i.test(
        shown.slice(0, at)
    );
};
const INPUT_COLUMN = /^(?!.*cach).*input/i;
const CACHED_INPUT_COLUMN = /cach.*input(?!.*storage)/i;
const OUTPUT_COLUMN = /output/i;
const COMBINED_PRICE_COLUMN = /price/i;

/**
 * The rows that name a model, from a table pricing models at the standard rate.
 *
 * A table under a batch, cache or embedding heading is skipped rather than
 * read: those price the same model on different terms, and nothing in the row
 * says so.
 */
/**
 * A table's column row, written the one way this reader compares them.
 */
export const normalisedHeaderRow = (headers: readonly string[]) =>
    headers.map((cell) => cell.trim().toLowerCase().replace(/\s+/g, " ")).join(" | ");

export const readPricingRows = (
    markdown: string,
    apiModel: string,
    shape: DocTableShape,
    page: DocumentUnits = { usd: false, perMillion: false },
    expectedHeaders?: readonly string[]
): GenericPricingRead => {
    const problems: string[] = [];
    const priced = markdownTables(markdown).filter((table) =>
        shape === "combined"
            ? columnIndex(table.headers, COMBINED_PRICE_COLUMN) >= 0
            : columnIndex(table.headers, INPUT_COLUMN) >= 0 &&
              columnIndex(table.headers, OUTPUT_COLUMN) >= 0
    );
    if (priced.length === 0) {
        return { matches: [], problems: ["pricing_table_not_found"] };
    }
    // The shape this provider's standard table has, recorded when a person
    // read the page. Every rule above asks whether something is wrong with a
    // table; this one asks whether it is the table at all, and that is the
    // only question with a finite answer. A provider that changes its columns
    // stops being readable rather than being read wrongly.
    const shaped = expectedHeaders?.length
        ? priced.filter((table) =>
              expectedHeaders.includes(normalisedHeaderRow(table.headers))
          )
        : priced;
    if (shaped.length === 0) {
        return { matches: [], problems: ["pricing_table_shape_unrecognised"] };
    }
    const standard = shaped.filter((table) => {
        // The preamble claims a rate as surely as the heading does -- "# Pricing"
        // over "Fast mode prices per 1M tokens" is a fast-mode table -- and an
        // ancestor heading claims it for everything nested under it.
        // An inclusion clause names other kinds of price without being about
        // them: "All prices, including image and tool prices, are in USD."
        // sits above an ordinary model table and made it look like an image
        // table.
        const preamble = table.preamble.replace(INCLUSION_CLAUSE, " ");
        const heading = table.heading.replace(INCLUSION_CLAUSE, " ");
        const ancestry = (table.ancestry ?? "").replace(INCLUSION_CLAUSE, " ");
        if (
            namesAnotherRateTier(heading, "label") ||
            namesAnotherRateTier(preamble, "prose") ||
            ancestry.split("\n").some((line) => namesAnotherRateTier(line, "label"))
        ) {
            return false;
        }
        // The heading is what claims a rate; the sentence under it is the same
        // sentence under every table. Reading both together let any heading
        // pass on the strength of its preamble saying "Prices per 1M tokens",
        // which "### Turbo [preview](url)" did after the link was flattened.
        const claim = heading.trim() || preamble.trim();
        // Nothing said is not a claim to a different rate: a table at the top
        // of a page with no heading above it stays readable.
        if (!claim) return true;
        // The non-standard word is read on the headings, not on the
        // paragraph. "built in browser search" and "models and tools" sit
        // above an ordinary price table. A paragraph that itself opens with
        // "Batch prices" or "Turbo pricing" is still another rate, and that
        // is namesAnotherRateTier above.
        return (
            STANDARD_SECTION.test(claim) &&
            !NON_STANDARD_SECTION.test(`${ancestry}\n${heading}`)
        );
    });
    if (standard.length === 0) {
        return { matches: [], problems: ["pricing_table_not_standard_rate"] };
    }
    const matches: PricingRowMatch[] = [];
    for (const table of standard) {
        // Which column holds the ids. Matching the whole row meant an id that
        // happened to appear in a cached-input cell claimed that row, and the
        // model asked about was answered with another model's prices.
        const idColumn = columnIndex(table.headers, MODEL_COLUMN);
        table.rows.forEach((cells, index) => {
            const named =
                idColumn >= 0
                    ? cellNamesModel(apiModel, (table.rawRows[index] ?? [])[idColumn] ?? "")
                    : textNamesModel(apiModel, table.rowText[index] ?? "");
            if (!named) return;
            // A row whose width disagrees with its header is a row this reader
            // cannot say which column each value came from.
            if (cells.length !== table.headers.length) {
                problems.push("row_width_mismatch");
                return;
            }
            matches.push({
                cells,
                text: table.rowText[index],
                headers: table.headers,
                units: tableUnits(table, page),
            });
        });
    }
    if (matches.length === 0 && problems.length === 0) {
        problems.push("model_row_not_found");
    }
    return { matches, problems };
};

const cellAt = (row: PricingRowMatch, match: RegExp) => {
    const index = columnIndex(row.headers, match);
    return index >= 0 ? (row.cells[index] ?? "") : "";
};

/** A cell read as a price, with the heading it sits under and the page. */
const pricedCellAt = (row: PricingRowMatch, match: RegExp): DocNumber => {
    const index = columnIndex(row.headers, match);
    if (index < 0) return { kind: "unreadable", reason: "empty" };
    return docPriceCell(row.cells[index] ?? "", row.headers[index] ?? "", row.units);
};

type TierBoundary = { inclusiveMax: number; side: "low" | "high" };

/**
 * The boundary a row's own label states, as an inclusive prompt ceiling.
 *
 * `< 200k` and `>= 200k` describe one boundary from opposite sides, and the low
 * price stops one token *below* 200,000. Stored inclusively because that is how
 * the pricing profile reads it (`promptTokens <= maxPromptTokens`); keeping
 * 200,000 would have charged a 200,000-token prompt the cheap rate the provider
 * charges the expensive one for.
 */
const tierBoundary = (text: string): TierBoundary | null => {
    const match = text.match(
        /(<=|>=|<|>|≤|≥|less than|under|below|over|above|at least|from)\s*(\d[\d,]*\s*[km]?)/i
    );
    if (!match) return null;
    const tokens = docTokenCell(match[2]);
    if (!tokens) return null;
    const operator = match[1].toLowerCase();
    if (/^(?:<|less than|under|below)$/.test(operator)) {
        return { inclusiveMax: tokens - 1, side: "low" };
    }
    if (/^(?:<=|≤)$/.test(operator)) {
        return { inclusiveMax: tokens, side: "low" };
    }
    if (/^(?:>=|≥|at least|from)$/.test(operator)) {
        return { inclusiveMax: tokens - 1, side: "high" };
    }
    // `>` and "over": the high side starts above N, so the low side ends at N.
    return { inclusiveMax: tokens, side: "high" };
};

/**
 * The long-context tier a provider writes as two rows of one model.
 *
 * Two rows for one id are a tier only when they say so: one low side, one high
 * side, the same boundary, and a cache column that either scales with input or
 * states that it does not. Anything else is two rows this reader will not
 * choose between.
 */
const tierFromRows = (
    rows: readonly PricingRowMatch[]
): {
    short: PricingRowMatch;
    longContext: DocLongContext;
    problems: string[];
} | null => {
    if (rows.length !== 2) return null;
    const first = tierBoundary(rows[0].text);
    const second = tierBoundary(rows[1].text);
    if (!first || !second) return null;
    if (first.side === second.side) return null;
    if (first.inclusiveMax !== second.inclusiveMax) return null;
    const shortRow = first.side === "low" ? rows[0] : rows[1];
    const longRow = shortRow === rows[0] ? rows[1] : rows[0];
    const shortInput = pricedCellAt(shortRow, INPUT_COLUMN);
    const longInput = pricedCellAt(longRow, INPUT_COLUMN);
    const shortOutput = pricedCellAt(shortRow, OUTPUT_COLUMN);
    const longOutput = pricedCellAt(longRow, OUTPUT_COLUMN);
    if (
        shortInput.kind !== "usd" ||
        longInput.kind !== "usd" ||
        shortOutput.kind !== "usd" ||
        longOutput.kind !== "usd" ||
        shortInput.value === 0 ||
        shortOutput.value === 0
    ) {
        return null;
    }
    const inputMultiplier = longInput.value / shortInput.value;
    const outputMultiplier = longOutput.value / shortOutput.value;
    const shortCached = pricedCellAt(shortRow, CACHED_INPUT_COLUMN);
    const longCached = pricedCellAt(longRow, CACHED_INPUT_COLUMN);
    const problems: string[] = [];
    let cacheTakesInputMultiplier = false;
    if (
        shortCached.kind !== "usd" ||
        longCached.kind !== "usd" ||
        shortCached.value <= 0
    ) {
        // Recorded rather than assumed. A reader downstream must not take this
        // `false` for "the cache rate stays flat above the threshold".
        problems.push("long_context_cache_unstated");
    } else {
        const cacheMultiplier = longCached.value / shortCached.value;
        if (Math.abs(cacheMultiplier - inputMultiplier) < 0.001) {
            cacheTakesInputMultiplier = true;
        } else if (Math.abs(cacheMultiplier - 1) < 0.001) {
            problems.push("long_context_cache_flat");
        } else {
            problems.push("long_context_cache_multiplier_mismatch");
            return { short: shortRow, longContext: { kind: "unknown" }, problems };
        }
    }
    return {
        short: shortRow,
        longContext: {
            kind: "tiered",
            thresholdTokens:
                first.side === "low" ? first.inclusiveMax : second.inclusiveMax,
            inputMultiplier,
            outputMultiplier,
            cacheTakesInputMultiplier,
        },
        problems,
    };
};

/**
 * `$0.15 input$0.60 output` in one cell.
 *
 * The whole cell and its heading are judged before the cell is split. Splitting
 * first threw the currency and the unit away with the rest of the text, so a
 * euro cell and a per-1K column both read as clean USD per-million prices.
 */
const combinedPrices = (row: PricingRowMatch) => {
    const index = columnIndex(row.headers, COMBINED_PRICE_COLUMN);
    const header = index >= 0 ? (row.headers[index] ?? "") : "";
    const text = plainCell(index >= 0 ? (row.cells[index] ?? "") : "");
    const refusal = (reason: string) => ({ kind: "unreadable", reason }) as const;
    if (!text) return { input: refusal("empty"), output: refusal("empty") };
    if (
        FOREIGN_CURRENCY.test(text) ||
        FOREIGN_CURRENCY.test(header) ||
        claimsAnotherCurrencyCode(text) ||
        claimsAnotherCurrencyCode(header)
    ) {
        return { input: refusal("not_usd"), output: refusal("not_usd") };
    }
    // The unit belongs to the whole cell as much as the currency does. Reading
    // "$0.15 input per 1K tokens" as a per-million price is a thousandfold
    // error, and the split cell no longer carries the words that said so.
    if (
        OTHER_UNIT_STATED.test(text) ||
        OTHER_UNIT_STATED.test(header) ||
        statesAnotherTokenQuantity(text) ||
        statesAnotherTokenQuantity(header)
    ) {
        return { input: refusal("unit_other"), output: refusal("unit_other") };
    }
    if (claimsAnotherPriceMeaning(text) || claimsAnotherPriceMeaning(header)) {
        return { input: refusal("not_usd"), output: refusal("not_usd") };
    }
    if (statedCurrencyIsForeign(text) || statedCurrencyIsForeign(header)) {
        return { input: refusal("not_usd"), output: refusal("not_usd") };
    }
    if (/contact|sales|enterprise|quote/i.test(text)) {
        return { input: refusal("not_published"), output: refusal("not_published") };
    }
    if (PROMOTIONAL_TEXT.test(text)) {
        return {
            input: refusal("promotional_or_free"),
            output: refusal("promotional_or_free"),
        };
    }
    // A struck-through old price sits in the same cell as the new one, and
    // matching once took whichever came first -- the price that no longer
    // applies. Two candidates for one side is a cell this reader cannot choose
    // from, the same judgement a two-number column cell gets.
    const inputs = [...text.matchAll(/\$\s*(\d[\d,]*(?:\.\d+)?)\s*input/gi)];
    const outputs = [...text.matchAll(/\$\s*(\d[\d,]*(?:\.\d+)?)\s*output/gi)];
    if (inputs.length > 1 || outputs.length > 1) {
        return {
            input: refusal("ambiguous_value"),
            output: refusal("ambiguous_value"),
        };
    }
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output) {
        return { input: refusal("unparsed"), output: refusal("unparsed") };
    }
    // Read back through the same gate, with the heading and page that state the
    // currency and the unit.
    // Last, after the more specific refusals. The split cell carries only the
    // number, so the words that changed what the number means are judged here,
    // on the cell the page actually wrote.
    if (namesAnUnknownPriceWord(text) || namesAnUnknownPriceWord(header)) {
        return { input: refusal("not_usd"), output: refusal("not_usd") };
    }
    return {
        input: docPriceCell(`$${input[1]}`, header, row.units),
        output: docPriceCell(`$${output[1]}`, header, row.units),
    };
};

const CONTEXT_SENTENCE =
    /(\d[\d,]*(?:\.\d+)?\s*[km]?)[\s-]*token context window|context window of\s*(\d[\d,]*(?:\.\d+)?\s*[km]?)|context(?: length| window)?[:\s]+(\d[\d,]*(?:\.\d+)?\s*[km]?)\s*tokens/i;
const MAX_OUTPUT_SENTENCE =
    /maximum output(?: length)?(?: of)?\s*(\d[\d,]*(?:\.\d+)?\s*[km]?)|max(?:imum)? output tokens?[:\s]+(\d[\d,]*(?:\.\d+)?\s*[km]?)|output length of\s*(\d[\d,]*(?:\.\d+)?\s*[km]?)/i;
const TEXT_ONLY_SENTENCE = /text[- ]only input/i;
const IMAGE_INPUT_SENTENCE = /\b(?:image|vision|multimodal) input|accepts? images?\b/i;
/**
 * Something shaped like a model identifier: a name with a version in it.
 *
 * The version does not always end the way this once assumed. "gpt-4o" and
 * "glm-4.6v" put a letter straight after the number, and requiring a hyphen
 * before it meant "GPT-4o" was not a model at all -- so a sentence about it
 * counted as naming no other model -- while "glm-4.6v" matched as "glm-4" and
 * was a different model from itself.
 */
const MODEL_SHAPED_TOKEN =
    /\b[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*-\d+(?:\.\d+)*[a-z]*(?:-[a-z0-9.]+)*\b|\b[a-z]+\d+(?:\.\d+)*[a-z]*(?:-[a-z0-9.]+)+\b/gi;

/**
 * The page as sentences, block by block.
 *
 * Joining every line first glued a heading to the paragraph beneath it, so a
 * page titled with this model's name lent that name to a sentence about the
 * previous generation.
 */
const documentSentences = (markdown: string) =>
    markdown
        .split(/\n\s*\n/)
        .flatMap((block) => {
            const lines = block.split("\n").filter(
                (line) => !line.trim().startsWith("|") && !/^#{1,6}\s/.test(line.trim())
            );
            const chunks: string[] = [];
            for (const line of lines) {
                // A bullet is its own sentence. Joining it onto the line above
                // turned the marker into a dash aside for the previous item.
                // A wrapped continuation stays with the bullet it belongs to.
                if (chunks.length === 0 || /^\s*[-*]\s+/.test(line)) chunks.push(line.trim());
                else chunks[chunks.length - 1] += ` ${line.trim()}`;
            }
            return chunks.flatMap((chunk) => chunk.split(/(?<=[.!?])\s+/));
        })
        .map((sentence) => sentence.trim())
        .filter(Boolean);

/**
 * A sentence may speak for this model when it names it, or when it names no
 * other model at all.
 *
 * A model page that opens by comparing itself with its predecessor states the
 * predecessor's context window first, and reading the first number on the page
 * attributed it to the model being asked about.
 */
/**
 * Identifiers that share a model's shape but name a standard.
 *
 * "RFC-9110", "SHA-256" and "ISO-27001" are model-shaped, and counting them as
 * other models threw away the sentence they appeared in. Unlike a tier name or
 * a currency this is a closed set -- standards bodies and algorithms -- and
 * missing one costs a fact rather than inventing one, so nothing speculative
 * belongs here.
 */
/**
 * A provider's display name for a model: capitalised words and a version.
 *
 * "Claude Sonnet 4.5" and "Llama 3.1" name models as surely as "glm-5.3"
 * does, and a page that opens by comparing itself with one of them stated its
 * context window first.
 */
const DISPLAY_NAME_MODEL =
    /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z0-9.]+){0,2})\s+[vV]?\d+(?:\.\d+)*[a-z]*\b/g;

/**
 * Words that take a number after them without naming a model.
 *
 * Missing one costs a dropped sentence rather than a wrong number, so this
 * list is safe while incomplete.
 */
const NOT_A_DISPLAY_NAME =
    /^(?:january|february|march|april|may|june|july|august|september|october|november|december|figure|table|section|chapter|part|step|note|appendix|version|release|tier|option|example|phase|day|week|month|year|quarter|page|line|item|level|rule|case|point|column|row|q|v|no|number|type|class|group|model|models|window|tokens?|context|update|updated|revision)$/i;

const NON_MODEL_IDENTIFIER =
    /^(?:rfc|sha|md|iso|iec|ansi|ietf|nist|fips|ecma|pci|utf|ipv|tls|ssl|aes|rsa|hmac|gdpr|soc|cve|cwe|http|oauth|jwt|json|xml|sql|gpu|cpu|ram)$/i;

const sentenceSpeaksFor = (apiModel: string, sentence: string) => {
    const bare = apiModel.slice(apiModel.lastIndexOf("/") + 1).toLowerCase();
    // A derivative is a different model. Letting one identifier stand for the
    // other when either string contains the other made "GLM-5.3-Flash has a
    // 128K-token context window" a statement about GLM-5.3, whose window is
    // 1M.
    const others = (sentence.toLowerCase().match(MODEL_SHAPED_TOKEN) ?? []).filter(
        (token) =>
            token !== bare &&
            !NON_MODEL_IDENTIFIER.test(token.split(/[-.]/)[0].replace(/\d+$/, ""))
    );
    for (const match of sentence.matchAll(DISPLAY_NAME_MODEL)) {
        const words = match[1].split(/\s+/);
        if (NOT_A_DISPLAY_NAME.test(words[words.length - 1])) continue;
        // The page's own name for this model, written out, is not another one.
        // Both sides are flattened the same way, or "DeepSeek V3.2" on the
        // page of "deepseek-v3.2" is a different model from itself.
        const flatten = (name: string) => name.replace(/[\s._-]+/g, "-");
        const spelled = flatten(match[0].toLowerCase());
        const flatBare = flatten(bare);
        if (spelled.includes(flatBare) || flatBare.includes(spelled)) continue;
        others.push(match[0].toLowerCase());
    }
    // Naming this model is not enough: "GLM-4.7 has a 128K context window, and
    // GLM-5.3 is its successor" names both, and the number belongs to the
    // first. A sentence speaks for this model only when no other model is in
    // it.
    return others.length === 0;
};

/**
 * Whether a page's own title is this model, in whatever spelling.
 *
 * A page headed "DeepSeek V3.2" is the page for deepseek-v3.2, and requiring
 * the API id verbatim made it a page about no model at all. Comparing the
 * title for equality rather than containment is what keeps a page headed
 * "GLM-5.3-Flash" from answering for glm-5.3.
 */
const flatName = (name: string) =>
    name.trim().toLowerCase().replace(/[\s._/-]+/g, " ").trim();

const pageTitle = (markdown: string) => markdown.match(/^#{1,2}\s+(.+)$/m)?.[1];

/**
 * "GLM-5.3-Flash/FlashX" names both SKUs. A short piece replaces the last word.
 *
 * "vendor-b/target-1" is a path, not two SKUs. A later piece that already
 * contains a hyphen is the rest of one name, and splitting it made
 * `vendor-a/target-1` answer to a page titled for `vendor-b`.
 */
const slashJoinedNames = (title: string) => {
    const parts = plainCell(title)
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean);
    if (parts.length === 0) return [];
    const suffixes = parts.slice(1);
    if (suffixes.some((part) => /[-_]/.test(part))) return [parts.join("/")];
    const names = [parts[0]];
    for (const part of suffixes) {
        const segments = parts[0].split("-");
        segments[segments.length - 1] = part;
        names.push(segments.join("-"));
    }
    return names;
};

const titleNamesSeveralModels = (markdown: string) => {
    const title = pageTitle(markdown);
    return title ? slashJoinedNames(title).length > 1 : false;
};

const flattenModelName = (name: string) =>
    name.trim().toLowerCase().replace(/[\s._-]+/g, "-");

const modelTokensIn = (sentence: string) =>
    [...sentence.toLowerCase().matchAll(new RegExp(MODEL_SHAPED_TOKEN.source, "gi"))]
        .map((match) => match[0])
        .filter(
            (token) =>
                !NON_MODEL_IDENTIFIER.test(token.split(/[-.]/)[0].replace(/\d+$/, ""))
        );

const displayNamesIn = (sentence: string) => {
    const names: string[] = [];
    for (const match of sentence.matchAll(new RegExp(DISPLAY_NAME_MODEL.source, "g"))) {
        const words = (match[1] ?? "").split(/\s+/);
        if (NOT_A_DISPLAY_NAME.test(words[words.length - 1] ?? "")) continue;
        names.push(match[0]);
    }
    return names;
};

/** Equality, not containment: "GLM-5.3-Flash" does not name glm-5.3. */
const plainModelSentence = (sentence: string) =>
    sentence
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[*_`]+/g, "")
        .replace(/^[>\s-]+/, "")
        .replace(/\s+/g, " ")
        .trim();

const titleAliases = (markdown: string) => {
    const title = pageTitle(markdown);
    if (!title) return [];
    const parts = plainCell(title)
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean);
    if (parts.length < 2 || parts.slice(1).some((part) => /[-_]/.test(part))) return [];
    const aliases = [];
    const head = parts[0].split("-");
    aliases.push({ label: head[head.length - 1] ?? "", full: parts[0] });
    for (const part of parts.slice(1)) {
        const segments = parts[0].split("-");
        segments[segments.length - 1] = part;
        aliases.push({ label: part, full: segments.join("-") });
    }
    return aliases;
};

/**
 * Aliases match the title's own capitalization. Lowercase "flash attention"
 * and "fast" are ordinary English. A hit glued to a following hyphen
 * (`Flash-series`) is a family word, not the SKU standing alone. One and two
 * letters stay unread: a shared page that needs them states no size fact.
 */
const aliasFlags = (label: string) => (label.length >= 3 ? "" : null);

const forEachAliasHit = (
    markdown: string,
    sentence: string,
    visit: (full: string, start: number, raw: string) => void
) => {
    const text = plainModelSentence(sentence);
    for (const alias of titleAliases(markdown)) {
        const flags = aliasFlags(alias.label);
        if (flags === null) continue;
        const pattern = new RegExp(
            `\\b${alias.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
            `${flags}g`
        );
        for (const match of text.matchAll(pattern)) {
            if (match.index === undefined) continue;
            if (text[match.index + match[0].length] === "-") continue;
            visit(alias.full, match.index, match[0]);
        }
    }
};

const aliasNamesIn = (markdown: string, sentence: string) => {
    const named: string[] = [];
    forEachAliasHit(markdown, sentence, (full) => named.push(flattenModelName(full)));
    return named;
};

const sentenceNamesThisModel = (apiModel: string, markdown: string, sentence: string) => {
    const text = plainModelSentence(sentence);
    const bare = flattenModelName(apiModel.slice(apiModel.lastIndexOf("/") + 1));
    if (modelTokensIn(text).some((token) => flattenModelName(token) === bare)) return true;
    if (displayNamesIn(text).some((name) => flattenModelName(name) === bare)) return true;
    return aliasNamesIn(markdown, text).includes(bare);
};

const titledModelNames = (markdown: string) => {
    const title = pageTitle(markdown);
    if (!title) return new Set<string>();
    return new Set(slashJoinedNames(title).map((name) => flattenModelName(name)));
};

const namesInSentence = (markdown: string, sentence: string) => {
    const text = plainModelSentence(sentence);
    return [
        ...modelTokensIn(text).map((token) => flattenModelName(token)),
        ...displayNamesIn(text).map((name) => flattenModelName(name)),
        ...aliasNamesIn(markdown, text),
    ];
};

/** Every model the sentence names is one this page's title names. */
const sentenceStaysOnTitledModels = (markdown: string, sentence: string) => {
    const titled = titledModelNames(markdown);
    return namesInSentence(markdown, sentence).every((name) => titled.has(name));
};

const titledNamesInSentence = (markdown: string, sentence: string) => {
    const titled = titledModelNames(markdown);
    return new Set(namesInSentence(markdown, sentence).filter((name) => titled.has(name)));
};

/**
 * "A and B support …" names both SKUs as one subject. "A has X and B has Y"
 * does not: a predicate sits between the names.
 */
const SELECTIVE_REFERENCE =
    /\b(?:the latter|the former|only the|the \w+er\b|the [\w-]+ (?:model|models|variant|version|tier|sku|one))\b/i;

const titledNamesAreOneSubject = (markdown: string, sentence: string) => {
    const text = plainModelSentence(sentence);
    // "A and B …, and the latter supports 1M" names both as a list and then
    // gives the number to one of them. That is not one subject.
    if (SELECTIVE_REFERENCE.test(text)) return false;
    const titled = titledModelNames(markdown);
    const spans: { start: number; end: number }[] = [];
    const consider = (start: number, raw: string) => {
        if (!titled.has(flattenModelName(raw))) return;
        spans.push({ start, end: start + raw.length });
    };
    for (const match of text.matchAll(new RegExp(MODEL_SHAPED_TOKEN.source, "gi"))) {
        if (match.index === undefined) continue;
        consider(match.index, match[0]);
    }
    for (const match of text.matchAll(new RegExp(DISPLAY_NAME_MODEL.source, "g"))) {
        const words = (match[1] ?? "").split(/\s+/);
        if (NOT_A_DISPLAY_NAME.test(words[words.length - 1] ?? "")) continue;
        if (match.index === undefined) continue;
        consider(match.index, match[0]);
    }
    forEachAliasHit(markdown, text, (full, start, raw) => {
        if (!titled.has(flattenModelName(full))) return;
        spans.push({ start, end: start + raw.length });
    });
    spans.sort((left, right) => left.start - right.start || right.end - left.end);
    const kept: { start: number; end: number }[] = [];
    let coveredUntil = -1;
    for (const span of spans) {
        if (span.start < coveredUntil) continue;
        kept.push(span);
        coveredUntil = span.end;
    }
    if (kept.length < 2) return false;
    // The names are one subject only when the sentence opens on them.
    // "The GLM-5.3-Flash and GLM-5.3-FlashX support…" does. "Compared to
    // GLM-5.3-Flash, …" does not, and neither does the next preposition.
    const lead = text.slice(0, kept[0].start);
    if (!/^(?:\s*(?:the|both)\s+)?$/i.test(lead)) return false;
    for (let index = 1; index < kept.length; index += 1) {
        const between = text.slice(kept[index - 1].end, kept[index].start);
        if (!/^\s*(?:(?:,|\/|&|\band\b|\bor\b)\s*)+$/i.test(between)) return false;
    }
    return true;
};

/**
 * A later subject with its own verb, between the last model name and the
 * number. "and the second supports" is one. "support the same" is not: the
 * determiner has no verb of its own. "and supports" continues the model's
 * own verb, so the conjunction immediately before the verb is not a new
 * subject. "but supports" is the same continuation. A spaced hyphen still
 * counts as a word, and so does a dotted number ("the 4.6 model supports").
 * Every dash spelling counts as that word, including a tight em dash and a
 * parenthetical, and a comma phrase has no character budget. One adverb may
 * sit before the verb ("now has") without spending the word budget. The
 * name's own aside close is not one of those words; the caller skips it.
 */
const ASIDE_TIGHT_DASH = "—|–|---|--";
/** A hyphen opens or closes an aside only with a space on each side. */
const ASIDE_DASH_OPEN = `(?:\\s*(?:${ASIDE_TIGHT_DASH})\\s*|\\s+-\\s+)`;
const ASIDE_DASH_CLOSE = `(?:${ASIDE_TIGHT_DASH}|(?<=\\s)-(?=\\s))`;
const NEW_SUBJECT_WORD = "[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*";
const NEW_SUBJECT_DASH = `${ASIDE_TIGHT_DASH}|-`;
const NEW_SUBJECT_ADVERB = "now|also|still|currently|already";
const NEW_SUBJECT_VERB =
    "supports?|offers?|has|have|accepts?|includes?|provides?|features?|uses?|comes?|delivers?|ships?|tops?|supporting|offering|accepting|offered|supported|accepted|included|provided|featured|used|had|came";
const NEW_SUBJECT_DASH_ASIDE = `${ASIDE_DASH_OPEN}${NEW_SUBJECT_WORD}(?:\\s+${NEW_SUBJECT_WORD}){0,6}\\s*${ASIDE_DASH_CLOSE}`;
const NEW_SUBJECT = new RegExp(
    `\\b(?:the|this|that|these|those|it|its|their|whose|another|either|one|former|latter)\\b(?:\\s+${NEW_SUBJECT_WORD}){0,3}(?:${NEW_SUBJECT_DASH_ASIDE}(?:\\s+(?:${NEW_SUBJECT_ADVERB}))?\\s*|,\\s+[^,]+,(?:\\s+(?:${NEW_SUBJECT_ADVERB}))?\\s+|\\s*\\([^)]*\\)(?:\\s+(?:${NEW_SUBJECT_ADVERB}))?\\s+|(?:\\s+(?:${NEW_SUBJECT_DASH}))?(?:\\s+(?:${NEW_SUBJECT_ADVERB}))?\\s+)(?<!\\bto )(?<!\\band )(?<!\\bbut )(?:${NEW_SUBJECT_VERB})\\b`,
    "i"
);

/**
 * A clause about the model this page replaced.
 *
 * "whereas the previous generation offered a 128K-token context window"
 * states the predecessor's window after this model's name, so a verb list
 * of present-tense subjects never sees it. The subject is the boundary.
 * A comma inside a number is not one.
 */
const PREDECESSOR_ADJECTIVE = "previous|prior|earlier|preceding|older|legacy|outgoing";

const PREDECESSOR_SUBJECT = new RegExp(
    `\\b(?:(?:the|its|their|whose|an|a)\\s+)?(?:${PREDECESSOR_ADJECTIVE})[\\s-]+(?:(?:generations?|versions?|releases?)(?:[\\s-]+models?)?|models?)\\b|\\b(?:its|their|whose)\\s+predecessors?\\b`,
    "gi"
);

/** A comparison that opens someone else's clause. Quantity words are not these. */
const PREDECESSOR_CLAUSE_MARK =
    /\b(?:whereas|unlike|versus)\b|\bcompared\s+(?:with|to)\b|\bup\s+from\b/gi;

const matchIndexes = (text: string, pattern: RegExp) => {
    const starts: number[] = [];
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
        if (match.index !== undefined) starts.push(match.index);
    }
    return starts;
};

/** Where this sentence names the model being read. */
const thisModelMentions = (markdown: string, apiModel: string, text: string) => {
    const bare = flattenModelName(apiModel.slice(apiModel.lastIndexOf("/") + 1));
    const mentions: { start: number; end: number }[] = [];
    const consider = (start: number, raw: string, identity: string) => {
        if (flattenModelName(identity) !== bare) return;
        mentions.push({ start, end: start + raw.length });
    };
    for (const match of text.matchAll(new RegExp(MODEL_SHAPED_TOKEN.source, "gi"))) {
        if (match.index !== undefined) consider(match.index, match[0], match[0]);
    }
    for (const match of text.matchAll(new RegExp(DISPLAY_NAME_MODEL.source, "g"))) {
        const words = (match[1] ?? "").split(/\s+/);
        if (NOT_A_DISPLAY_NAME.test(words[words.length - 1] ?? "")) continue;
        if (match.index !== undefined) consider(match.index, match[0], match[0]);
    }
    forEachAliasHit(markdown, text, (full, start, raw) => consider(start, raw, full));
    return mentions;
};

const clauseCommaAt = (text: string, index: number) => {
    const mark = text[index];
    if (mark !== "," && mark !== ";") return false;
    if (mark === "," && /\d/.test(text[index - 1] ?? "") && /\d/.test(text[index + 1] ?? "")) {
        return false;
    }
    return true;
};

/**
 * The aside right after the opening name: "GLM-5.4, unlike the previous
 * generation, supports a 1M". A trailing whereas clause is not one, because
 * the name is followed by its own fact before the comma.
 */
const asideAfterName = (text: string, nameEnd: number) => {
    const rest = text.slice(nameEnd);
    const paren = /^\s*\(/.exec(rest);
    if (paren) {
        const open = nameEnd + paren[0].lastIndexOf("(");
        let depth = 0;
        for (let index = open; index < text.length; index += 1) {
            if (text[index] === "(") depth += 1;
            else if (text[index] === ")") {
                depth -= 1;
                if (depth === 0) return { open, close: index };
            }
        }
        return null;
    }
    const dash = new RegExp(`^${ASIDE_DASH_OPEN}`).exec(rest);
    if (dash) {
        const from = nameEnd + dash[0].length;
        const end = new RegExp(ASIDE_DASH_CLOSE).exec(text.slice(from));
        if (!end || end.index === undefined) return null;
        return { open: nameEnd, close: from + end.index + end[0].length - 1 };
    }
    if (!/^\s*,/.test(rest)) return null;
    let open = -1;
    for (let index = nameEnd; index < text.length; index += 1) {
        if (clauseCommaAt(text, index)) {
            open = index;
            break;
        }
    }
    if (open < 0) return null;
    for (let index = open + 1; index < text.length; index += 1) {
        if (!clauseCommaAt(text, index)) continue;
        // ", which offered a maximum output length of 64K tokens," is still
        // the aside. The main clause resumes at the next comma.
        if (/^\s*(?:which|that|whose)\b/i.test(text.slice(index + 1))) continue;
        return { open, close: index };
    }
    return null;
};

const CAPABILITY_GAP = /(?:now|also|still|currently|already|even|only|can|will|may|could|would)\b/i;
const CAPABILITY_VERB =
    /(?:supports?|offers?|has|have|accepts?|includes?|provides?|features?|uses?|comes?|is|are)\b/i;
const PRESENT_CAPABILITY = new RegExp(
    `^(?:\\s+${CAPABILITY_GAP.source}){0,2}\\s+${CAPABILITY_VERB.source}`,
    "i"
);

/** "is limited" is not this model's capability. "supports" is. */
const resumesWithCapability = (after: string) => {
    if (/^\s+(?:is|are|was|were)\s+limited\b/i.test(after)) return false;
    return PRESENT_CAPABILITY.test(after);
};

/**
 * "On/In/With/Under/For the previous generation, the model …" puts the whole
 * sentence inside that generation, including after one comma-closed adverbial
 * ("However, with …"). "For teams moving off previous generation models" does
 * not: the preposition does not govern the generation noun. "Compared with"
 * is a mark, not this frame. generation, predecessor and flagship name a past
 * thing by themselves. version, release and model do so only with a
 * predecessor adjective, so "this release" stays this model's sentence and
 * "older models" does not.
 */
const FRONTED_GENERATION_FRAME = new RegExp(
    `(?:^|[.;:]\\s*|\\bnote\\s+that\\s+)(?:[\\w'-]+(?:\\s+[\\w'-]+){0,3},\\s+)?(?!compared\\b|unlike\\b|whereas\\b|versus\\b)[a-z]+\\s+(?:` +
        `(?:(?:the|its|their|a|an)\\s+)?(?:[\\w-]+\\s+){0,2}?(?:[\\w-]*-)?(?:generations?|predecessors?|flagships?)` +
        `|(?:(?:the|its|their|a|an)\\s+)?(?:${PREDECESSOR_ADJECTIVE})[\\s-]+(?:versions?|releases?|models?)` +
        `)\\b[^.]*?,?(?:\\s+|[—–-]\\s*)(?:this|the)\\s+model\\b`,
    "i"
);

const frontedGenerationFrame = (text: string) => FRONTED_GENERATION_FRAME.test(text);

/**
 * A dash aside may sit against the next word. The readers still require a
 * leading space, so a tight dash lends one. A comma or parenthesis already
 * has that space in ordinary prose.
 */
const clauseAfterAside = (text: string, close: number) => {
    const after = text.slice(close + 1);
    const mark = text[close] ?? "";
    if (mark !== "—" && mark !== "–" && mark !== "-") return after;
    return /^\s/.test(after) ? after : ` ${after}`;
};

/** The verb after a page-voice aside counts. "The model, unlike …, supports". */
const voiceContinuation = (text: string, voiceEnd: number) => {
    const aside = asideAfterName(text, voiceEnd);
    const after = aside ? clauseAfterAside(text, aside.close) : text.slice(voiceEnd);
    return resumesWithCapability(after);
};

/** "the model supported a 128K" is a previous state, not this model's window. */
const PAST_PAGE_VOICE = new RegExp(
    `^(?:\\s+${CAPABILITY_GAP.source}){0,2}\\s+(?:supported|offered|had|was|were|accepted|included|provided|featured|used|came)\\b`,
    "i"
);

/**
 * A time adverb that opens straight onto this model's subject.
 * "Previously, GLM-5.4 shipped" is one. "Previously unavailable …, the model
 * supports" is not: the adverb does not introduce the subject. "until" is
 * past only with recently, now or then.
 */
const PAST_TIME_LEAD =
    /^(?:[\w'-]+(?:\s+[\w'-]+){0,3},\s+)?(?:note\s+that\s+)?(?:previously|formerly|historically|in\s+the\s+past|up\s+to\s+now|until\s+(?:recently|now|then))\s*,?\s*$/i;

const pastVerbAfter = (text: string, subjectEnd: number) => {
    const aside = asideAfterName(text, subjectEnd);
    const after = aside ? clauseAfterAside(text, aside.close) : text.slice(subjectEnd);
    return PAST_PAGE_VOICE.test(after);
};

const RESUMED_PRESENT = new RegExp(
    `\\b(?:and|but)(?:\\s+${CAPABILITY_GAP.source}){0,2}\\s+${CAPABILITY_VERB.source}`,
    "i"
);

const PAST_MARKER =
    /\b(?:previously|formerly|historically|in\s+the\s+past|up\s+to\s+now|until\s+(?:recently|now|then)|supported|offered|had|was|were|accepted|included|provided|featured|used|came)\b/i;

/** A past marker governs a claim only when no present verb resumes before it. */
const claimFollowsPast = (beforeClaim: string) => {
    const resumed = RESUMED_PRESENT.exec(beforeClaim);
    const tail =
        resumed && resumed.index !== undefined
            ? beforeClaim.slice(resumed.index + resumed[0].length)
            : beforeClaim;
    return PAST_MARKER.test(tail);
};

const pastPageVoice = (text: string, voiceEnd: number) => pastVerbAfter(text, voiceEnd);

const subjectsOf = (apiModel: string, markdown: string, text: string) => {
    const subjects = [...thisModelMentions(markdown, apiModel, text)];
    const voice = /\b(?:this|the) model\b/i.exec(text);
    if (voice?.index !== undefined) {
        subjects.push({ start: voice.index, end: voice.index + voice[0].length });
    }
    return subjects;
};

/** A time adverb opening onto this model makes the whole sentence a past state. */
const pastAboutThisModel = (apiModel: string, markdown: string, sentence: string) => {
    const text = plainModelSentence(sentence);
    return subjectsOf(apiModel, markdown, text).some((subject) =>
        PAST_TIME_LEAD.test(text.slice(0, subject.start))
    );
};

/**
 * A claim inside the past clause is not this model's current value.
 * "was limited to a 64K output and now supports a 1M" keeps the window and
 * drops the output. The boundary is the present verb, per claim.
 */
const claimIsPast = (
    apiModel: string,
    markdown: string,
    text: string,
    claimStart: number
) => {
    for (const subject of subjectsOf(apiModel, markdown, text)) {
        if (PAST_TIME_LEAD.test(text.slice(0, subject.start))) return true;
        const aside = asideAfterName(text, subject.end);
        if (aside && claimStart > aside.open && claimStart < aside.close) {
            if (claimFollowsPast(text.slice(aside.open, claimStart))) return true;
        }
        const afterStart = aside ? aside.close + 1 : subject.end;
        const rawAfter = text.slice(afterStart);
        const after = aside ? clauseAfterAside(text, aside.close) : rawAfter;
        if (!PAST_PAGE_VOICE.test(after)) continue;
        const resumed = RESUMED_PRESENT.exec(after);
        const pad = after.length - rawAfter.length;
        const boundary =
            resumed?.index === undefined ? text.length : afterStart + resumed.index - pad;
        if (claimStart >= afterStart && claimStart < boundary) return true;
    }
    return false;
};

/**
 * A predecessor noun opens a clause. The exception is the noun as the object
 * of this model's own verb, including one adverb or auxiliary:
 * "compatible with older models and now supports a 1M".
 */
const OWN_PREDICATE_CONTINUATION = new RegExp(
    `^\\s*,?\\s+(?:and|but)(?:\\s+${CAPABILITY_GAP.source}){0,2}\\s+${CAPABILITY_VERB.source}`,
    "i"
);

const continuesOwnPredicate = (after: string) => {
    if (/^\s*,?\s+(?:and|but)\s+(?:is|are)\s+limited\b/i.test(after)) return false;
    return OWN_PREDICATE_CONTINUATION.test(after);
};

const subjectTriggers = (text: string) => {
    const starts: number[] = [];
    for (const match of text.matchAll(new RegExp(PREDECESSOR_SUBJECT.source, "gi"))) {
        if (match.index === undefined) continue;
        if (continuesOwnPredicate(text.slice(match.index + match[0].length))) continue;
        starts.push(match.index);
    }
    return starts;
};

/**
 * On a page about one model, "this model" / "the model" ends a predecessor
 * clause when it resumes with this model's own verb, including after an
 * aside. A fronted "On the previous generation, the model …" does not:
 * that "the model" is the generation the preposition named.
 */
const pageVoiceResumptions = (text: string) => {
    if (frontedGenerationFrame(text)) return [];
    const mentions: { start: number; end: number }[] = [];
    for (const match of text.matchAll(/\b(?:this|the) model\b/gi)) {
        if (match.index === undefined) continue;
        const end = match.index + match[0].length;
        if (!voiceContinuation(text, end)) continue;
        mentions.push({ start: match.index, end });
    }
    return mentions;
};

/**
 * A sentence that never names the model. Page voice may use it when no
 * generation word is present, or when "the model" resumes after an aside
 * with this model's own verb. A fronted generation frame is that generation's
 * sentence, whatever verb follows.
 */
const GENERATION_REFERENCE = new RegExp(
    `\\b(?:generations?|predecessors?|flagships?)\\b|\\b[\\w]+-generations?\\b|\\b(?:${PREDECESSOR_ADJECTIVE})[\\s-]+(?:versions?|releases?|models?)\\b`,
    "i"
);

const pageVoiceOwns = (text: string) => {
    const voice = /\b(?:this|the) model\b/i.exec(text);
    if (!voice || voice.index === undefined) return false;
    if (frontedGenerationFrame(text)) return false;
    const end = voice.index + voice[0].length;
    if (PAGE_VOICE_OTHER.test(text.slice(end))) return false;
    if (
        !isUnqualifiedPageVoice(text.slice(voice.index, end), text.slice(end)) &&
        !voiceContinuation(text, end)
    ) {
        return false;
    }
    if (pastPageVoice(text, end)) return false;
    if (!GENERATION_REFERENCE.test(text)) return true;
    return voiceContinuation(text, end);
};

/**
 * From a predecessor subject or a real comparison mark through the next
 * mention of this model, or the end of the sentence. An aside placed right
 * after the name closes at the comma where the main clause resumes, and a
 * which-clause stays inside that aside. "over", "than" and "while" are not
 * marks. On a single-model page, "this model supports" is a mention too.
 */
const foreignSpans = (markdown: string, apiModel: string, text: string) => {
    const triggers = [...subjectTriggers(text), ...matchIndexes(text, PREDECESSOR_CLAUSE_MARK)];
    const mentions = [
        ...thisModelMentions(markdown, apiModel, text),
        ...(titleNamesSeveralModels(markdown) ? [] : pageVoiceResumptions(text)),
    ];
    return triggers.map((start) => {
        let end = text.length;
        for (const mention of mentions) {
            if (mention.start > start && mention.start < end) end = mention.start;
        }
        for (const mention of mentions) {
            if (mention.end > start) continue;
            const aside = asideAfterName(text, mention.end);
            if (aside && start > aside.open && start < aside.close && aside.close < end) {
                end = aside.close;
            }
        }
        return { start, end };
    });
};

const claimSitsWithPredecessor = (
    markdown: string,
    apiModel: string,
    text: string,
    claimStart: number
) =>
    foreignSpans(markdown, apiModel, text).some(
        (span) => claimStart >= span.start && claimStart < span.end
    );

/** A fact that starts after a new subject is not a fact about the names above it. */
const OTHER_RELATIVE = new RegExp(
    `(?:\\b(?:the|this|that|these|those|it|its|their|our|his|her|another|either|one|former|latter)\\b|\\b[A-Za-z]+'s)(?:\\s+${NEW_SUBJECT_WORD}){0,3}\\s*(?:,|${ASIDE_DASH_OPEN}|\\()\\s*(?:which|that|whose)\\b`,
    "i"
);

/**
 * "the Air tier, which has a 64K, costs less" gives the number to that tier
 * even when the tier's own verb sits past the claim. A determiner phrase
 * that contains this model's name ("The GLM-5.4 model, which") is this
 * model's clause, and so is a phrase inside the name's own aside
 * ("GLM-5.4, the flagship model, which"). The closer may be a comma, a
 * dash, or a parenthesis.
 */
const claimSitsInOtherRelative = (text: string, nameEnd: number, claimStart: number) => {
    let pronounEnd = -1;
    for (const match of text.slice(0, claimStart).matchAll(new RegExp(OTHER_RELATIVE.source, "gi"))) {
        if (match.index === undefined) continue;
        const end = match.index + match[0].length;
        if (end <= nameEnd) continue;
        // The name sits inside the determiner phrase.
        if (match.index < nameEnd) continue;
        pronounEnd = end;
    }
    if (pronounEnd < 0) return false;
    const aside = asideAfterName(text, nameEnd);
    // The name's own appositive ("the flagship model, which") stays this
    // model's clause. A noun phrase that is the object of a preposition
    // ("from the Air tier, which") does not, even inside that aside.
    if (
        aside &&
        pronounEnd > aside.open &&
        pronounEnd < aside.close &&
        !relativeFollowsPrepositionObject(text, pronounEnd)
    ) {
        return false;
    }
    let markAt = pronounEnd - 1;
    while (markAt > nameEnd && /[A-Za-z]/i.test(text[markAt] ?? "")) markAt -= 1;
    while (markAt > nameEnd && /\s/.test(text[markAt] ?? "")) markAt -= 1;
    const mark = text[markAt] ?? "";
    let closer = text.length;
    if (mark === "(") {
        const end = text.indexOf(")", pronounEnd);
        closer = end < 0 ? text.length : end;
    } else if (mark === "—" || mark === "–" || mark === "-") {
        const end = new RegExp(ASIDE_DASH_CLOSE).exec(text.slice(pronounEnd));
        closer =
            end?.index === undefined ? text.length : pronounEnd + end.index;
    } else {
        for (let index = pronounEnd; index < text.length; index += 1) {
            if (!clauseCommaAt(text, index)) continue;
            closer = index;
            break;
        }
    }
    return claimStart < closer;
};

const RELATIVE_PREPOSITION =
    /\b(?:from|of|than|versus|against|with|for|by|about|over|into|via|within|to|in|under|below|alongside|among)\s+(?:the|a|an|this|that|these|those|our|its|their|his|her|[A-Za-z]+'s)\b[^,;:—–()-]*$/i;

/** "from the Air tier, which" attaches the clause to the object, not the name. */
const relativeFollowsPrepositionObject = (text: string, pronounEnd: number) => {
    let index = pronounEnd - 1;
    while (index > 0 && /[A-Za-z]/i.test(text[index] ?? "")) index -= 1;
    while (index > 0 && /\s/.test(text[index] ?? "")) index -= 1;
    return RELATIVE_PREPOSITION.test(text.slice(0, index));
};

/**
 * A determiner phrase that opens its own clause is another subject's,
 * whatever verb follows. "while the Air tier keeps a 128K" is one.
 * "supports the largest context window" is not: the determiner is an
 * object. A phrase inside the name's aside is still the name's.
 * Copulas are not nominals, so "that is tuned … and supports" stays
 * this model's sentence.
 */
const FOREIGN_NOMINAL = `(?!is\\b|are\\b|was\\b|were\\b)${NEW_SUBJECT_WORD}`;
const FOREIGN_SUBJECT = new RegExp(
    `(?:^|[,;:]|\\b(?:while|whereas|although|though)\\b|,?\\s*\\b(?:and|but|or|so|yet)\\b)\\s+(?:\\b(?:the|this|that|these|those|another|either|one|former|latter|its|their|whose|our|his|her)\\b|\\b[A-Za-z]+'s)(?:\\s+${FOREIGN_NOMINAL}){1,3}`,
    "gi"
);

/** The phrase names this model when nothing but "model" follows its name. */
const phraseIsThisModel = (phrase: string, bare: string) => {
    if (!bare) return false;
    const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[-\\s]");
    const found = new RegExp(escaped, "i").exec(phrase);
    if (!found || found.index === undefined) return false;
    const after = phrase
        .slice(found.index + found[0].length)
        .replace(new RegExp(`\\s+(?:${NEW_SUBJECT_VERB})$`, "i"), "");
    return /^(?:\s+models?)?\s*$/i.test(after);
};

/**
 * On a single-model page, "the model" is that page. "the model's Air
 * variant" and "the models in the Air line" name something else, so the
 * words after model(s) are part of the decision.
 */
const PAGE_VOICE_OTHER =
    /^(?:'s\b|\s+(?:in|of|from|under|below|alongside|among|with|for|by|about|over|into|via|within|to)\b)/i;

const isUnqualifiedPageVoice = (phrase: string, following = "") => {
    const head = /\b(?:the|this)\s+models?\b/i.exec(phrase);
    if (!head || head.index === undefined) return false;
    const rest = phrase.slice(head.index + head[0].length) + following;
    if (PAGE_VOICE_OTHER.test(rest)) return false;
    if (/^\s*$/.test(rest)) return true;
    if (/^\s+(?:is|are|was|were)\b/i.test(rest)) return true;
    if (/^\s*,\s*(?:which|that|whose)\b/i.test(rest)) return true;
    return resumesWithCapability(rest);
};

const claimHasForeignSubject = (
    text: string,
    nameEnd: number,
    claimStart: number,
    bare: string,
    shared: boolean
) => {
    const aside = asideAfterName(text, nameEnd);
    const region = text.slice(nameEnd, claimStart);
    for (const match of region.matchAll(new RegExp(FOREIGN_SUBJECT.source, "gi"))) {
        if (match.index === undefined) continue;
        const start = nameEnd + match.index;
        const end = start + match[0].length;
        if (aside && start >= aside.open && end <= aside.close) continue;
        if (phraseIsThisModel(match[0], bare)) continue;
        if (
            !shared &&
            !frontedGenerationFrame(text) &&
            isUnqualifiedPageVoice(match[0], text.slice(end))
        ) {
            continue;
        }
        return true;
    }
    return false;
};

const factOpensItsOwnClause = (
    markdown: string,
    apiModel: string,
    text: string,
    claimStart: number,
    shared = false
) => {
    if (claimSitsWithPredecessor(markdown, apiModel, text, claimStart)) return true;
    const titled = titledModelNames(markdown);
    let firstStart = -1;
    let firstEnd = -1;
    let nameEnd = -1;
    const note = (start: number, matched: string, identity: string) => {
        if (!titled.has(flattenModelName(identity))) return;
        if (firstStart < 0 || start < firstStart) {
            firstStart = start;
            firstEnd = start + matched.length;
        }
        const end = start + matched.length;
        if (end <= claimStart && end > nameEnd) nameEnd = end;
    };
    for (const match of text.matchAll(new RegExp(MODEL_SHAPED_TOKEN.source, "gi"))) {
        if (match.index !== undefined) note(match.index, match[0], match[0]);
    }
    for (const match of text.matchAll(new RegExp(DISPLAY_NAME_MODEL.source, "g"))) {
        const words = (match[1] ?? "").split(/\s+/);
        if (NOT_A_DISPLAY_NAME.test(words[words.length - 1] ?? "")) continue;
        if (match.index !== undefined) note(match.index, match[0], match[0]);
    }
    forEachAliasHit(markdown, text, (full, start, raw) => note(start, raw, full));
    // A number that arrives before this page's name belongs to the clause
    // in front of it. "Where the previous generation offered a 128K-token
    // context window, GLM-5.3-Flash offers…" is not this model's window.
    if (firstStart >= 0 && claimStart < firstStart) return true;
    if (nameEnd < 0) {
        // A sentence that never spells the name still has subjects. "The
        // model …, and the Air tier supports a 128K" is the tier's window.
        if (shared || frontedGenerationFrame(text)) return false;
        let voiceEnd = -1;
        for (const voice of text.matchAll(/\b(?:this|the) models?\b/gi)) {
            if (voice.index === undefined) continue;
            const end = voice.index + voice[0].length;
            if (
                !isUnqualifiedPageVoice(text.slice(voice.index, end), text.slice(end)) &&
                !voiceContinuation(text, end)
            ) {
                continue;
            }
            voiceEnd = end;
            break;
        }
        if (voiceEnd < 0) {
            const qualified = /\b(?:this|the) models?\b/i.exec(text);
            if (!qualified || qualified.index === undefined) return false;
            const between = text.slice(qualified.index + qualified[0].length, claimStart);
            if (
                PAGE_VOICE_OTHER.test(between) &&
                /\b(?:supports?|offers?|has|have|accepts?|includes?|provides?|features?|uses?|comes?|delivers?|ships?|tops?|is|are)\b/i.test(
                    between
                )
            ) {
                return true;
            }
            return false;
        }
        nameEnd = voiceEnd;
        if (firstEnd < 0) firstEnd = voiceEnd;
    }
    if (claimSitsInOtherRelative(text, nameEnd, claimStart)) return true;
    const bare = flattenModelName(apiModel.slice(apiModel.lastIndexOf("/") + 1));
    if (claimHasForeignSubject(text, firstEnd, claimStart, bare, shared)) return true;
    const sliceEnd = Math.min(text.length, claimStart + 24);
    const pattern = new RegExp(NEW_SUBJECT.source, "gi");
    for (const match of text.slice(nameEnd, sliceEnd).matchAll(pattern)) {
        const matchStart = nameEnd + (match.index ?? 0);
        const matchEnd = matchStart + match[0].length;
        if (verbResumesAside(text, nameEnd, matchStart, matchEnd)) continue;
        if (
            !shared &&
            !frontedGenerationFrame(text) &&
            isUnqualifiedPageVoice(match[0], text.slice(matchEnd))
        ) {
            continue;
        }
        return true;
    }
    return false;
};

/**
 * The verb right after a name's aside resumes that name. One adverb may sit
 * on the close, and further asides may follow when the matched subject
 * started inside the name's own aside. A subject that starts after the close
 * is somebody else's.
 */
const TRAILING_NAME_ASIDES = new RegExp(
    `^(?:${ASIDE_DASH_CLOSE}|[,;]|\\))(?:\\s*[^,;]+[,;]|\\s*\\([^)]*\\)|${NEW_SUBJECT_DASH_ASIDE})*$`,
    "i"
);

const verbResumesAside = (
    text: string,
    nameEnd: number,
    matchStart: number,
    matchEnd: number
) => {
    const aside = asideAfterName(text, nameEnd);
    if (!aside) return false;
    let index = matchEnd - 1;
    while (index > aside.close && /[A-Za-z]/i.test(text[index] ?? "")) index -= 1;
    while (index > aside.close && /\s/.test(text[index] ?? "")) index -= 1;
    const adverb = new RegExp(`^(?:${NEW_SUBJECT_ADVERB})$`, "i");
    const wordEnd = index + 1;
    let wordStart = index;
    while (wordStart > aside.close && /[A-Za-z]/i.test(text[wordStart] ?? "")) wordStart -= 1;
    if (!/[A-Za-z]/i.test(text[wordStart] ?? "")) wordStart += 1;
    if (adverb.test(text.slice(wordStart, wordEnd))) {
        index = wordStart - 1;
        while (index > aside.close && /\s/.test(text[index] ?? "")) index -= 1;
    }
    if (index === aside.close) return true;
    if (matchStart >= aside.close) return false;
    const tail = text.slice(aside.close, matchEnd).replace(
        new RegExp(`(?:\\s+(?:${NEW_SUBJECT_ADVERB}))?\\s+(?:${NEW_SUBJECT_VERB})$`, "i"),
        ""
    );
    return TRAILING_NAME_ASIDES.test(tail);
};

const COVERS_THE_LINE = /\b(?:all|both|series|family|models)\b/i;

/** A sentence that names part of a line and then says the whole line. */
const namesPartOfTheLine = (markdown: string, sentence: string) => {
    const named = titledNamesInSentence(markdown, sentence);
    return (
        named.size > 0 &&
        named.size < titledModelNames(markdown).size &&
        COVERS_THE_LINE.test(plainModelSentence(sentence))
    );
};

/**
 * Whether a promotion sentence on a model page applies to this model.
 *
 * A page titled for one model speaks for that model, including a sentence
 * that names nobody. A page titled for two SKUs does not lend a sentence
 * that names one of them to the other. A sentence that names nobody on that
 * shared page still applies to both: a promotion this reader cannot place
 * is not the same thing as no promotion.
 */
export const modelPageNoticeAppliesTo = (
    apiModel: string,
    markdown: string,
    sentence: string
) => {
    if (!titleNamesSeveralModels(markdown)) return true;
    const named = titledNamesInSentence(markdown, sentence);
    const bare = flattenModelName(apiModel.slice(apiModel.lastIndexOf("/") + 1));
    const text = plainModelSentence(sentence);
    if (namesPartOfTheLine(markdown, sentence)) return true;
    if (named.size > 0) return named.has(bare);
    // No titled name. A family word, or a model this title does not name,
    // is not the same as a sentence that names nobody.
    if (COVERS_THE_LINE.test(text)) return true;
    if (namesInSentence(markdown, sentence).some((name) => !titledModelNames(markdown).has(name))) {
        return true;
    }
    if (sentenceSpeaksFor(apiModel, sentence)) return true;
    return sentenceNamesThisModel(apiModel, markdown, sentence);
};

const titleNamesModel = (apiModel: string, markdown: string) => {
    const title = pageTitle(markdown);
    if (!title) return false;
    const bare = flatName(apiModel.slice(apiModel.lastIndexOf("/") + 1));
    return slashJoinedNames(title).some((name) => flatName(name) === bare);
};

/** What a provider's per-model page states about size and modality. */
export const readModelPageFacts = (apiModel: string, markdown: string) => {
    const shared = titleNamesSeveralModels(markdown);
    const namesModel = pageTitle(markdown)
        ? titleNamesModel(apiModel, markdown)
        : textNamesModel(apiModel, markdown);
    if (shared && titleAliases(markdown).some((alias) => alias.label.length < 3)) {
        return {
            contextWindowTokens: null,
            maxOutputTokens: null,
            imageInput: null,
            namesModel,
        };
    }
    const owned = documentSentences(markdown).filter((sentence) => {
        const namesThis = sentenceNamesThisModel(apiModel, markdown, sentence);
        // A size with no name is not this model's, unless the page is speaking
        // as itself. "This model has a 1M-token context window." is.
        // "With older models, developers were limited to a 128K-token context
        // window." is not. A shared title still needs the SKU by name.
        const pageVoice = !shared && pageVoiceOwns(plainModelSentence(sentence));
        if (!namesThis && !pageVoice) return false;
        if (pastAboutThisModel(apiModel, markdown, sentence)) return false;
        if (!shared) return sentenceSpeaksFor(apiModel, sentence);
        // A title that names two SKUs has not said which one an unnamed
        // sentence is about. A sentence that names both of them has.
        // "GLM-5.3-Flash and GLM-5.3-FlashX support a 128K-token context
        // window." is a fact about each. A third model in the same sentence
        // is not, and "It supports…" is neither.
        if (!sentenceNamesThisModel(apiModel, markdown, sentence)) return false;
        return sentenceStaysOnTitledModels(markdown, sentence);
    });
    const firstGroup = (match: RegExpMatchArray | null) =>
        match ? (match.slice(1).find(Boolean) ?? null) : null;
    const matchSpans = (sentence: string, pattern: RegExp) => {
        const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
        return [...sentence.matchAll(new RegExp(pattern.source, flags))].map((match) => ({
            start: match.index ?? 0,
            end: (match.index ?? 0) + match[0].length,
        }));
    };
    // One context figure and one output figure may share. Two figures for
    // the same fact may not: "128K- and 1M-token windows, respectively"
    // leaves the first number outside either pattern.
    const sharedFactsPartition = (sentence: string) => {
        const text = plainModelSentence(sentence);
        const figures = matchSpans(
            text,
            /\b\d[\d,]*(?:\.\d+)?(?:\s*[km]\b|(?=\s*[-–]?\s*tokens?\b)|(?=-\s+and\b)|(?=\s+and\s+\d))/i
        );
        const context = matchSpans(text, CONTEXT_SENTENCE);
        const output = matchSpans(text, MAX_OUTPUT_SENTENCE);
        if (context.length > 1 || output.length > 1) return false;
        const claims = [...context, ...output];
        return figures.every((figure) => {
            const covering = claims.filter(
                (claim) => figure.start < claim.end && claim.start < figure.end
            );
            return covering.length === 1;
        });
    };
    const sharedClaim = (sentence: string) =>
        titledNamesAreOneSubject(markdown, sentence) && sharedFactsPartition(sentence);
    const find = (pattern: RegExp) => {
        const values: number[] = [];
        for (const sentence of owned) {
            const text = plainModelSentence(sentence);
            const claims = matchSpans(text, pattern);
            if (claims.length !== 1) continue;
            if (claimIsPast(apiModel, markdown, text, claims[0].start)) continue;
            if (factOpensItsOwnClause(markdown, apiModel, text, claims[0].start, shared)) continue;
            if (
                shared &&
                (namesPartOfTheLine(markdown, text) ||
                    (titledNamesInSentence(markdown, text).size > 1 && !sharedClaim(text)))
            ) {
                continue;
            }
            const match = text.match(pattern);
            if (!match) continue;
            const value = docTokenCell(firstGroup(match) ?? "");
            if (value !== null) values.push(value);
        }
        if (values.length === 0) return null;
        return values.every((value) => value === values[0]) ? values[0] : null;
    };
    const modality = (pattern: RegExp) =>
        owned.some((sentence) => {
            const text = plainModelSentence(sentence);
            if (shared && namesPartOfTheLine(markdown, text)) return false;
            if (
                shared &&
                titledNamesInSentence(markdown, text).size > 1 &&
                !sharedClaim(text)
            ) {
                return false;
            }
            const match = text.match(pattern);
            if (!match || match.index === undefined) return false;
            if (claimIsPast(apiModel, markdown, text, match.index)) return false;
            return !factOpensItsOwnClause(markdown, apiModel, text, match.index, shared);
        });
    return {
        contextWindowTokens: find(CONTEXT_SENTENCE),
        maxOutputTokens: find(MAX_OUTPUT_SENTENCE),
        imageInput: modality(TEXT_ONLY_SENTENCE) && modality(IMAGE_INPUT_SENTENCE)
            ? null
            : modality(TEXT_ONLY_SENTENCE)
              ? false
              : modality(IMAGE_INPUT_SENTENCE)
                ? true
                : null,
        /** Whether the page names this model at all. */
        // A page titled "DeepSeek V3.2" names deepseek-v3.2, in the spelling
        // its own marketing uses. Requiring the API id verbatim made a page
        // about this model read as a page about no model at all. Only this
        // check is relaxed: a table row still has to carry the id, because
        // there the difference between one row and the next is the id.
        // A page with a title has already said which model it is about, and
        // a mention of this one in a comparison paragraph does not change
        // that. Only a page with no title at all falls back to its body.
        namesModel,
    };
};

/**
 * One model's documented facts, from a provider whose pages nobody wrote a
 * parser for.
 */
export const genericModelFromDocs = (input: {
    apiModel: string;
    pricingMarkdown: string | null;
    modelPageMarkdown: string | null;
    shape: DocTableShape;
    /**
     * The column row this provider's standard price table has, as a person
     * read it. Given, only a table with these columns is read at all.
     */
    expectedHeaders?: readonly string[];
    /**
     * Sentences on these pages saying a price will end -- both the ones nobody
     * has acknowledged and the ones acknowledged *for this model*. Carried into
     * the parse rather than only into the run summary: a promotion has to
     * withhold the prefill, and a line in a report an operator may not read is
     * not that.
     */
    promotionalNotices?: readonly string[];
}): ProviderModelDocParse => {
    const problems: string[] = [];
    const fields: ProviderModelDocFields = {
        displayName: null,
        contextWindowTokens: null,
        maxInputTokens: null,
        maxOutputTokens: null,
        imageInput: null,
        inputUsdPerMillionTokens: null,
        cachedInputUsdPerMillionTokens: null,
        cacheWriteUsdPerMillionTokens: null,
        outputUsdPerMillionTokens: null,
        longContext: { kind: "unknown" },
        promotional: null,
    };

    if (input.modelPageMarkdown) {
        if (isNotFoundDocument(input.modelPageMarkdown)) {
            problems.push("model_page_not_found");
        } else {
            const facts = readModelPageFacts(input.apiModel, input.modelPageMarkdown);
            if (!facts.namesModel) {
                // A documentation host answering 200 with somebody else's page,
                // or with a section index, is not this model's page.
                problems.push("model_page_names_other_model");
            } else {
                fields.contextWindowTokens = facts.contextWindowTokens;
                fields.maxOutputTokens = facts.maxOutputTokens;
                fields.imageInput = facts.imageInput;
            }
        }
    }

    const notice = input.promotionalNotices?.find((sentence) => sentence.trim());
    if (notice) {
        fields.promotional = { note: notice.slice(0, 400) };
        problems.push("page_promotional_notice");
    }

    const sized =
        fields.contextWindowTokens !== null || fields.maxOutputTokens !== null;

    if (!input.pricingMarkdown) {
        problems.push("pricing_document_missing");
        return sized
            ? { status: "parsed", fields, problems }
            : { status: "not_found", fields: null, problems };
    }
    if (isNotFoundDocument(input.pricingMarkdown)) {
        problems.push("pricing_document_not_found");
        return { status: "parse_failed", fields: null, problems };
    }

    const read = readPricingRows(
        input.pricingMarkdown,
        input.apiModel,
        input.shape,
        documentUnits(input.pricingMarkdown),
        input.expectedHeaders
    );
    problems.push(...read.problems);
    if (read.matches.length === 0) {
        return sized
            ? { status: "parsed", fields, problems }
            : { status: "not_found", fields: null, problems };
    }

    const tier = tierFromRows(read.matches);
    if (!tier && read.matches.length > 1) {
        problems.push("model_row_duplicated");
        return { status: "parse_failed", fields: null, problems };
    }
    const row = tier ? tier.short : read.matches[0];
    if (tier) {
        fields.longContext = tier.longContext;
        problems.push(...tier.problems);
    }

    if (input.shape === "combined") {
        const prices = combinedPrices(row);
        if (prices.input.kind === "usd") {
            fields.inputUsdPerMillionTokens = prices.input.value;
        } else problems.push(`input_price:${prices.input.reason}`);
        if (prices.output.kind === "usd") {
            fields.outputUsdPerMillionTokens = prices.output.value;
        } else problems.push(`output_price:${prices.output.reason}`);
    } else {
        const inputPrice = pricedCellAt(row, INPUT_COLUMN);
        const outputPrice = pricedCellAt(row, OUTPUT_COLUMN);
        const cachedPrice = pricedCellAt(row, CACHED_INPUT_COLUMN);
        if (inputPrice.kind === "usd") {
            fields.inputUsdPerMillionTokens = inputPrice.value;
        } else problems.push(`input_price:${inputPrice.reason}`);
        if (outputPrice.kind === "usd") {
            fields.outputUsdPerMillionTokens = outputPrice.value;
        } else problems.push(`output_price:${outputPrice.reason}`);
        if (cachedPrice.kind === "usd") {
            fields.cachedInputUsdPerMillionTokens = cachedPrice.value;
        }
    }

    // A table carrying the size in its own columns (Groq, xAI) states it for
    // every row, so it is read here as well as from a model page.
    if (fields.contextWindowTokens === null) {
        fields.contextWindowTokens = docTokenCell(cellAt(row, /context/i));
    }
    if (fields.maxOutputTokens === null) {
        fields.maxOutputTokens = docTokenCell(
            cellAt(row, /max.*(completion|output)/i)
        );
    }

    const priced =
        fields.inputUsdPerMillionTokens !== null &&
        fields.outputUsdPerMillionTokens !== null;
    if (
        !priced &&
        fields.contextWindowTokens === null &&
        fields.maxOutputTokens === null
    ) {
        return { status: "parse_failed", fields: null, problems };
    }
    return { status: "parsed", fields, problems };
};
