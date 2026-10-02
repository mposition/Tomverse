import type { AmuxAnalysisChunk } from "@/lib/amux/ideaAnalysisChunkCore";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";

type Proposal = AmuxAnalysisChunk["units"][number];
type Messages = Pick<(typeof adminAmuxIdeaInputMessages)["en"],
  "analysisResultParentRef" | "analysisResultFeatureRef" | "analysisResultStoryRef" |
  "analysisResultDependencies" | "analysisResultDuplicateCandidates" |
  "analysisResultSourceRefs" | "analysisResultCardRef" | "analysisResultNoRelation">;

const refs = (values: readonly string[], empty: string) =>
  values.length ? values.join(", ") : empty;

/** Display model-proposed references as inert text before any owner decision. */
export function AmuxIdeaProposalRelations({ proposal, messages }: {
  proposal: Proposal; messages: Messages;
}) {
  const sourceRefs = refs(proposal.sourceRefIds, messages.analysisResultNoRelation);
  return <dl className="grid gap-1 text-xs text-zinc-600 dark:text-zinc-400">
    {proposal.kind === "node" ? <div>
      <dt className="inline font-medium">{messages.analysisResultParentRef}: </dt>
      <dd className="inline break-all">{proposal.parentRef ?? messages.analysisResultNoRelation}</dd>
    </div> : null}
    {proposal.kind === "card" ? <>
      <div><dt className="inline font-medium">{messages.analysisResultFeatureRef}: </dt>
        <dd className="inline break-all">{proposal.featureRef}</dd></div>
      <div><dt className="inline font-medium">{messages.analysisResultStoryRef}: </dt>
        <dd className="inline break-all">{proposal.parentStoryRef ?? messages.analysisResultNoRelation}</dd></div>
      <div><dt className="inline font-medium">{messages.analysisResultDependencies}: </dt>
        <dd className="inline break-all">{refs(proposal.dependencyRefs, messages.analysisResultNoRelation)}</dd></div>
      <div><dt className="inline font-medium">{messages.analysisResultDuplicateCandidates}: </dt>
        <dd className="inline break-all">{refs(proposal.duplicateCandidateRefs, messages.analysisResultNoRelation)}</dd></div>
    </> : null}
    {proposal.kind === "evidence" ? <div>
      <dt className="inline font-medium">{messages.analysisResultCardRef}: </dt>
      <dd className="inline break-all">{proposal.cardRef}</dd>
    </div> : null}
    <div><dt className="inline font-medium">{messages.analysisResultSourceRefs}: </dt>
      <dd className="inline break-all">{sourceRefs}</dd></div>
  </dl>;
}
