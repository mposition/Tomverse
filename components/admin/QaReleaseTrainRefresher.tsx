"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { QA_RELEASE_TRAIN_CHANGED_EVENT, QA_RELEASE_TRAIN_RELOAD_EVENT, QA_RELEASE_TRAIN_TAB_HREF } from "@/components/admin/qaReleaseTabParts";

/**
 * Reads the release train tab again on the server after a save on it, and on
 * its "Read GitHub again" with `fresh` in the address, so the board reads
 * GitHub past its shared read too (qaReleaseTrainBoardRead.ts).
 */
export function QaReleaseTrainRefresher() {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => router.refresh();
    const reload = () => router.replace(`${QA_RELEASE_TRAIN_TAB_HREF}&fresh=${Date.now()}`, { scroll: false });
    window.addEventListener(QA_RELEASE_TRAIN_CHANGED_EVENT, refresh);
    window.addEventListener(QA_RELEASE_TRAIN_RELOAD_EVENT, reload);
    return () => {
      window.removeEventListener(QA_RELEASE_TRAIN_CHANGED_EVENT, refresh);
      window.removeEventListener(QA_RELEASE_TRAIN_RELOAD_EVENT, reload);
    };
  }, [router]);
  return null;
}

/**
 * A count that moves on each save or "Read GitHub again" on the train tab.
 * Either reads the candidates past the shared read: what was just saved, or
 * asked for, may have changed on GitHub since that read.
 */
export function useQaReleaseTrainReads(): { key: number; fresh: boolean } {
  const [reads, setReads] = useState({ key: 0, fresh: false });
  useEffect(() => {
    const again = () => setReads((current) => ({ key: current.key + 1, fresh: true }));
    window.addEventListener(QA_RELEASE_TRAIN_CHANGED_EVENT, again);
    window.addEventListener(QA_RELEASE_TRAIN_RELOAD_EVENT, again);
    return () => {
      window.removeEventListener(QA_RELEASE_TRAIN_CHANGED_EVENT, again);
      window.removeEventListener(QA_RELEASE_TRAIN_RELOAD_EVENT, again);
    };
  }, []);
  return reads;
}
