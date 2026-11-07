"use client";

import { useState } from "react";
import { ImageOff } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminMarketingAgentMessages } from "@/lib/adminMessages/marketingAgent";

const PREVIEW = (id: string) => `/api/admin/marketing/assets/${encodeURIComponent(id)}/preview`;

/**
 * The first file a post carries, as a picture.
 *
 * The preview route answers with a short-lived redirect to the stored file, so
 * the browser shows it if it is an image. A video, a file the browser cannot
 * draw or a refused request falls back to a quiet tile that says what the post
 * carries, never to a broken image. With no file the tile says so.
 */
export function MarketingPostThumb({
  assetIds,
  className = "",
}: {
  assetIds: unknown;
  className?: string;
}) {
  const m = useAdminMessages(adminMarketingAgentMessages);
  const [failed, setFailed] = useState(false);
  const ids = Array.isArray(assetIds)
    ? assetIds.filter((id): id is string => typeof id === "string" && id !== "")
    : [];
  const first = ids[0];
  const frame = `flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl bg-zinc-800 ${className}`;
  if (!first) {
    return (
      <div data-testid="marketing-post-thumb" data-state="none" className={`${frame} text-xs text-zinc-400`}>
        <span className="inline-flex items-center gap-1.5">
          <ImageOff className="h-4 w-4" aria-hidden />
          {m.previewNone}
        </span>
      </div>
    );
  }
  if (failed) {
    return (
      <a
        data-testid="marketing-post-thumb"
        data-state="fallback"
        href={PREVIEW(first)}
        target="_blank"
        rel="noopener noreferrer"
        className={`${frame} text-xs font-bold text-blue-300 hover:underline`}
      >
        {m.previewOpen}
      </a>
    );
  }
  return (
    <div data-testid="marketing-post-thumb" data-state="image" className={frame}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a signed redirect, not an optimisable asset */}
      <img
        src={PREVIEW(first)}
        alt={m.previewAlt}
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
      />
    </div>
  );
}
