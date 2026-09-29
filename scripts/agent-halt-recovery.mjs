// The engineering agent's halt recovery plan, run by an operator on their own
// machine (docs/policy/engineering-agent.md §12). Read-only: it lists the
// branches under `agent/engineering/` and the open pull requests on them,
// compares them with the bindings the operator exported from the Admin
// console, and prints what needs a person. It writes nothing to GitHub or the
// app, and needs no credential beyond an optional read token for rate limits.
//
//   npm run engineering-agent:halt-plan -- [--bindings <file.json>]
//
// Exit status: 0 nothing to recover, 1 recover by hand, 2 incident, 3 the
// plan could not be read completely (read again; never act on a partial list).

import { readFileSync } from "node:fs";

import { planHaltRecovery, renderHaltRecoveryPlan } from "./agent-halt-recovery-core.mjs";

const REPOSITORY = "mposition/Tomverse";
const API = "https://api.github.com";

const request = async (path) => {
  const token = process.env.GITHUB_TOKEN?.trim();
  const response = await fetch(`${API}${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const link = response.headers.get("link");
  if (!response.ok || (link !== null && /rel="?next"?/.test(link))) throw new Error("incomplete_read");
  return response.json();
};

const readBindings = () => {
  const at = process.argv.indexOf("--bindings");
  if (at < 0) return null;
  const parsed = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
  if (!Array.isArray(parsed)) throw new Error("bindings_not_a_list");
  return parsed.map((entry) => ({ runId: String(entry.runId), prNumber: Number(entry.prNumber), headSha: String(entry.headSha) }));
};

async function main() {
  let plan;
  try {
    const bindings = readBindings();
    const refs = await request(`/repos/${REPOSITORY}/git/matching-refs/heads/agent/engineering/?per_page=100`);
    const pulls = await request(`/repos/${REPOSITORY}/pulls?state=open&per_page=100`);
    if (!Array.isArray(refs) || !Array.isArray(pulls)) throw new Error("incomplete_read");
    plan = planHaltRecovery({
      refs: refs.map((ref) => ({ ref: ref.ref, sha: ref.object?.sha })),
      pulls: pulls
        // On the agent's namespace, or claiming to be the agent's by its marker.
        .filter(
          (pull) =>
            (typeof pull.head?.ref === "string" && pull.head.ref.startsWith("agent/")) ||
            (typeof pull.body === "string" && pull.body.startsWith("<!-- engineering-agent")),
        )
        .map((pull) => ({ number: pull.number, state: pull.state, headRef: pull.head.ref, headSha: pull.head.sha, body: pull.body ?? "" })),
      bindings,
    });
  } catch (error) {
    console.error(`The plan could not be read completely (${error instanceof Error ? error.message : "unknown"}). Read again; do not act on a partial list.`);
    process.exit(3);
  }
  console.log(renderHaltRecoveryPlan(plan, REPOSITORY));
  process.exit(plan.verdict === "nothing_to_recover" ? 0 : plan.verdict === "recover_by_hand" ? 1 : 2);
}

if (process.argv[1]?.endsWith("agent-halt-recovery.mjs")) {
  await main();
}
