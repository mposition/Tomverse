"use client";

/* eslint-disable @next/next/no-img-element -- Sticker previews use local object URLs. */
import { useEffect, useRef, useState } from "react";
import { zipSync } from "fflate";
import { Download, Plus, X } from "lucide-react";
import { STUDIO_STICKER_KEYS, STUDIO_STICKER_LIMIT, studioStickerLayout } from "@/lib/studioTools";
import { makeStudioImageReference, removeStudioGreenScreen, renderStudioImage, saveStudioFile, splitStudioSheet } from "./studioCanvas";
import { StudioFileButton, StudioStatus, useStudioCopy, useStudioTask, useStudioUrls } from "./StudioControls";
import { StudioGenerateButton, StudioQuoteHint } from "./StudioGenerationControls";
import { createStudioImageRunner, StudioGenerationError, useStudioImageQuote } from "./studioGenerationClient";
import { captureStudioDraftImage, useStudioCheckoutDraft, type StudioDraftImage } from "./studioCheckoutDraft";
import { isStudioCreditShortfall, StudioCreditRecovery } from "./StudioCreditRecovery";
import styles from "./studio.module.css";

type Sticker = { source: string; caption?: string };
type FaceStyle = "real" | "character";
type Replacement = { index: number; caption: string; source: string | null };
type StickerCheckoutDraft = {
  style: FaceStyle;
  photo: { source: StudioDraftImage; name?: string };
  reference: { source: StudioDraftImage; style: FaceStyle };
  stickers: Array<{ source: StudioDraftImage; caption?: string }>;
  captions: string[];
  captionDraft: string;
  sample: boolean;
  replacement: (Omit<Replacement, "source"> & { source: StudioDraftImage | null }) | null;
};

const samplePhoto = "/studio/selfie.png";
const sheetSize = "1536x1024";
const singleSize = "1024x1024";
const stickerBackground = "Use a perfectly flat pure green (#00ff00) background so the artwork can be cut out. Never use that background color in the character or props. Do not draw any lettering.";
const drawFace = (style: FaceStyle) => style === "real"
  ? "Preserve the recognisable, photoreal face and draw the body and props."
  : "Make a recognisable illustrated character from the portrait.";

export function StudioStickerTool() {
  const { copy, lang } = useStudioCopy();
  const urls = useStudioUrls();
  const { busy, status, report, task } = useStudioTask();
  const dialog = useRef<HTMLDialogElement>(null);
  const pausedForCheckout = useRef(false);
  const [creditError, setCreditError] = useState<StudioGenerationError | null>(null);
  const packController = useRef<AbortController | null>(null);
  const cutController = useRef<AbortController | null>(null);
  const [runPack] = useState(createStudioImageRunner);
  const [runCut] = useState(createStudioImageRunner);
  const committed = useRef<string | null>(null);
  const [style, setStyle] = useState<FaceStyle>("character");
  const [photo, setPhoto] = useState<{ source: string; name?: string }>({ source: samplePhoto });
  const [reference, setReference] = useState({ source: samplePhoto, style: "character" as FaceStyle });
  const [stickers, setStickers] = useState<Sticker[]>(() => STUDIO_STICKER_KEYS.map((_, i) => ({
    source: "/studio/sticker-" + (i + 1) + ".png",
  })));
  const [captions, setCaptions] = useState<string[]>([]);
  const [captionDraft, setCaptionDraft] = useState("");
  const words = [...captions, ...(captionDraft.trim() && captions.length < STUDIO_STICKER_LIMIT ? [captionDraft.trim()] : [])];
  const outputSize = words.length <= 1 ? singleSize : sheetSize;
  const sheetQuote = useStudioImageQuote(outputSize, true);
  const [sample, setSample] = useState(true);
  const [replacement, setReplacement] = useState<Replacement | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [replacementError, setReplacementError] = useState<string | null>(null);
  const singleQuote = useStudioImageQuote(singleSize, true, Boolean(replacement));
  const checkoutDraft = useStudioCheckoutDraft<StickerCheckoutDraft>("stickers", saved => {
    const restoreSource = (source: StudioDraftImage) => typeof source === "string" ? source : urls.make(source);
    urls.release(photo.source);
    urls.release(reference.source);
    stickers.forEach(sticker => urls.release(sticker.source));
    setStyle(saved.style);
    setPhoto({ ...saved.photo, source: restoreSource(saved.photo.source) });
    setReference({ ...saved.reference, source: restoreSource(saved.reference.source) });
    setStickers(saved.stickers.map(sticker => ({ ...sticker, source: restoreSource(sticker.source) })));
    setCaptions(saved.captions);
    setCaptionDraft(saved.captionDraft);
    setSample(saved.sample);
    if (saved.replacement && saved.replacement.index < saved.stickers.length) {
      setReplacement({ ...saved.replacement, source: saved.replacement.source ? restoreSource(saved.replacement.source) : null });
      if (!dialog.current?.open) dialog.current?.showModal();
    }
    report(copy.checkoutDraftRestored);
  });

  async function showCreditRecovery(error: StudioGenerationError, signal: AbortSignal) {
    try {
      const [photoSource, referenceSource, savedStickers, replacementSource] = await Promise.all([
        captureStudioDraftImage(photo.source),
        captureStudioDraftImage(reference.source),
        Promise.all(stickers.map(async sticker => ({ ...sticker, source: await captureStudioDraftImage(sticker.source) }))),
        replacement?.source ? captureStudioDraftImage(replacement.source) : null,
      ]);
      await checkoutDraft.save({
        style, photo: { ...photo, source: photoSource }, reference: { ...reference, source: referenceSource },
        stickers: savedStickers, captions, captionDraft, sample,
        replacement: replacement ? { ...replacement, source: replacementSource } : null,
      });
      if (signal.aborted) return;
      if (dialog.current?.open) {
        pausedForCheckout.current = true;
        dialog.current.close();
      }
      setCreditError(error);
    } catch {
      if (signal.aborted) return;
      if (replacement) setReplacementError(copy.checkoutDraftSaveFailed);
      else report(copy.checkoutDraftSaveFailed, true);
    }
  }
  function closeCreditRecovery() {
    setCreditError(null);
    if (pausedForCheckout.current) {
      pausedForCheckout.current = false;
      if (!dialog.current?.open) dialog.current?.showModal();
    }
  }
  const captionFor = (sticker: Sticker, index: number) => sticker.caption ?? copy[STUDIO_STICKER_KEYS[index]];
  const addCaption = () => {
    if (!captionDraft.trim() || captions.length >= STUDIO_STICKER_LIMIT) return;
    setCaptions(words);
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
    const { columns, rows } = studioStickerLayout(words.length);
    try {
      const blob = await runPack({
        inputKey: photo.source,
        prompt: "Create exactly " + words.length + " separate chat sticker drawings from this portrait. Arrange them in " + columns + " equal columns and " + rows + " equal rows filling the canvas. Place one drawing in each successive cell with padding and invisible grid lines. Leave any unused cells plain green. Keep the same face, style, palette and proportions. " +
          drawFace(style) + " " + stickerBackground +
          " In left-to-right, top-to-bottom order, each pose and expression should match its caption: " + JSON.stringify(words),
        size: outputSize,
        quote: sheetQuote.quote,
        reference: () => makeStudioImageReference(photo.source),
        signal: controller.signal,
      });
      const sheet = URL.createObjectURL(await removeStudioGreenScreen(blob));
      try {
        const pieces = await splitStudioSheet(sheet, words.length);
        controller.signal.throwIfAborted();
        const next = pieces.map((piece, index) => ({ source: urls.make(piece), caption: words[index] }));
        stickers.forEach(sticker => urls.release(sticker.source));
        if (reference.source !== photo.source) urls.release(reference.source);
        setReference({ source: photo.source, style });
        setStickers(next);
        setSample(false);
        setCaptions(words);
        setCaptionDraft("");
        report(copy.packReady);
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

  const png = (sticker: Sticker, index: number) => renderStudioImage(sticker.source, { width: 512, height: 512, fit: "contain", title: captionFor(sticker, index), sticker: true });
  const filename = (index: number) => "sticker-" + String(index + 1).padStart(2, "0") + ".png";
  const savePack = () => task(async () => {
    const entries = await Promise.all(stickers.map(async (sticker, index) => [filename(index), new Uint8Array(await (await png(sticker, index)).arrayBuffer())] as const));
    const bytes = new Uint8Array(zipSync(Object.fromEntries(entries)));
    saveStudioFile(new Blob([bytes.buffer], { type: "application/zip" }), "tomverse-stickers.zip");
  });

  const openSticker = (index: number) => {
    setReplacement({ index, caption: captionFor(stickers[index], index), source: null });
    dialog.current?.showModal();
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
      const current = stickers[replacement.index];
      const blob = await runCut({
        inputKey: current.source,
        prompt: "The left half is the reference portrait. The right half is an existing sticker. Draw one new sticker with the same identity, line work, colours and character as the reference. " +
          drawFace(reference.style) + " " + stickerBackground +
          " Change the pose, expression and props so the drawing depicts this new caption: " + JSON.stringify(replacement.caption.trim()),
        size: singleSize,
        quote: singleQuote.quote,
        reference: () => makeStudioImageReference(reference.source, current.source),
        signal: controller.signal,
      });
      const art = await removeStudioGreenScreen(blob);
      controller.signal.throwIfAborted();
      if (replacement.source) urls.release(replacement.source);
      setReplacement({ ...replacement, source: urls.make(art) });
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
    urls.release(stickers[index].source);
    setStickers(stickers.map((sticker, i) => i === index ? { source, caption } : sticker));
    committed.current = source;
    setCaptions(items => items[index] === stickers[index].caption
      ? items.map((item, i) => i === index ? caption : item) : items);
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
          {captions.length > 0 && <ul className={styles.captionChips}>
            {captions.map((caption, i) => <li key={i}>
              <span>{caption}</span>
              <button type="button" disabled={busy} aria-label={copy.removeCaption + " " + caption}
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
        <StudioQuoteHint {...sheetQuote} />
        <StudioStatus status={status} />
      </section>
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div><h2>{copy.myStickerPack}</h2><p>{sample ? copy.samplePack : copy.generatedPackCount.replace("{count}", String(stickers.length))}</p></div>
          <button type="button" className={styles.primary} disabled={busy || sample} onClick={() => void savePack()}>
            <Download size={16} aria-hidden />{copy.downloadAll}
          </button>
        </div>
        <ul className={styles.stickerGrid}>{stickers.map((sticker, index) => (
          <li key={index} className={styles.sticker} data-testid="studio-sticker">
            <div className={styles.stickerImage}><img src={sticker.source} alt="" /><span>{captionFor(sticker, index)}</span></div>
            <div className={styles.stickerActions}>
              <button type="button" disabled={busy} onClick={() => openSticker(index)}>{copy.regenerate}</button>
              <button type="button" disabled={busy} onClick={() => void task(async () => saveStudioFile(await png(sticker, index), filename(index)))}>PNG</button>
            </div>
          </li>
        ))}</ul>
      </section>
    </div>
    <dialog ref={dialog} className={styles.dialog} onClose={closeSticker} aria-labelledby="studio-sticker-regenerate">
      {replacement && <>
        <h2 id="studio-sticker-regenerate">{copy.regenerateFromWords}</h2>
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
        <StudioQuoteHint {...singleQuote} />
        {replacementError && <StudioStatus status={{ error: true, text: replacementError }} />}
        <div className={styles.compare}>
          <figure><figcaption>{copy.currentImage}</figcaption><img src={stickers[replacement.index].source} alt={captionFor(stickers[replacement.index], replacement.index)} /></figure>
          <figure aria-busy={regenerating}><figcaption>{copy.newImage}</figcaption>{replacement.source
            ? <img src={replacement.source} alt={replacement.caption} /> : <p>{regenerating ? copy.generating : copy.emptyResult}</p>}</figure>
        </div>
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondary} onClick={() => dialog.current?.close()}>{copy.close}</button>
          <button type="button" className={styles.primary} disabled={!replacement.source || regenerating} onClick={applySticker}>{copy.apply}</button>
        </div>
      </>}
    </dialog>
    <StudioCreditRecovery error={creditError} returnTo={"/studio/stickers?lang=" + encodeURIComponent(lang)} onClose={closeCreditRecovery} />
  </>;
}
