import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Download, Plus } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { desktopImagesCopy } from "../../../../locales/desktopImages";
import type { ChatHistoryRow, ReviewImageOffer } from "../chat-contract";
import type { ImageCapability, ImageGeneration, ImageRequest } from "../images-contract";

const activeImage = (image: ImageGeneration) => ["pending", "processing", "settling"].includes(image.status);
const sizeLabels = { "1024x1024": "square", "1536x1024": "landscape", "1024x1536": "portrait" } as const;
const qualityLabels = { low: "draft", medium: "standard", high: "final" } as const;
type ImageNotice = "historyFailed" | "loadFailed" | "unconfirmed" | "priceChanged";
type ResultNotice = "previewFailed" | "saved" | "saveFailed";

export function useImageWorkspace(active: boolean, language: Language) {
  const [rows, setRows] = useState<ChatHistoryRow[]>([]);
  const [selected, setSelected] = useState<string>();
  const [images, setImages] = useState<ImageGeneration[]>([]);
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState<ImageNotice | null>(null);
  const [sending, setSending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [offer, setOffer] = useState<ReviewImageOffer>();
  const [seed, setSeed] = useState<ReviewImageOffer>();
  const [seedVersion, setSeedVersion] = useState(0);
  const operation = useRef(0);
  const lastRequest = useRef<{ signature: string; id: string } | null>(null);
  const groups = useMemo(() => [...new Set(images.filter(activeImage).map((image) => image.groupId))], [images]);

  useEffect(() => window.desktop.subscribe((snapshot) => {
    if (snapshot.account.stage === "connected") return;
    operation.current++;
    lastRequest.current = null;
    setRows([]);
    setSelected(undefined);
    setImages([]);
    setPrompt("");
    setNotice(null);
    setSending(false);
    setOffer(undefined);
    setSeed(undefined);
  }), []);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void window.desktop.imageConversations().then((history) => {
      if (current) setRows(history);
    }, () => { if (current) setNotice("historyFailed"); });
    return () => { current = false; };
  }, [active, refresh]);
  useEffect(() => {
    if (!active || !groups.length) return;
    let current = true;
    const timer = setTimeout(async () => {
      const results = await Promise.allSettled(groups.map((id) => window.desktop.imageGroup(id)));
      if (!current) return;
      setImages((before) => {
        const next = new Map(before.map((image) => [image.generationId, image]));
        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          for (const image of result.value.generations) next.set(image.generationId, image);
        }
        return [...next.values()];
      });
    }, 5000);
    return () => { current = false; clearTimeout(timer); };
  }, [active, groups]);

  async function open(id?: string) {
    if (sending) return;
    const request = ++operation.current;
    lastRequest.current = null;
    setSelected(id);
    setImages([]);
    setNotice(null);
    setPrompt("");
    setOffer(undefined);
    setSeed(undefined);
    setSeedVersion((version) => version + 1);
    if (!id) return;
    try {
      const result = await window.desktop.imageHistory(id);
      if (operation.current === request) setImages(result.generations);
    } catch {
      if (operation.current === request) setNotice("loadFailed");
    }
  }

  async function generate(selection: Omit<ImageRequest, "prompt" | "idempotencyKey" | "conversationId">) {
    if (sending || !prompt.trim()) return;
    const request = ++operation.current;
    const { pricing, ...options } = selection;
    const payload = { ...options, prompt, conversationId: selected };
    // A new quote for the same image must keep its key to reconcile an earlier request.
    const signature = JSON.stringify(payload);
    const idempotencyKey = lastRequest.current?.signature === signature ? lastRequest.current.id : crypto.randomUUID();
    lastRequest.current = { signature, id: idempotencyKey };
    setSending(true);
    setNotice(null);
    try {
      const result = await window.desktop.generateImages({ ...payload, pricing, idempotencyKey });
      if (operation.current !== request) return;
      if (result.status === "price-changed") {
        setNotice("priceChanged");
        return;
      }
      const { receipt } = result;
      setSelected(receipt.conversationId);
      lastRequest.current = null;
      setPrompt("");
      setRefresh((value) => value + 1);
      const history = await window.desktop.imageHistory(receipt.conversationId);
      if (operation.current === request) setImages(history.generations);
    } catch {
      if (operation.current === request) {
        setNotice("unconfirmed");
        setRefresh((value) => value + 1);
      }
    } finally {
      if (operation.current === request) setSending(false);
    }
  }

  function applyImageOffer(reference: ReviewImageOffer) {
    if (sending) return;
    operation.current++;
    lastRequest.current = null;
    setSelected(undefined);
    setImages([]);
    setNotice(null);
    setOffer(undefined);
    setPrompt(reference.prompt);
    setSeed(reference);
    setSeedVersion((version) => version + 1);
  }

  return { rows, selected, images, prompt, setPrompt, language, notice: notice ? desktopImagesCopy[language][notice] : "", sending,
    open, generate, offer, seed, seedVersion,
    offerImages: (reference: ReviewImageOffer) => prompt.trim() ? setOffer(reference) : applyImageOffer(reference),
    applyImageOffer, dismissOffer: () => setOffer(undefined) };
}

type Workspace = ReturnType<typeof useImageWorkspace>;

export function ImageHistoryList({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const copy = desktopImagesCopy[workspace.language];
  return <>
    <button className="soft" type="button" disabled={workspace.sending} onClick={() => void workspace.open()}>
      <Plus size={15}/> {copy.comparison}
    </button>
    <div className="projects chat-history">
      <ul>{workspace.rows.map((row) => <li key={row.id}>
        <button type="button" aria-current={workspace.selected === row.id ? "page" : undefined} disabled={workspace.sending}
          onClick={() => void workspace.open(row.id)}><span>{row.title}</span></button>
      </li>)}</ul>
    </div>
    <button className="soft" type="button" onClick={onClose}>{copy.back}</button>
  </>;
}

function ImageResult({ image, name, language }: { image: ImageGeneration; name: string; language: Language }) {
  const copy = desktopImagesCopy[language];
  const card = useRef<HTMLLIElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [notice, setNotice] = useState<ResultNotice | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!card.current || visible) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "160px" });
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (image.status !== "succeeded" || !visible) return;
    let alive = true;
    let objectUrl: string | undefined;
    void window.desktop.previewImage(image.generationId).then(({ mimeType, bytes }) => {
      if (!alive) return;
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
      setPreview(objectUrl);
    }, () => { if (alive) setNotice("previewFailed"); });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image.generationId, image.status, visible]);
  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      if (await window.desktop.saveImage({ id: image.generationId, modelId: image.modelId })) setNotice("saved");
    } catch {
      setNotice("saveFailed");
    } finally {
      setSaving(false);
    }
  }
  return <li className="review-answer image-result" ref={card}>
    <h3>{name}</h3>
    {preview && <img src={preview} alt={image.prompt}/>}
    {activeImage(image) && <p role="status">{copy.generating}</p>}
    {image.status === "failed" && <p>{image.refunded ? copy.refunded : copy.failed}</p>}
    {image.status === "succeeded" && <button className="soft" type="button" disabled={saving} onClick={() => void save()}>
      <Download size={15}/> {copy.save}
    </button>}
    {notice && <p className="notice" role="status">{copy[notice]}</p>}
  </li>;
}

export function ImageWorkspace({ workspace, capability }: { workspace: Workspace; capability: ImageCapability | null }) {
  const { language } = workspace;
  const copy = desktopImagesCopy[language];
  const [size, setSize] = useState<ImageRequest["size"]>("1024x1024");
  const [quality, setQuality] = useState<ImageRequest["quality"]>(workspace.seed?.quality ?? "medium");
  const [selected, setSelected] = useState<string[]>(() => {
    const offered = [...new Set(workspace.seed?.models ?? [])];
    return offered.filter((id) => capability?.models.some((model) => model.id === id &&
      model.prices.some((price) => price.size === size && price.quality === quality))).slice(0, capability?.maxModels ?? 0);
  });
  const available = (capability?.models ?? []).map((model) => ({
    ...model, price: model.prices.find((price) => price.size === size && price.quality === quality)?.credits,
  }));
  const picked = available.filter((model) => selected.includes(model.id));
  const quoted = !!picked.length && picked.length <= (capability?.maxModels ?? 0) &&
    picked.every((model) => model.price !== undefined);
  const credits = picked.reduce((sum, model) => sum + (model.price ?? 0), 0);
  const groups = new Map<string, Map<string, ImageGeneration>>();
  for (const image of workspace.images) {
    const group = groups.get(image.groupId) ?? new Map();
    const old = group.get(image.targetId);
    if (!old || old.attemptNumber < image.attemptNumber) group.set(image.targetId, image);
    groups.set(image.groupId, group);
  }
  return <>
    <div className="scroll">
      <div className="content review-content">
        {workspace.offer && <section className="review-reference" aria-label={copy.replace}>
          <p>{copy.replacePrompt}</p>
          <button type="button" className="primary" onClick={() => workspace.applyImageOffer(workspace.offer!)}>{copy.use}</button>
          <button type="button" className="soft" onClick={workspace.dismissOffer}>{copy.keep}</button>
        </section>}
        {workspace.notice && <p className="notice" role="status">{workspace.notice}</p>}
        {!workspace.images.length && <section className="welcome chat-welcome">
          <h2>{copy.welcome}</h2>
          <p>{copy.describe}</p>
        </section>}
        {[...groups].map(([groupId, images]) => <section className="review-turn" key={groupId}>
          <h2>{images.values().next().value?.prompt}</h2>
          <ul className="review-answers" aria-label={copy.results}>
            {[...images.values()].map((image) => <ImageResult key={image.generationId} image={image} language={language}
              name={available.find(({ id }) => id === image.modelId)?.name ?? image.modelId} />)}
          </ul>
        </section>)}
      </div>
    </div>
    {capability && <div className="composer-slot chat-composer-slot">
      <form className="composer chat-composer" aria-label={copy.composer} onSubmit={(event) => {
        event.preventDefault();
        if (!quoted) return;
        void workspace.generate({ size, quality, models: picked.map(({ id }) => id),
          pricing: Object.fromEntries(picked.map(({ id, pricingVersion }) => [id, pricingVersion])) });
      }}>
        <textarea aria-label={copy.description} placeholder={copy.placeholder} value={workspace.prompt}
          disabled={workspace.sending} maxLength={8000} onChange={(event) => workspace.setPrompt(event.currentTarget.value)} />
        <div className="composer-actions">
          <label>{copy.ratio} <select aria-label={copy.ratio} value={size} disabled={workspace.sending}
            onChange={(event) => setSize(event.currentTarget.value as ImageRequest["size"])}>
            {Object.entries(sizeLabels).map(([value, label]) => <option key={value} value={value}>{copy[label]}</option>)}
          </select></label>
          <label>{copy.quality} <select aria-label={copy.quality} value={quality} disabled={workspace.sending}
            onChange={(event) => setQuality(event.currentTarget.value as ImageRequest["quality"])}>
            {Object.entries(qualityLabels).map(([value, label]) => <option key={value} value={value}>{copy[label]}</option>)}
          </select></label>
          <details className="model-menu">
            <summary aria-label={copy.picker}>{copy.models}{picked.length ? ` · ${copy.selected.replace("{count}", picked.length.toLocaleString(language))}` : ""}</summary>
            <div className="model-popover review-picker">
              <fieldset disabled={workspace.sending}><legend>{copy.models}</legend>
                {available.map((model) => <label key={model.id}>
                  <input type="checkbox" checked={selected.includes(model.id)} disabled={!selected.includes(model.id) &&
                    (model.price === undefined || picked.length >= capability.maxModels)}
                    onChange={(event) => setSelected(event.currentTarget.checked
                      ? [...selected, model.id] : selected.filter((id) => id !== model.id))} />
                  {model.name}{model.price !== undefined && ` · ${copy.credits.replace("{credits}", model.price.toLocaleString(language))}`}
                </label>)}
              </fieldset>
            </div>
          </details>
          <span className="spacer" />
          <button className="primary" type="submit" disabled={!workspace.prompt.trim() || !quoted || workspace.sending}>
            <ArrowUp size={16}/> {quoted ? copy.quotedGenerate.replace("{credits}", credits.toLocaleString(language)) : copy.generate}
          </button>
        </div>
      </form>
    </div>}
  </>;
}
