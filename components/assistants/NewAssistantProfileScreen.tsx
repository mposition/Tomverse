"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AssistantProfileEditor } from "@/components/assistants/AssistantProfileEditor";
import {
    assistantProfileReturnProduct,
    assistantProfileStartPath,
    stashPendingChatProfile,
} from "@/lib/assistantProfileReturn";
import {
    assistantKnowledgeProfileHref,
    isAssistantKnowledgeGuideRequest,
} from "@/lib/assistantKnowledgeGuide";
import { isLanguage } from "@/lib/language";

/**
 * The create screen, plus where a finished create goes.
 *
 * Fixed destinations: the profile's own edit page, the Knowledge setup guide
 * on that page, or back to the product (`/chat` or `/review`) whose composer
 * opened this screen. Query parameters are compared only with known literals
 * and are never read as URLs, so an attacker-supplied value cannot choose a
 * destination. `lib/assistantProfileReturn.ts` carries the handoff argument in
 * full.
 *
 * The conversation is not named anywhere in this trip. Each product route
 * restores the one the visitor left from its own session storage, so a conversation id
 * never has to survive the navigation — and an id that never travels cannot be
 * swapped for somebody else's.
 */
function NewAssistantProfileFlow() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const returnProduct = assistantProfileReturnProduct(searchParams);
    const fromGuide = isAssistantKnowledgeGuideRequest(searchParams);
    const requestedLanguage = searchParams.get("lang");
    const language = isLanguage(requestedLanguage) ? requestedLanguage : "en";

    if (fromGuide) {
        return (
            <AssistantProfileEditor
                creationEntry="guide"
                onCreated={(profileId) => {
                    router.replace(
                        assistantKnowledgeProfileHref(profileId, language)
                    );
                }}
            />
        );
    }

    if (!returnProduct) return <AssistantProfileEditor />;

    return (
        <AssistantProfileEditor
            creationEntry="chat"
            returnProduct={returnProduct}
            onCreated={(profileId, modelCount) => {
                // A request the product will make through the ordinary binding
                // handler, which re-checks ownership server-side. Stashing it
                // grants nothing; a tampered value earns the same 403 a
                // hand-picked one would.
                stashPendingChatProfile(profileId);
                router.replace(assistantProfileStartPath(returnProduct, modelCount));
            }}
        />
    );
}

export function NewAssistantProfileScreen() {
    return (
        <Suspense fallback={null}>
            <NewAssistantProfileFlow />
        </Suspense>
    );
}
