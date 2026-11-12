// What the Higgsfield image path checks in the concept call's answer, and how
// it picks the day's feature. Shared by check-concepts.mjs and
// run-higgsfield.mjs. A model wrote the concepts, so everything that can be
// checked without judgement is checked here before any paid call
// (docs/policy/marketing-automation.md §2: external and model text is data).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const LOCALES = ["en", "ko", "zh-Hant", "zh-Hans"];
export const TRANSLATED = ["ko", "zh-Hant", "zh-Hans"];
export const TEXT_ROLES = ["headline", "subhead", "cta", "screen", "answer", "label"];
/** Model and company names that are never translated (design guide 12). */
export const MODEL_FAMILIES = ["ChatGPT", "GPT", "Claude", "Gemini", "Grok", "Llama", "Mistral", "Qwen", "DeepSeek", "Kimi", "Nano Banana", "Perplexity", "OpenAI", "Anthropic", "Google", "xAI"];
/** Transliterations rejected on 2026-11-08 and their neighbours. */
const TRANSLITERATIONS = ["지피티", "챗지피티", "클로드", "제미나이", "제미니", "그록", "그로크", "오픈에이아이", "앤트로픽", "克劳德", "克勞德", "双子座", "雙子座", "吉米尼", "杰米尼", "傑米尼", "格罗克", "格羅克", "开放人工智能"];
/** Common characters that exist in only one of the two Chinese scripts. */
const TRADITIONAL_ONLY = "帳號開們這個為與對時會說問題讀檔圖實際點從來樣還種給讓頁見覺學習寫語試費額輸選擇處應該計劃錯誤書長車鐵線機電腦網頭雙類詢認證確檢雜據數隨歡";
const SIMPLIFIED_ONLY = "账号开们这个为与对时会说问题读档图实际点从来样还种给让页见觉学习写语试费额输选择处应该计划错误书长车铁线机电脑网头双类询认证确检杂据数随欢";
const MODEL_MENTION = /\b(?:GPT|Claude|Gemini|Grok|Llama|Mistral|Qwen|DeepSeek|Kimi|Nano Banana)\b[^,.;:!?\n]{0,20}?\d/gu;
const URL_LIKE = /https?:|www\.|\b[a-z0-9-]+\.(?:app|com|net|org|ai|io|co)\b/iu;

const isText = (value, min, max) => typeof value === "string" && value.trim().length >= min && value.length <= max;
const familiesIn = (text) => MODEL_FAMILIES.filter((name) => new RegExp(`(?<![\\p{L}\\p{N}])${name}(?![\\p{L}])`, "u").test(text));
const compact = (text) => String(text ?? "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");

/** yyyymmdd from "yyyy-mm-dd" or "yyyymmdd". */
export const dayKey = (value) => String(value ?? "").replaceAll("-", "").slice(0, 8);
const dayNumber = (key) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8))) / 86_400_000;

export function loadFeatures(toolDir) {
  return JSON.parse(readFileSync(path.join(toolDir, "features.json"), "utf8")).features;
}

/** Versioned model names a card may show: the listed models and the real example's. */
export function knownModels(features) {
  return [...new Set(features.flatMap((feature) => [...(feature.models ?? []), ...(feature.realExample?.models ?? [])]))];
}

/** The recorded answers a screen may quote under a real model name (design guide 10): `Speaker: "words"` pairs from features.json. */
export function recordedQuotes(features) {
  const quotes = [];
  for (const feature of features) {
    for (const value of Object.values(feature.realExample ?? {})) {
      if (typeof value !== "string") continue;
      for (const match of value.matchAll(/([^:."]+?):\s*"([^"]+)"/gu)) quotes.push({ speaker: match[1].trim(), quote: match[2] });
    }
  }
  return quotes;
}

/**
 * Today's feature: the one whose last card is oldest in the history (never
 * shown counts as oldest, in features.json order), never the last run day's.
 */
export function pickFeature(history, features, day) {
  const today = dayKey(day);
  const earlier = history.filter((entry) => entry && entry.feature && dayKey(entry.date) < today);
  const lastDay = earlier.reduce((latest, entry) => (dayKey(entry.date) > latest ? dayKey(entry.date) : latest), "");
  const yesterdays = new Set(earlier.filter((entry) => dayKey(entry.date) === lastDay).map((entry) => entry.feature));
  const last = (id) => earlier.filter((entry) => entry.feature === id).reduce((latest, entry) => (dayKey(entry.date) > latest ? dayKey(entry.date) : latest), "");
  const candidates = features.map((feature) => feature.id).filter((id) => !yesterdays.has(id));
  const pool = candidates.length > 0 ? candidates : features.map((feature) => feature.id);
  return pool.reduce((best, id) => (last(id) < last(best) ? id : best), pool[0]);
}

/** Scene ideas used in the 14 days before `day`. */
export function recentDevices(history, day, days = 14) {
  const today = dayNumber(dayKey(day));
  return history
    .filter((entry) => entry && /^\d{8}$/u.test(dayKey(entry.date)) && today - dayNumber(dayKey(entry.date)) <= days && today - dayNumber(dayKey(entry.date)) >= 0)
    .flatMap((entry) => [entry.device, entry.concept])
    .filter((value) => typeof value === "string" && value.trim());
}

function resolveFact(features, ref) {
  if (typeof ref !== "string" || !/^[a-z-]+(?:\.[A-Za-z0-9]+)+$/u.test(ref)) return undefined;
  const [id, ...keys] = ref.split(".");
  let value = features.find((feature) => feature.id === id);
  for (const key of keys) value = value == null ? undefined : value[key];
  return value;
}

function textProblem(text, locale, where) {
  if (/tomverse/iu.test(text)) return `${where}: the image never shows the Tomverse name, logo or address (the band adds them)`;
  if (URL_LIKE.test(text)) return `${where}: no web address in the image`;
  if (/lorem ipsum/iu.test(text)) return `${where}: placeholder text`;
  if (/\bswipe\b|더 보기|滑動|滑动/iu.test(text)) return `${where}: no page markers or "더 보기"`;
  for (const name of TRANSLITERATIONS) if (text.includes(name)) return `${where}: model and company names stay as written ("${name}")`;
  if (locale === "en" && /\bfree\b/iu.test(text) && !/credit/iu.test(text)) return `${where}: "free" only with its condition (within the included credits)`;
  if (locale === "ko" && text.includes("무료") && !text.includes("크레딧")) return `${where}: "무료" only with its condition (포함된 크레딧 안에서)`;
  if (locale.startsWith("zh") && /免費|免费/u.test(text) && !/額度|额度|點數|点数|積分|积分|credit/iu.test(text)) return `${where}: 免費 only with its condition`;
  if (locale === "en" && familiesIn(text).filter((name) => !["OpenAI", "Anthropic", "Google", "xAI"].includes(name)).length >= 2 && !/\band more\b|\+\s*more\b/iu.test(text)) {
    return `${where}: a list of models ends with "and more"`;
  }
  if (locale === "zh-Hans") for (const ch of text) if (TRADITIONAL_ONLY.includes(ch)) return `${where}: zh-Hans is written in Simplified characters ("${ch}")`;
  if (locale === "zh-Hant") for (const ch of text) if (SIMPLIFIED_ONLY.includes(ch)) return `${where}: zh-Hant is written in Traditional characters ("${ch}")`;
  return null;
}

function modelNameProblem(text, models, where) {
  for (const match of text.matchAll(MODEL_MENTION)) {
    const listed = (name) => text.startsWith(name, match.index) && !/^(?:[\p{L}\p{N}]|\s*[\d.]+)/u.test(text.slice(match.index + name.length));
    if (!models.some(listed)) return `${where}: "${match[0]}" is not a model name in features.json`;
  }
  return null;
}

/** null when the answer is fine, or the first reason it is not. */
export function checkConcepts(answer, options) {
  const sorted = sortConcepts(answer, options);
  return sorted.problem ?? sorted.dropped[0]?.problem ?? null;
}

/**
 * Splits an answer into the concepts that pass and those that do not:
 * `{problem}` when the answer as a whole is refused, else `{kept, dropped:
 * [{id, problem}]}`. One bad concept no longer costs the day: the box runs of
 * 2026-11-11 and 2026-11-12 each made nothing because one concept of three
 * broke one rule twice.
 */
export function sortConcepts(answer, { feature, history = [], day, toolDir }) {
  const refuse = (problem) => ({ problem });
  const features = loadFeatures(toolDir);
  if (!features.some((entry) => entry.id === feature)) return refuse(`feature ${feature} is not in features.json`);
  const models = knownModels(features);
  const quotes = recordedQuotes(features);
  const iconDir = path.resolve(toolDir, "..", "..", "public", "model-icons");
  const used = new Set((day ? recentDevices(history, day) : []).map(compact));
  const { concepts } = answer;
  if (Object.keys(answer).some((key) => !["date", "feature", "concepts"].includes(key))) return refuse("the answer has keys other than date, feature, concepts");
  if (!Array.isArray(concepts) || concepts.length < 2 || concepts.length > 3) return refuse("concepts: 2-3 entries");
  const ids = new Set();
  const devices = new Set();
  const KEYS = "alt,device,factRefs,feature,id,logos,prompt_en,texts,translations";
  const problemOf = (concept) => {
    const at = `concept ${concept?.id ?? "?"}`;
    if (Object.keys(concept ?? {}).sort().join(",") !== KEYS) return `${at}: keys must be exactly ${KEYS}`;
    if (!/^[a-z][a-z0-9-]{0,15}$/u.test(concept.id) || ids.has(concept.id)) return `${at}: id is short lower-case and unique`;
    ids.add(concept.id);
    if (concept.feature !== feature) return `${at}: feature must be today's (${feature})`;
    if (!isText(concept.device, 10, 160)) return `${at}: device is 10-160 characters`;
    if (devices.has(compact(concept.device))) return `${at}: two concepts share a device`;
    devices.add(compact(concept.device));
    if (used.has(compact(concept.device))) return `${at}: the device was used in the last 14 days`;
    if (!isText(concept.prompt_en, 200, 6000)) return `${at}: prompt_en is 200-6000 characters`;
    // The image model draws any "Tomverse" it reads, even in "no Tomverse logo"
    // or "Tomverse blue". The refusal quotes where the word is, so the retry can
    // drop it (the 2026-11-11 box run lost its day to this rule).
    const named = /tomverse/iu.exec(concept.prompt_en);
    if (named) {
      const around = concept.prompt_en.slice(Math.max(0, named.index - 40), named.index + 48).replace(/\s+/gu, " ");
      return `${at}: prompt_en must not contain the word "Tomverse" anywhere, not even as "no Tomverse logo" or "Tomverse blue" (write "#155dfb blue"; the band adds the logo). Found in: "...${around}..."`;
    }
    if (/\b(?:purple|violet|magenta|lavender|lilac|fuchsia)\b/iu.test(concept.prompt_en)) return `${at}: the one accent colour is #155dfb blue (no purple, violet or magenta)`;
    if (URL_LIKE.test(concept.prompt_en) || /lorem/iu.test(concept.prompt_en)) return `${at}: prompt_en holds an address or placeholder text`;

    if (!Array.isArray(concept.logos) || concept.logos.length > 4) return `${at}: logos is a list of at most 4`;
    for (const logo of concept.logos) {
      if (typeof logo !== "string" || !/^[a-z0-9-]+$/u.test(logo) || !existsSync(path.join(iconDir, `${logo}.png`))) return `${at}: logo ${JSON.stringify(logo)} is not a file in public/model-icons`;
    }

    if (!Array.isArray(concept.factRefs) || concept.factRefs.length === 0 || concept.factRefs.length > 8) return `${at}: factRefs names 1-8 facts`;
    for (const ref of concept.factRefs) if (resolveFact(features, ref) === undefined) return `${at}: factRef ${JSON.stringify(ref)} is not in features.json`;
    if (!concept.factRefs.some((ref) => ref.split(".")[0] === feature)) return `${at}: at least one factRef is from today's feature`;

    if (!Array.isArray(concept.texts) || concept.texts.length === 0 || concept.texts.length > 12) return `${at}: texts holds 1-12 entries`;
    if (!concept.texts.some((text) => text?.role === "headline")) return `${at}: texts has a headline`;
    for (const [index, text] of concept.texts.entries()) {
      const where = `${at} texts[${index}]`;
      if (Object.keys(text ?? {}).some((key) => !["role", "text", "speaker"].includes(key))) return `${where}: keys are role, text and speaker`;
      if (!TEXT_ROLES.includes(text.role)) return `${where}: role is one of ${TEXT_ROLES.join(", ")}`;
      if (!isText(text.text, 1, text.role === "headline" ? 70 : 400)) return `${where}: text is 1-${text.role === "headline" ? 70 : 400} characters`;
      if (text.speaker !== undefined && (text.role !== "answer" || !isText(text.speaker, 1, 40))) return `${where}: only an answer has a speaker`;
      const problem = textProblem(text.text, "en", where) ?? modelNameProblem(text.text, models, where);
      if (problem) return problem;
      // An answer shown under a real model name is that model's recorded answer, word for word (design guide 10).
      if (text.role === "answer" && text.speaker !== undefined && (familiesIn(text.speaker).length > 0 || models.includes(text.speaker))) {
        const recorded = quotes.some((entry) => entry.speaker === text.speaker && entry.quote.includes(text.text.replace(/^"|"$/gu, "")));
        if (!recorded) return `${where}: an answer under ${text.speaker} quotes its recorded answer in features.json word for word`;
      }
    }

    if (Object.keys(concept.translations ?? {}).sort().join(",") !== [...TRANSLATED].sort().join(",")) return `${at}: translations has exactly ${TRANSLATED.join(", ")}`;
    for (const locale of TRANSLATED) {
      const list = concept.translations[locale];
      if (!Array.isArray(list) || list.length !== concept.texts.length) return `${at} ${locale}: one translation per text, in order`;
      for (const [index, text] of list.entries()) {
        const source = concept.texts[index];
        const where = `${at} ${locale}[${index}]`;
        if (Object.keys(text ?? {}).some((key) => !["role", "text", "speaker"].includes(key))) return `${where}: keys are role, text and speaker`;
        if (text.role !== source.role || text.speaker !== source.speaker) return `${where}: same role and speaker as the English text`;
        if (!isText(text.text, 1, text.role === "headline" ? 40 : 400)) return `${where}: text is 1-${text.role === "headline" ? 40 : 400} characters`;
        const problem = textProblem(text.text, locale, where) ?? modelNameProblem(text.text, models, where);
        if (problem) return problem;
        for (const name of familiesIn(source.text)) if (!text.text.includes(name)) return `${where}: "${name}" stays as written`;
        if (/\+\s*more\b/iu.test(source.text) && !text.text.includes(locale === "ko" ? "+ 기타 AI" : "+ 其他 AI")) {
          return `${where}: "+ more" is "${locale === "ko" ? "+ 기타 AI" : "+ 其他 AI"}"`;
        }
        // A recorded quote stays in its own language (design guide 12).
        if (source.role === "answer" && source.speaker !== undefined && text.text !== source.text) return `${where}: a recorded answer is not translated`;
      }
    }

    if (Object.keys(concept.alt ?? {}).sort().join(",") !== [...LOCALES].sort().join(",")) return `${at}: alt has exactly ${LOCALES.join(", ")}`;
    for (const locale of LOCALES) {
      // Korean and Chinese say as much in fewer characters.
      const min = locale === "en" ? 20 : locale === "ko" ? 10 : 8;
      if (!isText(concept.alt[locale], min, 400)) return `${at} alt.${locale}: ${min}-400 characters`;
      if (URL_LIKE.test(concept.alt[locale])) return `${at} alt.${locale}: say "web address", never the address`;
    }
    return null;
  };
  const kept = [];
  const dropped = [];
  for (const concept of concepts) {
    const problem = problemOf(concept);
    if (problem) dropped.push({ id: typeof concept?.id === "string" ? concept.id : null, problem });
    else kept.push(concept);
  }
  return { kept, dropped };
}
