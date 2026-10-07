"use client";

import Link from "next/link";
import { useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";
import { classifyAmuxV22OutcomeError } from
  "@/lib/amux/v22OutcomeObservationCore";

export function AmuxOutcomeObservationForm(props: { taskId: string;
  revision: number; writeEnabled: boolean; onSaved: () => void }) {
  const m = useAdminMessages(adminAmuxExecutionMessages);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<"checks" | "independent_review" |
    "post_deploy_regression" | "user_outcome" |
    "estimate_revision">("post_deploy_regression");
  const [outcome, setOutcome] = useState("none_observed");
  const [digest, setDigest] = useState("");
  const [findingCount, setFindingCount] = useState("0");
  const [revisedEffortPoints, setRevisedEffortPoints] = useState("");
  const [revisedCostMicrousd, setRevisedCostMicrousd] = useState("");
  const [reasonCode, setReasonCode] = useState("scope_changed");
  const [error, setError] = useState<"reauth" | "unknown" | "stale" |
    "conflict" |
    "unavailable" | null>(null);
  if (!props.writeEnabled) return <p className="text-xs text-zinc-500">
    {m.outcomeWriteNotActive}</p>;

  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    const requestId = crypto.randomUUID();
    const params = new URLSearchParams({ taskId: props.taskId, requestId });
    let needsReadback = false;
    try {
      try {
        const response = await adminFetch("/api/admin/amux/v22-outcome", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, requestId, taskId: props.taskId,
          revision: props.revision, kind, outcome,
          evidenceDigest: digest || null,
          findingCount: kind === "checks" || kind === "independent_review" ?
            Number(findingCount) : null,
          revisedEffortPoints: kind === "estimate_revision" ?
            Number(revisedEffortPoints) : null,
          revisedCostMicrousd: kind === "estimate_revision" ?
            revisedCostMicrousd : null,
          reasonCode: kind === "estimate_revision" ? reasonCode : null }),
      });
        if (response.status === 428) { setError("reauth"); return; }
        if (response.ok) { props.onSaved(); return; }
        const result = await response.json() as { error?: string };
        if (result.error !== "outcome_unknown") {
          setError(classifyAmuxV22OutcomeError(result.error)); return;
        }
        needsReadback = true;
      } catch { needsReadback = true; }
      if (needsReadback) {
        try {
          const receipt = await adminFetch(`/api/admin/amux/v22-outcome?${params}`,
            { cache: "no-store" });
          if (receipt.ok) { props.onSaved(); return; }
        } catch { /* An unknown commit cannot be retried blindly. */ }
        setError("unknown");
      }
    } finally {
      setBusy(false);
    }
  };
  const digestValid = digest === "" || /^[0-9a-f]{64}$/.test(digest);
  return <div data-testid="amux-v22-outcome-form"
    className="mt-2 flex flex-wrap items-end gap-2 rounded border p-2 text-sm">
    <label>{m.observationKind}<select value={kind}
      onChange={(event) => { const next = event.target.value as typeof kind;
        setKind(next); setOutcome(next === "user_outcome" ? "met" :
          next === "post_deploy_regression" ? "none_observed" :
          next === "estimate_revision" ? "revised" : "passed");
        setFindingCount("0"); }}
      className="ml-1 rounded border bg-transparent p-1">
      <option value="checks">{m.checkFindings}</option>
      <option value="independent_review">{m.reviewFindings}</option>
      <option value="post_deploy_regression">{m.postDeployRegression}</option>
      <option value="user_outcome">{m.userOutcome}</option>
      <option value="estimate_revision">{m.estimateRevision}</option>
    </select></label>
    <label>{m.observationOutcome}<select value={outcome}
      onChange={(event) => setOutcome(event.target.value)}
      className="ml-1 rounded border bg-transparent p-1">
      {kind === "checks" || kind === "independent_review" ? <>
        <option value="passed">{m.checkPassed}</option>
        <option value="failed">{m.checkFailed}</option>
      </> : kind === "post_deploy_regression" ? <>
        <option value="none_observed">{m.noneObserved}</option>
        <option value="regression_observed">{m.regressionObserved}</option>
      </> : kind === "user_outcome" ? <>
        <option value="met">{m.outcomeMet}</option>
        <option value="mixed">{m.outcomeMixed}</option>
        <option value="not_met">{m.outcomeNotMet}</option>
      </> : <>
        <option value="revised">{m.revised}</option>
      </>}
    </select></label>
    {(kind === "checks" || kind === "independent_review") &&
      <label>{m.findingCount}<input type="number" min="0" max="1000"
        value={findingCount} onChange={(event) => setFindingCount(event.target.value)}
        className="ml-1 w-20 rounded border bg-transparent p-1" /></label>}
    {kind === "estimate_revision" && <>
      <label>{m.revisedEffortPoints}<input type="number" min="1" max="1000"
        value={revisedEffortPoints}
        onChange={(event) => setRevisedEffortPoints(event.target.value)}
        className="ml-1 w-20 rounded border bg-transparent p-1" /></label>
      <label>{m.revisedCostMicrousd}<input inputMode="numeric"
        value={revisedCostMicrousd}
        onChange={(event) => setRevisedCostMicrousd(event.target.value)}
        className="ml-1 w-40 rounded border bg-transparent p-1" /></label>
      <label>{m.revisionReason}<select value={reasonCode}
        onChange={(event) => setReasonCode(event.target.value)}
        className="ml-1 rounded border bg-transparent p-1">
        <option value="scope_changed">{m.scopeChanged}</option>
        <option value="actual_usage">{m.actualUsage}</option>
        <option value="quality_findings">{m.qualityFindings}</option>
        <option value="capacity_changed">{m.capacityChanged}</option>
      </select></label>
    </>}
    <label>{m.evidenceDigest}<input value={digest} maxLength={64}
      onChange={(event) => setDigest(event.target.value.toLowerCase())}
      className="ml-1 w-52 rounded border bg-transparent p-1 font-mono" /></label>
    <button type="button" className="rounded border px-2 py-1"
      disabled={busy || !digestValid ||
        ((outcome === "regression_observed" || kind === "checks" ||
          kind === "independent_review" || kind === "estimate_revision") && !digest) ||
        (kind === "estimate_revision" &&
          (!/^[1-9][0-9]{0,3}$/.test(revisedEffortPoints) ||
            Number(revisedEffortPoints) > 1000 ||
            !/^(0|[1-9][0-9]{0,18})$/.test(revisedCostMicrousd) ||
            BigInt(revisedCostMicrousd) > BigInt("9223372036854775807"))) ||
        ((kind === "checks" || kind === "independent_review") &&
          (!/^(0|[1-9][0-9]{0,3})$/.test(findingCount) ||
            Number(findingCount) > 1000 ||
            (outcome === "passed" && Number(findingCount) !== 0)))}
      onClick={() => void submit()}>{m.recordObservation}</button>
    <p className="w-full text-xs text-zinc-500">{m.observationHelp}</p>
    {error && <p role="alert" className="w-full text-red-700 dark:text-red-400">
      {error === "reauth" ? <Link className="underline"
        href={adminRecentAuthenticationHref("/admin/amux-execution?tab=cards")}>
        {m.reauth}</Link> : error === "unknown" ? m.unknownOutcome :
        error === "stale" ? <button type="button" className="underline"
          onClick={props.onSaved}>{m.reloadChangedTask}</button> :
        error === "conflict" ? m.requestConflict : m.unavailable}
    </p>}
  </div>;
}
