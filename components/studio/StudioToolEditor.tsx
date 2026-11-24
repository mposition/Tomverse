"use client";

/* eslint-disable @next/next/no-img-element -- User uploads and results use local object URLs. */
import { useEffect, useRef, useState } from "react";
import { Download, ImagePlus, Share2 } from "lucide-react";
import { STUDIO_EXPORT_FORMATS, STUDIO_PHOTO_PRESETS, studioArtworkPath as asset, type StudioCreativeTool, type StudioPhotoPreset, type StudioTool } from "@/lib/studioTools";
import { studioPresetName, studioPublicationPresets, type StudioPublicationPreset } from "@/lib/studioPresetLibrary";
import { applyStudioSubjectMask, makeStudioImageReference, renderStudioImage, saveStudioFile, shareStudioPng } from "./studioCanvas";
import { StudioFileButton, StudioStatus, useStudioCopy, useStudioTask, useStudioUrls } from "./StudioControls";
import { StudioGenerateButton, StudioQuoteHint } from "./StudioGenerationControls";
import { createStudioImageRunner, StudioGenerationError, useStudioImageQuote } from "./studioGenerationClient";
import { captureStudioDraftImage, useStudioCheckoutDraft, type StudioDraftImage } from "./studioCheckoutDraft";
import { isStudioCreditShortfall, StudioCreditRecovery } from "./StudioCreditRecovery";
import styles from "./studio.module.css";

type ToolCheckoutDraft = {
  photo: StudioDraftImage;
  result: StudioDraftImage;
  customPhoto: boolean;
  resultIsExample: boolean;
  format: number;
  title: string;
  details: string;
  caption: string;
  posterBrief?: string;
  posterCategory?: string;
  posterStyle?: string;
  posterHasText?: boolean;
  publicationPreset?: string;
};

const posterCategories = [["autoStyle", "auto"], ["eventCategory", "event"], ["productCategory", "product"], ["announcementCategory", "announcement"]] as const;
const posterStyles = [["autoStyle", "auto"], ["minimalStyle", "minimal"], ["editorialStyle", "editorial"], ["retroStyle", "retro"]] as const;

export function StudioToolEditor({ tool, preset }: {
  tool: Exclude<StudioTool, { id: "stickers" } | StudioCreativeTool>;
  preset?: StudioPhotoPreset;
}) {
  const { copy, lang } = useStudioCopy();
  const urls = useStudioUrls();
  const { busy, status, report, task } = useStudioTask();
  const active = useRef<AbortController | null>(null);
  const [runImage] = useState(createStudioImageRunner);
  const { id } = tool;
  const poster = id === "poster";
  const social = id === "social-post";
  const publishing = poster || social;
  const formats = STUDIO_EXPORT_FORMATS.map((option, index) => ({ ...option, index }))
    .filter(option => poster ? option.id === "poster" : option.id !== "poster");
  const publicationChoices = publishing ? studioPublicationPresets(id) : [];
  const [publicationPreset, setPublicationPreset] = useState("");
  const publication = publicationChoices.find(option => option.id === publicationPreset);
  const photoTool = id === "illustration" || id === "caricature";
  const pngTool = id === "transparent-png";
  const template = id === "meme" || publishing;
  const illustrationPresets = STUDIO_PHOTO_PRESETS.slice(0, 6).filter(item => item.id !== "watercolor" && item.style);
  if (preset?.style && preset.id !== "watercolor" && !illustrationPresets.some(item => item.id === preset.id)) illustrationPresets.push(preset);
  const artisticOptions = id === "illustration"
    ? [
      ["watercolor illustration", copy.watercolor], ["comic illustration", copy.comic], ["line art", copy.lineArt],
      ...illustrationPresets.map(item => [item.style, studioPresetName(item, lang)]),
    ]
    : [["subtle", copy.subtle], ["playful", copy.playful], ["bold", copy.bold]];
  const [photo, setPhoto] = useState(() => publishing ? "" : photoTool ? asset(preset?.id.startsWith("pet-") ? "cat" : "selfie") : asset(tool.artwork));
  const [customPhoto, setCustomPhoto] = useState(false);
  const [result, setResult] = useState(() => preset ? "/studio/" + preset.artwork : asset(tool.artwork));
  const [resultIsExample, setResultIsExample] = useState(true);
  const [format, setFormat] = useState(() => {
    if (social) return 1;
    const style = preset?.style ?? (id === "illustration" ? "watercolor illustration" : "");
    return Math.max(0, artisticOptions.findIndex(([value]) => value === style));
  });
  const [posterBrief, setPosterBrief] = useState("");
  const [posterCategory, setPosterCategory] = useState("auto");
  const [posterStyle, setPosterStyle] = useState("auto");
  const [posterHasText, setPosterHasText] = useState(poster);
  const [title, setTitle] = useState("");
  const [customDetails, setDetails] = useState<string>();
  const details = customDetails ?? (id === "meme" ? copy.exampleMemeSituation : "");
  const [customCaption, setCaption] = useState<string>();
  const caption = customCaption ?? copy.exampleMemeCaption;
  const hasReference = photoTool || pngTool || customPhoto;
  const size = publishing && STUDIO_EXPORT_FORMATS[format]?.id !== "feed" ? "1024x1536" : "1024x1024";
  const imageQuote = useStudioImageQuote(size, hasReference, true, publishing ? "1024x1024" : undefined);
  const [creditError, setCreditError] = useState<StudioGenerationError | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);
  const checkoutDraft = useStudioCheckoutDraft<ToolCheckoutDraft>(id, saved => {
    urls.release(photo);
    urls.release(result);
    setPhoto(publishing && !saved.customPhoto ? "" : typeof saved.photo === "string" ? saved.photo : urls.make(saved.photo));
    setResult(typeof saved.result === "string" ? saved.result : urls.make(saved.result));
    setCustomPhoto(saved.customPhoto);
    setResultIsExample(saved.resultIsExample);
    setFormat(publishing && !formats.some(option => option.index === saved.format) ? formats[0].index : saved.format);
    setTitle(saved.title);
    setDetails(saved.details);
    setCaption(saved.caption);
    setPosterBrief(saved.posterBrief ?? "");
    setPosterCategory(saved.posterCategory ?? "auto");
    setPosterStyle(saved.posterStyle ?? "auto");
    setPosterHasText(saved.posterHasText ?? (poster && saved.resultIsExample && saved.result === asset(tool.artwork)));
    setPublicationPreset(saved.publicationPreset ?? "");
    report(copy.checkoutDraftRestored);
  });

  async function saveCheckoutDraft() {
    try {
      const [photoDraft, resultDraft] = await Promise.all([captureStudioDraftImage(photo), captureStudioDraftImage(result)]);
      await checkoutDraft.save({
        photo: photoDraft, result: resultDraft, customPhoto, resultIsExample,
        format, title, details, caption, posterBrief, posterCategory, posterStyle, posterHasText, publicationPreset,
      });
      setDraftSaved(true);
    } catch {
      setDraftSaved(false);
    }
  }

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

  const removePhoto = () => {
    urls.release(photo);
    setPhoto("");
    setCustomPhoto(false);
  };

  function selectPublication(option: StudioPublicationPreset) {
    setPublicationPreset(option.id);
    urls.release(result);
    setResult(asset(option.artwork));
    setResultIsExample(true);
    setPosterHasText(false);
  }

  const imagePrompt = () => {
    switch (id) {
      case "meme":
        return (hasReference ? "Transform the supplied reference into " : "Create ") +
          "one funny, shareable image depicting this situation: " + details + ". Leave room at the top for a caption. Do not draw text. Caption context: " + caption;
      case "illustration":
        return "Transform the attached photo using this visual style: " + artisticOptions[format]?.[0] + ". Preserve the subject's identity and recognisable details. Direction: " + details;
      case "caricature":
        return "Draw a recognisable caricature of the person in the attached photo. Exaggeration: " + artisticOptions[format][0] + ". Features to keep: " + details;
      case "poster":
      case "social-post":
        return (hasReference ? "Incorporate the attached logo or photo when appropriate. " : "") +
          (poster ? "Design a finished print poster" : "Design a finished social media " + STUDIO_EXPORT_FORMATS[format].id + " image") +
          " with strong visual hierarchy and a clear focal point. " +
          (publication ? "Follow this template direction: " + publication.direction + ". " : "") +
          (title.trim() ? "Leave the upper quarter free for the exact title and details to be added separately. Do not draw text. "
            : "Create a concise headline using the language of the brief. Typeset the essential details clearly and keep all text within generous safe margins. ") +
          "Design brief: " + JSON.stringify({ description: posterBrief.trim(), category: posterCategory, style: posterStyle, title: title.trim(), details: details.trim() });
      case "transparent-png":
        return "Produce a square grayscale segmentation matte of the foreground subject. Subject pixels are white, background pixels black, and partially transparent edges gray. Do not reproduce the image, move, resize or crop anything. Match the exact original subject boundaries and keep transparent padding black.";
      default:
        return "";
    }
  };

  const generate = () => void task(async () => {
    const controller = new AbortController();
    active.current = controller;
    const { signal } = controller;
    try {
      if (!imageQuote.quote) return;
      const generated = await runImage({
        inputKey: hasReference ? photo : id,
        prompt: imagePrompt(),
        size: imageQuote.quote.size,
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
      if (publishing) setPosterHasText(!title.trim());
      void checkoutDraft.clear();
    } catch (error) {
      if (signal.aborted) return;
      if (isStudioCreditShortfall(error)) {
        await saveCheckoutDraft();
        if (signal.aborted) void checkoutDraft.clear();
        else setCreditError(error);
        return;
      }
      if (error instanceof StudioGenerationError && error.status === 409) imageQuote.reload();
      throw error;
    } finally {
      active.current = null;
    }
  });

  const valid = (!publishing || Boolean(title.trim() || posterBrief.trim())) && (id !== "meme" || Boolean(details.trim()));
  const generationLabel = pngTool ? copy.removeBackground : copy.generate;

  const posterTitle = posterHasText ? undefined : title || (resultIsExample && publication ? studioPresetName(publication, lang) : undefined);
  const posterDetails = posterHasText ? undefined : details;
  const download = (share = false) => void task(async () => {
    const dim = publishing ? STUDIO_EXPORT_FORMATS[format] : { width: 1080, height: 1080, id };
    const blob = pngTool && !resultIsExample ? await fetch(result).then(response => response.blob())
      : await renderStudioImage(result, {
        width: dim.width, height: dim.height, fit: template && !posterHasText ? "cover" : "contain",
        title: id === "meme" ? caption : publishing ? posterTitle : undefined,
        subtitle: publishing ? posterDetails : undefined,
        bleed: posterHasText,
      });
    const filename = "tomverse-" + dim.id + ".png";
    if (share) await shareStudioPng(blob, filename);
    else saveStudioFile(blob, filename);
  });
  const choice = (active: boolean) => active ? styles.choiceActive : styles.secondary;

  return <>
    {publishing && <section className={styles.publicationChooser}>
      <h2>{copy.choosePublicationPreset}</h2>
      <div className={styles.publicationChoices} role="group" aria-label={copy.choosePublicationPreset}>
        {publicationChoices.map(option => <button key={option.id} type="button" className={styles.publicationChoice}
          disabled={busy} aria-pressed={publicationPreset === option.id} onClick={() => selectPublication(option)}>
          <img src={asset(option.artwork)} alt="" width={150} height={150} loading="lazy" />
          <span>{studioPresetName(option, lang)}</span>
        </button>)}
      </div>
    </section>}
    <div className={styles.workbench}>
    <section className={styles.panel}>
      <h2>{copy.inputs}</h2>
      <div className={publishing ? styles.photoInput : styles.fileRow}>
        {photo ? <img src={photo} alt="" width={56} height={56} /> : <ImagePlus size={26} aria-hidden />}
        <span>{publishing ? copy.optionalArtwork : photoTool || pngTool ? copy.originalPhoto : copy.backgroundArtwork}</span>
        <StudioFileButton label={photo ? copy.changeImage : copy.uploadPhoto} disabled={busy} onInvalid={() => report(copy.invalidImage, true)} onFile={changePhoto} />
        {publishing && photo && <button type="button" className={styles.secondary} disabled={busy} onClick={removePhoto}>{copy.removePhoto}</button>}
      </div>
      {publishing && <>
        <label className={styles.field}>{social ? copy.socialPostBrief : copy.posterBrief}
          <textarea rows={4} maxLength={500} value={posterBrief} disabled={busy} onChange={event => setPosterBrief(event.target.value)} />
        </label>
        <label className={styles.field}>{copy.posterCategory}
          <select aria-label={copy.posterCategory} value={posterCategory} disabled={busy} onChange={event => setPosterCategory(event.target.value)}>
            {posterCategories.map(([label, value]) => <option key={value} value={value}>{copy[label]}</option>)}
          </select>
        </label>
        <label className={styles.field}>{copy.posterDesignStyle}
          <select aria-label={copy.posterDesignStyle} value={posterStyle} disabled={busy} onChange={event => setPosterStyle(event.target.value)}>
            {posterStyles.map(([label, value]) => <option key={value} value={value}>{copy[label]}</option>)}
          </select>
        </label>
      </>}
      {publishing && (
        <label className={styles.field}>{poster ? copy.eventTitle : copy.imageCaption}
          <input value={title} maxLength={65} disabled={busy} onChange={event => setTitle(event.target.value)} />
        </label>
      )}
      {!pngTool && <label className={styles.field}>{
        id === "meme" ? copy.situation : poster ? copy.dateAndPlace : copy.detailsToKeep
      }<textarea value={details} maxLength={500} rows={publishing ? 2 : 3} disabled={busy} onChange={event => setDetails(event.target.value)} /></label>}
      {id === "meme" && <label className={styles.field}>{copy.imageCaption}<input value={caption} maxLength={55} disabled={busy} onChange={event => setCaption(event.target.value)} /></label>}
      {photoTool && <fieldset className={styles.fieldset} disabled={busy}>
        <legend>{id === "illustration" ? copy.drawingStyle : copy.exaggeration}</legend>
        <div className={styles.choices}>{artisticOptions.map((option, i) => <button type="button" key={option[0]} className={choice(format === i)} aria-pressed={format === i} onClick={() => setFormat(i)}>{option[1]}</button>)}</div>
      </fieldset>}
      {social && <fieldset className={styles.fieldset} disabled={busy}>
        <legend>{copy.template}</legend>
        <div className={styles.choices}>{formats.map(option => <button type="button" key={option.id} className={choice(format === option.index)}
          aria-pressed={format === option.index} onClick={() => setFormat(option.index)}>{copy[option.id]}</button>)}</div>
      </fieldset>}
      <StudioGenerateButton label={generationLabel} busy={busy}
        disabled={!valid || !imageQuote.quote}
        onClick={() => generate()} />
      <StudioQuoteHint {...imageQuote} />
      <StudioStatus status={status} />
    </section>
    <section className={styles.panel} aria-busy={busy}>
      <h2>{copy.resultPreview}</h2>
        {resultIsExample && <p className={styles.hint}>{copy.exampleResult}</p>}
        {publishing && result && <div className={styles.posterGrid} data-poster={poster || undefined}>{formats.map(option => (
          <figure key={option.id}>
            <div className={styles.posterArt} data-contained={posterHasText || undefined} style={{ aspectRatio: option.width + " / " + option.height }}>
              {posterHasText && <img className={styles.posterBleed} src={result} alt="" />}
              <img src={result} alt="" />
              {posterTitle && <div className={styles.artText}><strong>{posterTitle}</strong><small>{posterDetails}</small></div>}
            </div>
            {social && <figcaption><button type="button" aria-pressed={format === option.index} disabled={busy}
              className={choice(format === option.index)} onClick={() => setFormat(option.index)}>{copy[option.id]}</button></figcaption>}
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
        <button type="button" className={styles.primary} disabled={!result || busy} onClick={() => download()}>
          <Download size={16} aria-hidden />{copy.savePng}
        </button>
        {publishing && <button type="button" className={styles.secondary} disabled={!result || busy} onClick={() => download(true)}>
          <Share2 size={16} aria-hidden />{copy.shareImage}
        </button>}
    </section>
  </div>
    <StudioCreditRecovery error={creditError} returnTo={"/studio/" + id + "?" + new URLSearchParams({ lang, ...(preset ? { preset: preset.id } : {}) })}
      draftSaved={draftSaved} onSaveDraft={saveCheckoutDraft} onClose={async () => {
        await checkoutDraft.clear();
        setCreditError(null);
      }} />
  </>;
}
