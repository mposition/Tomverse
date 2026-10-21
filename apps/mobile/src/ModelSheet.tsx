import { useEffect, useState } from "react";
import type { MobileLanguage } from "../../../locales/mobile";
import { mobileCopy } from "../../../locales/mobile";
import { mobileWorkspaceCopy } from "../../../locales/mobileWorkspace";
import type { ChatTransport, Conversation, MobileModel } from "./chatTransport";
import { Sheet } from "./Sheet";
import { mobileErrorText } from "../../../locales/mobileErrors";

export function ModelSheet({ transport, conversation, language, onClose, onApply }: {
  transport: ChatTransport; conversation: Conversation | null; language: MobileLanguage;
  onClose: () => void; onApply: (modelId: string, auto: boolean) => Promise<void>;
}) {
  const c = mobileWorkspaceCopy[language];
  const [models, setModels] = useState<MobileModel[]>([]);
  const [offered, setOffered] = useState(conversation?.autoSelection?.offered === true);
  const [selected, setSelected] = useState(conversation?.selectedModels[0] ?? "");
  const [auto, setAuto] = useState(conversation?.selectionMode === "auto");
  const [query, setQuery] = useState(""); const [provider, setProvider] = useState("");
  const [loading, setLoading] = useState(true); const [pending, setPending] = useState(false); const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([transport.models(), conversation ? Promise.resolve({ offered: conversation.autoSelection?.offered === true }) : transport.capabilities()])
      .then(([catalogue, capability]) => { if (active) { setModels(catalogue); setOffered(capability.offered); } })
      .catch(() => { if (active) setError(mobileCopy[language].error); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [transport, conversation, language]);
  return <Sheet title={c.model} closeLabel={mobileCopy[language].close} onClose={() => { if (!pending) onClose(); }}>
    {offered && <label className="adaptive-option"><span><strong>Smart Adaptive</strong><small>{c.automatic}</small></span><input type="checkbox" role="switch" checked={auto} disabled={pending} onChange={(e) => setAuto(e.target.checked)} /></label>}
    <div className="model-search"><input type="search" aria-label={c.search} placeholder={c.search} value={query} onChange={(e) => setQuery(e.target.value)} /><label>{c.provider}<select value={provider} onChange={(e) => setProvider(e.target.value)}><option value="">{c.all}</option>{[...new Set(models.map((m) => m.provider))].map((name) => <option value={name} key={name}>{name}</option>)}</select></label></div>
    {error && <p role="alert" className="notice error">{error}</p>}
    {loading && <p role="status">{c.loading}</p>}
    <div className="model-options" role="radiogroup" aria-label={c.manual}>
      {models.filter((model) => (!provider || model.provider === provider) && `${model.name} ${model.provider}`.toLowerCase().includes(query.toLowerCase())).map((model) => <label key={model.id} className="model-option" data-selected={selected === model.id}><span><strong>{model.name}</strong><small>{model.provider} · {model.minimumPlan}</small></span><input type="radio" name="model" value={model.id} checked={selected === model.id} disabled={pending || auto} onChange={() => setSelected(model.id)} /></label>)}
    </div>
    <footer className="sheet-footer"><button className="primary" disabled={pending || (!selected && !auto)} onClick={() => {
      setPending(true); setError("");
      void onApply(selected, auto).catch((error) => { setError(mobileErrorText(error, language, mobileCopy[language].error)); setPending(false); });
    }}>{pending ? mobileCopy[language].loading : c.apply}</button></footer>
  </Sheet>;
}
