import "server-only";

import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import { prisma } from "@/lib/prisma";
import { TEMPORARY_CHAT_FLAG_KEY, temporaryChatEnabledFromValue } from "@/lib/temporaryChatAccess";

/*
 * Kept out of lib/appSettings.ts for the reason lib/helpAssistantSettings.ts
 * gives: that file is in the Prompt Refiner's pinned runtime source closure.
 */

/** Whether a new temporary Chat may be started. Unreadable is off. */
export async function isTemporaryChatEnabled(): Promise<boolean> {
    if (isE2EDatabaseDisabled()) return false;
    try {
        const row = await prisma.appSetting.findUnique({
            where: { key: TEMPORARY_CHAT_FLAG_KEY },
            select: { value: true },
        });
        return temporaryChatEnabledFromValue(row?.value);
    } catch {
        return false;
    }
}
