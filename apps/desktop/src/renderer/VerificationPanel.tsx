import { useState } from "react";
import type { Language } from "../../../../lib/language";
import { desktopControlsCopy } from "../../../../locales/desktopControls";
import { desktopEvidenceCopy } from "../../../../locales/desktopEvidence";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import type { CommandInspection, Verification } from "../contract";
import { formatEvidence } from "./evidence-copy";
import { verificationBasis } from "./verificationBasis";

function CommandResult({ check, language }: { check: Verification; language: Language }) {
  const copy = desktopEvidenceCopy[language];
  const controls = desktopControlsCopy[language];
  const shellCopy = desktopShellCopy[language];
  const statuses: Record<string, string> = {
    ok: copy.exited, exited: copy.exited, cancelled: copy.cancelled, timeout: copy.timedOut,
    unconfirmed: shellCopy.unconfirmed, failed: shellCopy.failed,
  };
  const state = Object.hasOwn(statuses, check.state) ? statuses[check.state] : check.state;
  const [detail, setDetail] = useState<CommandInspection | null>();
  const [reading, setReading] = useState(false);
  async function load() {
    if (reading) return;
    setReading(true);
    try { setDetail(await window.desktop.readCommand(check.id)); }
    catch { setDetail(null); }
    finally { setReading(false); }
  }

  return <details onToggle={(event) => {
    if (event.currentTarget.open && !detail) void load();
  }}>
    <summary>{check.tool} · {state}{check.exitCode === undefined ? "" : ` · ${formatEvidence(copy.exit, language, { code: check.exitCode })}`}</summary>
    {reading && <p role="status">{copy.loadingCommand}</p>}
    {detail === null && !reading && <button className="soft" type="button" onClick={() => void load()}>{copy.reloadCommand}</button>}
    {detail && <>
      {detail.command ? <dl className="command-record">
        <dt>{copy.mode}</dt><dd>{detail.command.mode === "shell" ? copy.shell : copy.direct}</dd>
        <dt>{controls.executable}</dt><dd><code>{detail.command.file}</code></dd>
        <dt>{controls.arguments}</dt><dd><pre>{JSON.stringify(detail.command.args, null, 2)}</pre></dd>
        <dt>{controls.workingDirectory}</dt><dd><code>{detail.command.cwd}</code></dd>
        <dt>{controls.environment}</dt><dd><code>{detail.command.envNames.join(", ") || controls.none}</code></dd>
        <dt>{controls.timeout}</dt><dd>{detail.command.timeoutMs} ms</dd>
      </dl> : <p>{copy.commandUnavailable}</p>}
      {(detail.elapsedMs !== undefined || detail.signal) && <p>
        {detail.elapsedMs !== undefined && formatEvidence(copy.elapsed, language, { ms: detail.elapsedMs })}
        {detail.signal && ` · ${formatEvidence(copy.signal, language, { signal: detail.signal })}`}
      </p>}
      {detail.error && <p role="status">{detail.error}</p>}
      {detail.stdout && <><h4>{copy.stdout}</h4><pre role="region" aria-label={copy.stdout} tabIndex={0}>{detail.stdout}</pre></>}
      {detail.stdoutOmitted > 0 && <p>{formatEvidence(copy.stdoutOmitted, language, { count: detail.stdoutOmitted })}</p>}
      {detail.stderr && <><h4>{copy.stderr}</h4><pre role="region" aria-label={copy.stderr} tabIndex={0}>{detail.stderr}</pre></>}
      {detail.stderrOmitted > 0 && <p>{formatEvidence(copy.stderrOmitted, language, { count: detail.stderrOmitted })}</p>}
    </>}
  </details>;
}

export function VerificationPanel({ checks, language }: { checks: Verification[]; language: Language }) {
  if (!checks.length) return null;
  const basis = verificationBasis(checks);
  const copy = desktopEvidenceCopy[language];
  return <details><summary>{formatEvidence(copy.commandResults, language, { count: checks.length })}</summary>
    <p>{formatEvidence(copy.commandSummary, language, basis)}</p>
    <ul>{checks.map((check) => <li key={check.id}><CommandResult check={check} language={language} /></li>)}</ul>
  </details>;
}
