import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../../../tomverse-cli/src/runtime.js";

/**
 * The person's switch for the agent's use of the browser panel (the browser_* tools and sharing a page with Code). The panel itself,
 * for looking at a local development server and commenting on its elements, does not depend on it. Off until the person turns it on,
 * and anything unreadable means off.
 */
export function createBrowserAgentSwitch(file: () => string) {
  let enabled = false;
  return {
    load() {
      try { enabled = readFileSync(file(), "utf8") === "enabled"; }
      catch { enabled = false; }
    },
    get enabled() { return enabled; },
    set(value: boolean) {
      writeFileAtomic(file(), value ? "enabled" : "disabled");
      enabled = value;
    },
  };
}

/**
 * Which of the agent's browser tools a run gets. The switch is the person's; a fixture descriptor can still turn the tools on for the
 * tests. The same answer is used for a new task and for one that resumes, and every request is checked again when it arrives.
 */
export function browserToolsFor(input: { switchOn: boolean; fixtureAgent: boolean; fixtureInspection: boolean }) {
  const agent = input.switchOn || input.fixtureAgent;
  return { agent, inspection: agent || input.fixtureInspection };
}

/**
 * Whether the agent may also open public https sites. A second default-off switch of the person (a test fixture can turn it on); it
 * means nothing without the browser tools themselves, and every address is checked again when the request arrives.
 */
export function browserWebFor(input: { agent: boolean; switchOn: boolean; fixtureWeb: boolean }) {
  return input.agent && (input.switchOn || input.fixtureWeb);
}
