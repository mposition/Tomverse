import { useState } from "react";
import { desktopAccountDataCopy } from "../../../../locales/desktopAccountData";
import { DELETE_ASSISTANT_PHRASE } from "../account-data-contract";
import { AccountDataResultLine, TypedConfirmation, useAccountDataAction } from "./AccountDataSettings";
import { dictionaries, useSettingsRead, type Common } from "./settings-shared";

const knowledgeMessage = (language: Common["language"], code?: string) => {
  const copy = dictionaries[language].assistantProfiles;
  if (code === "ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE") return copy.knowledgeUnsupported;
  if (code === "ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED" || code === "FILE_TOO_LARGE") return copy.knowledgeQuotaExceeded;
  return copy.knowledgeUploadFailed;
};

/** Knowledge files of one assistant. Hidden while the server has knowledge files off. */
function KnowledgeFiles({ language, id, reloadProfile }: Common & { id: string; reloadProfile(): void }) {
  const copy = dictionaries[language].assistantProfiles;
  const words = desktopAccountDataCopy[language];
  const state = useSettingsRead(() => window.desktop.accountSettings<"knowledge">({ action: "knowledge", id }));
  const upload = useAccountDataAction();
  const [removing, setRemoving] = useState<string>();
  const [removeFailed, setRemoveFailed] = useState(false);
  if (!state.data) return null;
  const { files, capacity } = state.data;
  return <section className="desktop-setting-section" data-testid="native-assistant-knowledge">
    <h3>{copy.knowledgeLabel}</h3>
    {files.length === 0 ? <p>{words.assistantKnowledgeEmpty}</p> : <ul>{files.map(file => <li key={file.id}>
      {file.name} <small>{(file.bytes / 1024).toFixed(0)} KB · {file.processingStatus}</small>{" "}
      <button type="button" className="soft" disabled={removing === file.id} aria-label={copy.knowledgeRemove.replace("{name}", file.name)}
        onClick={() => {
          setRemoving(file.id); setRemoveFailed(false);
          void window.desktop.accountSettings<"deleteKnowledgeFile">({ action: "deleteKnowledgeFile", id, fileId: file.id })
            .then(() => { state.reload(); reloadProfile(); }, () => setRemoveFailed(true)).finally(() => setRemoving(undefined));
        }}>×</button>
    </li>)}</ul>}
    <button type="button" className="soft" disabled={upload.busy || files.length >= capacity.limits.maxFilesPerProfile}
      data-testid="native-assistant-knowledge-add" onClick={() => void (async () => {
        const value = await upload.run({ action: "uploadKnowledge", id });
        if (value?.status === "uploaded") { state.reload(); reloadProfile(); }
      })()}>{upload.busy ? words.working : copy.knowledgeAdd}</button>
    {upload.result && upload.result.status !== "uploaded" && upload.result.status !== "cancelled" && (
      upload.result.status === "failed" ? <p className="notice" role="alert">{knowledgeMessage(language, upload.result.code)}</p>
        : <AccountDataResultLine language={language} status={upload.result.status} />)}
    {removeFailed && <p className="notice" role="alert">{copy.knowledgeUploadFailed}</p>}
  </section>;
}

/** Package download and deletion for one assistant, below its editor. */
export function AssistantExtras({ language, id, name, reloadProfile, onDeleted }: Common & {
  id: string; name: string; reloadProfile(): void; onDeleted(): void;
}) {
  const copy = dictionaries[language].assistantProfiles;
  const words = desktopAccountDataCopy[language];
  const exporter = useAccountDataAction();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <>
    <KnowledgeFiles language={language} id={id} reloadProfile={reloadProfile} />
    <section className="desktop-setting-section" data-testid="native-assistant-package">
      <button type="button" className="soft" disabled={exporter.busy} data-testid="native-assistant-export"
        onClick={() => void exporter.run({ action: "saveAssistant", id, name })}>{exporter.busy ? words.working : words.assistantExport}</button>
      {exporter.result?.status === "saved" && <p role="status">{words.saved}</p>}
      <AccountDataResultLine language={language} status={exporter.result?.status} />
    </section>
    <section className="desktop-setting-section" data-testid="native-assistant-delete">
      <h3>{copy.deleteHeading}</h3>
      <p>{copy.deleteHint}</p>
      {confirming ? <TypedConfirmation language={language} testId="native-assistant-delete-form" phrase={DELETE_ASSISTANT_PHRASE}
        prompt={words.assistantDeletePrompt} actionLabel={copy.deleteAction} busy={busy}
        onCancel={() => { setConfirming(false); setFailed(false); }}
        onConfirm={() => {
          setBusy(true); setFailed(false);
          void window.desktop.accountSettings<"deleteAssistant">({ action: "deleteAssistant", id })
            .then(onDeleted, () => setFailed(true)).finally(() => setBusy(false));
        }} />
        : <button type="button" className="soft" onClick={() => setConfirming(true)}>{copy.deleteAction}</button>}
      {failed && <p className="notice" role="alert">{copy.noticeFailed}</p>}
    </section>
  </>;
}
