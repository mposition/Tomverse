import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { getMemorySettings, putMemorySettings } from "@/lib/memoryService";

/**
 * Account memory controls (§8.1, §21). Deliberately NOT flag-gated: the
 * master toggle is a privacy control, and turning the rollout off must
 * never lock a user out of turning their own memory off.
 */

export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await consumeApiRateLimit(req, session.user.id, "memory-settings-read", {
            minute: 30,
            day: 500,
        });
        return NextResponse.json(await getMemorySettings(session.user.id), {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("memory settings read failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}

const putSchema = z
    .object({
        masterEnabled: z.boolean(),
        styleEnabled: z.boolean(),
        defaultConversationMode: z.enum(["on", "off"]),
    })
    .strict();

export async function PUT(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await consumeApiRateLimit(req, session.user.id, "memory-settings-write", {
            minute: 10,
            day: 200,
        });

        const body = await readLimitedJson(req, 4 * 1024, putSchema);
        return NextResponse.json(
            await putMemorySettings(session.user.id, body),
            { headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("memory settings write failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
