"use client";

import { useId, useRef, useState } from "react";
import { ClipboardCopy, Download, Share2 } from "lucide-react";
import { StudioStatus, useStudioCopy } from "./StudioControls";
import { saveStudioFile } from "./studioCanvas";
import styles from "./studio.module.css";

export function StudioImageShare({ disabled, filename, prepare, iconOnly, description }: {
  disabled?: boolean;
  filename: string;
  prepare: () => Promise<Blob>;
  iconOnly?: boolean;
  description?: string;
}) {
  const { copy } = useStudioCopy();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const canShare = file && typeof navigator.share === "function" && navigator.canShare?.({ files: [file] });
  const canCopy = file && typeof ClipboardItem !== "undefined" && Boolean(navigator.clipboard?.write);

  function open() {
    const current = ++request.current;
    setFile(null);
    setStatus(null);
    setWorking(true);
    dialog.current?.showModal();
    void prepare().then(blob => {
      if (current === request.current) setFile(new File([blob], filename, { type: "image/png" }));
    }).catch(() => {
      if (current === request.current) setStatus({ text: copy.taskFailed, error: true });
    }).finally(() => {
      if (current === request.current) setWorking(false);
    });
  }

  async function share() {
    if (!file || working) return;
    setWorking(true);
    setStatus(null);
    try {
      await navigator.share({ files: [file] });
      dialog.current?.close();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setStatus({ text: copy.taskFailed, error: true });
    } finally {
      setWorking(false);
    }
  }

  async function copyFile() {
    if (!file || working) return;
    setWorking(true);
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": file })]);
      setStatus({ text: copy.imageCopied, error: false });
    } catch {
      setStatus({ text: copy.taskFailed, error: true });
    } finally {
      setWorking(false);
    }
  }

  const label = description ? `${copy.shareImage} · ${description}` : copy.shareImage;
  return <>
    <button type="button" className={iconOnly ? undefined : styles.secondary} disabled={disabled}
      aria-label={label} title={iconOnly ? label : undefined} onClick={open}>
      <Share2 size={16} aria-hidden />{!iconOnly && copy.shareImage}
    </button>
    <dialog ref={dialog} className={styles.dialog + " " + styles.shareDialog} aria-labelledby={titleId}
      onClose={() => { request.current++; setFile(null); setWorking(false); setStatus(null); }}>
      <h2 id={titleId}>{copy.shareImage}</h2>
      {!file && working && <p role="status">{copy.preparingImage}</p>}
      <div className={styles.shareActions}>
        {canShare && <button type="button" className={styles.primary} disabled={working} onClick={() => void share()}>
          <Share2 size={16} aria-hidden />{copy.shareToApps}
        </button>}
        {canCopy && <button type="button" className={styles.secondary} disabled={working} onClick={() => void copyFile()}>
          <ClipboardCopy size={16} aria-hidden />{copy.copyImage}
        </button>}
        {file && <button type="button" className={styles.secondary} disabled={working} onClick={() => saveStudioFile(file, file.name)}>
          <Download size={16} aria-hidden />{copy.savePng}
        </button>}
      </div>
      <StudioStatus status={status} />
      <div className={styles.dialogActions}>
        <button type="button" className={styles.secondary} onClick={() => dialog.current?.close()}>{copy.close}</button>
      </div>
    </dialog>
  </>;
}
