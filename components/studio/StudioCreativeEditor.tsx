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

const characterPresets = [
  { id: "fantasy", label: "fantasyCharacter", artwork: "character-fantasy.webp", photoreal: true,
    direction: "A fantasy mage with a real forest-green embroidered cloak and a small brass lantern, against a softly lit studio background." },
  { id: "knight", label: "knightCharacter", artwork: "character-knight.webp", photoreal: true,
    direction: "A royal knight in decorated steel armor and a crimson cape against a castle courtyard." },
  { id: "pilot", label: "pilotCharacter", artwork: "character-pilot.webp", photoreal: true,
    direction: "A retro-future space pilot in a white and cobalt flight suit with a distant planet behind them." },
  { id: "courier", label: "courierCharacter", artwork: "character-courier.webp", photoreal: true,
    direction: "A cyberpunk courier in purple and orange techwear in a neon city at dusk." },
  { id: "explorer", label: "explorerCharacter", artwork: "character-explorer.webp", photoreal: true,
    direction: "A desert explorer in sun-weathered linen holding a folded map in an ochre canyon." },
  { id: "detective", label: "detectiveCharacter", artwork: "character-detective.webp", photoreal: true,
    direction: "A noir detective in a fedora and trench coat, lit by a midcentury city street in the rain." },
  { id: "pirate", label: "pirateCharacter", artwork: "character-pirate.webp", photoreal: true,
    direction: "A pirate captain in a weathered burgundy coat and tricorne on a wooden ship at sea." },
  { id: "fairy", label: "fairyCharacter", artwork: "character-fairy.webp", photoreal: true,
    direction: "A woodland fairy in a moss-green practical costume with translucent lavender wings and a botanical crown." },
  { id: "anime", label: "animeCharacter", artwork: "preset-anime.webp",
    direction: "An original hand-drawn animation protagonist with a windswept scarf and an atmospheric painted setting." },
  { id: "3d", label: "threeDCharacter", artwork: "preset-3d.webp",
    direction: "A stylized 3D character with expressive proportions, tactile clay-like materials and soft studio lighting." },
  { id: "comic", label: "comicHeroCharacter", artwork: "character-comic.webp",
    direction: "An original retro comic hero in scarlet and navy, with hand-inked lines, halftone shading and a sunburst." },
  { id: "pixel", label: "pixelCharacter", artwork: "character-pixel.webp",
    direction: "A 16-bit pixel-art RPG adventurer in an embroidered teal hood, with chunky pixels and a limited palette." },
  { id: "paper", label: "paperCharacter", artwork: "character-paper.webp",
    direction: "A cheerful paper-cut character with layered colored cardstock, visible cut edges and a geometric setting." },
  { id: "felt", label: "feltCharacter", artwork: "character-felt.webp",
    direction: "A handmade felt stop-motion character in a coral sweater, with visible wool fibers and a soft blue background." },
  { id: "chibi", label: "chibiCharacter", artwork: "character-chibi.webp",
    direction: "A clean chibi character with an oversized head, expressive eyes and a warm peach and pink palette." },
] as const;
type CharacterPreset = (typeof characterPresets)[number]["id"];
const shareFormats = STUDIO_EXPORT_FORMATS.filter(format => format.id !== "poster");
const samplePhoto = "/studio/selfie.png";

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
  const [runImage] = useState(createStudioImageRunner);
  const [photo, setPhoto] = useState("");
  const [result, setResult] = useState("");
  const [analysis, setAnalysis] = useState<StudioAnalysisReport | null>(null);
  const [presetId, setPresetId] = useState<CharacterPreset>(characterPresets[0].id);
  const preset = characterPresets.find(choice => choice.id === presetId) ?? characterPresets[0];
  const [story, setStory] = useState(false);
  const [creditError, setCreditError] = useState<StudioGenerationError | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);
  const imageQuote = useStudioImageQuote("1024x1024", true, character);
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
          const look = "photoreal" in preset ? "Shoot it as a photoreal live-action character portrait with natural skin texture, real materials and lens lighting. " : "";
          const prompt = "Transform the person in the attached photo into the chosen original character. Keep their likeness recognizable, especially their facial features and hairstyle, while adapting the outfit and scene. Compose a square portrait with no text or watermark. " + look + "Character: " +
            preset.direction;
          const output = await runImage({
            inputKey: photo, prompt, size: imageQuote.quote.size, quote: imageQuote.quote,
            reference: () => makeStudioImageReference(photo), signal,
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

  const generateButton = <StudioGenerateButton label={copy.generate} busy={busy}
    disabled={!photo || (character ? !imageQuote.quote : sessionStatus !== "authenticated")}
    onClick={generate} />;

  return <>
    <div className={styles.workbench} data-character={character || undefined}>
      <section className={styles.panel}>
        <h2>{copy.inputs}</h2>
        <div className={styles.photoInput}>
          {photo ? <img src={photo} alt={copy.originalPhoto} width={72} height={72} /> : <Camera size={28} aria-hidden />}
          <StudioFileButton label={photo ? copy.changePhoto : copy.uploadPhoto} disabled={busy}
            onFile={file => pickPhoto(urls.make(file))} onInvalid={() => report(copy.invalidImage, true)} />
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
          <button type="button" className={styles.secondary} disabled={busy || photo === samplePhoto}
            onClick={() => pickPhoto(samplePhoto)}>{copy.samplePhoto}</button>
        </>}
        {!character && <>
          <div className={styles.creativeGenerate}>{generateButton}</div>
          {sessionStatus === "unauthenticated" && <StudioQuoteHint error={401} />}
          <StudioStatus status={status} />
        </>}
      </section>
      <section className={character ? styles.panel + " " + styles.characterPreview : styles.panel} aria-busy={busy} data-testid={id + "-result"}>
        <h2>{character && !result ? copy[preset.label] : copy.resultPreview}</h2>
        {character ? <>
          {!result && !busy && <p className={styles.hint}>{copy.exampleResult}</p>}
          {(result || !busy) && <img className={styles.characterArt} src={result || studioArtworkPath(preset.artwork)}
            alt={copy[preset.label]} />}
          <div className={styles.creativeGenerate}>{generateButton}</div>
          <StudioQuoteHint {...imageQuote} />
          <StudioStatus status={status} />
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
