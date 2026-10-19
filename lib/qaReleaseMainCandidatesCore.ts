/**
 * S-M3 of the QA-release agent (docs/policy/qa-release-agent.md section 8
 * item 1, section 9): the open pull requests into main and whether the
 * running production build serves main's head, shown in Admin. A display
 * only -- it never merges, and "allowed" is the main-PR source rule, not a
 * readiness verdict (hotfix items and each automation's own gates are a
 * person's to check).
 *
 * Pure: the reader (lib/qaReleaseMainCandidatesRead.ts) fetches the public
 * GitHub answers and the serving build; anything not the expected shape is
 * dropped or reported as unread, never guessed.
 */
import { mainPullRequestDecision } from "@/scripts/main-pr-source-policy.mjs";

export type QaReleaseMainCandidate = {
  number: number;
  title: string;
  head: string;
  draft: boolean;
  url: string;
  allowed: boolean;
  reason: string;
};

export type QaReleaseMainCandidates = {
  /** null when GitHub's answer could not be read. */
  pullRequests: QaReleaseMainCandidate[] | null;
  production: {
    environment: string;
    servingSha: string | null;
    /** null when main's head could not be read. */
    mainHeadSha: string | null;
    /** null when either side is unknown. */
    servesMainHead: boolean | null;
  };
};

const SHA = /^[0-9a-f]{40}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function qaReleaseMainCandidates(input: {
  openPullsJson: unknown;
  mainHeadJson: unknown;
  environment: string;
  servingSha: string | null;
}): QaReleaseMainCandidates {
  let pullRequests: QaReleaseMainCandidate[] | null = null;
  if (Array.isArray(input.openPullsJson)) {
    pullRequests = [];
    for (const pull of input.openPullsJson) {
      if (!isRecord(pull) || !isRecord(pull.head) || !isRecord(pull.base)) continue;
      if (pull.base.ref !== "main" || pull.state !== "open") continue;
      const head = pull.head.ref;
      if (typeof pull.number !== "number" || typeof head !== "string" || typeof pull.html_url !== "string") continue;
      const decision = mainPullRequestDecision(head, pull.number);
      pullRequests.push({
        number: pull.number,
        title: typeof pull.title === "string" ? pull.title.slice(0, 200) : "",
        head,
        draft: pull.draft === true,
        url: pull.html_url,
        allowed: decision.allowed,
        reason: decision.reason,
      });
    }
    pullRequests.sort((a, b) => a.number - b.number);
  }

  const mainHead = isRecord(input.mainHeadJson) ? input.mainHeadJson.sha : null;
  const mainHeadSha = typeof mainHead === "string" && SHA.test(mainHead) ? mainHead : null;
  const servingSha = input.servingSha && SHA.test(input.servingSha) ? input.servingSha : null;
  return {
    pullRequests,
    production: {
      environment: input.environment,
      servingSha,
      mainHeadSha,
      servesMainHead: servingSha && mainHeadSha ? servingSha === mainHeadSha : null,
    },
  };
}
