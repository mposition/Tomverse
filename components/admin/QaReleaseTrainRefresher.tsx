"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { QA_RELEASE_TRAIN_CHANGED_EVENT, QA_RELEASE_TRAIN_RELOAD_EVENT } from "@/components/admin/qaReleaseTabParts";
import { adminFetch } from "@/lib/adminFetch";

const FRESH_READ = "/api/admin/agent-digests/qa-release/train-cargo?fresh=1";

/**
 * Reads the release train tab again on the server after a save on it or its
 * "Read GitHub again": first a fresh cargo read, which also expires the
 * departure board's shared GitHub reads (qaReleaseTrainBoardRead.ts), then
 * the page. Nothing goes in the address, so no reload, link or later visit
 * reads past the shared read again.
 */
export function QaReleaseTrainRefresher() {
  const router = useRouter();
  useEffect(() => {
    const again = () => {
      void adminFetch(FRESH_READ, { cache: "no-store" })
        .catch(() => undefined)
        .then(() => router.refresh());
    };
    window.addEventListener(QA_RELEASE_TRAIN_CHANGED_EVENT, again);
    window.addEventListener(QA_RELEASE_TRAIN_RELOAD_EVENT, again);
    return () => {
      window.removeEventListener(QA_RELEASE_TRAIN_CHANGED_EVENT, again);
      window.removeEventListener(QA_RELEASE_TRAIN_RELOAD_EVENT, again);
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
