"use client";

/* eslint-disable @next/next/no-img-element -- User inputs and generated art use local URLs. */
import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Camera, Download } from "lucide-react";
import { parseStudioAnalysis, studioAnalysisPrompt, type StudioAnalysisReport } from "@/lib/studioCreativeAnalysis";
import { STUDIO_CHARACTER_PRESETS, studioCharacterPrompt, type StudioCharacterPresetId } from "@/lib/studioCharacterPrompt";
import { STUDIO_EXPORT_FORMATS, studioArtworkPath, type StudioCreativeTool } from "@/lib/studioTools";
import { studioOutputLanguage } from "@/locales/studio";
import { makeStudioImageReference, readStudioBlob, renderStudioImage, saveStudioFile } from "./studioCanvas";
import { StudioImageShare } from "./StudioImageShare";
import { captureStudioDraftImage, useStudioCheckoutDraft, type StudioDraftImage } from "./studioCheckoutDraft";
import { StudioFileButton, StudioStatus, useStudioCopy, useStudioTask, useStudioUrls } from "./StudioControls";
import { isStudioCreditShortfall, StudioCreditRecovery } from "./StudioCreditRecovery";
import { StudioGenerateButton, StudioQuoteHint } from "./StudioGenerationControls";
import { createStudioImageRunner, generateStudioText, StudioGenerationError, useStudioImageQuote } from "./studioGenerationClient";
import { renderStudioPortraitReport } from "./studioPortraitReport";
import styles from "./studio.module.css";

const characterPresets = STUDIO_CHARACTER_PRESETS;
type CharacterPreset = StudioCharacterPresetId;
const shareFormats = STUDIO_EXPORT_FORMATS.filter(format => format.id !== "poster");

type CreativeDraft = {
  photo: StudioDraftImage;
  result: StudioDraftImage;
  report: StudioAnalysisReport | null;
  characterPreset?: CharacterPreset;
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
  const previousReports = useRef(new Map<string, StudioAnalysisReport>());
  const [runImage] = useState(createStudioImageRunner);
  const [photo, setPhoto] = useState("");
  const [result, setResult] = useState("");
  const [analysis, setAnalysis] = useState<StudioAnalysisReport | null>(null);
  const [presetId, setPresetId] = useState<CharacterPreset>(characterPresets[0].id);
  const preset = characterPresets.find(choice => choice.id === presetId) ?? characterPresets[0];
  const [story, setStory] = useState(false);
  const [creditError, setCreditError] = useState<StudioGenerationError | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);
  const photoreal = "photoreal" in preset;
  const imageQuote = useStudioImageQuote("1024x1024", true, character, undefined,
    photoreal ? "live-action-character" : "stylized-character");
  const checkout = useStudioCheckoutDraft<CreativeDraft>(id, saved => {
    urls.release(photo);
    urls.release(result);
    setPhoto(typeof saved.photo === "string" ? saved.photo : urls.make(saved.photo));
    setResult(typeof saved.result === "string" ? saved.result : urls.make(saved.result));
    setAnalysis(saved.report);
    setPresetId(saved.characterPreset ?? characterPresets[0].id);
    setStory(saved.story);
    report(copy.checkoutDraftRestored);
  });

  async function saveDraft() {
    try {
      const [savedPhoto, savedResult] = await Promise.all([captureStudioDraftImage(photo), captureStudioDraftImage(result)]);
      await checkout.save({ photo: savedPhoto, result: savedResult, report: analysis, characterPreset: presetId, story });
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
    if (!photo) return;
    void task(async () => {
      const controller = new AbortController();
      active.current = controller;
      const { signal } = controller;
      try {
        if (character) {
          if (!imageQuote.quote) return;
          const output = await runImage({
            inputKey: photo, prompt: studioCharacterPrompt(preset), size: imageQuote.quote.size, quote: imageQuote.quote,
            reference: () => makeStudioImageReference(photo),
            signal,
          });
          signal.throwIfAborted();
          urls.release(result);
          setResult(urls.make(output));
        } else {
          const image = await makeStudioImageReference(photo);
          const digest = await crypto.subtle.digest("SHA-256", await image.arrayBuffer());
          const key = `${id}/${lang}/${new Uint8Array(digest).join(",")}`;
          let next: StudioAnalysisReport | null = previousReports.current.get(key) ?? null;
          // The answer is JSON written as free text: one that does not parse is asked for once more.
          for (let attempt = 0; !next; attempt++) {
            const text = await generateStudioText(studioAnalysisPrompt(id, studioOutputLanguage[lang]), signal, image);
            signal.throwIfAborted();
            try {
              next = parseStudioAnalysis(id, text);
              if (!next) break;
            } catch {
              if (attempt === 0) continue;
              report(copy.analysisIncomplete, true);
              return;
            }
          }
          signal.throwIfAborted();
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
          if (next) previousReports.current.set(key, next);
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

  const filename = "tomverse-" + id + (story ? "-story" : "-feed") + ".png";
  const prepareImage = () => !character && !story
    ? readStudioBlob(result)
    : renderStudioImage(result, { width: 1080, height: story ? 1920 : 1080, fit: "contain", bleed: story });
  const sampleReport = `/studio/${id}-sample.${lang === "ko" ? "ko" : "en"}.webp`;

  const generateButton = <StudioGenerateButton label={copy.generate} busy={busy}
    disabled={!photo || (character ? !imageQuote.quote : sessionStatus !== "authenticated")}
    onClick={generate} />;
  const resultActions = <div className={styles.creativeActions}>
    {ready && <label className={styles.field}>{copy.template}
      <select aria-label={copy.template} value={story ? "story" : "feed"} disabled={busy} onChange={event => setStory(event.target.value === "story")}>
        {shareFormats.map(format => <option key={format.id} value={format.id}>{copy[format.id]}</option>)}
      </select>
    </label>}
    <button type="button" className={styles.primary} disabled={!ready || busy}
      onClick={() => void task(async () => saveStudioFile(await prepareImage(), filename))}>
      <Download size={16} aria-hidden />{copy.savePng}
    </button>
    <StudioImageShare disabled={!ready || busy} filename={filename} prepare={prepareImage} />
  </div>;

  return <>
    <div className={styles.workbench} data-character={character || undefined}>
      <section className={styles.panel}>
        <h2>{copy.inputs}</h2>
        <div className={styles.photoInput}>
          {photo ? <img src={photo} alt={copy.originalPhoto} width={72} height={72} /> : <Camera size={28} aria-hidden />}
          <StudioFileButton label={photo ? copy.changePhoto : copy.uploadPhoto} disabled={busy}
            onFile={file => pickPhoto(urls.make(file))} onInvalid={() => report(copy.invalidImage, true)} />
          {!character && <StudioFileButton label={copy.takeSelfie} disabled={busy} capture="user"
            onFile={file => pickPhoto(urls.make(file))} onInvalid={() => report(copy.invalidImage, true)} />}
        </div>
        {character ? <fieldset className={styles.fieldset} disabled={busy}>
          <legend>{copy.chooseCharacter}</legend>
          <div className={styles.characterPresets}>
            {characterPresets.map(choice => <label key={choice.id} className={styles.characterPreset}>
              <input type="radio" name="studio-character-preset" value={choice.id} checked={preset.id === choice.id}
                onChange={() => {
                  setPresetId(choice.id);
                  urls.release(result);
                  setResult("");
                }} />
              <img src={studioArtworkPath(choice.artwork)} alt="" width={120} height={120} />
              <span>{copy[choice.label]}</span>
            </label>)}
          </div>
        </fieldset> : <>
          <p className={styles.hint}>{copy.photoGuidance}</p>
        </>}
        {!character && <>
          <div className={styles.creativeGenerate}>{generateButton}</div>
          {sessionStatus === "unauthenticated" && <StudioQuoteHint error={401} />}
          <StudioStatus status={status} />
        </>}
      </section>
      <section className={character ? styles.panel + " " + styles.characterPreview : styles.panel} aria-busy={busy} data-testid={id + "-result"}>
        {character ? <h2>{result ? copy.resultPreview : copy[preset.label]}</h2>
          : <div className={styles.reportHeader}><h2>{copy.resultPreview}</h2>{resultActions}</div>}
        {character ? <>
          {!result && !busy && <p className={styles.hint}>{copy.exampleResult}</p>}
          {(result || !busy) && <img className={styles.characterArt} src={result || studioArtworkPath(preset.artwork)}
            alt={copy[preset.label]} />}
          <div className={styles.creativeGenerate}>{generateButton}</div>
          <StudioQuoteHint error={imageQuote.error} />
          <StudioStatus status={status} />
        </> : <>
          {!result && <figure className={styles.sampleReport}>
            <figcaption>{copy.exampleResult}</figcaption>
            <a className={styles.reportPreview} href={sampleReport} target="_blank" rel="noreferrer">
              <img src={sampleReport} alt={copy.exampleResult + " · " + copy[tool.title]} width={800} height={1200} />
            </a>
          </figure>}
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
        {ready && character && resultActions}
      </section>
    </div>
    <StudioCreditRecovery error={creditError} returnTo={"/studio/" + id + "?lang=" + encodeURIComponent(lang)}
      draftSaved={draftSaved} onSaveDraft={saveDraft} onClose={async () => {
        await checkout.clear();
        setCreditError(null);
      }} />
  </>;
}
