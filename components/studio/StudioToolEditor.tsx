"use client";

/* eslint-disable @next/next/no-img-element -- User uploads and results use local object URLs. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, ImagePlus, Share2 } from "lucide-react";
import { STUDIO_EXPORT_FORMATS, STUDIO_PHOTO_PRESETS, studioArtworkPath as asset, type StudioCreativeTool, type StudioPhotoPreset, type StudioTool } from "@/lib/studioTools";
import { studioPresetName, studioPublicationPresets, type StudioPublicationPreset } from "@/lib/studioPresetLibrary";
import { STUDIO_SOCIAL_FORMATS, studioOrderedSocialPresets, studioPublishingDesign, studioPublishingPrompt, studioSocialFormat } from "@/lib/studioPublishing";
import { drawStudioPublishingArtwork, renderStudioPublishingArtwork, type StudioPublishingArtwork } from "./studioPublishingArtwork";
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
  socialFormatId?: string;
  logo?: StudioDraftImage;
};

const posterCategories = [["autoStyle", "auto"], ["eventCategory", "event"], ["productCategory", "product"], ["announcementCategory", "announcement"]] as const;
const posterStyles = [["autoStyle", "auto"], ["minimalStyle", "minimal"], ["editorialStyle", "editorial"], ["retroStyle", "retro"]] as const;

const socialPlatforms = [...new Set(STUDIO_SOCIAL_FORMATS.map(format => format.platform))];

function PublishingPreview({ artwork, label }: { artwork: StudioPublishingArtwork; label: string }) {
  const preview = useRef<HTMLCanvasElement>(null);
  const [failedArtwork, setFailedArtwork] = useState<StudioPublishingArtwork>();
  const ratio = Math.min(1, 800 / Math.max(artwork.width, artwork.height));
  const width = Math.round(artwork.width * ratio), height = Math.round(artwork.height * ratio);
  useEffect(() => {
    let active = true;
    const rendered = document.createElement("canvas");
    void drawStudioPublishingArtwork(rendered, { ...artwork, width, height }).then(() => {
      if (active) preview.current?.getContext("2d")?.drawImage(rendered, 0, 0);
    }).catch(() => {
      if (active) setFailedArtwork(artwork);
    });
    return () => { active = false; };
  }, [artwork, width, height]);
  if (failedArtwork === artwork) return <img className={styles.publishingPreview} src={artwork.source} alt={label} />;
  return <canvas ref={preview} className={styles.publishingPreview} width={width} height={height} role="img" aria-label={label} />;
}

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
  const [socialFormatId, setSocialFormatId] = useState("instagram-feed");
  const socialFormat = studioSocialFormat(socialFormatId);
  const dim = poster ? STUDIO_EXPORT_FORMATS[0] : socialFormat;
  const publicationChoices = useMemo(() => social ? studioOrderedSocialPresets(socialFormat.platform)
    : poster ? studioPublicationPresets("poster") : [], [social, poster, socialFormat.platform]);
  const [showAllPresets, setShowAllPresets] = useState(false);
  const [publicationPreset, setPublicationPreset] = useState("");
  const publication = publicationChoices.find(option => option.id === publicationPreset);
  const firstChoices = publicationChoices.slice(0, 8);
  const visibleChoices = !social || showAllPresets ? publicationChoices
    : publication && !firstChoices.includes(publication) ? [...firstChoices, publication] : firstChoices;
  const activePreset = social ? (publication ?? publicationChoices[0]).id : publicationPreset;
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
  const [logo, setLogo] = useState("");
  const [result, setResult] = useState(() => publishing ? asset(publicationChoices[0].artwork)
    : preset ? asset(preset.artwork) : asset(tool.artwork));
  const [resultIsExample, setResultIsExample] = useState(true);
  const [format, setFormat] = useState(() => {
    const style = preset?.style ?? (id === "illustration" ? "watercolor illustration" : "");
    return Math.max(0, artisticOptions.findIndex(([value]) => value === style));
  });
  const [posterBrief, setPosterBrief] = useState("");
  const [posterCategory, setPosterCategory] = useState("auto");
  const [posterStyle, setPosterStyle] = useState("auto");
  const [posterHasText, setPosterHasText] = useState(false);
  const [title, setTitle] = useState("");
  const [customDetails, setDetails] = useState<string>();
  const details = customDetails ?? (id === "meme" ? copy.exampleMemeSituation : "");
  const [customCaption, setCaption] = useState<string>();
  const caption = customCaption ?? copy.exampleMemeCaption;
  const hasReference = photoTool || pngTool || customPhoto;
  const size = !publishing || dim.width === dim.height ? "1024x1024"
    : dim.width > dim.height ? "1536x1024" : "1024x1536";
  const design = useMemo(() => id === "poster" || id === "social-post"
    ? studioPublishingDesign(id, activePreset, posterCategory, posterStyle) : undefined,
  [id, activePreset, posterCategory, posterStyle]);
  const sample = resultIsExample && publishing
    ? publicationChoices.find(option => option.id === design?.presetId) ?? publicationChoices[0] : undefined;
  const exactTitle = posterHasText ? "" : title.trim() || (sample ? studioPresetName(sample, lang) : "");
  const artworkSource = sample && !posterHasText ? asset(sample.artwork) : result;
  const artwork = useMemo<StudioPublishingArtwork | undefined>(() => artworkSource && design ? {
    source: artworkSource, logo: logo || undefined, width: dim.width, height: dim.height,
    design, placement: social ? socialFormat : undefined, title: exactTitle, details, locale: lang,
  } : undefined, [artworkSource, logo, dim, design, social, socialFormat, exactTitle, details, lang]);
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
    setFormat(saved.format);
    setSocialFormatId(studioSocialFormat(saved.socialFormatId, saved.format).id);
    urls.release(logo);
    setLogo(typeof saved.logo === "string" ? saved.logo : saved.logo ? urls.make(saved.logo) : "");
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
      const [photoDraft, resultDraft, logoDraft] = await Promise.all(
        [photo, result, logo].map(captureStudioDraftImage),
      );
      await checkoutDraft.save({
        photo: photoDraft, result: resultDraft, logo: logoDraft, customPhoto, resultIsExample,
        format, title, details, caption, posterBrief, posterCategory, posterStyle, posterHasText, publicationPreset, socialFormatId,
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
        return studioPublishingPrompt({
          kind: id, design: design!, placement: social ? socialFormat : undefined,
          locale: lang, brief: posterBrief, title, details, hasPhoto: hasReference, hasLogo: Boolean(logo),
          category: posterCategory, style: posterStyle,
        });
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

  const download = (share = false) => void task(async () => {
    const blob = artwork ? await renderStudioPublishingArtwork(artwork)
      : pngTool && !resultIsExample ? await fetch(result).then(response => response.blob())
        : await renderStudioImage(result, {
          width: 1080, height: 1080, fit: template ? "cover" : "contain",
          title: id === "meme" ? caption : undefined,
        });
    const filename = "tomverse-" + (publishing ? dim.id : id) + ".png";
    if (share) await shareStudioPng(blob, filename);
    else saveStudioFile(blob, filename);
  });
  const choice = (active: boolean) => active ? styles.choiceActive : styles.secondary;

  return <>
    {social && <section className={styles.publicationChooser}>
      <h2>{copy.socialPlacement}</h2>
      <div className={styles.socialPlacement}>
        <label className={styles.field}>{copy.socialPlatform}
          <select aria-label={copy.socialPlatform} value={socialFormat.platform} disabled={busy} onChange={event => {
            const next = STUDIO_SOCIAL_FORMATS.find(option => option.platform === event.target.value);
            if (next) {
              setSocialFormatId(next.id);
              setShowAllPresets(false);
            }
          }}>
            {socialPlatforms.map(platform => <option key={platform}>{platform}</option>)}
          </select>
        </label>
        <fieldset className={styles.fieldset} disabled={busy}>
          <legend>{copy.socialPublishFormat}</legend>
          <div className={styles.choices}>
            {STUDIO_SOCIAL_FORMATS.filter(option => option.platform === socialFormat.platform).map(option =>
              <button key={option.id} type="button" className={choice(socialFormat.id === option.id)}
                aria-pressed={socialFormat.id === option.id} onClick={() => setSocialFormatId(option.id)}>
                {copy[option.label]} · {option.ratio}
              </button>)}
          </div>
        </fieldset>
      </div>
    </section>}
    {publishing && <section className={styles.publicationChooser}>
      <h2>{poster ? copy.choosePosterPreset : copy.choosePublicationPreset}</h2>
      <div className={styles.publicationChoices} role="group" aria-label={poster ? copy.choosePosterPreset : copy.choosePublicationPreset}>
        {visibleChoices.map(option => <button key={option.id} type="button" className={styles.publicationChoice}
          disabled={busy} aria-pressed={design?.presetId === option.id} onClick={() => selectPublication(option)}>
          <img src={asset(option.artwork)} alt="" width={150} height={150} loading="lazy" />
          <span>{studioPresetName(option, lang)}</span>
        </button>)}
      </div>
      {social && <button type="button" className={styles.secondary} disabled={busy} aria-expanded={showAllPresets}
        onClick={() => setShowAllPresets(previous => !previous)}>
        {showAllPresets ? copy.showFewerSocialStyles : copy.showMoreSocialStyles}
      </button>}
    </section>}
    <div className={styles.workbench}>
    <section className={styles.panel}>
      <h2>{copy.inputs}</h2>
      <div className={publishing ? styles.photoInput : styles.fileRow}>
        {photo ? <img src={photo} alt="" width={56} height={56} /> : <ImagePlus size={26} aria-hidden />}
        <span>{publishing ? copy.optionalPublishingPhoto : photoTool || pngTool ? copy.originalPhoto : copy.backgroundArtwork}</span>
        <StudioFileButton label={photo ? copy.changeImage : copy.uploadPhoto} disabled={busy} onInvalid={() => report(copy.invalidImage, true)} onFile={changePhoto} />
        {publishing && photo && <button type="button" className={styles.secondary} disabled={busy} onClick={removePhoto}>{copy.removePhoto}</button>}
      </div>
      {publishing && <>
        <div className={styles.photoInput}>
          {logo ? <img src={logo} alt="" width={56} height={56} /> : <ImagePlus size={26} aria-hidden />}
          <span>{copy.optionalPublishingLogo}</span>
          <StudioFileButton label={copy.uploadPublishingLogo} disabled={busy} onInvalid={() => report(copy.invalidImage, true)} onFile={file => {
            urls.release(logo);
            setLogo(urls.make(file));
          }} />
          {logo && <button type="button" className={styles.secondary} disabled={busy} onClick={() => {
            urls.release(logo);
            setLogo("");
          }}>{copy.removePublishingLogo}</button>}
        </div>
        <label className={styles.field}>{social ? copy.socialPostBrief : copy.posterBrief}
          <textarea rows={4} maxLength={500} value={posterBrief} disabled={busy} onChange={event => setPosterBrief(event.target.value)} />
        </label>
      </>}
      {poster && <>
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
        <label className={styles.field}>{copy.publishingHeadline}
          <input value={title} maxLength={65} disabled={busy} onChange={event => setTitle(event.target.value)} />
        </label>
      )}
      {!pngTool && <label className={styles.field}>{
        id === "meme" ? copy.situation : publishing ? copy.publishingDetails : copy.detailsToKeep
      }<textarea value={details} maxLength={500} rows={publishing ? 2 : 3} disabled={busy} onChange={event => setDetails(event.target.value)} /></label>}
      {id === "meme" && <label className={styles.field}>{copy.imageCaption}<input value={caption} maxLength={55} disabled={busy} onChange={event => setCaption(event.target.value)} /></label>}
      {photoTool && <fieldset className={styles.fieldset} disabled={busy}>
        <legend>{id === "illustration" ? copy.drawingStyle : copy.exaggeration}</legend>
        <div className={styles.choices}>{artisticOptions.map((option, i) => <button type="button" key={option[0]} className={choice(format === i)} aria-pressed={format === i} onClick={() => setFormat(i)}>{option[1]}</button>)}</div>
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
        {artwork && <figure className={styles.publishingFigure} data-vertical={dim.width < dim.height || undefined}>
          <PublishingPreview artwork={artwork} label={copy.processedImage} />
          <figcaption>{social ? socialFormat.platform + " · " + copy[socialFormat.label] + " · " : ""}
            {dim.width} × {dim.height} · PNG
          </figcaption>
        </figure>}
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
