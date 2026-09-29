// The engineering agent's halt recovery plan (docs/policy/engineering-agent.md
// §12: "정지 복구 도구"). Pure: it takes what GitHub shows under the agent's
// namespace and what the app has bound, and says what a person should look at.
// It never writes -- closing a pull request or deleting a branch is a public,
// irreversible act, and it stays a person's, one item at a time.
//
// More items than a handful is not a recovery but an incident (§12): the
// closure is the publisher App key revoked or the App uninstalled, the mode
// `off`, and a record; re-entry needs a new version of the policy.

import { parseEngineeringBranchName, prBodyCarriesMarker } from "../lib/engineeringAgentCore.ts";

/** Up to this many items is a recovery; more is an incident (§12, "항목이 소수를 넘으면"). */
export const HALT_RECOVERY_SMALL_LIMIT = 3;

/**
 * refs:     [{ ref: "refs/heads/agent/engineering/<run>", sha }]
 * pulls:    [{ number, state, headRef, headSha, body }] -- open pull requests
 *           whose head is in the agent's namespace
 * bindings: null when the operator gave none, else [{ runId, prNumber, headSha }]
 *           as the Admin console's pull request section shows them
 */
export const planHaltRecovery = ({ refs, pulls, bindings }) => {
  const items = [];
  const bound = (runId, prNumber, headSha) =>
    bindings === null
      ? "unverified"
      : bindings.some(
            (binding) =>
              binding.runId === runId &&
              (prNumber === null || binding.prNumber === prNumber) &&
              binding.headSha === headSha,
          )
        ? "bound"
        : "unbound";

  for (const { ref, sha } of refs) {
    const runId = parseEngineeringBranchName(ref);
    if (runId === null) {
      items.push({ kind: "ref", ref, sha, runId: null, status: "unbound", look: "not a run branch of the agent's namespace" });
      continue;
    }
    const pull = pulls.find((candidate) => candidate.headRef === ref.replace(/^refs\/heads\//, ""));
    const status = bound(runId, pull?.number ?? null, sha);
    if (status === "bound") continue;
    items.push({
      kind: "ref",
      ref,
      sha,
      runId,
      status,
      look: pull ? `pull request #${pull.number} is on it` : "no open pull request is on it",
    });
  }
  for (const pull of pulls) {
    const runId = parseEngineeringBranchName(pull.headRef ?? "");
    const marked = runId !== null && prBodyCarriesMarker(pull.body ?? "", runId);
    const status = runId === null || !marked ? "unbound" : bound(runId, pull.number, pull.headSha);
    if (status === "bound") continue;
    items.push({
      kind: "pull_request",
      number: pull.number,
      headRef: pull.headRef,
      headSha: pull.headSha,
      runId,
      status,
      look: marked ? "carries the run's marker" : "does not carry a run marker",
    });
  }
  const needsAttention = items.length;
  return {
    items,
    verdict:
      needsAttention === 0
        ? "nothing_to_recover"
        : needsAttention <= HALT_RECOVERY_SMALL_LIMIT
          ? "recover_by_hand"
          : "incident",
  };
};

/** The plan as text for the operator's terminal: identifiers and links only. */
export const renderHaltRecoveryPlan = (plan, repository) => {
  const lines = [];
  if (plan.verdict === "nothing_to_recover") {
    lines.push("Nothing under the agent's namespace needs a person. Acknowledge the halt in the Admin console once the halt's own cause is understood.");
    return lines.join("\n");
  }
  lines.push(`${plan.items.length} item(s) need a person (read-only plan; nothing was changed):`);
  for (const item of plan.items) {
    if (item.kind === "ref") {
      lines.push(`- branch ${item.ref.replace(/^refs\/heads\//, "")} at ${item.sha} [${item.status}]: ${item.look}`);
      lines.push(`  https://github.com/${repository}/tree/${encodeURI(item.ref.replace(/^refs\/heads\//, ""))}`);
    } else {
      lines.push(`- pull request #${item.number} (${item.headRef} at ${item.headSha}) [${item.status}]: ${item.look}`);
      lines.push(`  https://github.com/${repository}/pull/${item.number}`);
    }
  }
  if (plan.verdict === "incident") {
    lines.push("");
    lines.push("This is more than a recovery (docs/policy/engineering-agent.md §12): treat it as an incident.");
    lines.push("Revoke the publisher App's key or uninstall the App, set the agent's mode to off in the Admin console, and record the incident.");
    lines.push("Re-entry needs a new exclusivity record and a new approved version of the policy.");
  } else {
    lines.push("");
    lines.push("Look at each item on GitHub. Close or delete only what you have checked yourself, then acknowledge the halt in the Admin console.");
  }
  return lines.join("\n");
};
