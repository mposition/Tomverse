import { useState } from "react";
import { ImagePlus } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { desktopImageOfferCopy } from "../../../../locales/desktopImageOffer";
import { imageOfferQuote } from "../image-offer";
import type { ImageCapability } from "../images-contract";
import { clearImageOffer, useImageOffer } from "./image-offer-store";
import "./answer-extras.css";

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);

/**
 * The server's own judgement said the saved question is an image request. The web starts the image at once;
 * Desktop shows the model and price first and starts it only on the click, because it charges credits.
 */
export function ChatImageOffer({ conversationId, capability, language, onStarted }: {
  conversationId?: string; capability?: ImageCapability | null; language: Language; onStarted: () => void;
}) {
  const offer = useImageOffer(conversationId);
  const copy = desktopImageOfferCopy[language];
  const [phase, setPhase] = useState<"idle" | "starting" | "failed">("idle");
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (dismissed === conversationId) return <p className="chat-effort" role="status" data-testid="desktop-image-offer-dismissed">{copy.dismissed}</p>;
  if (!offer) return null;
  const quote = imageOfferQuote(capability, offer.request);
  const blocker = offer.request.edit ? copy.editUnsupported : quote ? null : copy.priceUnavailable;

  async function create() {
    if (!offer || !quote || phase === "starting") return;
    setPhase("starting");
    try {
      const outcome = await window.desktop.chatExtras<"imageTurn">({
        action: "imageTurn", conversationId: offer.conversationId, sourceUserMessageId: offer.sourceUserMessageId,
        assistantMessageId: offer.assistantMessageId, modelId: offer.modelId, imageModelIds: offer.request.modelIds,
        preset: offer.request.preset, ...(offer.request.prompt ? { prompt: offer.request.prompt } : {}),
        ...(offer.request.routingDecisionId ? { routingDecisionId: offer.request.routingDecisionId } : {}),
      });
      if (!outcome.ok) { setPhase("failed"); return; }
      clearImageOffer();
      setPhase("idle");
      onStarted();
    } catch {
      setPhase("failed");
    }
  }
  return <section className="chat-image-offer" data-testid="desktop-image-offer" aria-label={copy.title}>
    <h4><ImagePlus size={15} aria-hidden="true" /> {copy.title}</h4>
    <p>{copy.body}</p>
    {quote && <dl>
      <div><dt>{copy.model}</dt><dd>{quote.models.map((model) => model.name).join(", ")}</dd></div>
      <div><dt>{copy.quality}</dt><dd>{copy[offer.request.preset ?? "standard"]}</dd></div>
      <div><dt>{copy.price.replace("{credits}", "").trim()}</dt><dd>{quote.credits}</dd></div>
    </dl>}
    {blocker && <p role="status" data-testid="desktop-image-offer-blocked">{blocker}</p>}
    {phase === "failed" && <p role="alert" data-testid="desktop-image-offer-failed">{copy.failed}</p>}
    <div className="chat-image-offer-actions">
      <button type="button" disabled={!quote || phase === "starting"} data-testid="desktop-image-offer-create" onClick={() => void create()}>
        {phase === "starting" ? copy.creating : quote ? fill(copy.create, { credits: quote.credits }) : copy.create.replace(/ · .*/, "")}
      </button>
      <button type="button" className="soft" disabled={phase === "starting"} data-testid="desktop-image-offer-dismiss"
        onClick={() => { clearImageOffer(); setDismissed(offer.conversationId); }}>{copy.dismiss}</button>
    </div>
  </section>;
}
