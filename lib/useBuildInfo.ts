"use client";

import { useEffect, useState } from "react";
import type { PublicBuildInfo } from "@/lib/buildInfo";

// Client-side counterpart to lib/buildInfo.ts: fetches the same public
// /api/build-info endpoint the server itself is built from, so the UI and
// the endpoint can never disagree about which deployment is running
// (STG-F010). Cheap enough (one process.env read + one small file read, no
// database) that each mount fetching independently is fine -- no shared
// cache/context needed.
export function useBuildInfo() {
  const [buildInfo, setBuildInfo] = useState<PublicBuildInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/build-info", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: PublicBuildInfo | null) => {
        if (!cancelled && data) setBuildInfo(data);
      })
      .catch(() => {
        // Silent -- build info is a diagnostics affordance, never load-bearing.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return buildInfo;
}
