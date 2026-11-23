"use client";

/* eslint-disable @next/next/no-img-element -- User uploads and results use local object URLs. */
import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Download } from "lucide-react";
import { STUDIO_EXPORT_FORMATS, type StudioTool } from "@/lib/studioTools";
import { studioOutputLanguage } from "@/locales/studio";
import { applyStudioSubjectMask, makeStudioImageReference, renderStudioImage, saveStudioFile } from "./studioCanvas";
import { StudioFileButton, StudioStatus, useStudioCopy, useStudioTask, useStudioUrls } from "./StudioControls";
import { StudioGenerateButton, StudioQuoteHint } from "./StudioGenerationControls";
import { createStudioImageRunner, generateStudioText, StudioGenerationError, useStudioImageQuote } from "./studioGenerationClient";
import styles from "./studio.module.css";

const asset = (name: string) => "/studio/" + name + ".png";

export function StudioToolEditor({ tool }: { tool: Exclude<StudioTool, { id: "stickers" }> }) {
  const { copy, lang } = useStudioCopy();
  const { status: sessionStatus } = useSession();
  const urls = useStudioUrls();
  const { busy, status, report, task } = useStudioTask();
  const active = useRef<AbortController | null>(null);
  const [runImage] = useState(createStudioImageRunner);
  const { id } = tool;
  const photoTool = id === "illustration" || id === "caricature";
  const pngTool = id === "transparent-png";
  const template = id === "meme" || id === "poster";
  const roleplay = id === "roleplay";
  const social = roleplay || id === "character-quiz";
  const artisticOptions = id === "illustration"
    ? [["watercolor", copy.watercolor], ["comic", copy.comic], ["line art", copy.lineArt]]
    : [["subtle", copy.subtle], ["playful", copy.playful], ["bold", copy.bold]];
  const [photo, setPhoto] = useState(() => photoTool ? asset("selfie") : asset(tool.artwork));
  const [customPhoto, setCustomPhoto] = useState(false);
  const [result, setResult] = useState(() => social ? "" : asset(tool.artwork));
  const [resultIsExample, setResultIsExample] = useState(!social);
  const [format, setFormat] = useState(0);
  const [customTitle, setTitle] = useState<string>();
  const title = customTitle ?? (id === "poster" ? copy.examplePosterTitle :
    id === "character-quiz" ? copy.exampleQuizTitle : "");
  const [customDetails, setDetails] = useState<string>();
  const details = customDetails ?? (id === "poster" ? copy.exampleEventDetails :
    id === "meme" ? copy.exampleMemeSituation :
    roleplay ? copy.exampleRoleplay :
    id === "character-quiz" ? copy.exampleQuizQuestion : "");
  const [customCaption, setCaption] = useState<string>();
  const caption = customCaption ?? copy.exampleMemeCaption;
  const [players, setPlayers] = useState("4");
  const [textDraft, setTextDraft] = useState("");
  const [sceneAction, setSceneAction] = useState("");
  const hasReference = photoTool || pngTool || customPhoto;
  const size = id === "poster" ? "1024x1536" : "1024x1024";
  const imageQuote = useStudioImageQuote(size, hasReference, !social);

  useEffect(() => () => active.current?.abort(), []);

  const changePhoto = (file: File) => {
    const url = urls.make(file);
    urls.release(photo);
    setPhoto(url);
    setCustomPhoto(true);
    urls.release(result);
    setResult("");
    setResultIsExample(false);
  };

  const imagePrompt = () => {
    switch (id) {
      case "meme":
        return (hasReference ? "Transform the supplied reference into " : "Create ") +
          "one funny, shareable image depicting this situation: " + details + ". Leave room at the top for a caption. Do not draw text. Caption context: " + caption;
      case "illustration":
        return "Redraw the attached photo as a " + artisticOptions[format][0] + " illustration. Keep the person recognisable. Direction: " + details;
      case "caricature":
        return "Draw a recognisable caricature of the person in the attached photo. Exaggeration: " + artisticOptions[format][0] + ". Features to keep: " + details;
      case "poster":
        return (hasReference ? "Use the supplied artwork as a reference. " : "") +
          "Create cover artwork for a poster about " + JSON.stringify(title) + " (" + details + "). Keep the focal point centred so the artwork can be cropped into a square or a vertical story. Leave space at the top and do not draw text.";
      case "transparent-png":
        return "Produce a square grayscale segmentation matte of the foreground subject. Subject pixels are white, background pixels black, and partially transparent edges gray. Do not reproduce the image, move, resize or crop anything. Match the exact original subject boundaries and keep transparent padding black.";
      default:
        return "";
    }
  };

  const generate = (nextScene = false) => void task(async () => {
    const controller = new AbortController();
    active.current = controller;
    const { signal } = controller;
    try {
      if (social) {
        const language = studioOutputLanguage[lang];
        const request = roleplay
          ? "Host a five-minute roleplaying game for " + players + " friends. Write in " + language + ". Give a short scene and invite each friend to act. Opening situation: " + details +
            (nextScene ? "\nStory so far: " + textDraft.slice(-6_000) + "\nLatest action: " + sceneAction.trim() + "\nWrite only the next scene, without recapping." : "")
          : "Create a playful friend-group character quiz in " + language + ". Give four multiple-choice questions, three distinct result types, a clear scoring key, and two-sentence descriptions for the result cards. Use plain text. Title: " + title + "\nExample question: " + details;
        const draft = await generateStudioText(request, signal);
        signal.throwIfAborted();
        setTextDraft(nextScene ? textDraft + "\n\n" + draft : draft);
        setSceneAction("");
      } else {
        if (!imageQuote.quote) return;
        const generated = await runImage({
          inputKey: hasReference ? photo : id,
          prompt: imagePrompt(),
          size,
          quote: imageQuote.quote,
          reference: hasReference ? () => pngTool
            ? renderStudioImage(photo, { width: 1024, height: 1024, fit: "contain" })
            : makeStudioImageReference(photo) : undefined,
          signal,
        });
        const output = pngTool ? await applyStudioSubjectMask(photo, generated) : generated;
        signal.throwIfAborted();
        urls.release(result);
        setResult(urls.make(output));
        setResultIsExample(false);
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof StudioGenerationError && error.status === 409 && !social) imageQuote.reload();
      throw error;
    } finally {
      active.current = null;
    }
  });

  const valid = social ? Boolean(details.trim() && (roleplay || title.trim()))
    : (id !== "poster" || Boolean(title.trim())) && (id !== "meme" || Boolean(details.trim()));
  const generationLabel = roleplay ? copy.firstScene : pngTool ? copy.removeBackground : copy.generate;

  const download = () => void task(async () => {
    const dim = id === "poster" ? STUDIO_EXPORT_FORMATS[format] : { width: 1080, height: 1080, id };
    const blob = pngTool && !resultIsExample ? await fetch(result).then(response => response.blob())
      : await renderStudioImage(result, {
        width: dim.width, height: dim.height, fit: template ? "cover" : "contain",
        title: id === "meme" ? caption : id === "poster" ? title : undefined,
        subtitle: id === "poster" ? details : undefined,
      });
    saveStudioFile(blob, "tomverse-" + dim.id + ".png");
  });
  const downloadText = () => saveStudioFile(new Blob([textDraft], { type: "text/plain;charset=utf-8" }), "tomverse-" + id + ".txt");
  const choice = (active: boolean) => active ? styles.choiceActive : styles.secondary;

  return <div className={styles.workbench}>
    <section className={styles.panel}>
      <h2>{copy.inputs}</h2>
      {!social && <div className={styles.fileRow}>
        <img src={photo} alt="" width={56} height={56} />
        <span>{photoTool || pngTool ? copy.originalPhoto : copy.backgroundArtwork}</span>
        <StudioFileButton label={copy.changeImage} disabled={busy} onInvalid={() => report(copy.invalidImage, true)} onFile={changePhoto} />
      </div>}
      {(id === "poster" || id === "character-quiz") && (
        <label className={styles.field}>{id === "poster" ? copy.eventTitle : copy.quizTitle}
          <input value={title} maxLength={65} disabled={busy} onChange={event => setTitle(event.target.value)} />
        </label>
      )}
      {!pngTool && <label className={styles.field}>{
        roleplay ? copy.openingSituation : id === "character-quiz" ? copy.questionExample :
        id === "meme" ? copy.situation : id === "poster" ? copy.dateAndPlace : copy.detailsToKeep
      }<textarea value={details} maxLength={500} rows={id === "poster" ? 2 : 3} disabled={busy} onChange={event => setDetails(event.target.value)} /></label>}
      {id === "meme" && <label className={styles.field}>{copy.imageCaption}<input value={caption} maxLength={55} disabled={busy} onChange={event => setCaption(event.target.value)} /></label>}
      {roleplay && <label className={styles.field}>{copy.players}
        <select value={players} disabled={busy} onChange={event => setPlayers(event.target.value)}>{[2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}</select>
      </label>}
      {photoTool && <fieldset className={styles.fieldset} disabled={busy}>
        <legend>{id === "illustration" ? copy.drawingStyle : copy.exaggeration}</legend>
        <div className={styles.choices}>{artisticOptions.map((option, i) => <button type="button" key={option[0]} className={choice(format === i)} aria-pressed={format === i} onClick={() => setFormat(i)}>{option[1]}</button>)}</div>
      </fieldset>}
      {id === "poster" && <fieldset className={styles.fieldset} disabled={busy}>
        <legend>{copy.template}</legend>
        <div className={styles.choices}>{STUDIO_EXPORT_FORMATS.map((option, i) => <button type="button" key={option.id} className={choice(format === i)} aria-pressed={format === i} onClick={() => setFormat(i)}>{copy[option.id]}</button>)}</div>
      </fieldset>}
      <StudioGenerateButton label={generationLabel} busy={busy}
        disabled={!valid || (social ? sessionStatus !== "authenticated" : !imageQuote.quote)}
        onClick={() => generate()} />
      {social
        ? sessionStatus === "unauthenticated" && <StudioQuoteHint error={401} />
        : <StudioQuoteHint {...imageQuote} />}
      <StudioStatus status={status} />
    </section>
    <section className={styles.panel} aria-busy={busy}>
      <h2>{copy.resultPreview}</h2>
      {social ? <>
        <img className={styles.scene} src={asset(tool.artwork)} alt="" />
        <label className={styles.field}>{copy.generatedDraft}
          <textarea rows={7} value={textDraft} disabled={busy} onChange={event => setTextDraft(event.target.value)} placeholder={copy.emptyResult} />
        </label>
        {roleplay && textDraft.trim() && <>
          <label className={styles.field}>{copy.sceneAction}
            <input value={sceneAction} maxLength={500} disabled={busy} onChange={event => setSceneAction(event.target.value)} />
          </label>
          <StudioGenerateButton label={copy.nextScene} busy={busy}
            disabled={!sceneAction.trim() || sessionStatus !== "authenticated"} onClick={() => generate(true)} />
        </>}
        <button type="button" className={styles.secondary} disabled={!textDraft.trim() || busy} onClick={downloadText}><Download size={16} aria-hidden />{copy.saveDraft}</button>
      </> : <>
        {resultIsExample && <p className={styles.hint}>{copy.exampleResult}</p>}
        {id === "poster" && result && <div className={styles.posterGrid}>{STUDIO_EXPORT_FORMATS.map((option, i) => (
          <figure key={option.id}>
            <div className={styles.posterArt} style={{ aspectRatio: option.width + " / " + option.height }}>
              <img src={result} alt="" />
              <div className={styles.artText}><strong>{title}</strong><small>{details}</small></div>
            </div>
            <figcaption><button type="button" aria-pressed={format === i} disabled={busy} className={choice(format === i)} onClick={() => setFormat(i)}>{copy[option.id]}</button></figcaption>
          </figure>
        ))}</div>}
        {id === "meme" && result && <div className={styles.memeArt}><img src={result} alt="" /><strong>{caption}</strong></div>}
        {template && !result && <p className={styles.hint}>{busy ? copy.generating : copy.emptyResult}</p>}
        {!template && <div className={styles.compare}>
          <figure><figcaption>{copy.original}</figcaption><img src={photo} alt="" /></figure>
          <figure className={pngTool ? styles.checker : undefined}><figcaption>{copy.result}</figcaption>
            {result ? <img src={result} alt={copy.processedImage} /> : <p>{busy ? copy.generating : copy.emptyResult}</p>}
          </figure>
        </div>}
        <button type="button" className={styles.primary} disabled={!result || busy} onClick={download}>
          <Download size={16} aria-hidden />{copy.savePng}
        </button>
      </>}
    </section>
  </div>;
}
