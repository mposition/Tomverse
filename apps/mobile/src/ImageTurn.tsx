import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatTransport, MobileImageGroup } from "./chatTransport";
import type { MobileLanguage } from "../../../locales/mobile";
import { mobileParityCopy } from "../../../locales/mobileParity";
import { isImageAssetUrlExpired } from "../../../lib/imageAssetPayload";

export function ImageTurn({ groupId, transport, language }: { groupId: string; transport: ChatTransport; language: MobileLanguage }) {
  const copy = mobileParityCopy(language);
  const [group, setGroup] = useState<MobileImageGroup | null>(null);
  const [failed, setFailed] = useState(false);
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const request = useRef(0);
  const expiredRetries = useRef(new Set<string>());
  const refresh = useCallback(async () => {
    const current = ++request.current;
    try {
      if (!transport.imageGroup) throw Error("IMAGE_READ_UNAVAILABLE");
      const value = await transport.imageGroup(groupId);
      if (current === request.current) { setGroup(value); setFailed(false); setFailedImages([]); }
    } catch { if (current === request.current) setFailed(true); }
  }, [groupId, transport]);
  useEffect(() => { queueMicrotask(() => void refresh()); return () => { request.current++; }; }, [refresh]); // eslint-disable-line react-hooks/exhaustive-deps -- A request epoch, not a DOM ref.
  const pending = group?.targets.some(target => {
    const attempt = group.generations.find(item => item.generationId === target.currentGenerationId);
    return !attempt || !["succeeded", "failed", "cancelled"].includes(attempt.status);
  });
  useEffect(() => { if (!pending || failed) return; const timer = setInterval(() => void refresh(), 4000); return () => clearInterval(timer); }, [pending, failed, refresh]);
  return <div className="image-turn">
    {(!group || failed) && <p role="status">{failed ? copy.imageFailed : copy.imageLoading}{failed && <button onClick={() => void refresh()}>{copy.retry}</button>}</p>}
    {group?.targets.map(target => {
      const attempt = group.generations.find(item => item.generationId === target.currentGenerationId);
      const asset = attempt?.assets.find(item => item.role === "original") ?? attempt?.assets[0];
      let safe = false;
      try { const url = new URL(asset?.url ?? ""); safe = url.protocol === "https:" && !url.username && !url.password; } catch { /* Refuse malformed asset URLs. */ }
      return <figure key={target.targetId}>
        {attempt?.status === "succeeded" && asset && safe && !failedImages.includes(target.targetId) ? <>
          {/* eslint-disable-next-line @next/next/no-img-element -- Short-lived signed image URL, held only in memory. */}
          <img src={asset.url} alt={attempt.prompt} referrerPolicy="no-referrer" onError={() => {
            setFailedImages(items => [...items, target.targetId]);
            if (!expiredRetries.current.has(asset.url) && isImageAssetUrlExpired(asset.urlExpiresAt ?? null, Date.now())) { expiredRetries.current.add(asset.url); void refresh(); }
          }} />
          <a href={asset.url} target="_blank" rel="noopener noreferrer">{copy.openImage}</a>
        </> : <p role="status">{attempt?.status === "failed" || failedImages.includes(target.targetId) ? copy.imageFailed : copy.imageLoading}<button onClick={() => void refresh()}>{copy.retry}</button></p>}
        <figcaption>{target.modelId}</figcaption>
      </figure>;
    })}
  </div>;
}
