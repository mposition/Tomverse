import { randomUUID } from "node:crypto";
import { browserAgentRequest, type BrowserAgentReply, type BrowserAgentRequest } from "../../../tomverse-cli/src/browser-tools";
import { MAX_CODE_BROWSER_TABS, webHostKey, type BrowserCommand, type BrowserKind, type BrowserState, type ElementPick } from "../browser-contract";
import { agentMayUsePage, agentNavigateTarget, agentRequestRefusal, type AgentTab } from "./browser-agent-policy";
import { cleanReply } from "./browser-agent-format";
import type { BrowserDriver } from "./code-browser-driver";
import { readPick } from "./browser-pick-store";

/**
 * The host side of the agent's browser tools and of the element picker. The agent is handed one tab, opened by its own task in the
 * task's own browser; the person sees it in the panel, can take it back at any moment, and every request is checked here against
 * the live run before anything touches the page.
 */

export type BridgeTab = { kind: BrowserKind; origin: string; driver: BrowserDriver; current(): BrowserState | null;
  /** The site a page tried to move to that the agent was not given (once); null when there was none. */
  takeBlocked(): string | null };
export type BridgeRun = { runId: string | null; taskId: string | null; running: boolean; apiExecution: boolean; suspended: boolean; scope: string | null };
export type BridgeDeps = {
  /** The browser tools are on (a default-off switch of the fixture). */
  enabled(): boolean;
  /** The person's second switch: the agent may open public https sites too. Checked again at every address. */
  webEnabled(): boolean;
  run(): BridgeRun;
  tab(id: string): BridgeTab | undefined;
  tabs(): Array<[string, BridgeTab]>;
  /** Opens the address in the tab through the same command the panel uses, so the address rules are the same ones. */
  open(tab: string, url: string): Promise<unknown>;
  publish(state: BrowserState): void;
  publishPick(pick: ElementPick): void;
  reply(runId: string, requestId: string, reply: BrowserAgentReply): void;
  clean(text: string): string;
};

const fail = (message: string): BrowserAgentReply => ({ status: "error", message });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createBrowserAgentBridge(deps: BridgeDeps) {
  /** hosts: the sites of a web tab the person approved for this task (each address the agent was allowed to open); empty for a local tab. */
  let agent: (AgentTab & { hosts: Set<string> }) | undefined;
  let busy = 0;
  const inflight = new Set<AbortController>();

  const agentState = (tab: string): BrowserState["agent"] =>
    agent?.tab !== tab ? undefined : agent.control === "stopped" ? "stopped" : busy > 0 ? "working" : "idle";
  const decorate = (state: BrowserState): BrowserState => {
    const mark = agentState(state.tab);
    const picking = deps.tab(state.tab)?.driver.isPicking() === true;
    return mark || picking ? { ...state, ...(mark ? { agent: mark } : {}), ...(picking ? { picking: true } : {}) } : state;
  };
  const publishTab = (tab: string) => {
    const state = deps.tab(tab)?.current();
    if (state) deps.publish(decorate(state));
  };

  /** The panel lays the tab out when it learns of it; a request that needs a size waits for that, briefly. */
  const waitForSize = async (view: BridgeTab, signal: AbortSignal) => {
    for (let waited = 0; waited < 3_000; waited += 100) {
      const { width, height } = view.driver.size();
      if (width > 0 && height > 0) return;
      signal.throwIfAborted();
      await sleep(100);
    }
  };

  const MOVED = "The page tried to go to a site you were not given (";
  const blockedReply = (host: string) => fail(MOVED + host + "), so it was stopped. Open that address with browser_navigate if you need it; the user is asked first.");

  async function execute(request: BrowserAgentRequest, run: BridgeRun, runId: string, signal: AbortSignal): Promise<BrowserAgentReply> {
    if (request.tool === "screenshot" && request.pick) {
      const stored = readPick(request.pick);
      return stored ? { status: "ok", url: stored.url, image: { mediaType: stored.mediaType, base64: stored.base64 } } : fail("That picked element is no longer available.");
    }
    if (request.tool === "navigate") {
      const target = agentNavigateTarget(request.url, { web: deps.webEnabled() });
      if ("error" in target) return fail(target.error);
      if (agent && (agent.taskId !== run.taskId || agent.scope !== run.scope)) agent = undefined;
      const existing = agent && deps.tab(agent.tab);
      const tab = existing && agent ? agent.tab : randomUUID();
      if (!existing && deps.tabs().length >= MAX_CODE_BROWSER_TABS) return fail("The browser has no free tab. Ask the user to close one.");
      // The site is approved before the page is asked for, so the tab's own checks already know it when the first request goes out.
      agent = { tab, taskId: run.taskId!, scope: run.scope!, runId, control: agent?.control ?? "active", hosts: existing && agent ? agent.hosts : new Set() };
      if (target.kind === "web") agent.hosts.add(webHostKey(target.url));
      try { await deps.open(tab, target.url.href); }
      catch { if (!deps.tab(tab)) agent = undefined; return fail("The page could not be opened."); }
      const view = deps.tab(tab);
      if (!view) return fail("The browser tab was closed.");
      // The panel learns of the tab (and shows itself) as soon as the agent has one, whatever the page does next.
      publishTab(tab);
      await view.driver.waitForLoad(15_000);
      signal.throwIfAborted();
      const moved = view.takeBlocked();
      if (moved) return blockedReply(moved);
      const loaded = view.current();
      if (!loaded || loaded.failed) return fail(target.kind === "web" ? "The page could not be loaded." : "The page could not be loaded. Is the dev server running at that address?");
      return { status: "ok", ...view.driver.where() };
    }
    const view = agent && deps.tab(agent.tab);
    if (!view) return fail("The browser tab was closed. Open the page again with browser_navigate.");
    // A page the person opened on their own network is theirs: the agent never reads or acts on it, even in the tab it holds.
    if (view.kind === "private") return fail("The tab shows a page on the user's own network, which you may not use. Open a page with browser_navigate.");
    // The second switch is read on every request: once it is off, a public page is not read or acted on, whoever held the tab meanwhile.
    if (view.kind === "web" && !deps.webEnabled()) return fail("Public websites are turned off for the agent. Only a local page can be used.");
    // A web tab the person moved on (or a page that moved by itself) is on a site the agent was not given: nothing is read or done there.
    if (!agentMayUsePage(view.kind === "web" ? agent!.hosts : undefined, view.driver.where().url)) {
      return fail("The tab is no longer on a site you opened for this task. Open the page again with browser_navigate.");
    }
    if (request.tool === "read") return view.driver.read(request.mode, signal);
    if (request.tool === "console") return view.driver.console(request.clear);
    await waitForSize(view, signal);
    let reply: BrowserAgentReply;
    if (request.tool === "click") reply = await view.driver.click(request.selector, request.origin, signal);
    else if (request.tool === "type") reply = await view.driver.type(request, signal);
    else return view.driver.screenshot(request.selector, signal);
    const moved = view.takeBlocked();
    return reply.status === "ok" && moved ? blockedReply(moved) : reply;
  }

  return {
    /**
     * The sites a web tab may move within while the agent holds it, or null (a tab the agent does not hold, one the person took back, a
     * local tab). The tab's own request checks read this; the person can take the tab to browse freely.
     */
    hostsFor(tab: string): ReadonlySet<string> | null {
      return agent?.tab === tab && agent.control === "active" && agent.hosts.size > 0 ? agent.hosts : null;
    },

    /** The agent holds this tab right now (the person has not taken it back): a page in it is not asked for permissions or downloads. */
    holds(tab: string): boolean { return agent?.tab === tab && agent.control === "active"; },

    /** The tab the agent opened, whoever is steering it right now. */
    agentTab(): string | undefined { return agent?.tab; },

    /** The agent's tab when it belongs to another task or scope than the current one (the host closes it); the person's own tabs stay. */
    dropStale(): string | undefined {
      const run = deps.run();
      if (!agent || (agent.taskId === run.taskId && agent.scope === run.scope)) return undefined;
      const { tab } = agent;
      for (const controller of inflight) controller.abort();
      agent = undefined;
      return tab;
    },

    /** Adds the agent and picker marks to a tab's state before it reaches the panel. */
    decorate,

    /** One request of the running task's agent. Always answers the runner, with the reason when it does not do what was asked. */
    async handle(event: { runId: string; requestId: string; request: unknown }) {
      const respond = (reply: BrowserAgentReply) => {
        try { deps.reply(event.runId, event.requestId, cleanReply(reply, deps.clean)); } catch { /* The task ended before the reply. */ }
      };
      const parsed = browserAgentRequest.safeParse(event.request);
      if (!parsed.success) { respond(fail("The browser request was not valid.")); return; }
      const request = parsed.data;
      const run = deps.run();
      const refusal = agentRequestRefusal({
        enabled: deps.enabled(), eventRunId: event.runId, activeRunId: run.runId, taskId: run.taskId, taskRunning: run.running,
        apiExecution: run.apiExecution, suspended: run.suspended, scope: run.scope, tool: request.tool,
        pickedScreenshot: request.tool === "screenshot" && Boolean(request.pick), agent,
      });
      if (refusal) { respond(fail(refusal)); return; }
      const controller = new AbortController();
      inflight.add(controller);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(request.tool === "navigate" ? 30_000 : 20_000)]);
      const mark = agent?.tab;
      busy += 1;
      if (mark) publishTab(mark);
      let reply: BrowserAgentReply;
      try { reply = await execute(request, run, event.runId, signal); }
      catch { reply = fail(controller.signal.aborted ? "The user stopped the browser." : signal.aborted ? "The browser did not answer in time." : "The browser could not complete the request."); }
      finally {
        inflight.delete(controller);
        busy -= 1;
      }
      if (agent) publishTab(agent.tab);
      // A reply to a run that has ended, or to a task that is no longer this one, is dropped.
      const after = deps.run();
      if (after.runId === event.runId && after.scope === run.scope) respond(controller.signal.aborted ? fail("The user stopped the browser.") : reply);
    },

    /** The panel's own commands about the picker and the agent's control; the panel's other commands stay with the browser itself. */
    async command(command: Extract<BrowserCommand, { type: "sync" | "pick" | "agent-stop" | "agent-resume" }>) {
      if (command.type === "sync") {
        for (const [tab] of deps.tabs()) publishTab(tab);
        return;
      }
      const view = deps.tab(command.tab);
      if (!view) return;
      if (command.type === "pick") {
        view.driver.listen({ pick: (pick) => deps.publishPick(pick), picking: () => publishTab(command.tab) });
        await view.driver.setPicking(command.enabled);
        publishTab(command.tab);
        return;
      }
      if (agent?.tab !== command.tab) return;
      agent = { ...agent, control: command.type === "agent-stop" ? "stopped" : "active" };
      if (command.type === "agent-stop") for (const controller of inflight) controller.abort();
      publishTab(command.tab);
    },

    /** The task was stopped or ended its run: whatever the agent was doing in the page ends. */
    abortAll() { for (const controller of inflight) controller.abort(); },

    /** The browser itself was closed (the task changed, or the person left Code). */
    reset() {
      for (const controller of inflight) controller.abort();
      agent = undefined;
    },
  };
}
