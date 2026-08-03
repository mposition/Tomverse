import { chatgptAdapter } from "@/lib/externalImportAdapters/chatgpt";
import { claudeAdapter } from "@/lib/externalImportAdapters/claude";
import type {
    ExternalAdapterProvider,
    ExternalConversationAdapter,
} from "@/lib/externalImportAdapters/types";

export const EXTERNAL_IMPORT_ADAPTERS: readonly ExternalConversationAdapter[] =
    [chatgptAdapter, claudeAdapter];

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
