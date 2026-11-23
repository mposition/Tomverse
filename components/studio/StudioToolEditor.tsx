"use client";

/* eslint-disable @next/next/no-img-element -- User uploads and editor results use local object URLs. */
import { useState } from "react";
import Link from "next/link";
import { Download, WandSparkles } from "lucide-react";
import { STUDIO_EXPORT_FORMATS, type StudioTool } from "@/lib/studioTools";
import { studioOutputLanguage } from "@/locales/studio";
import { removeSolidStudioBackground, renderStudioImage, saveStudioFile } from "./studioCanvas";
import { StudioFileButton, StudioStatus, useStudioCopy, useStudioTask, useStudioUrls } from "./StudioControls";
import styles from "./studio.module.css";

const asset = (name: string) => `/studio/${name}.png`;

export function StudioToolEditor({ tool }: { tool: Exclude<StudioTool, { id: "stickers" }> }) {
  const { copy, lang } = useStudioCopy();
  const urls = useStudioUrls();
  const { busy, status, report, task } = useStudioTask();
  const { id } = tool;
  const photoTool = id === "illustration" || id === "caricature";
  const pngTool = id === "transparent-png";
  const template = id === "meme" || id === "poster";
  const social = id === "roleplay" || id === "character-quiz";
  const artisticOptions = id === "illustration"
    ? [["watercolor", copy.watercolor], ["comic", copy.comic], ["line art", copy.lineArt]]
    : [["subtle", copy.subtle], ["playful", copy.playful], ["bold", copy.bold]];
  const [photo, setPhoto] = useState(() => photoTool ? asset("selfie") : asset(tool.artwork));
  const [result, setResult] = useState(() => social || template ? "" : asset(tool.artwork));
  const [resultIsExample, setResultIsExample] = useState(photoTool || pngTool);
  const [format, setFormat] = useState(0);
  const [tolerance, setTolerance] = useState(45);
  const [customTitle, setTitle] = useState<string>();
  const title = customTitle ?? ( id === "poster" ? copy.examplePosterTitle :
    id === "character-quiz" ? copy.exampleQuizTitle : "");
  const [customDetails, setDetails] = useState<string>();
  const details = customDetails ?? ( id === "poster" ? copy.exampleEventDetails :
    id === "meme" ? copy.exampleMemeSituation :
    id === "roleplay" ? copy.exampleRoleplay :
    id === "character-quiz" ? copy.exampleQuizQuestion : "");
  const [customCaption, setCaption] = useState<string>();
  const caption = customCaption ?? copy.exampleMemeCaption;
  const [players, setPlayers] = useState("4");
  const [textDraft, setTextDraft] = useState("");

  const photoLabel = photoTool || pngTool ? copy.originalPhoto : copy.backgroundArtwork;
  const invalid = () => report(copy.invalidImage, true);
  const changePhoto = (file: File) => {
    const url = urls.make(file);
    urls.release(photo);
    setPhoto(url);
    if (photoTool || pngTool) {
      urls.release(result);
      setResult("");
      setResultIsExample(false);
    }
  };
  const importResult = (file: File) => {
    const url = urls.make(file);
    urls.release(result);
    setResult(url);
    setResultIsExample(false);
  };
  const createPrompt = () => {
    switch (id) {
      case "roleplay":
        return `Host a five-minute roleplaying game for ${players} friends. React to their free-text actions and remember established facts. Give only a short opening scene and invite each friend to act. Write in ${studioOutputLanguage[lang]}. Opening situation: ${details}`;
      case "character-quiz":
        return `Create a playful friend-group character test in ${studioOutputLanguage[lang]}. Provide four multiple-choice questions, three distinct result types, an answer-to-result mapping, and two-sentence descriptions for the result cards. Title: ${title}. Example question: ${details}`;
      case "meme":
        return `Create one funny, shareable image depicting this situation: ${details}. Leave room at the top for a caption. Do not draw text. Caption context: ${caption}`;
      case "illustration":
        return `Redraw the attached photo as a ${artisticOptions[format][0]} illustration. Keep the person recognisable. Direction: ${details}`;
      case "caricature":
        return `Draw a recognisable caricature of the person in the attached photo. Exaggeration: ${artisticOptions[format][0]}. Features to keep: ${details}`;
      case "poster":
        return `Create cover artwork for a poster about “${title}” (${details}). Keep the focal point in the middle so the artwork can be cropped into a square or vertical story. Leave space at the top and do not draw text.`;
      default:
        return "";
    }
  };
  const copyPrompt = () => void task(async () => {
    await navigator.clipboard.writeText(createPrompt());
    report(copy.copiedPrompt);
  });
  const clearBackground = () => void task(async () => {
    const blob = await removeSolidStudioBackground(photo, tolerance);
    const source = urls.make(blob);
    urls.release(result);
    setResult(source);
    setResultIsExample(false);
  });
  const download = (requestedFormat = format) => void task(async () => {
    const dim = id === "poster" ? STUDIO_EXPORT_FORMATS[requestedFormat] : { width: 1080, height: 1080, id };
    const blob = await renderStudioImage(template ? photo : result, {
      width: dim.width, height: dim.height, fit: template ? "cover" : "contain",
      title: id === "meme" ? caption : id === "poster" ? title : undefined,
      subtitle: id === "poster" ? details : undefined,
    });
    saveStudioFile(blob, `tomverse-${dim.id}.png`);
  });
  const downloadText = () => saveStudioFile(new Blob([textDraft], { type: "text/plain;charset=utf-8" }), `tomverse-${id}.txt`);
  const classNames = (active: boolean) => active ? styles.choiceActive : styles.secondary;

  return <div className={styles.workbench}>
    <section className={styles.panel}>
      <h2>{copy.inputs}</h2>
      {!social && <div className={styles.fileRow}>
        <img src={photo} alt="" width={56} height={56} />
        <span>{photoLabel}</span>
        <StudioFileButton label={copy.changeImage} disabled={busy} onInvalid={invalid} onFile={changePhoto} />
      </div>}
      {(id === "poster" || id === "character-quiz") && (
        <label className={styles.field}>{id === "poster" ? copy.eventTitle : copy.quizTitle}
          <input value={title} maxLength={65} onChange={event => setTitle(event.target.value)} />
        </label>
      )}
      {!pngTool && <label className={styles.field}>{
        id === "roleplay" ? copy.openingSituation :
        id === "character-quiz" ? copy.questionExample :
        id === "meme" ? copy.situation :
        id === "poster" ? copy.dateAndPlace : copy.detailsToKeep
      }<textarea value={details} maxLength={500} rows={id === "poster" ? 2 : 3} onChange={event => setDetails(event.target.value)} /></label>}
      {id === "meme" && <label className={styles.field}>{copy.imageCaption}<input value={caption} maxLength={55} onChange={event => setCaption(event.target.value)} /></label>}
      {id === "roleplay" && <label className={styles.field}>{copy.players}
        <select value={players} onChange={event => setPlayers(event.target.value)}>{[2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}</select>
      </label>}
      {photoTool && <fieldset className={styles.fieldset}>
        <legend>{id === "illustration" ? copy.drawingStyle : copy.exaggeration}</legend>
        <div className={styles.choices}>{artisticOptions.map((option, i) => <button type="button" key={option[0]} className={classNames(format === i)} aria-pressed={format === i} onClick={() => setFormat(i)}>{option[1]}</button>)}</div>
      </fieldset>}
      {id === "poster" && <fieldset className={styles.fieldset}>
        <legend>{copy.template}</legend>
        <div className={styles.choices}>{STUDIO_EXPORT_FORMATS.map((option, i) => <button type="button" key={option.id} className={classNames(format === i)} aria-pressed={format === i} onClick={() => setFormat(i)}>{copy[option.id]}</button>)}</div>
      </fieldset>}
      {pngTool ? <>
        <label className={styles.field}>{copy.colorTolerance}<input type="range" min={12} max={95} value={tolerance} onChange={event => setTolerance(Number(event.target.value))} /></label>
        <button type="button" className={styles.primary} disabled={busy} onClick={clearBackground}>{copy.removeBackground}</button>
        <p className={styles.hint}>{copy.backgroundHint}</p>
      </> : <>
        <button type="button" className={styles.primary} disabled={busy || (!details.trim() && social)} onClick={copyPrompt}>
          <WandSparkles size={16} aria-hidden />{copy.copyAiPrompt}
        </button>
        <Link className={styles.textLink} href={{ pathname: "/chat", query: { lang } }} target="_blank" rel="noopener">{copy.openChat}</Link>
        <p className={styles.hint}>{copy.returnWithResult}</p>
      </>}
      <StudioStatus status={status} />
    </section>
    <section className={styles.panel}>
      <h2>{copy.resultPreview}</h2>
      {social ? <>
        <img className={styles.scene} src={asset(tool.artwork)} alt="" />
        <label className={styles.field}>{copy.generatedDraft}
          <textarea rows={7} value={textDraft} onChange={event => setTextDraft(event.target.value)} placeholder={copy.pasteDraft} />
        </label>
        <button type="button" className={styles.primary} disabled={!textDraft.trim()} onClick={downloadText}><Download size={16} aria-hidden />{copy.saveDraft}</button>
      </> : id === "poster" ? <>
        <div className={styles.posterGrid}>{STUDIO_EXPORT_FORMATS.map((option, i) => (
          <figure key={option.id}>
            <div className={styles.posterArt} style={{ aspectRatio: `${option.width} / ${option.height}` }}>
              <img src={photo} alt="" />
              <div className={styles.artText}><strong>{title}</strong><small>{details}</small></div>
            </div>
            <figcaption><button type="button" aria-pressed={format === i} className={classNames(format === i)} onClick={() => setFormat(i)}>{copy[option.id]}</button></figcaption>
          </figure>
        ))}</div>
      </> : id === "meme" ? <div className={styles.memeArt}>
        <img src={photo} alt="" /><strong>{caption}</strong>
      </div> : <>
        {resultIsExample && <p className={styles.hint}>{copy.exampleResult}</p>}
        <div className={styles.compare}>
          <figure><figcaption>{copy.original}</figcaption><img src={photo} alt="" /></figure>
          <figure className={pngTool ? styles.checker : undefined}>
            <figcaption>{copy.result}</figcaption>
            {result && <img src={result} alt={copy.processedImage} />}
          </figure>
        </div>
        {photoTool && <StudioFileButton label={copy.importResult} disabled={busy} onInvalid={invalid} onFile={importResult} />}
      </>}
      {!social && (
        <button type="button" className={styles.primary} disabled={(!template && !result) || busy} onClick={() => download()}>
          <Download size={16} aria-hidden />{copy.savePng}
        </button>
      )}
    </section>
  </div>;
}
