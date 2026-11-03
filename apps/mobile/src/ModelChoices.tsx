import { Blocks, Check, Search } from "lucide-react";
import type { ReactNode } from "react";
import type { MobileLanguage } from "../../../locales/mobile";
import { mobileWorkspaceCopy } from "../../../locales/mobileWorkspace";
import { mobileSelectionCopy } from "../../../locales/mobileSelection";
import type { MobileModel } from "./chatTransport";
import openai from "../../../public/model-icons/chatgpt.png";
import anthropic from "../../../public/model-icons/claude.png";
import google from "../../../public/model-icons/gemini.png";
import deepseek from "../../../public/model-icons/deepseek.png";
import xai from "../../../public/model-icons/grok.png";
import moonshot from "../../../public/model-icons/kimi.png";
import mistral from "../../../public/model-icons/mistral.png";
import qwen from "../../../public/model-icons/qwen.png";
import zhipu from "../../../public/model-icons/zhipu.png";
import perplexity from "../../../public/model-icons/perplexity.png";
import groq from "../../../public/model-icons/llama.png";
import "./modelSelection.css";

const providerBrands: Record<string, { name: string; image: string }> = {
  openai: { name: "OpenAI", image: openai }, anthropic: { name: "Anthropic", image: anthropic }, google: { name: "Google", image: google },
  deepseek: { name: "DeepSeek", image: deepseek }, xai: { name: "xAI", image: xai }, moonshot: { name: "Moonshot", image: moonshot },
  mistral: { name: "Mistral", image: mistral }, qwen: { name: "Qwen", image: qwen }, zhipu: { name: "Zhipu", image: zhipu },
  perplexity: { name: "Perplexity", image: perplexity }, groq: { name: "Groq", image: groq },
};
export const providerName = (provider: string) => providerBrands[provider.toLowerCase()]?.name ?? provider;
export function ProviderMark({ provider }: { provider: string }) {
  const brand = providerBrands[provider.toLowerCase()];
  return <span className="provider-mark" aria-hidden="true">
    {/* Native Vite assets use the existing bundled provider logos. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {brand ? <img src={brand.image} alt="" /> : <Blocks size={22} />}
  </span>;
}

export function SelectionOption({ label, hint, leading, checked, disabled, multiple = true, onChange }: {
  label: string; hint?: string; leading?: ReactNode; checked: boolean; disabled?: boolean; multiple?: boolean; onChange: (checked: boolean) => void;
}) {
  return <label className="selection-option" data-selected={checked}>
    {leading}<span className="selection-option-copy"><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
    <input type={multiple ? "checkbox" : "radio"} name={multiple ? undefined : "model"} aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
    <span className={multiple ? "selection-check" : "selection-radio"} aria-hidden="true">{multiple && checked && <Check size={16} strokeWidth={2.5} />}</span>
  </label>;
}

export function ModelFilters({ models, language, query, provider, onQuery, onProvider }: {
  models: MobileModel[]; language: MobileLanguage; query: string; provider: string; onQuery: (value: string) => void; onProvider: (value: string) => void;
}) {
  const c = mobileWorkspaceCopy[language]; const copy = mobileSelectionCopy(language);
  return <div className="selection-filters">
    <label className="selection-search"><Search size={20} aria-hidden="true" /><input type="search" aria-label={c.search} placeholder={c.search} value={query} onChange={event => onQuery(event.target.value)} /></label>
    <div className="provider-filters" role="group" aria-label={c.provider}>
      {["", ...new Set(models.map(model => model.provider))].map(value => <button type="button" key={value} aria-pressed={provider === value} onClick={() => onProvider(value)}>{value ? providerName(value) : copy.all}</button>)}
    </div>
  </div>;
}

export function ModelChoices({ models, language, query, provider, selected, multiple = false, disabled, onChange }: {
  models: MobileModel[]; language: MobileLanguage; query: string; provider: string; selected: string[]; multiple?: boolean;
  disabled: (model: MobileModel) => boolean; onChange: (id: string, checked: boolean) => void;
}) {
  const visible = models.filter(model => (!provider || model.provider === provider) && `${model.name} ${model.provider} ${providerName(model.provider)}`.toLowerCase().includes(query.toLowerCase()));
  const providers = [...new Set(visible.map(model => model.provider))];
  return <div className="selection-models" role={multiple ? "group" : "radiogroup"} aria-label={mobileWorkspaceCopy[language].manual}>
    {providers.map(value => <section className="selection-provider-group" key={value}>
      <h3><ProviderMark provider={value} />{providerName(value)}</h3>
      {visible.filter(model => model.provider === value).map(model => <SelectionOption key={model.id} label={model.name} hint={model.minimumPlan} checked={selected.includes(model.id)} multiple={multiple} disabled={disabled(model)} onChange={checked => onChange(model.id, checked)} />)}
    </section>)}
    {!visible.length && <p className="selection-empty" role="status">{mobileSelectionCopy(language).empty}</p>}
  </div>;
}

export function SelectionFooter({ count, names, language, action, disabled, onClick }: {
  count: number; names: string; language: MobileLanguage; action: string; disabled?: boolean; onClick: () => void;
}) {
  return <footer className="selection-footer"><div className="selection-summary" aria-live="polite"><strong>{mobileSelectionCopy(language).count.replace("{count}", String(count))}</strong><small>{names}</small></div><button type="button" className="selection-apply" disabled={disabled} onClick={onClick}>{action}</button></footer>;
}
