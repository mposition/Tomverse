import "server-only";

import type { AdmittedTunableChange } from "@/lib/autoRouterTunablesCore";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";

/**
 * The operator's notice of each setting the optimizer changed or undid on its
 * own. The owner made this the condition of the permission (2026-10-20: "운영자에게
 * 알림은 가야됩니다"). Delivered through the existing operational alert path
 * (`reportOperationalIncident`: `OPS_ALERT_EMAIL` and any configured chat
 * webhook), with every notice forced past the per-code cooldown: each one is a
 * different change the operator should see.
 *
 * Never throws. The change is already committed with its audit entry; a
 * failed notice is logged, and Admin › Routing shows every applied setting
 * whether or not the notice arrived.
 */
export const AUTO_ROUTER_TUNABLE_INCIDENT_CODE = "AUTO_ROUTER_SETTING_CHANGED";

const adminRoutingUrl = (env: Readonly<Record<string, string | undefined>>) =>
    `${(env.PUBLIC_APP_URL || env.NEXT_PUBLIC_APP_URL || "https://tomverse.app").replace(/\/+$/u, "")}/admin/routing`;

export type TunableNotice =
    | { kind: "applied"; cycleId: string; change: AdmittedTunableChange; previousTimeoutMs?: number }
    | { kind: "reverted"; cycleId: string | null; setting: "routerTimeoutMs"; from: number; to: number; reason: string };

const describe = (notice: TunableNotice) => {
    if (notice.kind === "reverted") {
        return {
            title: `Auto router: the router timeout went back to ${notice.to} ms (it made routing worse)`,
            context: { setting: notice.setting, from: notice.from, to: notice.to, reason: notice.reason },
        };
    }
    const change = notice.change;
    return change.setting === "routerTimeoutMs"
        ? {
              title: `Auto router: the router timeout changed to ${change.value} ms`,
              context: { setting: change.setting, from: notice.previousTimeoutMs ?? null, to: change.value, reason: change.reason },
          }
        : {
              title: `Auto router: ${change.modelId} is left out of Auto's choices for ${change.hours} h`,
              context: { setting: change.setting, modelId: change.modelId, hours: change.hours, reason: change.reason },
          };
};

export async function notifyAutoRouterTunable(
    notice: TunableNotice,
    deps: {
        readonly report?: typeof reportOperationalIncident;
        readonly env?: Readonly<Record<string, string | undefined>>;
    } = {}
): Promise<boolean> {
    const env = deps.env ?? process.env;
    const { title, context } = describe(notice);
    try {
        await (deps.report ?? reportOperationalIncident)({
            code: AUTO_ROUTER_TUNABLE_INCIDENT_CODE,
            title,
            severity: "warning",
            forceNotification: true,
            context: {
                component: "auto-router-optimizer",
                kind: notice.kind,
                cycleId: notice.cycleId,
                admin: adminRoutingUrl(env),
                ...context,
            },
        });
        return true;
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "auto_router_tunable_alert_failed",
                errorName: error instanceof Error ? error.name : typeof error,
            })
        );
        return false;
    }
}
