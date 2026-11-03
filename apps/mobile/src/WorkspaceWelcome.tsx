import { useId } from "react";
import type { MobileLanguage } from "../../../locales/mobile";
import { mobileWorkspaceStartCopy } from "../../../locales/mobileWorkspaceStart";
import chatLight from "./assets/workspace-chat-light.webp";
import chatDark from "./assets/workspace-chat-dark.webp";
import reviewLight from "./assets/workspace-review-light.webp";
import reviewDark from "./assets/workspace-review-dark.webp";

export function WorkspaceWelcome({ product, language, automatic = false }: {
  product: "chat" | "review"; language: MobileLanguage; automatic?: boolean;
}) {
  const c = mobileWorkspaceStartCopy(language);
  const id = useId();
  const review = product === "review";
  return <section className={`workspace-welcome ${product}-welcome`} data-testid="workspace-start" data-product={product} aria-labelledby={id}>
    <div className="workspace-welcome-content">
      <h1 id={id}><span>{review ? c.reviewFirst : c.chatFirst}</span><span className="welcome-headline-last">{review ? c.reviewLast : c.chatLast}<span className="welcome-period">.</span></span></h1>
      <p className="welcome-intro">{review ? c.reviewDescription : automatic ? c.chatAutomatic : c.chatDescription}</p>
    </div>
    <div className="welcome-art" aria-hidden="true">
      {/* Decorative assets are bundled locally; first entry never creates a conversation. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- Native Vite image assets. */}
      <img className="welcome-art-light" src={review ? reviewLight : chatLight} alt="" />
      {/* eslint-disable-next-line @next/next/no-img-element -- Native Vite image assets. */}
      <img className="welcome-art-dark" src={review ? reviewDark : chatDark} alt="" />
    </div>
  </section>;
}
