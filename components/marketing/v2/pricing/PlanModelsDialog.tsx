"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { canUseModelWithPlan, getModelUsageCredits, type AiModel, type ModelTier } from "@/lib/models";
import { getModelBrand } from "@/lib/modelBranding";
import type { PricingPageCopy } from "./pricingPageContent";

// Provider names are brand names, so they are not part of the translated copy.
const PROVIDER_NAME: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  xai: "xAI",
  deepseek: "DeepSeek",
  perplexity: "Perplexity",
  mistral: "Mistral",
  qwen: "Qwen",
  moonshot: "Moonshot AI",
  zhipu: "Zhipu AI",
  minimax: "MiniMax",
  cohere: "Cohere",
  groq: "Groq",
};

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));

function ModelGroups({ models, locked }: { models: readonly AiModel[]; locked: boolean }) {
  const groups = new Map<string, AiModel[]>();
  for (const model of models) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
  return <>{[...groups].map(([provider, list]) => {
    const icon = getModelBrand(provider).image;
    return <div key={provider} className="pd-group" data-provider={provider}>
      <h3>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {icon ? <img src={icon} alt="" /> : null}{PROVIDER_NAME[provider] ?? provider}
      </h3>
      <ul className="pd-list">
        {list.map((model) => <li key={model.id} className={`pd-item${locked ? " locked" : ""}`} data-model-id={model.id}>
          {model.name}<b>{getModelUsageCredits(model)}</b>
        </li>)}
      </ul>
    </div>;
  })}</>;
}

/**
 * The models one plan can use, in a modal `<dialog>`: the browser moves focus into it,
 * traps it, closes it on Escape and puts focus back on the button that opened it.
 */
export function PlanModelsDialog({ plan, planIndex, copy, models, dailyLabel, catalogHref, onClose }: {
  plan: ModelTier;
  planIndex: 0 | 1 | 2;
  copy: PricingPageCopy["models"];
  models: readonly AiModel[];
  /** The plan's daily limit, already formatted with its unit. */
  dailyLabel: string;
  catalogHref: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // No cleanup that closes it: the element leaves the page with the component, and a close
    // here would fire the dialog's own close event and ask the parent to drop it a second time
    // (React's development double run of effects did exactly that).
    if (!dialog.open) dialog.showModal();
  }, []);
  const usable = models.filter((model) => canUseModelWithPlan(plan, model));
  const locked = models.filter((model) => !canUseModelWithPlan(plan, model));
  const values = { plan, n: usable.length, total: models.length, daily: dailyLabel };
  return <dialog ref={ref} id="plan-dialog" data-testid="pricing-models-dialog" aria-labelledby="pd-title"
    onClose={onClose}
    onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
    <div className="pd-head">
      <div>
        <span className="eyebrow">{plan}</span>
        <h2 id="pd-title">{fill(copy.title, values)}</h2>
        <p className="muted">{fill(copy.sub, values)}</p>
      </div>
      <button type="button" className="pd-close" aria-label={copy.close} onClick={() => ref.current?.close()}>✕</button>
    </div>
    <div className="pd-body">
      <ModelGroups models={usable} locked={false} />
      {locked.length > 0 ? <>
        <p className="pd-divider">{fill(copy.locked, { n: locked.length })}</p>
        <ModelGroups models={locked} locked />
      </> : null}
    </div>
    <p className="note pd-note">{fill(copy.notes[planIndex], values)}</p>
    <p className="pd-link"><Link href={catalogHref}>{copy.catalogLink} <span aria-hidden="true">↗</span></Link></p>
  </dialog>;
}
