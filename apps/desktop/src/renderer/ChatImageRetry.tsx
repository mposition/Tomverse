import { useState } from "react";
import type { Language } from "../../../../lib/language";
import { imageTurnFromOffer } from "../image-turn-request";
import { webLocales } from "./answer-locales";
import { clearImageOffer, useImageOffer } from "./image-offer-store";
import "./answer-extras.css";

/**
 * The server judged the saved question an image request and Desktop started the image at once, as the web does.
 * This card appears only when that start failed; trying again reuses the answer id, so it never charges twice.
 */
export function ChatImageRetry({ conversationId, language, onStarted }: { conversationId?: string; language: Language; onStarted: () => void }) {
  const offer = useImageOffer(conversationId);
  const chat = webLocales[language].chat;
  const [phase, setPhase] = useState<"failed" | "starting">("failed");
  if (!offer) return null;
  async function retry() {
    if (!offer || phase === "starting") return;
    setPhase("starting");
    try {
      const outcome = await window.desktop.chatExtras<"imageTurn">(imageTurnFromOffer(offer));
      if (outcome.ok) {
        clearImageOffer();
        onStarted();
      }
    } catch { /* The card stays, with the same answer id for the next try. */ }
    setPhase("failed");
  }
  return <section className="chat-image-offer" data-testid="desktop-image-turn-failed">
    <p role={phase === "starting" ? "status" : "alert"}>{phase === "starting" ? chat.imageTurnGenerating : chat.imageTurnFailed}</p>
    <div className="chat-image-offer-actions">
      <button type="button" disabled={phase === "starting"} data-testid="desktop-image-turn-retry" onClick={() => void retry()}>{chat.imageTurnRetry}</button>
    </div>
  </section>;
}
