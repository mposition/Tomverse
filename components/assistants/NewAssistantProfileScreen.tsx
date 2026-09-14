"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AssistantProfileEditor } from "@/components/assistants/AssistantProfileEditor";
import {
    ASSISTANT_PROFILE_CHAT_PATH,
    ASSISTANT_PROFILE_RETURN_CHAT,
    ASSISTANT_PROFILE_RETURN_PARAM,
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
 * Three fixed destinations: the profile's own edit page, the Knowledge setup
 * guide on that page, or back to chat. Query parameters are compared only with
 * known literals and are never read as URLs, so an attacker-supplied value
 * cannot choose a destination. `lib/assistantProfileReturn.ts` carries the
 * chat handoff argument in full.
 *
 * The conversation is not named anywhere in this trip. `/chat` restores the
 * one the visitor left from its own session storage, so a conversation id
 * never has to survive the navigation — and an id that never travels cannot be
 * swapped for somebody else's.
 */
function NewAssistantProfileFlow() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const fromChat =
        searchParams.get(ASSISTANT_PROFILE_RETURN_PARAM) ===
        ASSISTANT_PROFILE_RETURN_CHAT;
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

    if (!fromChat) return <AssistantProfileEditor />;

    return (
        <AssistantProfileEditor
            creationEntry="chat"
            onCreated={(profileId) => {
                // A request the chat will make through the ordinary binding
                // handler, which re-checks ownership server-side. Stashing it
                // grants nothing; a tampered value earns the same 403 a
                // hand-picked one would.
                stashPendingChatProfile(profileId);
                router.replace(ASSISTANT_PROFILE_CHAT_PATH);
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
