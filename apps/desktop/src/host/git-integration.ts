import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ApprovalRequest, Decision } from "../contract";
import type { GitApprovalView } from "../git-actions-contract";
import type { PullEvidence, PullLink } from "../github-pr-contract";
import { ApprovalLedger } from "./git-approval-ledger";
import { readAgentGitSwitch, writeAgentGitSwitch } from "./git-agent-switch";
import { createGitHost } from "./git-host";
import { createFixtureGhRunner, createGhRunner, ghFixtureFile, type GhRunner } from "./github-cli";

export type GitIntegrationEnvironment = {
  userData: string;
  /** A test or QA build with a fixture profile: `gh` answers from `gh-fixture.json` there and never starts a program. */
  fixtureProfile: string | null;
  target(): { folder: string; managed: boolean } | null;
  /** An agent run, a confirmation or another approval card is active. */
  busy(): boolean;
  /** No approval card is open or pending, so a new one may open. */
  canAsk(): boolean;
  showApproval(request: ApprovalRequest): void;
  clearPending(id: string): void;
  savedLinks(): PullLink[];
  linkPull(url: string): Promise<void>;
  readPublic(link: PullLink): Promise<PullEvidence | null>;
  afterBranchChange(): void;
};

/**
 * The Electron side of the Git panel and the agent's commit and push tools: opens the approval window, and treats its answer as the only
 * way a ticket is granted. Nothing the renderer sends can grant one.
 */
export function createGitIntegration(environment: GitIntegrationEnvironment) {
  const ledger = new ApprovalLedger();
  const switchFile = join(environment.userData, "git-agent-actions.json");
  let waiting: { id: string; ticket: string; settle: (approved: boolean) => void } | null = null;

  function request(view: GitApprovalView, ticket: string) {
    if (waiting || !environment.canAsk()) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const approval: ApprovalRequest = { id: randomUUID(), root: view.repository, tool: view.kind === "publish" ? "git push" : "git commit", canRemember: false, git: view };
      const settle = (approved: boolean) => {
        if (waiting?.id !== approval.id) return;
        waiting = null;
        environment.clearPending(approval.id);
        if (approved) ledger.grant(ticket);
        resolve(approved);
      };
      waiting = { id: approval.id, ticket, settle };
      environment.showApproval(approval);
    });
  }

  const host = createGitHost({
    target: environment.target, busy: environment.busy, ledger, requestApproval: request,
    hooksOff: join(environment.userData, "disabled-git-hooks"),
    gh: (): GhRunner | null => environment.fixtureProfile ? createFixtureGhRunner(ghFixtureFile(environment.fixtureProfile)) : createGhRunner(),
    savedLinks: environment.savedLinks, linkPull: environment.linkPull, readPublic: environment.readPublic,
    agentSwitch: { read: () => readAgentGitSwitch(switchFile), write: (enabled) => writeAgentGitSwitch(switchFile, enabled) },
    afterBranchChange: environment.afterBranchChange,
  });

  return {
    handle: (value: unknown) => host.handle(value),
    agent: (value: unknown) => host.agent(value),
    switchFile,
    /** The approval window's answer. Only "once" approves: a git card cannot be remembered. True when the answer was for a Git card. */
    decide(decision: Decision): boolean {
      if (!waiting || waiting.id !== decision.id) return false;
      waiting.settle(decision.action === "once");
      return true;
    },
    /** Whatever closes the approval window without an answer is a denial. */
    dismiss() { waiting?.settle(false); },
    readSwitch: () => readAgentGitSwitch(switchFile),
  };
}
