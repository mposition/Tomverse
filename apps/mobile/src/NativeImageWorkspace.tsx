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
  const pendingKey = `tomverse-image-pending:${owner}`;
  type ImageRequest = Parameters<NonNullable<ChatTransport["generateImages"]>>[0];
  const readPending = (): ImageRequest | null => { try { const value = JSON.parse(localStorage.getItem(pendingKey) ?? "null"); return value && typeof value.prompt === "string" && Array.isArray(value.modelIds) && /^[A-Za-z0-9_-]{8,64}$/.test(value.idempotencyKey) ? value : null; } catch { return null; } };
  const [pending, setPending] = useState(readPending);
  const c = mobileReviewCopy(language); const copy = mobileCopy[language];
  const [cap, setCap] = useState<MobileCapabilities | null>(null); const [prompt, setPrompt] = useState(pending?.prompt ?? initial?.prompt ?? "");
  const [selected, setSelected] = useState<string[]>(pending?.modelIds ?? initial?.modelIds ?? []);
  const [quality, setQuality] = useState<string>(pending?.quality ?? IMAGE_QUALITY_BY_PRESET[initial?.preset ?? "standard"]); const [size, setSize] = useState(pending?.size ?? "1024x1024");
  const [consent, setConsent] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [conversationId, setConversationId] = useState(pending ? pending.conversationId : historyId); const [groups, setGroups] = useState<string[]>([]);
  const [unknown, setUnknown] = useState(Boolean(pending));
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => { let active = true;
    void transport.mobileCapabilities?.(true).then(value => { if (active) { setCap(value); if (!initial && !pending) setSelected(value.images?.models.slice(0, 1).map(model => model.id) ?? []); } }).catch(() => { if (active) setError(c.unavailable); });
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
  function accept(receipt: { conversationId: string; groupId: string }) {
    setConversationId(receipt.conversationId); setGroups(previous => [...new Set([...previous, receipt.groupId])]); onCreated(receipt.conversationId); localStorage.removeItem(pendingKey); setPending(null); setUnknown(false); setConsent(false); setError("");
  }
  async function recover() {
    if (!pending || !transport.imageRequest || busy) return;
    setBusy(true);
    try { accept(await transport.imageRequest(pending.idempotencyKey)); }
    catch { setError(c.pendingImages); } finally { setBusy(false); }
  }
  async function generate(resume = false) {
    if (!valid || !consent || busy || (unknown && !resume) || !prompt.trim() || !transport.generateImages) return;
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
      const input: ImageRequest = { prompt: prompt.trim(), size, quality, idempotencyKey: resume && pending ? pending.idempotencyKey : crypto.randomUUID(), modelIds: selected, expectedPricingVersions: Object.fromEntries(quote.map(item => [item.model!.id, item.model!.pricingVersion])), ...((resume && pending ? pending.conversationId : conversationId) ? { conversationId: resume && pending ? pending.conversationId : conversationId } : {}) };
      localStorage.setItem(pendingKey, JSON.stringify(input)); setPending(input); setUnknown(true);
      accept(await transport.generateImages(input));
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status && status >= 400 && status < 500 && status !== 408) {
        // A replay can be refused before the server reads an already-created group.
        if (!resume) { localStorage.removeItem(pendingKey); setPending(null); setUnknown(false); }
        setConsent(false); setError(status === 409 ? c.quoteChanged : c.failed); if (status === 409) setCap(await transport.mobileCapabilities!(true).catch(() => cap));
      }
      else setError(c.pendingImages);
    } finally { setBusy(false); }
  }
  return <Sheet title={c.images} closeLabel={copy.close} onClose={() => { if (!busy) onClose(); }}><div className="native-image-workspace">
    <p>{c.imageHint}</p>{initial?.unsupported && <p className="notice">{c.unsupported}</p>}{error && <p role="alert" className="notice error">{error}</p>}
    {!cap?.images?.enabled && <p role="status">{c.unavailable}</p>}
    <label>{c.prompt}<textarea maxLength={8000} value={prompt} disabled={busy || unknown} onChange={event => { setPrompt(event.target.value); setConsent(false); }} /></label>
    <div className="review-model-options">{models.map(model => <label key={model.id}>{model.name}<input type="checkbox" checked={selected.includes(model.id)} disabled={busy || unknown || Boolean(initial) || (!selected.includes(model.id) && selected.length >= (cap?.images?.maxModels ?? 1))} onChange={event => { setSelected(previous => event.target.checked ? [...previous, model.id] : previous.filter(id => id !== model.id)); setConsent(false); }} /></label>)}</div>
    <label>{c.quality}<select value={quality} disabled={busy || unknown} onChange={event => { setQuality(event.target.value); setConsent(false); }}>{["low", "medium", "high"].map(value => <option key={value}>{value}</option>)}</select></label>
    <label>{c.size}<select value={size} disabled={busy || unknown} onChange={event => { setSize(event.target.value); setConsent(false); }}>{["1024x1024", "1536x1024", "1024x1536"].map(value => <option key={value}>{value}</option>)}</select></label>
    <ul>{quote.map((item, index) => <li key={selected[index]}>{item.model?.name ?? selected[index]} · {item.price?.credits ?? "—"} {c.credits}</li>)}</ul>
    <strong>{quote.reduce((total, item) => total + (item.price?.credits ?? 0), 0)} {c.credits}</strong>
    <label className="switch-field">{c.imageConsent}<input type="checkbox" disabled={busy || !valid} checked={consent} onChange={event => setConsent(event.target.checked)} /></label>
    <button className="primary" disabled={busy || unknown || !valid || !consent || !prompt.trim()} onClick={() => void generate()}>{busy ? copy.loading : c.generate}</button>
    {unknown && <div className="notice"><p role="status">{c.pendingImages}</p><button disabled={busy} onClick={() => void recover()}>{c.refresh}</button><p>{c.resumeHint}</p><button disabled={busy || !valid || !consent} onClick={() => void generate(true)}>{c.resumeImages}</button></div>}
    {conversationId && <button disabled={busy} onClick={() => void history(conversationId).catch(() => setError(c.failed))}>{c.refresh}</button>}
    {groups.map(id => <ImageTurn key={id} groupId={id} transport={transport} language={language} />)}
  </div></Sheet>;
}
