import { useEffect, useId, useState } from "react";
import { Sparkles, FileText, Globe, Code2, FileSpreadsheet, Image as ImageIcon } from "lucide-react";
import { workspaceWelcomeCopy } from "../../../locales/workspaceWelcome";
import { reviewWorkspaceCopy } from "../../../lib/reviewWorkspaceCopy";
import type { MobileLanguage } from "../../../locales/mobile";
import type { ChatTransport, MobileCapabilities } from "./chatTransport";

type Starter = "compareAnswers" | "documentQuestions" | "sourcedAnswer" | "debugStackTrace" | "spreadsheetFromAnswer" | "compareImageModels";
const icons = { compareAnswers: Sparkles, documentQuestions: FileText, sourcedAnswer: Globe, debugStackTrace: Code2, spreadsheetFromAnswer: FileSpreadsheet, compareImageModels: ImageIcon };
export function WorkspaceWelcome({ product, language, transport, capability, onSeed }: {
  product: "chat" | "review"; language: MobileLanguage; transport: ChatTransport; capability?: MobileCapabilities | null;
  onSeed: (text: string, starter: Starter) => void;
}) {
  const [loaded, setLoaded] = useState<MobileCapabilities | null>(null);
  const descriptionId = useId();
  useEffect(() => {
    if (capability !== undefined) return;
    let active = true;
    void transport.mobileCapabilities?.().then(value => { if (active) setLoaded(value); }).catch(() => {});
    return () => { active = false; };
  }, [transport, capability]);
  const available = capability ?? loaded;
  const c = workspaceWelcomeCopy[language]; const review = reviewWorkspaceCopy[language];
  const imageAvailable = available?.images?.enabled && available.images.models.length > 0;
  const card = (key: Starter, title?: string, hint?: string) => {
    const item = c.starter.cards[key]; const Icon = icons[key];
    return <button key={key} type="button" className={`welcome-card welcome-${key}`} aria-label={title?.replaceAll("\n", " ") ?? item.label} aria-describedby={`${descriptionId}-${key}`} onClick={() => onSeed(item.seed, key)}>
      <Icon size={18} strokeWidth={1.7} aria-hidden="true" /><span><strong>{title ?? item.label}</strong>{hint && <small>{hint}</small>}</span>
      <span id={`${descriptionId}-${key}`} hidden>{item.outcome}</span>
    </button>;
  };
  return <div className={`workspace-welcome ${product}-welcome`}><div className="workspace-welcome-content">
    {product === "review" && <span className="welcome-product-label">{review.newReview}</span>}
    <h1>{product === "review" ? review.welcome : c.greeting.replace(". ", ".\n")}</h1>
    {product === "review" && <p className="welcome-intro">{review.intro}</p>}
    <p className="welcome-seed-hint">{c.starter.hint}</p>
    {product === "chat" ? <div className="welcome-card-grid">
      {(available?.maxModels ?? 0) >= 3 && card("compareAnswers")}
      {card("documentQuestions")}{card("sourcedAnswer")}{card("debugStackTrace")}{card("spreadsheetFromAnswer")}
      {imageAvailable && card("compareImageModels")}
    </div> : <>
      <div className="review-welcome-cards">{card("documentQuestions", review.documents, review.documentHint)}{imageAvailable && card("compareImageModels", review.images, review.imageHint)}{card("sourcedAnswer", review.research, review.researchHint)}</div>
      <div className="welcome-extra-actions">{card("debugStackTrace", review.code)}{card("spreadsheetFromAnswer", review.files)}</div>
    </>}
  </div></div>;
}
