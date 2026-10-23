import { useEffect, useState } from "react";
import { IMAGE_QUALITY_BY_PRESET, type ImagePreset } from "../../../lib/imageGenerationPricing";
import { mobileReviewCopy } from "../../../locales/mobileReview";
import { mobileCopy, type MobileLanguage } from "../../../locales/mobile";
import type { ChatTransport, MobileCapabilities } from "./chatTransport";
import { ImageTurn } from "./ImageTurn";
import { Sheet } from "./Sheet";

export function NativeImageWorkspace({ transport, language, owner, initial, historyId, onClose, onBusy, onCreated }: {
  transport: ChatTransport; language: MobileLanguage; owner: string | null; initial?: { prompt: string; modelIds: string[]; preset: ImagePreset; unsupported: boolean }; historyId?: string;
  onClose: () => void; onBusy: (busy: boolean) => void; onCreated: (id: string) => void;
}) {
  const c = mobileReviewCopy(language); const copy = mobileCopy[language];
  const [cap, setCap] = useState<MobileCapabilities | null>(null); const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [selected, setSelected] = useState<string[]>(initial?.modelIds ?? []);
  const [quality, setQuality] = useState<string>(IMAGE_QUALITY_BY_PRESET[initial?.preset ?? "standard"]); const [size, setSize] = useState("1024x1024");
  const [consent, setConsent] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [conversationId, setConversationId] = useState(historyId); const [groups, setGroups] = useState<string[]>([]);
  const pendingKey = `tomverse-image-pending:${owner}`;
  const [unknown, setUnknown] = useState(localStorage.getItem(pendingKey) === "pending");
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => { let active = true;
    void transport.mobileCapabilities?.(true).then(value => { if (active) { setCap(value); if (!initial) setSelected(value.images?.models.slice(0, 1).map(model => model.id) ?? []); } }).catch(() => { if (active) setError(c.unavailable); });
    return () => { active = false; };
  }, [transport]); // eslint-disable-line react-hooks/exhaustive-deps
  async function history(id: string) {
    if (!transport.imageHistory) return;
    const value = await transport.imageHistory(id); setGroups([...new Set(value.generations.map(row => row.groupId).filter(Boolean))]);
  }
  useEffect(() => { if (historyId) void Promise.resolve().then(() => history(historyId)).catch(() => setError(c.failed)); }, [historyId]); // eslint-disable-line react-hooks/exhaustive-deps
  const models = cap?.images?.models ?? [];
  const quote = selected.map(id => { const model = models.find(row => row.id === id); return { model, price: model?.prices.find(price => price.quality === quality && price.size === size) }; });
  const valid = Boolean(cap?.images?.enabled && selected.length && selected.length <= (cap.images.maxModels ?? 1) && quote.every(item => item.model?.pricingVersion && item.price && item.price.credits >= 0));
  async function generate() {
    if (!valid || !consent || busy || unknown || !prompt.trim() || !transport.generateImages) return;
    setBusy(true); setError("");
    try {
      // Read the existing catalogue again immediately before dispatch; a new quote needs a new consent.
      const fresh = await transport.mobileCapabilities!(true);
      const changed = !fresh.images?.enabled || selected.length > fresh.images.maxModels || quote.some(item => {
        const model = fresh.images?.models.find(row => row.id === item.model?.id);
        const price = model?.prices.find(row => row.quality === quality && row.size === size);
        return model?.pricingVersion !== item.model?.pricingVersion || price?.credits !== item.price?.credits;
      });
      if (changed) { setCap(fresh); setConsent(false); setError(c.quoteChanged); return; }
      localStorage.setItem(pendingKey, "pending"); setUnknown(true);
      const receipt = await transport.generateImages({ prompt: prompt.trim(), size, quality, idempotencyKey: crypto.randomUUID(), modelIds: selected, expectedPricingVersions: Object.fromEntries(quote.map(item => [item.model!.id, item.model!.pricingVersion])), ...(conversationId ? { conversationId } : {}) });
      setConversationId(receipt.conversationId); setGroups(previous => [...previous, receipt.groupId]); onCreated(receipt.conversationId); localStorage.removeItem(pendingKey); setUnknown(false); setConsent(false);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status && status >= 400 && status < 500 && status !== 408) { localStorage.removeItem(pendingKey); setUnknown(false); setConsent(false); setError(status === 409 ? c.quoteChanged : c.failed); if (status === 409) setCap(await transport.mobileCapabilities!(true).catch(() => cap)); }
      else setError(c.pendingImages);
    } finally { setBusy(false); }
  }
  return <Sheet title={c.images} closeLabel={copy.close} onClose={() => { if (!busy) onClose(); }}><div className="native-image-workspace">
    <p>{c.imageHint}</p>{initial?.unsupported && <p className="notice">{c.unsupported}</p>}{error && <p role="alert" className="notice error">{error}</p>}
    {!cap?.images?.enabled && <p role="status">{c.unavailable}</p>}
    <label>{c.prompt}<textarea maxLength={8000} value={prompt} disabled={busy} onChange={event => { setPrompt(event.target.value); setConsent(false); }} /></label>
    <div className="review-model-options">{models.map(model => <label key={model.id}>{model.name}<input type="checkbox" checked={selected.includes(model.id)} disabled={busy || Boolean(initial) || (!selected.includes(model.id) && selected.length >= (cap?.images?.maxModels ?? 1))} onChange={event => { setSelected(previous => event.target.checked ? [...previous, model.id] : previous.filter(id => id !== model.id)); setConsent(false); }} /></label>)}</div>
    <label>{c.quality}<select value={quality} disabled={busy} onChange={event => { setQuality(event.target.value); setConsent(false); }}>{["low", "medium", "high"].map(value => <option key={value}>{value}</option>)}</select></label>
    <label>{c.size}<select value={size} disabled={busy} onChange={event => { setSize(event.target.value); setConsent(false); }}>{["1024x1024", "1536x1024", "1024x1536"].map(value => <option key={value}>{value}</option>)}</select></label>
    <ul>{quote.map((item, index) => <li key={selected[index]}>{item.model?.name ?? selected[index]} · {item.price?.credits ?? "—"} {c.credits}</li>)}</ul>
    <strong>{quote.reduce((total, item) => total + (item.price?.credits ?? 0), 0)} {c.credits}</strong>
    <label className="switch-field">{c.imageConsent}<input type="checkbox" disabled={busy || !valid || unknown} checked={consent} onChange={event => setConsent(event.target.checked)} /></label>
    <button className="primary" disabled={busy || unknown || !valid || !consent || !prompt.trim()} onClick={() => void generate()}>{busy ? copy.loading : c.generate}</button>
    {unknown && <p role="status">{c.pendingImages}</p>}
    {conversationId && <button disabled={busy} onClick={() => void history(conversationId).catch(() => setError(c.failed))}>{c.refresh}</button>}
    {groups.map(id => <ImageTurn key={id} groupId={id} transport={transport} language={language} />)}
  </div></Sheet>;
}
