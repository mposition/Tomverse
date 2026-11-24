"use client";

import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { studioCopy } from "@/locales/studio";
import { studioCreativeCopy } from "@/locales/studioCreative";
import { createStudioObjectUrl, revokeStudioObjectUrl, studioImageAccept, validStudioImage } from "./studioCanvas";
import styles from "./studio.module.css";

export function useStudioCopy() {
  const { lang } = useLanguage();
  return { lang, copy: { ...studioCopy[lang], ...studioCreativeCopy[lang] } };
}

export function useStudioUrls() {
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const owned = urls.current;
    return () => {
      for (const url of owned) revokeStudioObjectUrl(url);
      owned.clear();
    };
  }, []);
  return {
    make(blob: Blob) {
      const url = createStudioObjectUrl(blob);
      urls.current.add(url);
      return url;
    },
    release(url: string) {
      if (urls.current.delete(url)) revokeStudioObjectUrl(url);
    },
  };
}

export function useStudioTask() {
  const { copy } = useStudioCopy();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  const report = (text: string, error = false) => setStatus({ text, error });
  const task = async (work: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setStatus(null);
    try {
      await work();
    } catch {
      report(copy.taskFailed, true);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, status, report, task };
}

export function StudioFileButton({ label, onFile, disabled, onInvalid, capture }: {
  label: string;
  onFile: (file: File) => void;
  disabled?: boolean;
  onInvalid: () => void;
  capture?: "user";
}) {
  return (
    <label className={styles.fileButton} data-disabled={disabled || undefined} data-capture={capture}>
      <span>{label}</span>
      <input
        type="file"
        accept={capture ? "image/*" : studioImageAccept}
        capture={capture}
        aria-label={label}
        disabled={disabled}
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          if (!validStudioImage(file)) onInvalid();
          else onFile(file);
        }}
      />
    </label>
  );
}

export function StudioStatus({ status }: { status: ReturnType<typeof useStudioTask>["status"] }) {
  if (!status) return null;
  return <p className={styles.status} role={status.error ? "alert" : "status"}>{status.text}</p>;
}
