import { useState } from "react";
import { useVisibleViewportHeight } from "../../../components/chat/useVisualViewport";
import { mobileCopy, type MobileLanguage } from "../../../locales/mobile";
import { mobileSelectionCopy } from "../../../locales/mobileSelection";
import type { MobileModel } from "./chatTransport";
import { ModelChoices, ModelFilters, ProviderMark, providerName, SelectionFooter, SelectionOption } from "./ModelChoices";
import { Sheet } from "./Sheet";

export function ReviewModelPicker({ language, mode, onMode, easyOffered, busy, models, selected, providers, providerOptions, maxModels, onModels, onProviders, onClose }: {
  language: MobileLanguage; mode: "easy" | "professional"; onMode: (mode: "easy" | "professional") => void;
  easyOffered: boolean; busy: boolean; models: MobileModel[]; selected: string[]; providers: string[]; providerOptions: string[]; maxModels: number;
  onModels: (models: string[]) => void; onProviders: (providers: string[]) => void; onClose: () => void;
}) {
  const c = mobileSelectionCopy(language); const visibleHeight = useVisibleViewportHeight();
  const [query, setQuery] = useState(""); const [provider, setProvider] = useState("");
  const count = mode === "easy" ? providers.length : selected.length;
  const names = mode === "easy" ? providers.map(providerName).join(", ") : selected.map(id => models.find(model => model.id === id)?.name ?? id).join(", ");
  return <Sheet className="selection-sheet" maxHeight={visibleHeight > 0 ? Math.min(640, visibleHeight - 16) : 640} title={c.reviewTitle} closeLabel={mobileCopy[language].close} onClose={onClose}>
    <div className="selection-body"><div className="selection-controls">
      <div className="selection-modes" role="group" aria-label="Review mode">{(["easy", "professional"] as const).map(value => <button type="button" key={value} aria-pressed={mode === value} disabled={busy || value === "easy" && !easyOffered} onClick={() => onMode(value)}>{value === "easy" ? "Easy" : "Professional"}</button>)}</div>
      <p className="selection-hint">{mode === "easy" ? c.easy : c.professional}</p>
      {mode === "professional" && <ModelFilters models={models} language={language} query={query} provider={provider} onQuery={setQuery} onProvider={setProvider} />}
    </div>
    <div className="selection-results">
      {mode === "easy" ? <div className="selection-providers">{providerOptions.map(value => <SelectionOption key={value} label={providerName(value)} hint={c.providerAuto.replace("{provider}", providerName(value))} leading={<ProviderMark provider={value} />} checked={providers.includes(value)} disabled={!providers.includes(value) && providers.length >= Math.min(3, maxModels)} onChange={checked => onProviders(checked ? [...providers, value] : providers.filter(item => item !== value))} />)}</div>
        : <ModelChoices models={models} language={language} query={query} provider={provider} selected={selected} multiple disabled={model => !selected.includes(model.id) && selected.length >= maxModels} onChange={(id, checked) => onModels(checked ? [...selected, id] : selected.filter(value => value !== id))} />}
    </div>
    </div>
    <SelectionFooter count={count} names={names} language={language} action={c.done} onClick={onClose} />
  </Sheet>;
}
