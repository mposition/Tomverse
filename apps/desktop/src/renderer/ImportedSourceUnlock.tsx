import { useRef, useState, type FormEvent } from "react";
import type { Language } from "../../../../lib/language";
import { desktopChatCopy } from "../../../../locales/desktopChat";
import type { ChatUnlockImportedResult } from "../chat-contract";
import { dictionaries } from "./settings-shared";

type Outcome = Exclude<ChatUnlockImportedResult["status"], "unlocked">;

/**
 * Password form for a locked imported original. The password lives in the input element only: it is
 * read once on submit, the field is cleared at that moment, and nothing here keeps it in state. The
 * main process holds the resulting unlock grant; this component never sees it.
 */
export function ImportedSourceUnlock({ id, language, onUnlocked }: { id: string; language: Language; onUnlocked(): void }) {
  const copy = desktopChatCopy[language];
  const lock = dictionaries[language].externalImport;
  const field = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = field.current;
    const password = input?.value ?? "";
    if (!input || !password || busy) return;
    input.value = "";
    setBusy(true);
    setOutcome(undefined);
    try {
      const result = await window.desktop.chatUnlockImportedSource({ id, password });
      if (result.status === "unlocked") onUnlocked();
      else setOutcome(result.status);
    } catch {
      setOutcome("failed");
    } finally {
      setBusy(false);
    }
  }

  const message = outcome === "wrong" ? lock.lockWrongPassword
    : outcome === "limited" ? lock.lockTooManyAttempts
      : outcome === "unavailable" ? copy.unlockImportedUnavailable
        : outcome === "failed" ? lock.lockFailed : null;
  return <form className="chat-imported-unlock" data-testid="imported-source-unlock" onSubmit={(event) => void submit(event)}>
    <p>{lock.lockGateDescription}</p>
    <label>{lock.lockPasswordLabel}
      <input ref={field} className="history-search" type="password" autoComplete="off" maxLength={128} required
        disabled={busy} data-testid="imported-source-unlock-password" />
    </label>
    {message && <p role="alert" data-testid={`imported-source-unlock-${outcome}`}>{message}</p>}
    <button className="primary" type="submit" disabled={busy} data-testid="imported-source-unlock-submit">{lock.lockUnlockCta}</button>
  </form>;
}
