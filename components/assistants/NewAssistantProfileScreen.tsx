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

/**
 * The create screen, plus where a finished create goes.
 *
 * Two destinations and no third: the profile's own edit page, or back to the
 * chat. Which one is decided by comparing one query parameter to one literal —
 * the parameter is never read as a URL, so there is nothing here that an
 * attacker-supplied value could point at. `lib/assistantProfileReturn.ts`
 * carries that argument in full.
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

    if (!fromChat) return <AssistantProfileEditor />;

    return (
        <AssistantProfileEditor
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
