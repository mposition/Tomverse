"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { QA_RELEASE_TRAIN_CHANGED_EVENT, QA_RELEASE_TRAIN_RELOAD_EVENT } from "@/components/admin/qaReleaseTabParts";

/** Reads the release train tab again on the server after a save on it or its "Read again" (qaReleaseTabParts.ts). */
export function QaReleaseTrainRefresher() {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => router.refresh();
    window.addEventListener(QA_RELEASE_TRAIN_CHANGED_EVENT, refresh);
    window.addEventListener(QA_RELEASE_TRAIN_RELOAD_EVENT, refresh);
    return () => {
      window.removeEventListener(QA_RELEASE_TRAIN_CHANGED_EVENT, refresh);
      window.removeEventListener(QA_RELEASE_TRAIN_RELOAD_EVENT, refresh);
    };
  }, [router]);
  return null;
}

/** A count that moves on each save or "Read again" on the train tab, and whether the last move asked GitHub afresh. */
export function useQaReleaseTrainReads(): { key: number; fresh: boolean } {
  const [reads, setReads] = useState({ key: 0, fresh: false });
  useEffect(() => {
    const changed = () => setReads((current) => ({ key: current.key + 1, fresh: false }));
    const reload = () => setReads((current) => ({ key: current.key + 1, fresh: true }));
    window.addEventListener(QA_RELEASE_TRAIN_CHANGED_EVENT, changed);
    window.addEventListener(QA_RELEASE_TRAIN_RELOAD_EVENT, reload);
    return () => {
      window.removeEventListener(QA_RELEASE_TRAIN_CHANGED_EVENT, changed);
      window.removeEventListener(QA_RELEASE_TRAIN_RELOAD_EVENT, reload);
    };
  }, []);
  return reads;
}
