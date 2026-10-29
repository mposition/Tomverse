import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatTransport, MobileImageGroup } from "./chatTransport";
import type { MobileLanguage } from "../../../locales/mobile";
import { mobileParityCopy } from "../../../locales/mobileParity";
import { isImageAssetUrlExpired } from "../../../lib/imageAssetPayload";
import { imageGenerationFeedbackCopy, imageResultQuality } from "../../../locales/imageGenerationFeedback";

function ImageProgress({ language }: { language: MobileLanguage }) {
  const copy = imageGenerationFeedbackCopy[language];
  return <div className="native-image-progress" role="status" data-testid="native-image-progress">
    <svg className="native-image-progress-icon" viewBox="0 0 56 44" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="52" height="40" rx="8" stroke="currentColor" strokeWidth="2" />
      <circle cx="17" cy="15" r="4" fill="currentColor" opacity=".55" />
      <path d="m7 35 13-12 9 8 9-14 11 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    <strong>{copy.generating}<span className="native-image-progress-dots" aria-hidden="true"><i /><i /><i /></span></strong>
    <span>{copy.workingHint}</span>
  </div>;
}

export function ImageTurn({ groupId, transport, language }: { groupId: string; transport: ChatTransport; language: MobileLanguage }) {
  const copy = mobileParityCopy(language);
  const feedback = imageGenerationFeedbackCopy[language];
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
      const running = !attempt || !["succeeded", "failed", "cancelled"].includes(attempt.status);
      const quality = imageResultQuality(attempt?.quality, attempt?.preset);
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
          {quality && <div className="native-image-quality" data-testid="native-image-quality">
            <span>{feedback[quality]}</span>
            {quality === "medium" && <><p>{feedback.upgradeHint}</p><small>{feedback.costHint}</small></>}
          </div>}
        </> : running ? <ImageProgress language={language} /> : <p role="status">{copy.imageFailed}<button onClick={() => void refresh()}>{copy.retry}</button></p>}
        <figcaption>{target.modelId}</figcaption>
      </figure>;
    })}
  </div>;
}
