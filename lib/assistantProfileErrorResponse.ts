import { NextResponse } from "next/server";

import { AssistantProfilesDisabledError } from "@/lib/appSettings";
import { AssistantProfileError } from "@/lib/assistantProfileService";

export const assistantProfileErrorResponse = (error: unknown) => {
    if (error instanceof AssistantProfileError) {
        return NextResponse.json(
            {
                error: error.message,
                code: error.code,
                ...(error.problems ? { problems: error.problems } : {}),
            },
            { status: error.status, headers: { "Cache-Control": "no-store" } }
        );
    }
    if (error instanceof AssistantProfilesDisabledError) {
        return NextResponse.json(
            {
                error: "Assistant profiles are not enabled.",
                code: "ASSISTANT_PROFILES_DISABLED",
            },
            { status: 403, headers: { "Cache-Control": "no-store" } }
        );
    }
    return null;
};
