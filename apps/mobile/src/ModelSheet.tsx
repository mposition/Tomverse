import { useEffect, useState } from "react";
import type { MobileLanguage } from "../../../locales/mobile";
import { mobileCopy } from "../../../locales/mobile";
import { mobileWorkspaceCopy } from "../../../locales/mobileWorkspace";
import type { ChatTransport, Conversation, MobileModel } from "./chatTransport";
import { Sheet } from "./Sheet";
import { mobileErrorText } from "../../../locales/mobileErrors";
import { mobileModelsCopy } from "../../../locales/mobileModels";
import { mobileSelectionCopy } from "../../../locales/mobileSelection";
import { ModelChoices, ModelFilters, SelectionFooter } from "./ModelChoices";
import { useVisibleViewportHeight } from "../../../components/chat/useVisualViewport";

export function ModelSheet({ transport, conversation, language, onClose, onApply }: {
  transport: ChatTransport; conversation: Conversation | null; language: MobileLanguage;
  onClose: () => void; onApply: (modelId: string, auto: boolean) => Promise<void>;
}) {
  const c = mobileWorkspaceCopy[language];
  const feedback = mobileModelsCopy(language);
  const selectionCopy = mobileSelectionCopy(language);
  const visibleHeight = useVisibleViewportHeight();
  const [models, setModels] = useState<MobileModel[]>([]);
  const [offered, setOffered] = useState(conversation?.autoSelection?.offered === true);
  const [selected, setSelected] = useState(conversation?.selectedModels[0] ?? "");
  const [auto, setAuto] = useState(!conversation || conversation.selectionMode === "auto");
  const [query, setQuery] = useState(""); const [provider, setProvider] = useState("");
  const [loading, setLoading] = useState(true); const [pending, setPending] = useState(false); const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false); const [capabilityFailed, setCapabilityFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([transport.models(), conversation ? Promise.resolve({ offered: conversation.autoSelection?.offered === true }) : transport.capabilities()])
      .then(([catalogue, capability]) => {
        if (!active) return;
        setLoadFailed(catalogue.status === "rejected");
        setCapabilityFailed(capability.status === "rejected");
        setModels(catalogue.status === "fulfilled" ? catalogue.value : []);
        const available = capability.status === "fulfilled" && capability.value.offered;
        setOffered(available); if (!available) setAuto(false);
      }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [transport, conversation, reload]);
  return <Sheet className="selection-sheet" maxHeight={visibleHeight > 0 ? Math.min(640, visibleHeight - 16) : 640} title={c.model} closeLabel={mobileCopy[language].close} onClose={() => { if (!pending) onClose(); }}>
    <div className="selection-body"><div className="selection-controls">
      {offered && <label className="selection-adaptive"><span><strong>Smart Adaptive</strong><small>{selectionCopy.automatic}</small></span><input className="selection-switch" type="checkbox" role="switch" aria-label="Smart Adaptive" checked={auto} disabled={pending} onChange={(e) => setAuto(e.target.checked)} /></label>}
      <ModelFilters models={models} language={language} query={query} provider={provider} onQuery={setQuery} onProvider={setProvider} />
    </div>
    <div className="selection-results">
    {error && <p role="alert" className="notice error">{error}</p>}
    {loadFailed && <p role="alert" className="notice error">{feedback.loadFailed}</p>}
    {capabilityFailed && <p role="status" className="notice">{feedback.capabilityFailed}</p>}
    {(loadFailed || capabilityFailed) && <button type="button" disabled={loading || pending} onClick={() => { setLoading(true); setError(""); setLoadFailed(false); setCapabilityFailed(false); setReload(value => value + 1); }}>{feedback.retry}</button>}
    {loading && <p role="status">{c.loading}</p>}
    {!loading && !loadFailed && <ModelChoices models={models} language={language} query={query} provider={provider} selected={[selected]} disabled={() => pending || auto} onChange={id => setSelected(id)} />}
    </div>
    </div>
    <SelectionFooter count={auto || selected ? 1 : 0} names={auto ? "Smart Adaptive" : models.find(model => model.id === selected)?.name ?? selectionCopy.none} language={language} action={pending ? mobileCopy[language].loading : c.apply} disabled={pending || loading || loadFailed || (auto && !offered) || (!selected && !auto)} onClick={() => {
      setPending(true); setError("");
      void onApply(selected, auto).catch((error) => { setError(mobileErrorText(error, language, mobileCopy[language].error)); setPending(false); });
    }} />
  </Sheet>;
}
