"use client";

/* eslint-disable @next/next/no-img-element -- Sticker previews use local object URLs. */
import { useEffect, useRef, useState } from "react";
import { zipSync } from "fflate";
import { Download, Plus, Shuffle, X } from "lucide-react";
import { isLanguage, SUPPORTED_LANGUAGES, type Language } from "@/lib/language";
import { fillStudioStickerCaptions, STUDIO_STICKER_KEYS, STUDIO_STICKER_LIMIT, studioObjectUrl } from "@/lib/studioTools";
import { studioStickerBrief, type StudioStickerFaceStyle as FaceStyle } from "@/lib/studioStickerPrompt";
import { studioCopy, studioStickerSuggestions } from "@/locales/studio";
import { photoSampleCaptions } from "@/locales/studio.ko";
import { makeStudioStickerReference, renderStudioSticker, saveStudioFile, splitStudioSheet, STUDIO_STICKER_BACKGROUND, type StickerComposition } from "./studioCanvas";
import { StudioFileButton, StudioStatus, useStudioCopy, useStudioTask, useStudioUrls } from "./StudioControls";
import { StudioGenerateButton, StudioQuoteHint } from "./StudioGenerationControls";
import { StudioImageShare } from "./StudioImageShare";
import { createStudioImageRunner, StudioGenerationError, useStudioImageQuote } from "./studioGenerationClient";
import { captureStudioDraftImage, useStudioCheckoutDraft, type StudioDraftImage } from "./studioCheckoutDraft";
import { isStudioCreditShortfall, StudioCreditRecovery } from "./StudioCreditRecovery";
import styles from "./studio.module.css";

type Sticker = { source: string; caption?: string; language?: Language; composed?: StickerComposition };
type PackCaption = { text: string; suggested?: boolean };
type Replacement = { index: number; caption: string; source: string | null; language?: Language; composed?: StickerComposition };
type StickerCheckoutDraft = {
  style: FaceStyle;
  photo: { source: StudioDraftImage; name?: string };
  reference: { source: StudioDraftImage; style: FaceStyle };
  stickers: Array<Omit<Sticker, "source"> & { source: StudioDraftImage }>;
  captions: string[];
  captionDraft: string;
  captionLanguage?: Language;
  suggestedCaptionIndexes?: number[];
  sample: boolean;
  replacement: (Omit<Replacement, "source"> & { source: StudioDraftImage | null }) | null;
};

const samplePhoto = "/studio/selfie.png";
const koreanPhotoSample: Sticker[] = photoSampleCaptions.map((caption, index) => ({
  source: "/studio/stickers-real-ko/" + String(index + 1).padStart(2, "0") + ".png", caption, language: "ko", composed: "opaque",
}));
const characterSample: Sticker[] = STUDIO_STICKER_KEYS.map((_, i) => ({ source: "/studio/sticker-" + (i + 1) + ".png" }));
const stickerSize = "1024x1024";
function StudioStickerPreview({ source, caption, composed, language }: Sticker & { caption: string; language: Language }) {
  const [rendered, setRendered] = useState<{ source: string; caption: string; language: Language; url: string }>();
  useEffect(() => {
    if (composed === "opaque" || !source) return;
    let cancelled = false;
    let url: string | undefined;
    void renderStudioSticker(source, caption, language, composed).then(blob => {
      if (cancelled || !blob) return;
      const created = URL.createObjectURL(blob);
      try {
        url = studioObjectUrl(created);
      } catch (error) {
        URL.revokeObjectURL(created);
        throw error;
      }
      setRendered({ source, caption, language, url });
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [source, caption, composed, language]);
  const ready = composed === "opaque" ? source
    : rendered?.source === source && rendered.caption === caption && rendered.language === language ? rendered.url : undefined;
  return ready
    ? <img src={ready} style={{ backgroundColor: STUDIO_STICKER_BACKGROUND }} alt={caption} />
    : <span>{caption}</span>;
}

export function StudioStickerTool({ billingNotice }: { billingNotice?: string }) {
  const { copy, lang } = useStudioCopy();
  const urls = useStudioUrls();
  const { busy, status, report, task } = useStudioTask();
  const dialog = useRef<HTMLDialogElement>(null);
  const pausedForCheckout = useRef(false);
  const [creditError, setCreditError] = useState<StudioGenerationError | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);
  const packController = useRef<AbortController | null>(null);
  const cutController = useRef<AbortController | null>(null);
  const [runPack] = useState(createStudioImageRunner);
  const [runCut] = useState(createStudioImageRunner);
  const committed = useRef<string | null>(null);
  const [style, setStyle] = useState<FaceStyle>(lang === "ko" ? "real" : "character");
  const [photo, setPhoto] = useState<{ source: string; name?: string }>({ source: samplePhoto });
  const [reference, setReference] = useState({ source: samplePhoto, style: "character" as FaceStyle });
  const [savedPack, setStickers] = useState<Sticker[] | null>(null);
  const [captions, setCaptions] = useState<PackCaption[]>([]);
  const [captionDraft, setCaptionDraft] = useState("");
  const [captionLanguage, setCaptionLanguage] = useState<Language>();
  const outputLanguage = captionLanguage ?? lang;
  const sampleStyle = style === "real" && outputLanguage === "ko" ? "real" : "character";
  const stickers = savedPack ?? (sampleStyle === "real" ? koreanPhotoSample : characterSample);
  const sourceStyle = savedPack ? reference.style : sampleStyle;
  const pendingCaption = captions.length < STUDIO_STICKER_LIMIT ? captionDraft.trim() : "";
  const captionEntries = [...captions, ...(pendingCaption ? [{ text: pendingCaption }] : [])];
  const words = captionEntries.map(({ text }) => text);
  const packUseCase = style === "real" ? "real-sticker-pack" : "character-sticker-pack";
  const stickerUseCase = style === "real" ? "real-sticker" : "character-sticker";
  const sheetQuote = useStudioImageQuote(stickerSize, true, words.length > 0, undefined,
    words.length > 1 ? packUseCase : stickerUseCase);
  const [sample, setSample] = useState(true);
  const [replacement, setReplacement] = useState<Replacement | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [replacementError, setReplacementError] = useState<string | null>(null);
  const singleQuote = useStudioImageQuote(stickerSize, true, Boolean(replacement), undefined,
    sourceStyle === "real" ? "real-sticker" : "character-sticker");
  const checkoutDraft = useStudioCheckoutDraft<StickerCheckoutDraft>("stickers", saved => {
    const restoreSource = (source: StudioDraftImage) => typeof source === "string" ? source : urls.make(source);
    urls.release(photo.source);
    urls.release(reference.source);
    stickers.forEach(sticker => urls.release(sticker.source));
    setStyle(saved.style);
    setPhoto({ ...saved.photo, source: restoreSource(saved.photo.source) });
    setReference({ ...saved.reference, source: restoreSource(saved.reference.source) });
    setStickers(saved.stickers.length ? saved.stickers.map(sticker => ({ ...sticker, source: restoreSource(sticker.source) })) : null);
    setCaptions(saved.captions.map((text, index) => ({ text, suggested: saved.suggestedCaptionIndexes?.includes(index) })));
    setCaptionDraft(saved.captionDraft);
    setCaptionLanguage(saved.captionLanguage);
    setSample(saved.sample);
    if (saved.replacement && saved.replacement.index < saved.stickers.length) {
      setReplacement({ ...saved.replacement, source: saved.replacement.source ? restoreSource(saved.replacement.source) : null });
    }
    report(copy.checkoutDraftRestored);
  });

  async function saveCheckoutDraft() {
    try {
      const [photoSource, referenceSource, savedStickers, replacementSource] = await Promise.all([
        captureStudioDraftImage(photo.source),
        captureStudioDraftImage(reference.source),
        Promise.all((savedPack ?? []).map(async sticker => ({ ...sticker, source: await captureStudioDraftImage(sticker.source) }))),
        replacement?.source ? captureStudioDraftImage(replacement.source) : null,
      ]);
      await checkoutDraft.save({
        style, photo: { ...photo, source: photoSource }, reference: { ...reference, source: referenceSource },
        stickers: savedStickers, captions: captions.map(({ text }) => text), captionDraft, captionLanguage, sample,
        suggestedCaptionIndexes: captions.flatMap((caption, index) => caption.suggested ? [index] : []),
        replacement: replacement ? { ...replacement, source: replacementSource } : null,
      });
      setDraftSaved(true);
    } catch {
      setDraftSaved(false);
    }
  }

  async function showCreditRecovery(error: StudioGenerationError, signal: AbortSignal) {
    await saveCheckoutDraft();
    if (signal.aborted) {
      void checkoutDraft.clear();
      return;
    }
    if (dialog.current?.open) {
      pausedForCheckout.current = true;
      dialog.current.close();
    }
    setCreditError(error);
  }

  async function closeCreditRecovery() {
    await checkoutDraft.clear();
    pausedForCheckout.current = false;
    setCreditError(null);
  }

  useEffect(() => {
    if (replacement && !creditError && !pausedForCheckout.current && !dialog.current?.open) dialog.current?.showModal();
  }, [replacement, creditError]);
  const captionFor = (sticker: Sticker, index: number) => sticker.caption ?? studioCopy[outputLanguage][STUDIO_STICKER_KEYS[index]];
  const languageFor = (sticker: Sticker) => sticker.language ?? outputLanguage;
  const readyCount = stickers.filter(sticker => sticker.source).length;
  const addCaption = () => {
    if (!pendingCaption) return;
    setCaptions(captionEntries);
    setCaptionDraft("");
  };
  const manualCaptions = captionEntries.filter(caption => !caption.suggested);
  const fillCaptions = () => {
    const defaults = STUDIO_STICKER_KEYS.map(key => studioCopy[outputLanguage][key]);
    const filled = fillStudioStickerCaptions(manualCaptions.map(({ text }) => text), [...defaults, ...studioStickerSuggestions[outputLanguage]]);
    setCaptions([...manualCaptions, ...filled.slice(manualCaptions.length).map(text => ({ text, suggested: true }))]);
    setCaptionDraft("");
  };

  useEffect(() => () => {
    packController.current?.abort();
    cutController.current?.abort();
  }, []);

  const changePhoto = (file: File) => {
    if (photo.source !== reference.source) urls.release(photo.source);
    setPhoto({ source: urls.make(file), name: file.name });
  };

  const createPack = () => void task(async () => {
    if (!sheetQuote.quote || !words.length) return;
    const controller = new AbortController();
    packController.current = controller;
    try {
      const { prompt, spellingKey } = studioStickerBrief(style, words);
      const blob = await runPack({
        inputKey: JSON.stringify([photo.source, spellingKey]),
        prompt,
        size: sheetQuote.quote.size,
        quote: sheetQuote.quote,
        reference: () => makeStudioStickerReference(photo.source, spellingKey),
        signal: controller.signal,
      });
      const sheet = URL.createObjectURL(blob);
      try {
        const pieces = await splitStudioSheet(sheet, words.length);
        controller.signal.throwIfAborted();
        const next: Sticker[] = pieces.map((piece, index) => ({
          source: piece ? urls.make(piece) : "", caption: words[index], language: outputLanguage, composed: piece ? "opaque" : undefined,
        }));
        stickers.forEach(sticker => urls.release(sticker.source));
        if (reference.source !== photo.source) urls.release(reference.source);
        setReference({ source: photo.source, style });
        setStickers(next);
        setSample(false);
        setCaptions(captionEntries);
        setCaptionDraft("");
        report(next.every(sticker => sticker.source) ? copy.packReady : copy.packNeedsRegeneration);
        void checkoutDraft.clear();
      } finally {
        URL.revokeObjectURL(sheet);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isStudioCreditShortfall(error)) {
        await showCreditRecovery(error, controller.signal);
        return;
      }
      if (error instanceof StudioGenerationError && error.status === 409) sheetQuote.reload();
      throw error;
    } finally {
      packController.current = null;
    }
  });

  const png = async (sticker: Sticker, index: number) => {
    const result = await renderStudioSticker(sticker.source, captionFor(sticker, index), languageFor(sticker), sticker.composed);
    if (!result) throw new Error("Sticker has no readable caption area");
    return result;
  };
  const filename = (index: number) => "sticker-" + String(index + 1).padStart(2, "0") + ".png";
  const savePack = () => task(async () => {
    const entries = await Promise.all(stickers.map(async (sticker, index) => [filename(index), new Uint8Array(await (await png(sticker, index)).arrayBuffer())] as const));
    const bytes = new Uint8Array(zipSync(Object.fromEntries(entries)));
    saveStudioFile(new Blob([bytes.buffer], { type: "application/zip" }), "tomverse-stickers.zip");
  });

  const openSticker = (index: number) => {
    const sticker = stickers[index];
    setReplacement({ index, caption: captionFor(sticker, index), language: languageFor(sticker), source: null });
  };
  const closeSticker = () => {
    if (pausedForCheckout.current) return;
    cutController.current?.abort();
    cutController.current = null;
    if (replacement?.source && replacement.source !== committed.current) urls.release(replacement.source);
    committed.current = null;
    setReplacement(null);
    setRegenerating(false);
    setReplacementError(null);
  };
  const createSticker = async () => {
    if (!replacement || !singleQuote.quote || cutController.current || !replacement.caption.trim()) return;
    const controller = new AbortController();
    cutController.current = controller;
    setRegenerating(true);
    setReplacementError(null);
    try {
      const language = replacement.language ?? languageFor(stickers[replacement.index]);
      const { prompt, spellingKey } = studioStickerBrief(sourceStyle, [replacement.caption]);
      const blob = await runCut({
        inputKey: JSON.stringify([reference.source, spellingKey]),
        prompt,
        size: singleQuote.quote.size,
        quote: singleQuote.quote,
        reference: () => makeStudioStickerReference(reference.source, spellingKey),
        signal: controller.signal,
      });
      const source = URL.createObjectURL(blob);
      let art: Blob | null;
      try {
        [art] = await splitStudioSheet(source, 1);
      } finally {
        URL.revokeObjectURL(source);
      }
      controller.signal.throwIfAborted();
      if (!art) { setReplacementError(copy.packNeedsRegeneration); return; }
      if (replacement.source) urls.release(replacement.source);
      setReplacement({ ...replacement, source: urls.make(art), language, composed: "opaque" });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isStudioCreditShortfall(error)) {
        await showCreditRecovery(error, controller.signal);
        return;
      }
      if (error instanceof StudioGenerationError && error.status === 409) singleQuote.reload();
      setReplacementError(copy.taskFailed);
    } finally {
      if (cutController.current === controller) {
        cutController.current = null;
        setRegenerating(false);
      }
    }
  };
  const applySticker = () => {
    if (!replacement?.source || !replacement.caption.trim()) return;
    const { index, source } = replacement;
    const caption = replacement.caption.trim();
    if (!savedPack) setReference({ source: samplePhoto, style: sourceStyle });
    urls.release(stickers[index].source);
    setStickers(stickers.map((sticker, i) => i === index ? { ...sticker, source, caption, language: replacement.language, composed: replacement.composed } : sticker));
    committed.current = source;
    setCaptions(items => items[index]?.text === stickers[index].caption
      ? items.map((item, i) => i === index ? { text: caption } : item) : items);
    setReplacement(null);
    dialog.current?.close();
    report(copy.stickerReplaced);
    void checkoutDraft.clear();
  };
  const invalid = () => report(copy.invalidImage, true);

  return <>
    <div className={styles.workbench}>
      <section className={styles.panel}>
        <h2>{copy.photoAndStyle}</h2>
        <div className={styles.fileRow}>
          <img src={photo.source} alt="" width={56} height={56} />
          <span>{photo.name ?? copy.samplePhoto}</span>
          <StudioFileButton label={copy.changePhoto} disabled={busy} onInvalid={invalid} onFile={changePhoto} />
        </div>
        <fieldset className={styles.fieldset} disabled={busy}>
          <legend>{copy.faceStyle}</legend>
          {(["real", "character"] as const).map(key => (
            <label className={styles.styleOption} key={key}>
              <img src={"/studio/" + key + ".png"} width={44} height={44} alt="" />
              <span>{key === "real" ? copy.realFace : copy.illustratedFace}</span>
              <input type="radio" name="studio-face-style" checked={style === key} onChange={() => setStyle(key)} />
            </label>
          ))}
        </fieldset>
        <div className={styles.packCaptions}>
          <div className={styles.captionLabel}>
            <label htmlFor="studio-pack-caption">{copy.packCaptions}</label>
            <span>{copy.captionLimit.replace("{count}", String(words.length))}</span>
          </div>
          <div className={styles.captionSuggestions}>
            <label className={styles.field}>{copy.captionLanguage}
              <select value={outputLanguage} disabled={busy} onChange={event => {
                if (isLanguage(event.target.value)) setCaptionLanguage(event.target.value);
              }}>
                {SUPPORTED_LANGUAGES.map(language => <option key={language} value={language} lang={language}>
                  {new Intl.DisplayNames([language], { type: "language" }).of(language)}
                </option>)}
              </select>
            </label>
            <button type="button" className={styles.secondary} disabled={busy || manualCaptions.length >= STUDIO_STICKER_LIMIT}
              onClick={fillCaptions}><Shuffle size={14} aria-hidden />{copy.randomCaptions}</button>
          </div>
          {captions.length > 0 && <ul className={styles.captionChips}>
            {captions.map(({ text }, i) => <li key={i}>
              <span>{text}</span>
              <button type="button" disabled={busy} aria-label={copy.removeCaption + " " + text}
                onClick={() => setCaptions(captions.filter((_, index) => i !== index))}><X size={13} aria-hidden /></button>
            </li>)}
          </ul>}
          <div className={styles.captionEntry}>
            <label className={styles.field}>
              <input id="studio-pack-caption" value={captionDraft} maxLength={32} placeholder={copy.stickerDefault01}
                disabled={busy || captions.length === STUDIO_STICKER_LIMIT}
                onChange={event => setCaptionDraft(event.target.value)}
                onKeyDown={event => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  event.preventDefault();
                  addCaption();
                }} />
            </label>
            <button type="button" className={styles.secondary} disabled={busy || !captionDraft.trim() || captions.length === STUDIO_STICKER_LIMIT}
              onClick={addCaption}><Plus size={14} aria-hidden />{copy.addCaption}</button>
          </div>
        </div>
        <StudioGenerateButton label={words.length ? copy.generatePack.replace("{count}", String(words.length)) : copy.generate} busy={busy} disabled={!sheetQuote.quote || !words.length} onClick={createPack} />
        <StudioQuoteHint error={sheetQuote.error} />
        <StudioStatus status={status} />
      </section>
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <h2>{copy.myStickerPack}</h2>
            <p>{sample ? copy.samplePack : copy.generatedPackCount.replace("{count}", String(readyCount))}
              {!sample && readyCount < stickers.length && ` / ${stickers.length}`}
              {" · "}{copy.stickerBackgroundPng}
            </p>
          </div>
          <button type="button" className={styles.primary} disabled={busy || sample || stickers.some(sticker => !sticker.source)} onClick={() => void savePack()}>
            <Download size={16} aria-hidden />{copy.downloadAll}
          </button>
        </div>
        <ul className={styles.stickerGrid}>{stickers.map((sticker, index) => {
          const caption = captionFor(sticker, index);
          return (
            <li key={index} className={styles.sticker} data-testid="studio-sticker">
              <div className={styles.stickerImage} style={{ backgroundColor: STUDIO_STICKER_BACKGROUND }}>
                {sticker.source ? <StudioStickerPreview {...sticker} caption={caption} language={languageFor(sticker)} /> : <span>{caption}</span>}
              </div>
              <div className={styles.stickerActions}>
                <button type="button" disabled={busy} aria-label={copy.regenerate + " · " + caption}
                  onClick={() => openSticker(index)}>{copy.regenerate}</button>
                <button type="button" disabled={busy || !sticker.source} aria-label={copy.savePng + " · " + caption}
                  onClick={() => void task(async () => saveStudioFile(await png(sticker, index), filename(index)))}>PNG</button>
                <StudioImageShare iconOnly description={caption} filename={filename(index)} disabled={busy || !sticker.source}
                  prepare={() => png(sticker, index)} />
              </div>
            </li>
          );
        })}</ul>
      </section>
    </div>
    <dialog ref={dialog} className={styles.dialog} onClose={closeSticker} aria-labelledby="studio-sticker-regenerate">
      {replacement && <>
        <h2 id="studio-sticker-regenerate">{copy.regenerateFromWords}</h2>
        {billingNotice && <p role="status" className={styles.billingNotice}>{billingNotice}</p>}
        <div className={styles.regenerationRow}>
          <label className={styles.field}>{copy.newCaption}
            <input autoFocus value={replacement.caption} maxLength={32} disabled={regenerating} onChange={event => {
              if (replacement.source) urls.release(replacement.source);
              setReplacement({ ...replacement, caption: event.target.value, source: null });
              setReplacementError(null);
            }} />
          </label>
          <StudioGenerateButton label={copy.regenerate} busy={regenerating}
            disabled={!singleQuote.quote || !replacement.caption.trim()} onClick={() => void createSticker()} />
        </div>
        <StudioQuoteHint error={singleQuote.error} />
        {replacementError && <StudioStatus status={{ error: true, text: replacementError }} />}
        <div className={styles.compare}>
          <figure><figcaption>{copy.currentImage}</figcaption>{stickers[replacement.index].source
            ? <StudioStickerPreview {...stickers[replacement.index]} caption={captionFor(stickers[replacement.index], replacement.index)}
              language={languageFor(stickers[replacement.index])} />
            : <p>{copy.emptyResult}</p>}</figure>
          <figure aria-busy={regenerating}><figcaption>{copy.newImage}</figcaption>{replacement.source
            ? <StudioStickerPreview source={replacement.source} caption={replacement.caption.trim()}
              language={replacement.language ?? outputLanguage} composed={replacement.composed} /> : <p>{regenerating ? copy.generating : copy.emptyResult}</p>}</figure>
        </div>
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondary} onClick={() => dialog.current?.close()}>{copy.close}</button>
          <button type="button" className={styles.primary} disabled={!replacement.source || regenerating} onClick={applySticker}>{copy.apply}</button>
        </div>
      </>}
    </dialog>
    <StudioCreditRecovery error={creditError} returnTo={"/studio/stickers?lang=" + encodeURIComponent(lang)}
      draftSaved={draftSaved} onSaveDraft={saveCheckoutDraft} onClose={closeCreditRecovery} />
  </>;
}
