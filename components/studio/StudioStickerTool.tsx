"use client";

/* eslint-disable @next/next/no-img-element -- User-selected and generated object URLs are local. */
import { useRef, useState } from "react";
import Link from "next/link";
import { zipSync } from "fflate";
import { Download, WandSparkles } from "lucide-react";
import { STUDIO_STICKER_KEYS } from "@/lib/studioTools";
import { renderStudioImage, saveStudioFile, splitStudioSheet } from "./studioCanvas";
import { StudioFileButton, StudioStatus, useStudioCopy, useStudioTask, useStudioUrls } from "./StudioControls";
import styles from "./studio.module.css";

type Sticker = { source: string; caption?: string };
type Replacement = { index: number; caption: string; source: string | null };

export function StudioStickerTool() {
  const { lang, copy } = useStudioCopy();
  const urls = useStudioUrls();
  const { busy, status, report, task } = useStudioTask();
  const dialog = useRef<HTMLDialogElement>(null);
  const committedSource = useRef<string | null>(null);
  const [style, setStyle] = useState<"real" | "character">("character");
  const [photo, setPhoto] = useState<{ source: string; name?: string }>({ source: "/studio/selfie.png" });
  const [stickers, setStickers] = useState<Sticker[]>(() => STUDIO_STICKER_KEYS.map((_, index) => ({
    source: `/studio/sticker-${index + 1}.png`,
  })));
  const sample = stickers.some(sticker => !sticker.source.startsWith("blob:"));
  const [replacement, setReplacement] = useState<Replacement | null>(null);
  const captionFor = (sticker: Sticker, index: number) => sticker.caption ?? copy[STUDIO_STICKER_KEYS[index]];

  const invalid = () => report(copy.invalidImage, true);
  const stylePrompt = style === "real" ? "Keep the real face and draw a playful body." : "Draw a recognisable illustrated character from the original face.";
  const copyPrompt = (index?: number, caption?: string) => task(async () => {
    const prompt = index === undefined
      ? `Using the attached portrait, create exactly 20 separate chat sticker drawings in a 5-column by 4-row contact sheet. Tight visual consistency, original identity, each sticker centred in its cell with padding, transparent background. ${stylePrompt} The image in each cell must depict the meaning of its caption. Do not draw lettering. Captions from left to right, top to bottom: ${stickers.map(captionFor).join(" | ")}.`
      : `Using the attached portrait and the existing sticker as references, draw one square chat sticker based on the meaning of “${caption}”. Change the pose, expression and props to depict those words. ${stylePrompt} Keep the same character identity as the existing pack, transparent background, no lettering.`;
    await navigator.clipboard.writeText(prompt);
    report(index === undefined ? copy.copiedPortrait : copy.copiedStickerReferences);
  });

  const importSheet = (file: File) => void task(async () => {
    const url = URL.createObjectURL(file);
    try {
      const pieces = await splitStudioSheet(url);
      const sources = pieces.map(piece => urls.make(piece));
      for (const sticker of stickers) urls.release(sticker.source);
      setStickers(stickers.map((sticker, index) => ({ ...sticker, source: sources[index] })));
      report(copy.sheetSplit);
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  const png = (sticker: Sticker, index: number) => renderStudioImage(sticker.source, { width: 512, height: 512, fit: "contain", title: captionFor(sticker, index), sticker: true });
  const filename = (index: number) => `sticker-${String(index + 1).padStart(2, "0")}.png`;
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
    if (replacement?.source && replacement.source !== committedSource.current) urls.release(replacement.source);
    committedSource.current = null;
    setReplacement(null);
  };
  const applySticker = () => {
    if (!replacement?.source || !replacement.caption.trim()) return;
    const source = replacement.source;
    committedSource.current = source;
    urls.release(stickers[replacement.index].source);
    setStickers(stickers.map((sticker, index) => index === replacement.index ? { source, caption: replacement.caption.trim() } : sticker));
    setReplacement(null);
    dialog.current?.close();
    report(copy.stickerReplaced);
  };

  return <>
    <div className={styles.workbench}>
      <section className={styles.panel}>
        <h2>{copy.photoAndStyle}</h2>
        <div className={styles.fileRow}>
          <img src={photo.source} alt="" width={56} height={56} />
          <span>{photo.name ?? copy.samplePhoto}</span>
          <StudioFileButton label={copy.changePhoto} disabled={busy} onInvalid={invalid} onFile={file => {
            const source = urls.make(file);
            urls.release(photo.source);
            setPhoto({ source, name: file.name });
          }} />
        </div>
        <fieldset className={styles.fieldset}>
          <legend>{copy.faceStyle}</legend>
          {(["real", "character"] as const).map(key => (
            <label className={styles.styleOption} key={key}>
              <img src={`/studio/${key}.png`} width={44} height={44} alt="" />
              <span>{key === "real" ? copy.realFace : copy.illustratedFace}</span>
              <input type="radio" name="studio-face-style" checked={style === key} disabled={busy} onChange={() => setStyle(key)} />
            </label>
          ))}
        </fieldset>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => void copyPrompt()}>
          <WandSparkles size={16} aria-hidden />{copy.copyPackPrompt}
        </button>
        <Link className={styles.textLink} href={{ pathname: "/chat", query: { lang } }} target="_blank" rel="noopener">{copy.openChat}</Link>
        <p className={styles.hint}>{copy.portraitInstructions}</p>
        <StudioFileButton label={copy.importSheet} disabled={busy} onInvalid={invalid} onFile={importSheet} />
        <StudioStatus status={status} />
      </section>
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div><h2>{copy.myStickerPack}</h2>
            <p>{sample ? copy.samplePack : copy.packCount}</p></div>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void savePack()}>
            <Download size={16} aria-hidden />{copy.downloadZip}
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
        <label className={styles.field}>{copy.newCaption}
          <input autoFocus value={replacement.caption} maxLength={32} disabled={busy} onChange={event => setReplacement({ ...replacement, caption: event.target.value })} />
        </label>
        <div className={styles.compare}>
          <figure><figcaption>{copy.currentImage}</figcaption><img src={stickers[replacement.index].source} alt={captionFor(stickers[replacement.index], replacement.index)} /></figure>
          <figure><figcaption>{copy.newImage}</figcaption>{replacement.source && <img src={replacement.source} alt={replacement.caption} />}</figure>
        </div>
        <StudioFileButton label={copy.importReplacement} disabled={busy} onInvalid={invalid} onFile={file => {
          if (replacement.source) urls.release(replacement.source);
          setReplacement({ ...replacement, source: urls.make(file) });
        }} />
        <StudioStatus status={status} />
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondary} onClick={() => dialog.current?.close()}>{copy.close}</button>
          <button type="button" className={styles.secondary} disabled={!replacement.caption.trim() || busy} onClick={() => void copyPrompt(replacement.index, replacement.caption)}>{copy.copyImagePrompt}</button>
          <button type="button" className={styles.primary} disabled={!replacement.source || !replacement.caption.trim() || busy} onClick={applySticker}>{copy.replaceImage}</button>
        </div>
      </>}
    </dialog>
  </>;
}
