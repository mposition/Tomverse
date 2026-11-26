import { useEffect, useState, type ReactNode } from "react";
import { desktopAccountDataCopy } from "../../../../locales/desktopAccountData";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import { storeBillingDeletionNotice } from "../../../../locales/storeBilling";
import {
  DELETE_ACCOUNT_PHRASE, DELETE_ALL_CHATS_PHRASE, type AccountDataStatus, type DesktopAccountDataInput, type DesktopAccountDataResult,
} from "../account-data-contract";
import { dictionaries, ReadStatus, useSettingsRead, type Common } from "./settings-shared";

export const runAccountData = (input: DesktopAccountDataInput) => window.desktop.accountData(input);

/** The sentence for a status that is not a success. Unavailable is a quiet state, not an alarm. */
export function accountDataMessage(language: Common["language"], status: AccountDataStatus): string | null {
  const copy = desktopAccountDataCopy[language];
  switch (status) {
    case "reauth": return copy.reauthDesktop;
    case "unavailable": return copy.unavailable;
    case "notIncluded": return dictionaries[language].modelStatusReasons.upgradeRequired;
    case "locked": return copy.deleteAllLocked;
    case "expired": return dictionaries[language].accountDataExport.linkExpired;
    case "failed": return desktopShellCopy[language].actionFailed;
    default: return null;
  }
}

/** A result line with the sign-out shortcut a recent-sign-in refusal needs. */
export function AccountDataResultLine({ language, status }: Common & { status?: AccountDataStatus }) {
  const message = status ? accountDataMessage(language, status) : null;
  if (!message) return null;
  return <p className="notice" role={status === "unavailable" ? "status" : "alert"} data-testid={`account-data-${status}`}>
    {message}
    {status === "reauth" && <> <button type="button" className="soft" onClick={() => void window.desktop.signOut()}>
      {desktopAccountDataCopy[language].signOutNow}
    </button></>}
  </p>;
}

/** Runs one account-data action and keeps its busy flag and last result. */
export function useAccountDataAction() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DesktopAccountDataResult>();
  const run = async (input: DesktopAccountDataInput) => {
    if (busy) return undefined;
    setBusy(true);
    setResult(undefined);
    try {
      const value = await runAccountData(input);
      setResult(value);
      return value;
    } catch {
      const value: DesktopAccountDataResult = { status: "failed" };
      setResult(value);
      return value;
    } finally {
      setBusy(false);
    }
  };
  return { busy, result, run, clear: () => setResult(undefined) };
}

const loadExportHistory = () => window.desktop.accountSettings<"exportHistory">({ action: "exportHistory" });

const formatRemaining = (milliseconds: number) => {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

// Remounted (key) after each request or download, so it always reads the current list.
function ExportHistory({ language }: Common) {
  const copy = dictionaries[language].accountDataExport;
  const state = useSettingsRead(loadExportHistory);
  if (!state.data) return <ReadStatus language={language} failed={state.failed} retry={state.reload} />;
  const statusLabels: Record<string, string> = copy.status;
  return <section data-testid="native-account-export-history">
    <h4>{copy.historyTitle}</h4>
    {state.data.requests.length === 0 ? <p>{copy.historyEmpty}</p> : <ul>
      {state.data.requests.map(entry => <li key={entry.id}>
        <strong>{statusLabels[entry.status] ?? entry.status}</strong>{" "}
        <small>{new Date(entry.createdAt).toLocaleString(language)}
          {entry.byteLength !== null ? ` · ${(entry.byteLength / 1024).toFixed(1)} KB` : ""}</small>
      </li>)}
    </ul>}
  </section>;
}

function AccountExport({ language }: Common) {
  const copy = dictionaries[language].accountDataExport;
  const words = desktopAccountDataCopy[language];
  const action = useAccountDataAction();
  const [expiresAt, setExpiresAt] = useState<number>();
  const [now, setNow] = useState(Date.now);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  const remaining = expiresAt ? expiresAt - now : 0;
  const ready = !!expiresAt && remaining > 0;
  return <section className="desktop-setting-section" data-testid="native-account-export">
    <h3>{copy.pageTitle}</h3>
    <p>{copy.pageDescription}</p>
    <p>{copy.securityNote}</p>
    {ready ? <>
      <button type="button" className="primary" disabled={action.busy} data-testid="native-account-export-save" onClick={() => void (async () => {
        const value = await action.run({ action: "saveExport" });
        if (value?.status === "saved" || value?.status === "expired") setExpiresAt(undefined);
        setRefresh(count => count + 1);
      })()}>{copy.downloadNow}</button>
      <p role="timer">{copy.linkExpiresIn.replace("{remaining}", formatRemaining(remaining))}</p>
    </> : <button type="button" className="soft" disabled={action.busy} data-testid="native-account-export-request" onClick={() => void (async () => {
      const value = await action.run({ action: "requestExport" });
      if (value?.status === "ready" && value.expiresAt) { setExpiresAt(Date.parse(value.expiresAt)); setNow(Date.now()); }
      setRefresh(count => count + 1);
    })()}>{expiresAt ? copy.requestAgain : copy.prepareDownload}</button>}
    {expiresAt && !ready && <p>{copy.linkExpired}</p>}
    {action.result?.status === "saved" && <p role="status">{words.saved}</p>}
    <AccountDataResultLine language={language} status={action.result?.status} />
    <ExportHistory key={refresh} language={language} />
  </section>;
}

function AllConversations({ language }: Common) {
  const copy = dictionaries[language].auth;
  const words = desktopAccountDataCopy[language];
  const action = useAccountDataAction();
  return <section className="desktop-setting-section" data-testid="native-all-conversations">
    <h3>{copy.dataExportTitle}</h3>
    <p>{copy.dataExportDescription}</p>
    <button type="button" className="soft" disabled={action.busy} data-testid="native-all-conversations-save"
      onClick={() => void action.run({ action: "saveAllConversations" })}>{action.busy ? words.working : copy.downloadAllTxt}</button>
    {action.result?.status === "saved" && <p role="status">{words.saved}</p>}
    <AccountDataResultLine language={language} status={action.result?.status} />
  </section>;
}

/**
 * A destructive action behind a typed phrase. The confirm button stays disabled until the
 * text matches exactly, so a stray click cannot start it.
 */
export function TypedConfirmation({ language, phrase, prompt, actionLabel, busy, onConfirm, onCancel, testId, children }: Common & {
  phrase: string; prompt: string; actionLabel: string; busy: boolean; onConfirm(): void; onCancel(): void; testId: string; children?: ReactNode;
}) {
  const copy = dictionaries[language].auth;
  const [typed, setTyped] = useState("");
  const [consent, setConsent] = useState(!children);
  const ready = typed === phrase && consent;
  return <form className="account-settings-form" data-testid={testId} role="alertdialog" aria-label={actionLabel}
    onSubmit={event => { event.preventDefault(); if (ready && !busy) onConfirm(); }}>
    {children && <label><span><input type="checkbox" checked={consent} disabled={busy}
      onChange={event => setConsent(event.currentTarget.checked)} /> {children}</span></label>}
    <label>{prompt.replace("{phrase}", phrase)}
      <input value={typed} autoComplete="off" spellCheck={false} placeholder={phrase} disabled={busy}
        data-testid={testId + "-input"} onChange={event => setTyped(event.currentTarget.value)} /></label>
    <div className="account-settings-actions">
      <button type="button" className="soft" disabled={busy} onClick={onCancel}>{copy.cancel}</button>
      <button type="submit" className="primary" disabled={!ready || busy} data-testid={testId + "-confirm"}>{actionLabel}</button>
    </div>
  </form>;
}

function DeleteAllConversations({ language }: Common) {
  const copy = dictionaries[language].auth;
  const words = desktopAccountDataCopy[language];
  const action = useAccountDataAction();
  const [open, setOpen] = useState(false);
  const deleted = action.result?.status === "deleted";
  return <section className="desktop-setting-section" data-testid="native-delete-all-conversations">
    <p>{copy.dangerZoneDescription}</p>
    {!open && !deleted && <button type="button" className="soft" onClick={() => setOpen(true)}>{copy.deleteAllChats}</button>}
    {open && !deleted && <TypedConfirmation language={language} testId="native-delete-all-conversations-form"
      phrase={DELETE_ALL_CHATS_PHRASE} prompt={words.deleteAllPrompt} actionLabel={copy.deleteAllChats} busy={action.busy}
      onCancel={() => { setOpen(false); action.clear(); }}
      onConfirm={() => void action.run({ action: "deleteAllConversations", confirmation: DELETE_ALL_CHATS_PHRASE })} />}
    {deleted && <p role="status">{words.deleteAllDone}</p>}
    <AccountDataResultLine language={language} status={action.result?.status} />
  </section>;
}

export function AccountDataPanel({ language }: Common) {
  return <>
    <AccountExport language={language} />
    <AllConversations language={language} />
    <DeleteAllConversations language={language} />
  </>;
}

/** Account deletion lives in the Account tab, as on the web. */
export function DeleteAccountSection({ language }: Common) {
  const copy = dictionaries[language].auth;
  const words = desktopAccountDataCopy[language];
  const action = useAccountDataAction();
  const [open, setOpen] = useState(false);
  return <section className="desktop-setting-section" data-testid="native-delete-account">
    <p>{copy.accountDangerZoneDescription}</p>
    {!open && <button type="button" className="soft" data-testid="native-delete-account-open" onClick={() => setOpen(true)}>{copy.deleteAccount}</button>}
    {open && <>
      <h4>{copy.deleteAccountImmediateTitle}</h4>
      <p>{copy.deleteAccountImmediateDescription}</p>
      <p>{storeBillingDeletionNotice(language)}</p>
      <TypedConfirmation language={language} testId="native-delete-account-form" phrase={DELETE_ACCOUNT_PHRASE}
        prompt={words.accountDeletePrompt} actionLabel={copy.confirmPermanentDelete} busy={action.busy}
        onCancel={() => { setOpen(false); action.clear(); }}
        onConfirm={() => void action.run({ action: "deleteAccount", confirmation: DELETE_ACCOUNT_PHRASE })}>
        {copy.deleteAccountConsent}
      </TypedConfirmation>
    </>}
    <AccountDataResultLine language={language} status={action.result?.status} />
  </section>;
}

