import { useState } from "react";
import type { MobileLanguage } from "../../../locales/mobile";
import { mobileWorkspaceCopy } from "../../../locales/mobileWorkspace";

/** Navigation and mode layout are ready; no Review execution is claimed by this preview. */
export function ReviewPreview({ language }: { language: MobileLanguage }) {
  const c = mobileWorkspaceCopy[language]; const [mode, setMode] = useState("easy");
  return <section className="review-preview">
    <div className="segmented" role="group" aria-label={c.reviewMode}>{["easy", "professional"].map((item) => <button key={item} aria-pressed={mode === item} onClick={() => setMode(item)}>{item === "easy" ? "Easy" : "Professional"}</button>)}</div>
    <h1>{c.reviewTitle}</h1><p>{mode === "easy" ? c.easy : c.professional}</p>
    <p role="status" className="preview-notice">{c.preview}</p>
    <h2>{mode === "easy" ? c.providers : c.selected}</h2>
    <div className="preview-slots">{(mode === "easy" ? ["OpenAI", "Anthropic", "Google"] : [c.model]).map((item) => <button key={item} disabled>{item}<span>＋</span></button>)}</div>
  </section>;
}
