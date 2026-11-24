"use client";

/* eslint-disable @next/next/no-img-element -- User inputs and generated art use local URLs. */
import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Camera, Download, Share2 } from "lucide-react";
import { parseStudioAnalysis, studioAnalysisPrompt, type StudioAnalysisReport } from "@/lib/studioCreativeAnalysis";
import { STUDIO_EXPORT_FORMATS, studioArtworkPath, type StudioCreativeTool } from "@/lib/studioTools";
import { studioOutputLanguage } from "@/locales/studio";
import { makeStudioImageReference, renderStudioImage, saveStudioFile, shareStudioPng } from "./studioCanvas";
import { captureStudioDraftImage, useStudioCheckoutDraft, type StudioDraftImage } from "./studioCheckoutDraft";
import { StudioFileButton, StudioStatus, useStudioCopy, useStudioTask, useStudioUrls } from "./StudioControls";
import { isStudioCreditShortfall, StudioCreditRecovery } from "./StudioCreditRecovery";
import { StudioGenerateButton, StudioQuoteHint } from "./StudioGenerationControls";
import { createStudioImageRunner, generateStudioText, StudioGenerationError, useStudioImageQuote } from "./studioGenerationClient";
import { renderStudioPortraitReport } from "./studioPortraitReport";
import styles from "./studio.module.css";

const genres = [
  ["autoStyle", "auto"], ["fantasy", "fantasy"], ["scienceFiction", "science fiction"], ["modern", "modern day"],
] as const;
const artStyles = [
  ["autoStyle", "auto"], ["realistic", "realistic"], ["anime", "anime"], ["comic", "comic illustration"],
  ["render3d", "3D render"], ["pixelArt", "pixel art"],
] as const;
const shareFormats = STUDIO_EXPORT_FORMATS.filter(format => format.id !== "poster");
const samplePhoto = "/studio/selfie.png";

type CreativeDraft = {
  photo: StudioDraftImage;
  result: StudioDraftImage;
  report: StudioAnalysisReport | null;
  description: string;
  name: string;
  role: string;
  genre: string;
  artStyle: string;
  story: boolean;
};

export function StudioCreativeEditor({ tool }: { tool: StudioCreativeTool }) {
  const { id } = tool;
  const character = id === "character-maker";
  const { copy, lang } = useStudioCopy();
  const { status: sessionStatus } = useSession();
  const urls = useStudioUrls();
  const { busy, status, report, task } = useStudioTask();
  const active = useRef<AbortController | null>(null);
  const [runImage] = useState(createStudioImageRunner);
  const [photo, setPhoto] = useState("");
  const [result, setResult] = useState("");
  const [analysis, setAnalysis] = useState<StudioAnalysisReport | null>(null);
  const [description, setDescription] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [genre, setGenre] = useState("auto");
  const [artStyle, setArtStyle] = useState("auto");
  const [story, setStory] = useState(false);
  const [creditError, setCreditError] = useState<StudioGenerationError | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);
  const imageQuote = useStudioImageQuote("1024x1024", false, character);
  const checkout = useStudioCheckoutDraft<CreativeDraft>(id, saved => {
    urls.release(photo);
    urls.release(result);
    setPhoto(typeof saved.photo === "string" ? saved.photo : urls.make(saved.photo));
    setResult(typeof saved.result === "string" ? saved.result : urls.make(saved.result));
    setAnalysis(saved.report);
    setDescription(saved.description);
    setName(saved.name);
    setRole(saved.role);
    setGenre(saved.genre);
    setArtStyle(saved.artStyle);
    setStory(saved.story);
    report(copy.checkoutDraftRestored);
  });

  async function saveDraft() {
    try {
      const [savedPhoto, savedResult] = await Promise.all([captureStudioDraftImage(photo), captureStudioDraftImage(result)]);
      await checkout.save({ photo: savedPhoto, result: savedResult, report: analysis, description, name, role, genre, artStyle, story });
      setDraftSaved(true);
    } catch {
      setDraftSaved(false);
    }
  }

  useEffect(() => () => active.current?.abort(), []);

  function pickPhoto(source: string) {
    urls.release(photo);
    urls.release(result);
    setPhoto(source);
    setResult("");
    setAnalysis(null);
  }

  function generate() {
    void task(async () => {
      const controller = new AbortController();
      active.current = controller;
      const { signal } = controller;
      try {
        if (character) {
          if (!imageQuote.quote) return;
          const prompt = "Create an original character portrait for a story or game. Show the character and signature details clearly. Use a well-composed square image, with no text, logo or watermark. Brief: " +
            JSON.stringify({ description: description.trim(), name: name.trim(), role: role.trim(), genre, artStyle });
          const output = await runImage({
            inputKey: id, prompt, size: imageQuote.quote.size, quote: imageQuote.quote, signal,
          });
          signal.throwIfAborted();
          urls.release(result);
          setResult(urls.make(output));
        } else {
          const prompt = studioAnalysisPrompt(id, studioOutputLanguage[lang]);
          const text = await generateStudioText(prompt, signal, await makeStudioImageReference(photo));
          signal.throwIfAborted();
          const next = parseStudioAnalysis(id, text);
          const reportImage = next && await renderStudioPortraitReport(photo, next, {
            interpretation: copy.photoInterpretation,
            color: {
              title: [copy.colorReportTitleLead, copy.colorReportTitleRest],
              season: copy.colorSeason, recommended: copy.colorSuggestions, comparison: copy.avoidColors,
              features: [copy.hairColor, copy.eyeColor, copy.skinColor],
              profile: [copy.colorUndertone, copy.colorContrast, copy.colorOverallTone],
              palettes: [copy.recommendPalette, copy.comparePalette], basis: copy.colorReportBasis,
            },
            face: {
              title: copy.faceAnalysisTitle, lead: copy.faceReportLead, overall: copy.faceOverall, breakdown: copy.faceBreakdown,
              tips: copy.faceRecommendations, notes: copy.faceAssessmentNotes,
              thirds: [copy.faceUpperThird, copy.faceMiddleThird, copy.faceLowerThird],
            },
          }, lang);
          signal.throwIfAborted();
          urls.release(result);
          setResult(reportImage ? urls.make(reportImage) : "");
          setAnalysis(next);
          if (!next) report(copy.photoRetry, true);
        }
        void checkout.clear();
      } catch (error) {
        if (signal.aborted) return;
        if (isStudioCreditShortfall(error)) {
          await saveDraft();
          if (signal.aborted) void checkout.clear();
          else setCreditError(error);
          return;
        }
        if (character && error instanceof StudioGenerationError && error.status === 409) imageQuote.reload();
        throw error;
      } finally {
        active.current = null;
      }
    });
  }

  const ready = Boolean(result);
  const outcome = analysis && ("score" in analysis
    ? new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(analysis.score) + " / 10"
    : analysis.season);

  function exportResult(share: boolean) {
    void task(async () => {
      const output = !character && !story
        ? await captureStudioDraftImage(result)
        : await renderStudioImage(result, { width: 1080, height: story ? 1920 : 1080, fit: "contain", bleed: story });
      if (typeof output === "string") return;
      const filename = "tomverse-" + id + (story ? "-story" : "-feed") + ".png";
      if (share) await shareStudioPng(output, filename);
      else saveStudioFile(output, filename);
    });
  }

  return <>
    <div className={styles.workbench}>
      <section className={styles.panel}>
        <h2>{copy.inputs}</h2>
        {character ? <>
          <label className={styles.field}>{copy.characterBrief}
            <textarea rows={4} maxLength={500} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} />
          </label>
          <label className={styles.field}>{copy.characterName}
            <input maxLength={65} value={name} disabled={busy} onChange={event => setName(event.target.value)} />
          </label>
          <label className={styles.field}>{copy.characterRole}
            <input maxLength={80} value={role} disabled={busy} onChange={event => setRole(event.target.value)} />
          </label>
          <label className={styles.field}>{copy.characterGenre}
            <select aria-label={copy.characterGenre} value={genre} disabled={busy} onChange={event => setGenre(event.target.value)}>
              {genres.map(([label, value]) => <option key={value} value={value}>{copy[label]}</option>)}
            </select>
          </label>
          <label className={styles.field}>{copy.drawingStyle}
            <select aria-label={copy.drawingStyle} value={artStyle} disabled={busy} onChange={event => setArtStyle(event.target.value)}>
              {artStyles.map(([label, value]) => <option key={value} value={value}>{copy[label]}</option>)}
            </select>
          </label>
        </> : <>
          <div className={styles.photoInput}>
            {photo ? <img src={photo} alt={copy.originalPhoto} width={72} height={72} /> : <Camera size={28} aria-hidden />}
            <StudioFileButton label={photo ? copy.changePhoto : copy.uploadPhoto} disabled={busy}
              onFile={file => pickPhoto(urls.make(file))} onInvalid={() => report(copy.invalidImage, true)} />
          </div>
          <p className={styles.hint}>{copy.photoGuidance}</p>
          <button type="button" className={styles.secondary} disabled={busy || photo === samplePhoto}
            onClick={() => pickPhoto(samplePhoto)}>{copy.samplePhoto}</button>
        </>}
        <div className={styles.creativeGenerate}>
          <StudioGenerateButton label={copy.generate} busy={busy}
            disabled={character ? !description.trim() || !imageQuote.quote : !photo || sessionStatus !== "authenticated"}
            onClick={generate} />
        </div>
        {character ? <StudioQuoteHint {...imageQuote} /> : sessionStatus === "unauthenticated" && <StudioQuoteHint error={401} />}
        <StudioStatus status={status} />
      </section>
      <section className={styles.panel} aria-busy={busy} data-testid={id + "-result"}>
        <h2>{copy.resultPreview}</h2>
        {character ? <>
          {!result && !busy && <p className={styles.hint}>{copy.exampleResult}</p>}
          {(result || !busy) && <img className={styles.characterArt} src={result || studioArtworkPath(tool.artwork)}
            alt={result ? copy[tool.title] : ""} />}
        </> : <>
          {!result && !busy && <p className={styles.hint}>{copy.emptyResult}</p>}
          {result && <a className={styles.reportPreview} href={result} target="_blank" rel="noreferrer">
            <img src={result} alt={outcome ? copy[tool.title] + " · " + outcome : copy[tool.title]} />
          </a>}
          {analysis && <>
            <div className="sr-only">
              <h3>{outcome}</h3>
              <p>{analysis.summary}</p>
              {"observations" in analysis ? <>
                {analysis.metrics && <ul>{analysis.metrics.map((item, index) => <li key={index}>{item.label} {item.score} / 10</li>)}</ul>}
                <ul>{analysis.observations.map((item, index) => <li key={index}>{item.label} {item.score} / 10. {item.note}</li>)}</ul>
                <ul>{analysis.tips.map((tip, index) => <li key={index}>{tip.label}. {tip.note}</li>)}</ul>
              </> : <>
                <p>{copy.hairColor} {analysis.features.hair.name} · {copy.eyeColor} {analysis.features.eyes.name} · {copy.skinColor} {analysis.features.skin.name}</p>
                {analysis.profile && <p>{copy.colorUndertone} {analysis.profile.undertone.name} · {copy.colorContrast} {analysis.profile.contrast.name} · {copy.colorOverallTone} {analysis.profile.tone.name}</p>}
                <p>{copy.colorSuggestions} · {analysis.recommended.map(item => item.name + " " + item.color).join(", ")}</p>
                <p>{copy.avoidColors} · {analysis.comparison.map(item => item.name + " " + item.color).join(", ")}</p>
              </>}
            </div>
            <p className={styles.hint}>{copy.photoInterpretation}</p>
          </>}
        </>}
        {!ready && busy && <p className={styles.hint}>{copy.generating}</p>}
        {ready && <div className={styles.creativeActions}>
          <label className={styles.field}>{copy.template}
            <select aria-label={copy.template} value={story ? "story" : "feed"} disabled={busy} onChange={event => setStory(event.target.value === "story")}>
              {shareFormats.map(format => <option key={format.id} value={format.id}>{copy[format.id]}</option>)}
            </select>
          </label>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => exportResult(false)}>
            <Download size={16} aria-hidden />{copy.savePng}
          </button>
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => exportResult(true)}>
            <Share2 size={16} aria-hidden />{copy.shareImage}
          </button>
        </div>}
      </section>
    </div>
    <StudioCreditRecovery error={creditError} returnTo={"/studio/" + id + "?lang=" + encodeURIComponent(lang)}
      draftSaved={draftSaved} onSaveDraft={saveDraft} onClose={async () => {
        await checkout.clear();
        setCreditError(null);
      }} />
  </>;
}
