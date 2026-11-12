/**
 * A stand-in for the retrieval provider, for the database suites.
 *
 * Nothing leaves the process: `globalThis.fetch` is replaced for the duration
 * of a suite. Vectors are deterministic and deliberately crude -- one
 * dimension per concept, set when the text mentions it -- so "a question and a
 * passage about the same thing in different words" is something a test can
 * state exactly. Rerank scores come from a function the test supplies.
 */

const CONCEPTS: ReadonlyArray<RegExp> = [
    /환불|반품|refund|return/i,
    /커피|카페인|coffee|caffeine/i,
    /배송|shipping/i,
    /등산|hiking/i,
];

/** One dimension per concept, plus a last one for text that mentions none. */
export const toyVector = (text: string): number[] => {
    const vector: number[] = new Array<number>(CONCEPTS.length + 1).fill(0);
    CONCEPTS.forEach((pattern, index) => {
        if (pattern.test(text)) vector[index] = 100;
    });
    if (!vector.some((value) => value !== 0)) vector[CONCEPTS.length] = 100;
    return vector;
};

export const TEST_RETRIEVAL_ENV = {
    COHERE_API_KEY: "test-key-not-a-real-credential",
    COHERE_RERANK_MODEL: "rerank-test",
    COHERE_RERANK_MICROUSD_PER_SEARCH_UNIT: "2000",
    COHERE_EMBED_MODEL: "embed-test",
    COHERE_EMBED_MICROUSD_PER_MILLION_TEXT_TOKENS: "100000",
    COHERE_EMBED_MICROUSD_PER_MILLION_IMAGE_TOKENS: "200000",
    RETRIEVAL_PROVIDER_COHERE_COST_MICROUSD_PER_DAY: "5000000",
    RETRIEVAL_PROVIDER_COHERE_COST_MICROUSD_PER_MONTH: "50000000",
} as const;

/** The label a vector from this provider is stored under. */
export const TEST_EMBEDDING_LABEL = "cohere:embed-test:default:int8";

export type ProviderCall = { api: "rerank" | "embed"; body: Record<string, unknown> };

export const installTestRetrievalProvider = () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = new Map<string, string | undefined>();
    for (const [name, value] of Object.entries(TEST_RETRIEVAL_ENV)) {
        originalEnv.set(name, process.env[name]);
        process.env[name] = value;
    }

    const state = {
        calls: [] as ProviderCall[],
        /** When true every request answers 500. */
        failing: false,
        rerankScore: ((): number => 0.5) as (query: string, document: string) => number,
    };

    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const api = url.endsWith("/v2/rerank") ? "rerank" : "embed";
        state.calls.push({ api, body });
        if (state.failing) return new Response("{}", { status: 500 });

        if (api === "rerank") {
            const documents = body.documents as string[];
            return Response.json({
                results: documents.map((document, index) => ({
                    index,
                    relevance_score: state.rerankScore(String(body.query), document),
                })),
                meta: { billed_units: { search_units: 1 } },
            });
        }
        const inputs = Array.isArray(body.texts)
            ? (body.texts as string[])
            : (body.inputs as unknown[]).map(() => "image");
        return Response.json({
            embeddings: { int8: inputs.map(toyVector) },
            meta: { billed_units: { input_tokens: 10, image_tokens: 10 } },
        });
    }) as typeof fetch;

    return {
        state,
        setEnv(name: string, value: string) {
            if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
            process.env[name] = value;
        },
        reset() {
            state.calls.length = 0;
            state.failing = false;
            state.rerankScore = () => 0.5;
            for (const [name, value] of Object.entries(TEST_RETRIEVAL_ENV)) {
                process.env[name] = value;
            }
        },
        restore() {
            globalThis.fetch = originalFetch;
            for (const [name, value] of originalEnv) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        },
    };
};
