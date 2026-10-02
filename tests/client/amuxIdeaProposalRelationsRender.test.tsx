import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxIdeaProposalRelations } from "@/components/admin/AmuxIdeaProposalRelations";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import type { AmuxAnalysisChunk } from "@/lib/amux/ideaAnalysisChunkCore";

type Proposal = AmuxAnalysisChunk["units"][number];
const render = (proposal: Proposal, locale: "en" | "ko" = "en") =>
  renderToStaticMarkup(<AmuxIdeaProposalRelations proposal={proposal}
    messages={adminAmuxIdeaInputMessages[locale]} />);

test("proposed Task shows hierarchy, dependencies, overlap, and evidence refs as inert text", () => {
  const html = render({ kind: "card", featureRef: "c0:node-2",
    parentStoryRef: "c0:card-1", dependencyRefs: ["c0:card-2", "c0:card-3"],
    duplicateCandidateRefs: ["c0:card-4"], sourceRefIds: ["repo-file-1"],
  } as Proposal);
  for (const value of ["Feature reference", "c0:node-2", "Parent Story reference",
    "c0:card-1", "Dependency references", "c0:card-2, c0:card-3",
    "Possible overlap references", "c0:card-4", "Source references", "repo-file-1"]) {
    assert.ok(html.includes(value), value);
  }
  assert.doesNotMatch(html, /<a\b|href=|<button\b/i);
});

test("missing optional links are explicit, and model text cannot become markup", () => {
  const html = render({ kind: "node", localId: "c0:node-0", level: "initiative",
    title: "Test proposal", description: "Text only",
    parentRef: null, sourceRefIds: ["source-1"],
  }, "ko");
  assert.match(html, /상위 항목 참조/);
  assert.match(html, /근거 자료 참조/);
  assert.match(html, /없음/);
  const escaped = render({ kind: "node", localId: "c0:node-0", level: "epic",
    title: "Test proposal", description: "Text only",
    parentRef: "<script>run()</script>", sourceRefIds: ["source-1"],
  });
  assert.match(escaped, /&lt;script&gt;run\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(escaped, /<script>|<a\b|href=/);
});

test("evidence proposal names its card reference without implying approval", () => {
  const html = render({ kind: "evidence", cardRef: "c0:card-1",
    sourceRefIds: ["source-1"] } as Proposal);
  assert.match(html, /Card reference/);
  assert.match(html, /c0:card-1/);
  assert.doesNotMatch(html, /approve|register|<a\b/i);
});
