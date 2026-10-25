"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { QA_RELEASE_TRAIN_CHANGED_EVENT } from "@/components/admin/qaReleaseTabParts";

/** Reads the release train tab again on the server after a save on it (qaReleaseTabParts.ts). */
export function QaReleaseTrainRefresher() {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => router.refresh();
    window.addEventListener(QA_RELEASE_TRAIN_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(QA_RELEASE_TRAIN_CHANGED_EVENT, refresh);
  }, [router]);
  return null;
}
