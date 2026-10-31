import { useEffect, useId, useRef } from "react";
import { FileImage, FileText, LoaderCircle } from "lucide-react";
import { formatArtifactSize } from "../../../lib/generatedArtifactCore";
import { mobileUploadCopy } from "../../../locales/mobileUpload";
import type { MobileLanguage } from "../../../locales/mobile";
import "./uploadProgress.css";

export type UploadProgress = { file: Pick<File, "name" | "size" | "type">; completed: number; total: number };

export function UploadProgressDialog({ progress, language }: { progress: UploadProgress; language: MobileLanguage }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const copy = mobileUploadCopy[language];
  const FileIcon = progress.file.type.startsWith("image/") ? FileImage : FileText;
  useEffect(() => {
    const node = dialog.current;
    node?.showModal(); heading.current?.focus({ preventScroll: true });
    return () => node?.close();
  }, []);
  return <dialog ref={dialog} className="upload-progress-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-file ${id}-count ${id}-note`} onCancel={event => event.preventDefault()}>
    <LoaderCircle className="upload-progress-spinner" size={64} strokeWidth={1.8} aria-hidden="true" />
    <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{copy.title}</h2>
    <div className="upload-progress-file" id={`${id}-file`}>
      <FileIcon size={32} strokeWidth={1.6} aria-hidden="true" />
      <div><p className="upload-progress-name">{progress.file.name}</p><p className="upload-progress-size">{formatArtifactSize(progress.file.size)}</p></div>
    </div>
    <div className="upload-progress-track" role="progressbar" aria-label={copy.title} aria-describedby={`${id}-count`}><span /></div>
    <p id={`${id}-count`} className="upload-progress-count" role="status" aria-live="polite" aria-atomic="true">{copy.completed.replace("{completed}", String(progress.completed)).replace("{total}", String(progress.total))}</p>
    <p id={`${id}-note`} className="upload-progress-note">{copy.automaticClose}</p>
  </dialog>;
}
