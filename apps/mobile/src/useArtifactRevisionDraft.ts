import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { readDeviceDraft, writeDeviceDraft } from "@tomverse/chat-core/device-draft";
import type { ChatStreamArtifact } from "../../../lib/generatedArtifactCore";
import { mobileArtifactRevisionCopy } from "../../../locales/mobileArtifactRevision";
import { mobileErrorText } from "../../../locales/mobileErrors";
import { mobileUploadCopy } from "../../../locales/mobileUpload";
import type { MobileLanguage } from "../../../locales/mobile";
import { appendNativeRevisionDraft, nativeRevisionConflict, readNativeDraftFiles, writeNativeDraftFiles, type NativeFileUpdate } from "./nativeRevisionDraft";
import type { ChatTransport, MobileAttachment } from "./chatTransport";

const keyFor = (owner: string | null, conversationId: string | null) => JSON.stringify([owner, conversationId]);
const restoreFiles = (owner: string | null, conversationId: string | null) => {
  try { return owner ? readNativeDraftFiles(localStorage, owner, conversationId) : []; } catch { return []; }
};

export function useArtifactRevisionDraft(input: {
  owner: string | null; conversationId: string | null; text: string;
  setText: (text: string, conversationId?: string | null) => void;
  transport: ChatTransport; enabled: boolean; language: MobileLanguage;
}) {
  const { owner, conversationId, transport, enabled, language } = input;
  const scope = keyFor(owner, conversationId);
  const [identity, setIdentity] = useState({ owner, epoch: 0 });
  const [store, setStore] = useState<Record<string, MobileAttachment[]>>(() => ({ [scope]: restoreFiles(owner, conversationId) }));
  if (identity.owner !== owner) {
    setIdentity({ owner, epoch: identity.epoch + 1 });
    setStore({ [scope]: restoreFiles(owner, conversationId) });
  } else if (!(scope in store)) {
    setStore({ ...store, [scope]: restoreFiles(owner, conversationId) });
  }
  const active = useRef({ owner, conversationId, epoch: identity.epoch, text: input.text, setText: input.setText });
  const files = useRef(store);
  const texts = useRef(new Map<string, string>());
  const operations = useRef(new Map<string, { id: string; pending?: Promise<string | null> }>());
  useLayoutEffect(() => {
    if (active.current.owner !== owner) { texts.current.clear(); operations.current.clear(); }
    active.current = { owner, conversationId, epoch: identity.epoch, text: input.text, setText: input.setText };
    files.current = store;
    texts.current.set(scope, input.text);
  }, [conversationId, identity.epoch, input.setText, input.text, owner, scope, store]);
  useLayoutEffect(() => () => { active.current.epoch++; }, []);
  const readFiles = useCallback((targetOwner: string | null, targetId: string | null) =>
    files.current[keyFor(targetOwner, targetId)] ?? restoreFiles(targetOwner, targetId), []);
  const updateFiles = useCallback((update: NativeFileUpdate) => {
    if (active.current.owner !== owner || active.current.epoch !== identity.epoch) return;
    const current = readFiles(owner, conversationId), next = typeof update === "function" ? update(current) : update;
    files.current = { ...files.current, [scope]: next };
    setStore(files.current);
    try { if (owner) writeNativeDraftFiles(localStorage, owner, conversationId, next); } catch { /* In-memory draft is retained. */ }
  }, [owner, conversationId, identity.epoch, readFiles, scope]);
  const prepare = useCallback(async (artifact: ChatStreamArtifact): Promise<string | null> => {
    const copy = mobileArtifactRevisionCopy(language);
    if (!enabled || !owner || !conversationId || !transport.prepareArtifactRevision) return copy.failed;
    const epoch = active.current.epoch;
    const conflictCopy = (reason: "name" | "count" | "text" | "size") => reason === "name" ? copy.nameConflict : reason === "count" ? copy.countConflict
      : reason === "size" ? mobileUploadCopy[language].sizeLimit : copy.textConflict;
    const conflict = nativeRevisionConflict(readFiles(owner, conversationId), artifact.filename);
    if (conflict) return conflictCopy(conflict);
    const key = `${scope}:${artifact.id}`;
    const operation = operations.current.get(key) ?? { id: crypto.randomUUID() };
    if (operation.pending) return operation.pending;
    const pending = (async () => {
      try {
        const upload = await transport.prepareArtifactRevision!({ artifactId: artifact.id, conversationId, operationId: operation.id });
        if (active.current.owner !== owner || active.current.epoch !== epoch) return copy.failed;
        const text = active.current.conversationId === conversationId ? active.current.text : texts.current.get(scope) ?? readDeviceDraft(localStorage, owner, conversationId);
        const request = (upload.revisionMode === "workbook-values" ? copy.valuesPrompt : upload.revisionMode === "workbook" ? copy.workbookPrompt
          : artifact.format === "docx" || artifact.format === "pptx" ? copy.officePrompt : copy.prompt).replaceAll("{filename}", upload.name);
        const result = appendNativeRevisionDraft({ text, files: readFiles(owner, conversationId) }, upload, request);
        if (result.conflict) {
          operations.current.delete(key);
          await transport.discardAttachment?.(upload.uploadId);
          return conflictCopy(result.conflict);
        }
        files.current = { ...files.current, [scope]: result.draft.files };
        texts.current.set(scope, result.draft.text);
        try { writeDeviceDraft(localStorage, owner, conversationId, result.draft.text); writeNativeDraftFiles(localStorage, owner, conversationId, result.draft.files); } catch { /* Preserve active in-memory draft. */ }
        if (active.current.conversationId === conversationId) {
          active.current.setText(result.draft.text, conversationId);
          active.current.text = result.draft.text;
        }
        setStore(files.current);
        operations.current.delete(key);
        return null;
      } catch (error) { return mobileErrorText(error, language, copy.failed); }
      finally { operation.pending = undefined; }
    })();
    operation.pending = pending; operations.current.set(key, operation);
    return pending;
  }, [conversationId, enabled, language, owner, readFiles, scope, transport]);
  const removeFile = useCallback((file: MobileAttachment) => {
    updateFiles(current => current.filter(value => value.uploadId !== file.uploadId));
    void transport.discardAttachment?.(file.uploadId).catch(() => { /* Existing unbound retention limitation applies. */ });
  }, [transport, updateFiles]);
  const addFile = useCallback((file: MobileAttachment): "added" | "count" | "name" | "stale" => {
    if (active.current.owner !== owner || active.current.epoch !== identity.epoch) return "stale";
    const current = readFiles(owner, conversationId);
    if (current.some(item => item.uploadId === file.uploadId)) return "added";
    const conflict = nativeRevisionConflict(current, file.name);
    if (conflict) return conflict;
    updateFiles([...current, file]);
    return "added";
  }, [conversationId, identity.epoch, owner, readFiles, updateFiles]);
  return { files: store[scope] ?? [], setFiles: updateFiles, addFile, removeFile,
    prepare: enabled && owner && conversationId && transport.prepareArtifactRevision ? prepare : undefined };
}
