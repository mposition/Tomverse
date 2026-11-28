export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { deleteSavedPrompt, updateSavedPrompt } from "@/lib/savedPrompts";
import { savedPromptUpdateSchema } from "@/lib/savedPromptsCore";

/** Rename, edit or delete one of the account's saved prompts. Another account's id is 404. */

type Context = { params: Promise<{ promptId: string }> };

const signedInUser = async (req: Request) => {
    const authentication = await resolveChatRouteSession(req);
    if (authentication.response) return { response: authentication.response };
    const userId = authentication.session?.user?.id;
    if (!userId) return { response: NextResponse.json({ error: "Login required", code: "AUTH_REQUIRED" }, { status: 401 }) };
    return { userId };
};

const notFound = () => NextResponse.json({ error: "Saved prompt not found." }, { status: 404 });

export async function PATCH(req: Request, context: Context) {
    try {
        const auth = await signedInUser(req);
        if (!auth.userId) return auth.response;
        await consumeApiRateLimit(req, auth.userId, "saved-prompts-write", { minute: 30, day: 500 });
        const { promptId } = await context.params;
        const patch = await readLimitedJson(req, 64 * 1024, savedPromptUpdateSchema);
        const prompt = await updateSavedPrompt(auth.userId, promptId, patch);
        return prompt ? NextResponse.json({ prompt }) : notFound();
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Failed to update a saved prompt:", error);
        return NextResponse.json({ error: "Failed to update the prompt." }, { status: 500 });
    }
}

export async function DELETE(req: Request, context: Context) {
    try {
        const auth = await signedInUser(req);
        if (!auth.userId) return auth.response;
        await consumeApiRateLimit(req, auth.userId, "saved-prompts-write", { minute: 30, day: 500 });
        const { promptId } = await context.params;
        return (await deleteSavedPrompt(auth.userId, promptId)) ? NextResponse.json({ success: true }) : notFound();
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Failed to delete a saved prompt:", error);
        return NextResponse.json({ error: "Failed to delete the prompt." }, { status: 500 });
    }
}
