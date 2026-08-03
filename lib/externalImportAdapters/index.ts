import { chatgptAdapter } from "@/lib/externalImportAdapters/chatgpt";
import { claudeAdapter } from "@/lib/externalImportAdapters/claude";
import type {
    ExternalAdapterProvider,
    ExternalConversationAdapter,
} from "@/lib/externalImportAdapters/types";

export type {
    ExternalAdapterProvider,
    ExternalConversationAdapter,
    ParsedExternalConversation,
    ParsedExternalMessage,
} from "@/lib/externalImportAdapters/types";

export const EXTERNAL_IMPORT_ADAPTERS: readonly ExternalConversationAdapter[] =
    [chatgptAdapter, claudeAdapter];

/**
 * Version label of the client-side parsing stack (adapters + archive walker +
 * pipeline), sent with each import so parse failure rates can be broken down
 * by parser build in the §22 metrics. Bump on any behavioural change to the
 * adapters, the archive rules or the pipeline.
 *
 * v2 also marks the client contract change that came with the wizard: a v2
 * client seals its upload before reviewing, so an import left in `staging`
 * was created by a pre-wizard session. The finalize path still accepts
 * `staging` for the whole 72h absolute TTL so those older tabs can complete,
 * but the wizard only ever offers to resume `preview_ready`.
 */
export const EXTERNAL_IMPORT_PARSER_VERSION = "v2";

/** First adapter whose detect() accepts the parsed export, or null. */
export function detectExternalImportAdapter(
    value: unknown
): ExternalConversationAdapter | null {
    for (const adapter of EXTERNAL_IMPORT_ADAPTERS) {
        if (adapter.detect(value)) return adapter;
    }
    return null;
}

export function getExternalImportAdapter(
    provider: ExternalAdapterProvider
): ExternalConversationAdapter {
    const adapter = EXTERNAL_IMPORT_ADAPTERS.find(
        (candidate) => candidate.provider === provider
    );
    if (!adapter) throw new Error(`Unknown import provider: ${provider}`);
    return adapter;
}
