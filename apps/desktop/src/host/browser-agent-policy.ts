import { loopbackBrowserUrl } from "../browser-contract";

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

/** The only addresses the agent may open: the same loopback pages the person may open in the panel, with an explicit port. */
export function agentNavigateTarget(value: string): { url: URL } | { error: string } {
  const url = loopbackBrowserUrl(value.trim());
  return url ? { url } : { error: "Only an http address on localhost, 127.0.0.1 or [::1] with a port can be opened (for example http://localhost:3000/)." };
}

/** A click or typing is bound to the site the person approved: the page must still be on it. */
export function sameApprovedSite(approvedOrigin: string, pageUrl: string): boolean {
  try { return new URL(pageUrl).origin === approvedOrigin; } catch { return false; }
}
