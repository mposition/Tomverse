export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { createSavedPrompt, listSavedPrompts, SavedPromptLimitReached } from "@/lib/savedPrompts";
import { SAVED_PROMPT_LIMITS, savedPromptCreateSchema } from "@/lib/savedPromptsCore";

/**
 * The signed-in account's saved prompts (lib/savedPrompts.ts): list and save.
 * A guest is answered 401 and the composer asks them to sign in. Web only:
 * the native and desktop bearer gates do not enrol this path.
 */

const BODY_BYTES = 64 * 1024;

const signedInUser = async (req: Request) => {
    const authentication = await resolveChatRouteSession(req);
    if (authentication.response) return { response: authentication.response };
    const userId = authentication.session?.user?.id;
    if (!userId) return { response: NextResponse.json({ error: "Login required", code: "AUTH_REQUIRED" }, { status: 401 }) };
    return { userId };
};

export async function GET(req: Request) {
    try {
        const auth = await signedInUser(req);
        if (!auth.userId) return auth.response;
        await consumeApiRateLimit(req, auth.userId, "saved-prompts-read", { minute: 60, day: 2_000 });
        return NextResponse.json(
            { prompts: await listSavedPrompts(auth.userId), limits: SAVED_PROMPT_LIMITS },
            { headers: { "Cache-Control": "private, no-store" } }
        );
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Failed to list saved prompts:", error);
        return NextResponse.json({ error: "Failed to load saved prompts." }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const auth = await signedInUser(req);
        if (!auth.userId) return auth.response;
        await consumeApiRateLimit(req, auth.userId, "saved-prompts-write", { minute: 30, day: 500 });
        const body = await readLimitedJson(req, BODY_BYTES, savedPromptCreateSchema);
        const prompt = await createSavedPrompt(auth.userId, body);
        return NextResponse.json({ prompt }, { status: 201 });
    } catch (error) {
        if (error instanceof SavedPromptLimitReached) {
            return NextResponse.json({ error: error.message, code: "SAVED_PROMPT_LIMIT" }, { status: 409 });
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Failed to save a prompt:", error);
        return NextResponse.json({ error: "Failed to save the prompt." }, { status: 500 });
    }
}
