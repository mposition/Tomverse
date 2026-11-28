import { agentWebUrl, loopbackBrowserUrl, onApprovedSite, type BrowserKind } from "../browser-contract";

/**
 * The decisions the host takes before the agent touches the browser, kept apart from Electron so they can be tested. The agent never
 * names a tab: it gets the one tab its own task opened, in the browser of its own task, and only while that task's run is live.
 */

export type AgentTab = {
  tab: string;
  /** The task and the browser scope the tab was opened under; another task's tab is never reachable from this one. */
  taskId: string;
  scope: string;
  runId: string;
  /** stopped: the person took the tab back; nothing the agent asks is done until they hand it over again. */
  control: "active" | "stopped";
};

export type AgentGateInput = {
  /** The browser tools are on for this build and fixture. */
  enabled: boolean;
  eventRunId: string;
  activeRunId: string | null;
  taskId: string | null;
  taskRunning: boolean;
  /** The task runs on the Tomverse API path (the only path that has these tools). */
  apiExecution: boolean;
  suspended: boolean;
  scope: string | null;
  tool: "navigate" | "read" | "click" | "type" | "screenshot" | "console";
  /** A screenshot of an element the person picked: it needs no tab. */
  pickedScreenshot: boolean;
  agent: AgentTab | undefined;
};

/** Why a request is refused, or null when it may go on. */
export function agentRequestRefusal(input: AgentGateInput): string | null {
  if (!input.enabled) return "The browser tools are not turned on.";
  if (!input.scope || !input.taskId) return "The browser is not available for this task.";
  if (input.eventRunId !== input.activeRunId || !input.taskRunning || !input.apiExecution || input.suspended) return "The task is not running.";
  const own = input.agent && input.agent.taskId === input.taskId && input.agent.scope === input.scope ? input.agent : undefined;
  if (own?.control === "stopped") return "The user took control of the browser. Ask them before using it again.";
  if (input.tool === "navigate" || input.pickedScreenshot) return null;
  if (input.agent && !own) return "That browser tab belongs to another task.";
  if (!own) return "No browser page is open for this task. Open one with browser_navigate.";
  return null;
}

/**
 * The only addresses the agent may open: a loopback page with a port (the same ones the person may open in the panel) and, when the
 * person's second switch is on, a public https site on the standard port. Nothing else, whatever the model says.
 */
export function agentNavigateTarget(value: string, options: { web?: boolean } = {}): { url: URL; kind: BrowserKind } | { error: string } {
  const local = loopbackBrowserUrl(value.trim());
  if (local) return { url: local, kind: "local" };
  const web = options.web ? agentWebUrl(value) : null;
  if (web) return { url: web, kind: "web" };
  return { error: options.web
    ? "Only an https address of a public site (standard port) or an http address on localhost, 127.0.0.1 or [::1] with a port can be opened (for example https://example.com/ or http://localhost:3000/)."
    : "Only an http address on localhost, 127.0.0.1 or [::1] with a port can be opened (for example http://localhost:3000/)." };
}

/**
 * A tab the agent holds on a public site stays on the sites the person approved for it: the page it opened, and every address it was
 * later asked to open. A page that moves on by itself (a redirect, a link, a form) is stopped, and anything the person did in the tab
 * after taking it is not read or acted on either until the agent is asked to open that site. No set means a local tab (pinned to its origin).
 */
export function agentMayUsePage(approvedHosts: ReadonlySet<string> | undefined, pageUrl: string): boolean {
  if (!approvedHosts) return true;
  return onApprovedSite(approvedHosts, pageUrl);
}

/** A click or typing is bound to the site the person approved: the page must still be on it. */
export function sameApprovedSite(approvedOrigin: string, pageUrl: string): boolean {
  try { return new URL(pageUrl).origin === approvedOrigin; } catch { return false; }
}
