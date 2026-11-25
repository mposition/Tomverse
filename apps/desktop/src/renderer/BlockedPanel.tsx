import { useState } from "react";
import type { Language } from "../../../../lib/language";
import { desktopEvidenceCopy } from "../../../../locales/desktopEvidence";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import { desktopCodeQuotaCopy } from "../../../../locales/desktopCodeQuota";
import { zCodeExtraUsageUnavailableCode, type CodeQuotaEvidence, type RecoveryResult, type RunStatus, type Task } from "../contract";

const guidance: Partial<Record<RunStatus, keyof typeof desktopEvidenceCopy.en>> = {
  blocked: "blockedGuide", failed: "failedGuide", unknown: "unknownGuide",
};

export function CodeQuotaPanel({ quota, language, openSettings }: { quota: CodeQuotaEvidence; language: Language; openSettings: () => void }) {
  const copy = desktopCodeQuotaCopy[language];
  const resetAt = "resetAt" in quota ? quota.resetAt : undefined;
  const reset = resetAt && Number.isFinite(Date.parse(resetAt))
    ? copy.reset.replace("{time}", new Date(resetAt).toLocaleString(language, { dateStyle: "medium", timeStyle: "short" }))
    : copy.resetUnknown;
  const overage = quota.source === "zcode" && zCodeExtraUsageUnavailableCode.safeParse(quota.providerCode).success
    ? copy.overageUnavailable : copy.overageUnknown;
  return <section className="code-quota" aria-label={copy.paused}>
    <div role="status">
      <p><strong>{copy.paused}</strong></p>
      <p>{copy[quota.reason]}</p>
      <p className="code-quota-details"><span>{reset}</span><span>{copy.remainingUnknown}</span>
        {quota.source !== "tomverse_api" && <span>{overage}</span>}</p>
    </div>
    <button className="soft" type="button" onClick={openSettings}>{copy.settings}</button>
  </section>;
}

export function BlockedPanel({ task, language }: { task: Task; language: Language }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<RecoveryResult | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumeFailed, setResumeFailed] = useState(false);
  const message = guidance[task.status];
  const copy = desktopEvidenceCopy[language];
  const native = task.execution?.executionMode === "provider_cli" ? task.execution : undefined;
  const recovery = result?.status === "checked" ? result.native : undefined;
  const id = task.id;
  if (task.status === "blocked" && task.quota) return null;
  if (id && task.status === "stopped" && task.canResume) {
    const resume = async () => {
      setResumeFailed(false);
      setResuming(true);
      try { setResumeFailed(!await window.desktop.resume(id)); }
      catch { setResumeFailed(true); }
      finally { setResuming(false); }
    };
    return <div className="notice">
      {!native && <p>{copy.resumeGuide}</p>}
      <button type="button" disabled={resuming} onClick={() => void resume()}>{copy.resumeTask}</button>
      {resumeFailed && <p role="status">{copy.resumeUnavailable}</p>}
    </div>;
  }
  if (!message) return null;

  async function check(id: string) {
    setChecking(true);
    try { setResult(await window.desktop.checkRecovery(id)); }
    catch { setResult({ status: "unavailable" }); }
    finally { setChecking(false); }
  }

  return <div className="notice">
    {(!native || task.status !== "unknown") && <p>{copy[message]}</p>}
    {id && task.status === "unknown" && task.canCheckRecovery && <button type="button" disabled={checking}
      onClick={() => void check(id)}>{checking ? copy.checking : copy.checkRecovery}</button>}
    {result && <div role="status">
      {result.status === "checked" ? <>
        {recovery ? <>
          <p>{native?.cli} · {desktopShellCopy[language][recovery.turn]}</p>
          {(recovery.passed > 0 || recovery.failed > 0 || recovery.unconfirmed > 0) && <p>{(native?.provider === "anthropic" ? copy.readSummary : copy.commandSummary)
            .replace("{passed}", recovery.passed.toLocaleString(language))
            .replace("{failed}", recovery.failed.toLocaleString(language))
            .replace("{unconfirmed}", recovery.unconfirmed.toLocaleString(language))}</p>}
        </> : <p>{copy.reviewEvidence}</p>}
        {result.notes.length > 0 && <ul>{result.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
      </> : <p>{result.status === "locked" ? copy.recoveryLocked : copy.recoveryUnavailable}</p>}
    </div>}
  </div>;
}
