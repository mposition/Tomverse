/**
 * The search backends this application drives itself, and the limits that
 * bound one turn's use of them.
 *
 * ## Why there is such a thing as an application-managed backend
 *
 * A provider-native search is the provider's own tool: the model decides to
 * search, the provider runs the query, and the bill arrives afterwards. That
 * works exactly as long as the request can say how many searches it is willing
 * to pay for -- Anthropic's `maxUses`, OpenAI's `max_tool_calls`. Google's
 * Search grounding takes neither, on the tool or on the request, so a Gemini
 * turn's search cost has no worst case and `nativeSearchIsDispatchable` has
 * refused it since the ceiling rule landed. Every active Google model was
 * therefore offered as unable to search, on a product where they are four of
 * the models people actually pick.
 *
 * The tempting fixes are all the same fix wearing different clothes: reserve
 * an observed average, ask the model in the system prompt to search "at most
 * five times", trust the provider's project quota. None of those is a ceiling
 * the request enforces, and a reservation sized on a number nobody enforces is
 * a reservation that is correct until the first turn that matters.
 *
 * So the search stops being the provider's and becomes this application's: a
 * plain function tool the model calls, executed here, against a backend this
 * code holds the connection to. The ceiling is then a counter in this process,
 * which is the only kind of ceiling that cannot be talked out of.
 *
 * ## Why this module is pure
 *
 * The composer, the model picker, the credit estimate and the message badge
 * all need to know that a model searches through a backend and how much a turn
 * may reserve for it. They are client components. The adapter that actually
 * calls Brave is `server-only`; the facts about *which* backends exist and
 * what bounds them live here, where both halves can read them.
 *
 * Policy: docs/policy/credit-and-cost-limits.md, "Application-managed web
 * search".
 */

/** Every backend this application knows how to drive. */
export const WEB_SEARCH_BACKENDS = ["brave"] as const;

export type WebSearchBackend = (typeof WEB_SEARCH_BACKENDS)[number];

export const isWebSearchBackend = (value: unknown): value is WebSearchBackend =>
    typeof value === "string" &&
    (WEB_SEARCH_BACKENDS as readonly string[]).includes(value);

/**
 * What one model may spend on search in one turn, and what one search may
 * bring back.
 *
 * `maxQueriesPerRequest` is the number the cost reservation is sized on and
 * the number the executor's counter enforces. They are the same field on
 * purpose: a constant the reservation reads and a different constant the
 * counter reads is two ceilings that can drift, and the drift is only ever
 * visible as an overspend.
 *
 * Approved figures (docs/policy/credit-and-cost-limits.md):
 *   - five backend requests per model per turn;
 *   - five results per request;
 *   - US$5.00 per 1,000 Brave requests, so 5,000 micro-USD each and a
 *     25,000 micro-USD worst case per model per turn.
 *
 * The size caps below are not money, they are prompt budget: retrieved result
 * text is fed back into the model's context, and an unbounded snippet is an
 * unbounded input token bill on a turn whose input was already reserved.
 */
export const APP_MANAGED_SEARCH_LIMITS = {
    /** Backend requests one model may make in one turn. Enforced by a counter. */
    maxQueriesPerRequest: 5,
    /** Results kept from one backend response. */
    maxResultsPerQuery: 5,
    /** Longest query the tool will send. Longer is refused, never truncated. */
    maxQueryCharacters: 400,
    /** Most whitespace-separated words a query may carry. */
    maxQueryWords: 50,
    /** Longest snippet kept per result. Truncated, since a snippet is prose. */
    maxSnippetCharacters: 400,
    /** Longest title kept per result. */
    maxTitleCharacters: 200,
    /**
     * Ceiling on the whole serialized result set handed back to the model, in
     * characters. Reached by dropping whole results from the end, so what the
     * model sees is always a prefix of what the backend ranked first.
     */
    maxResultPayloadCharacters: 6_000,
    /** How long one backend request may take before it is aborted. */
    requestTimeoutMs: 8_000,
} as const;

/**
 * Which backends this running process could actually reach, as opposed to
 * which ones the capability register declares.
 *
 * Two different facts, and collapsing them is how a composer promises a search
 * that the deployment has no API key for. The register is compiled in and the
 * same everywhere; readiness is a property of one environment, so it is
 * resolved on the server and handed to the client as data rather than guessed
 * at from a public environment variable -- a client that could see the key's
 * presence would be a client that could see the key's presence.
 *
 * An absent entry is not ready. Nothing here defaults to true.
 */
export type WebSearchBackendReadiness = Readonly<
    Partial<Record<WebSearchBackend, boolean>>
>;

/** No backend reachable. The correct answer when nobody has said otherwise. */
export const NO_WEB_SEARCH_BACKENDS: WebSearchBackendReadiness = Object.freeze(
    {}
);

/**
 * Every backend reachable.
 *
 * For tests and for the pure-capability questions that are deliberately about
 * the register rather than about one deployment -- `check:*` scripts and the
 * catalogue inventory. Never used to answer a user-facing surface: that would
 * be the fail-open this type exists to prevent.
 */
export const ALL_WEB_SEARCH_BACKENDS_READY: WebSearchBackendReadiness =
    Object.freeze(
        Object.fromEntries(
            WEB_SEARCH_BACKENDS.map((backend) => [backend, true])
        ) as Record<WebSearchBackend, boolean>
    );

export const isWebSearchBackendReady = (
    readiness: WebSearchBackendReadiness | undefined,
    backend: WebSearchBackend | undefined
): boolean =>
    backend !== undefined && readiness?.[backend] === true;

/** Parses a readiness map off untrusted JSON without letting unknown keys in. */
export const parseWebSearchBackendReadiness = (
    value: unknown
): WebSearchBackendReadiness => {
    if (!value || typeof value !== "object") return NO_WEB_SEARCH_BACKENDS;
    const record = value as Record<string, unknown>;
    const parsed: Partial<Record<WebSearchBackend, boolean>> = {};
    for (const backend of WEB_SEARCH_BACKENDS) {
        if (record[backend] === true) parsed[backend] = true;
    }
    return Object.freeze(parsed);
};

/**
 * One search result, after the adapter has stripped everything a result has no
 * business carrying.
 *
 * Declared here rather than beside the adapter because the pure halves of this
 * feature -- the session counter, the citation normaliser, the tests for both
 * -- hold these values and must not import a `server-only` module to name
 * their type.
 */
export type WebSearchBackendResult = {
    title: string;
    url: string;
    snippet?: string;
    /** ISO-8601 when the backend published one, otherwise absent. */
    publishedAt?: string;
};

/** Why a query the model wrote will not be sent to a backend. */
export type SearchQueryRejection =
    /** Nothing but whitespace, or not a string at all. */
    | "empty_query"
    | "query_too_long"
    | "query_too_many_words";

export type SearchQueryValidation =
    | { ok: true; query: string }
    | { ok: false; reason: SearchQueryRejection };

/**
 * Whether this is a query worth spending a backend request on.
 *
 * Refuses rather than truncates. A truncated query is a different question
 * from the one the model asked, answered at full price, and the model has no
 * way to tell that happened -- so it reads the results as though they answered
 * what it wrote. A refusal costs nothing and the model can rephrase.
 *
 * A refusal deliberately does *not* consume the turn's query budget: the
 * counter is incremented by the executor around the backend call, and no call
 * is made here.
 */
export const validateSearchQuery = (raw: unknown): SearchQueryValidation => {
    if (typeof raw !== "string") return { ok: false, reason: "empty_query" };
    const query = raw.trim().replace(/\s+/g, " ");
    if (!query) return { ok: false, reason: "empty_query" };
    if (query.length > APP_MANAGED_SEARCH_LIMITS.maxQueryCharacters) {
        return { ok: false, reason: "query_too_long" };
    }
    if (query.split(" ").length > APP_MANAGED_SEARCH_LIMITS.maxQueryWords) {
        return { ok: false, reason: "query_too_many_words" };
    }
    return { ok: true, query };
};
