import { amuxTaskRegistrationRefusalPresentation } from
  "@/components/admin/amuxIdeaRegistrationRefusalUi";
import type { AmuxV20RegistrationRefusalView } from
  "@/lib/amux/ideaRegistrationRefusalCore";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";

export function AmuxIdeaRegistrationRefusalNotice({ m, refusal }: {
  m: typeof adminAmuxIdeaInputMessages.en;
  refusal: AmuxV20RegistrationRefusalView;
}) {
  const presentation = amuxTaskRegistrationRefusalPresentation(refusal.refusalCode);
  const attempt = refusal.attemptKind === "prepare"
    ? m.registrationRefusalPrepare
    : refusal.attemptKind === "consume"
      ? m.registrationRefusalConsume
      : m.registrationRefusalWholePlan;
  return <div data-testid="amux-registration-refusal"
    className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-100">
    <h4 className="font-semibold">{m.registrationRefusalTitle}</h4>
    <p>{m.registrationRefusalHint}</p>
    {presentation ? <p>{m[presentation.messageKey]}</p> : null}
    <p>{m.registrationRefusalAttempt}: {attempt} · {refusal.attemptedAt}</p>
    <dl className="grid gap-1 text-xs sm:grid-cols-[max-content_1fr]">
      <dt>{m.registrationRefusalRequestId}</dt>
      <dd className="break-all font-mono">{refusal.requestId}</dd>
      <dt>{m.registrationRefusalDraftUnitId}</dt>
      <dd className="break-all font-mono">{refusal.draftUnitId}</dd>
      <dt>{m.registrationRefusalPreviewId}</dt>
      <dd className="break-all font-mono">{refusal.analysisPreviewId}</dd>
      <dt>{m.registrationRefusalPlanId}</dt>
      <dd className="break-all font-mono">{refusal.sourcePlanRevisionId}</dd>
      <dt>{m.registrationRefusalGrades}</dt>
      <dd>{refusal.proposedExecutionGrade ?? "—"} → {refusal.finalExecutionGrade ?? "—"}</dd>
    </dl>
  </div>;
}
