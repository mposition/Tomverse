/**
 * amux-intake v19 item 7: "알림은 링크만 담는다". When a session analysis
 * answer ends anywhere but a registered plan, the operator gets one existing
 * operational alert whose body is the idea's Admin link and a closed reason
 * word -- no idea text, plan text, path or model output.
 */

import "server-only";

import { reportOperationalIncident } from "@/lib/operationalMonitoring";

export const AMUX_SESSION_IDEA_ALERT_CODE = "AMUX_V19_SESSION_IDEA_NEEDS_OPERATOR";
const REASON = /^[a-z_]{1,40}$/;
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export const amuxSessionIdeaAdminUrl = (requestId: string,
  env: Readonly<Record<string, string | undefined>>): string =>
  `${(env.PUBLIC_APP_URL || env.NEXT_PUBLIC_APP_URL || "https://tomverse.app")
    .replace(/\/+$/u, "")}/admin/amux-backlog?tab=ideas&idea=${
    encodeURIComponent(requestId)}`;

/** Never throws: the result it describes is already committed. */
export async function reportAmuxSessionIdeaNeedsOperator(
  input: { readonly requestId: string; readonly reason: string },
  deps: { readonly report?: typeof reportOperationalIncident;
    readonly env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<void> {
  if (!REQUEST_ID.test(input.requestId) || !REASON.test(input.reason)) return;
  const env = deps.env ?? process.env;
  try {
    await (deps.report ?? reportOperationalIncident)({
      code: AMUX_SESSION_IDEA_ALERT_CODE,
      title: "An AMUX session idea needs the operator",
      severity: "warning",
      // Each idea is its own decision; a cooldown would drop the next one.
      forceNotification: true,
      context: { component: "amux-intake", reason: input.reason,
        admin: amuxSessionIdeaAdminUrl(input.requestId, env) },
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "amux_session_idea_alert_failed",
      errorName: error instanceof Error ? error.name : typeof error }));
  }
}
