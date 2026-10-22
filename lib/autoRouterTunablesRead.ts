import "server-only";

import type { Prisma } from "@prisma/client";
import { EMPTY_TUNABLES, parseTunables, type AutoRouterTunables } from "@/lib/autoRouterTunablesCore";
import { prisma } from "@/lib/prisma";

/**
 * Reading the optimizer's setting changes (lib/autoRouterTunablesCore.ts). Its
 * own module so the live router can read them without importing the
 * optimizer that writes them.
 */
export const AUTO_ROUTER_TUNABLES_SETTING_KEY = "auto.llmRouterTunables";

/** The owner's switch: off unless stored on, and then no change is applied. */
export const AUTO_ROUTER_SETTING_AUTO_APPLY_KEY = "auto.llmRouterSettingAutoApply";

type SettingReader = Pick<Prisma.TransactionClient, "appSetting">;

/** The stored settings, or none when the row is missing, unreadable or off its shape. */
export async function readAutoRouterTunables(db: SettingReader = prisma): Promise<AutoRouterTunables> {
    try {
        const row = await db.appSetting.findUnique({
            where: { key: AUTO_ROUTER_TUNABLES_SETTING_KEY },
            select: { value: true },
        });
        return parseTunables(row?.value);
    } catch {
        return EMPTY_TUNABLES;
    }
}

export async function readSettingAutoApply(db: SettingReader = prisma): Promise<boolean> {
    try {
        const row = await db.appSetting.findUnique({
            where: { key: AUTO_ROUTER_SETTING_AUTO_APPLY_KEY },
            select: { value: true },
        });
        if (!row) return false;
        return (JSON.parse(row.value) as { enabled?: unknown } | null)?.enabled === true;
    } catch {
        return false;
    }
}
