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
// A versioned model name: a family in any case, at most two words that are
// capitalised or a known tier word in lower case, then a number ("GPT 6",
// "Claude Opus 4", "claude opus 4", "GPT-4o", "GPT4"). Not "Gemini agree on
// 7": the looser pattern refused every count that followed a model name.
const MODEL_FAMILY = /(?<![\p{L}\p{N}])(?:GPT|Claude|Gemini|Grok|Llama|Mistral|Qwen|DeepSeek|Kimi|Nano Banana)(?![A-Za-z])/giu;
const MODEL_VERSION_TAIL = /^(?:[-\s]+(?:[A-Z][A-Za-z]*|(?:opus|sonnet|haiku|flash|pro|ultra|mini|nano|turbo|max|plus|lite|luna|image|imagine|banana|preview)(?![a-z]))){0,2}?[-\s]*\d[\d.]*/u;
const COUNTER_AFTER = /^\s?(?:가지|개|건|곳|個|个|點|点|項|项|處|处|條|条)/u;
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
      // A speaker may hold a stop ("Claude Haiku 5.5"); the stop and space after the quote before it are not its name.
      for (const match of value.matchAll(/([^:"]+?):\s*"([^"]+)"/gu)) quotes.push({ speaker: match[1].replace(/^[\s.;,]+/u, "").trim(), quote: match[2] });
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
  // A feature on hold (not shown live, or with a copy contract the cards cannot keep yet) is never today's.
  const live = features.filter((feature) => !feature.hold).map((feature) => feature.id);
  const candidates = live.filter((id) => !yesterdays.has(id));
  const pool = candidates.length > 0 ? candidates : live;
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

/** The text around a match, on one line, so a refusal shows where the word is. */
const around = (text, match) => text.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40).replace(/\s+/gu, " ");
const COMPANIES = ["OpenAI", "Anthropic", "Google", "xAI"];
/** Ad copy, as against what a drawn screen or a tag shows. */
const COPY_ROLES = ["headline", "subhead", "cta"];

/** Every problem of one text of the picture. */
function textProblems(text, { locale, where, role, models }) {
  const problems = [];
  if (/tomverse/iu.test(text)) problems.push(`${where}: no text in the picture contains "Tomverse" (the band adds the name, logo and address); reword it without the name`);
  if (URL_LIKE.test(text)) problems.push(`${where}: no web address in the image`);
  if (/lorem ipsum/iu.test(text)) problems.push(`${where}: placeholder text`);
  if (/\bswipe\b|더 보기|滑動|滑动/iu.test(text)) problems.push(`${where}: no page markers ("swipe", "더 보기", "滑動")`);
  for (const name of TRANSLITERATIONS) if (text.includes(name)) problems.push(`${where}: model and company names stay as written, in Latin letters ("${name}")`);
  // "stress-free" and the like are not an offer; "free time" and "feel free" are reworded.
  if (locale === "en" && /(?<![-\p{L}])free\b/iu.test(text) && !/credit/iu.test(text)) {
    problems.push(`${where}: the word "free" stands only in a text that also says its condition ("within the included credits"); reword any other "free"`);
  }
  if (locale === "ko" && text.includes("무료") && !text.includes("크레딧")) problems.push(`${where}: "무료" only in a text that also says its condition (포함된 크레딧 안에서)`);
  if (locale.startsWith("zh") && /免費|免费/u.test(text) && !/額度|额度|點數|点数|積分|积分|credit/iu.test(text)) problems.push(`${where}: 免費 only in a text that also says its condition (額度 / 额度)`);
  if (locale === "en") {
    // Design guide 6 is about copy. A screen or a tag that lists exact models of
    // features.json (the three that answered the recorded example, say) shows
    // what is there; "and more" would be false on it (box run 2026-11-12).
    // Every model in it must be an exact name: one bare name among them
    // ("GPT 6 Luna · Claude") and it is copy again. Words around the names are
    // allowed: the real model writes "Asked at once: GPT 6 Luna, Claude Haiku
    // 5.5, Gemini Flash", and a bare-list rule refused 3 of 30 real concepts.
    const named = (value) => familiesIn(value).filter((name) => !COMPANIES.includes(name));
    const exactOnly = !COPY_ROLES.includes(role) && named([...models].sort((a, b) => b.length - a.length).reduce((rest, name) => rest.replaceAll(name, " "), text)).length === 0;
    if (!exactOnly && named(text).length >= 2 && !/\band more\b|\+\s*more\b/iu.test(text)) {
      problems.push(`${where}: a text that names two or more models ends with "and more" (e.g. "GPT, Claude, Gemini and more"); only a screen, answer or label whose every model is a full name of features.json ("GPT 6 Luna · Claude Haiku 5.5 · Gemini Flash") needs none`);
    }
  }
  if (locale === "zh-Hans") {
    const wrong = [...new Set([...text].filter((ch) => TRADITIONAL_ONLY.includes(ch)))];
    if (wrong.length > 0) problems.push(`${where}: zh-Hans is written in Simplified characters (found "${wrong.join("")}")`);
  }
  if (locale === "zh-Hant") {
    const wrong = [...new Set([...text].filter((ch) => SIMPLIFIED_ONLY.includes(ch)))];
    if (wrong.length > 0) problems.push(`${where}: zh-Hant is written in Traditional characters (found "${wrong.join("")}")`);
  }
  for (const match of text.matchAll(MODEL_FAMILY)) {
    const version = MODEL_VERSION_TAIL.exec(text.slice(match.index + match[0].length));
    if (!version) continue;
    const mention = text.slice(match.index, match.index + match[0].length + version[0].length);
    // "Gemini 7가지", "Gemini 7 個": a count after a name, not a version.
    if (COUNTER_AFTER.test(text.slice(match.index + mention.length))) continue;
    // Listed exactly as written in features.json, so "claude haiku 5.5" is not.
    const listed = (name) => text.startsWith(name, match.index) && !/^(?:[\p{L}\p{N}]|\s*[\d.]+)/u.test(text.slice(match.index + name.length));
    if (!models.some(listed)) problems.push(`${where}: "${mention}" is not a model name in features.json (the versioned names are ${models.join(", ")})`);
  }
  return problems;
}

/** A quote as compared: quote marks around it and a final stop or ellipsis do not count. */
const bareQuote = (text) =>
  String(text)
    .normalize("NFKC")
    .replace(/[“”„]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^["']+|["']+$/gu, "")
    .replace(/(?:…|\.)+$/u, "")
    .trim();

/** null when the answer is fine, or the first reason it is not. */
export function checkConcepts(answer, options) {
  const sorted = sortConcepts(answer, options);
  return sorted.problem ?? sorted.dropped[0]?.problems[0] ?? null;
}

/**
 * Splits an answer into the concepts that pass and those that do not:
 * `{problem}` when the answer as a whole is refused, else `{kept, dropped:
 * [{id, problems}]}`. One bad concept no longer costs the day (the box runs of
 * 2026-11-11 and 2026-11-12 each made nothing because one concept of three
 * broke one rule twice), and a dropped concept lists everything wrong with it,
 * so one retry can mend it all.
 */
export function sortConcepts(answer, { feature, history = [], day, toolDir }) {
  const refuse = (problem) => ({ problem });
  const features = loadFeatures(toolDir);
  if (!features.some((entry) => entry.id === feature)) return refuse(`feature ${feature} is not in features.json`);
  const models = knownModels(features);
  const quotes = recordedQuotes(features);
  const iconDir = path.resolve(toolDir, "..", "..", "public", "model-icons");
  const used = new Set((day ? recentDevices(history, day) : []).map(compact));
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return refuse("the answer is one JSON object");
  const { concepts } = answer;
  if (Object.keys(answer).some((key) => !["date", "feature", "concepts"].includes(key))) return refuse("the answer has keys other than date, feature, concepts");
  if (!Array.isArray(concepts) || concepts.length < 2 || concepts.length > 3) return refuse("concepts: 2-3 entries");
  const ids = new Set();
  const devices = new Set();
  const KEYS = "alt,device,factRefs,feature,id,logos,prompt_en,texts,translations";
  /** Every problem of one concept. A broken shape is reported alone: nothing under it can be read. */
  const problemsOf = (concept) => {
    const at = `concept ${typeof concept?.id === "string" ? concept.id : "?"}`;
    if (concept === null || typeof concept !== "object" || Object.keys(concept).sort().join(",") !== KEYS) return [`${at}: keys must be exactly ${KEYS}`];
    if (typeof concept.id !== "string" || !/^[a-z][a-z0-9-]{0,15}$/u.test(concept.id) || ids.has(concept.id)) return [`${at}: id is short lower-case and unique`];
    ids.add(concept.id);
    const problems = [];
    if (concept.feature !== feature) problems.push(`${at}: feature must be today's (${feature})`);
    if (!isText(concept.device, 10, 160)) problems.push(`${at}: device is 10-160 characters`);
    else {
      if (devices.has(compact(concept.device))) problems.push(`${at}: two concepts share a device`);
      devices.add(compact(concept.device));
      if (used.has(compact(concept.device))) problems.push(`${at}: the device was used in the last 14 days`);
    }

    if (!isText(concept.prompt_en, 200, 6000)) problems.push(`${at}: prompt_en is 200-6000 characters${typeof concept.prompt_en === "string" ? ` (it has ${concept.prompt_en.length})` : ""}`);
    else {
      // The image model draws or follows any word it reads, even after "no": the
      // refusal says the word must go and quotes where it is, so the retry can
      // drop it (the 2026-11-11 box run lost its day to "Tomverse").
      const banned = [
        [/tomverse/iu, 'the word "Tomverse", not even as "no Tomverse logo" or "Tomverse blue" (write "#155dfb blue"; the band adds the logo)'],
        [/\b(?:purple|violet|magenta|lavender|lilac|fuchsia)\b/iu, 'the words purple, violet, magenta, lavender, lilac or fuchsia, not even as "no purple" (the one accent colour is #155dfb blue)'],
        [/lorem/iu, 'the words "lorem ipsum", not even as "no lorem ipsum" (write "real sentences")'],
        [URL_LIKE, "a web address or anything shaped like one (name.com, name.app)"],
      ];
      for (const [pattern, what] of banned) {
        const match = pattern.exec(concept.prompt_en);
        if (match) problems.push(`${at}: prompt_en must not contain ${what}. Found in: "...${around(concept.prompt_en, match)}..."`);
      }
    }

    if (!Array.isArray(concept.logos) || concept.logos.length > 4) problems.push(`${at}: logos is a list of at most 4`);
    else {
      for (const logo of concept.logos) {
        if (typeof logo !== "string" || !/^[a-z0-9-]+$/u.test(logo) || !existsSync(path.join(iconDir, `${logo}.png`))) problems.push(`${at}: logo ${JSON.stringify(logo)} is not one of the logo files listed in the prompt`);
      }
    }

    if (!Array.isArray(concept.factRefs) || concept.factRefs.length === 0 || concept.factRefs.length > 8) problems.push(`${at}: factRefs names 1-8 facts`);
    else {
      for (const ref of concept.factRefs) if (typeof ref === "string" && features.find((entry) => entry.id === ref.split(".")[0])?.hold) problems.push(`${at}: factRef ${JSON.stringify(ref)} is a feature on hold: a card never mentions it`);
      for (const ref of concept.factRefs) if (resolveFact(features, ref) === undefined) problems.push(`${at}: factRef ${JSON.stringify(ref)} is not a path in features.json (<feature id>.<field>, e.g. ${feature}.what)`);
      if (!concept.factRefs.some((ref) => typeof ref === "string" && ref.split(".")[0] === feature)) problems.push(`${at}: at least one factRef is from today's feature (${feature}.what, say)`);
    }

    if (!Array.isArray(concept.texts) || concept.texts.length === 0 || concept.texts.length > 12) {
      return [...problems, `${at}: texts holds 1-12 entries${Array.isArray(concept.texts) ? ` (it has ${concept.texts.length}; show fewer pieces of text)` : ""}`];
    }
    if (!concept.texts.some((text) => text?.role === "headline")) problems.push(`${at}: texts has a headline`);
    // A stranger must see what to do and that this is AI (JOB-higgsfield.md "Who the ad is for", owner 2026-11-12).
    if (concept.texts.filter((text) => text?.role === "cta").length !== 1) problems.push(`${at}: texts has exactly one cta that tells the reader what to do next`);
    const copy = concept.texts.filter((text) => ["headline", "subhead"].includes(text?.role) && typeof text.text === "string").map((text) => text.text).join(" ");
    if (copy && !/\bAI\b/u.test(copy) && familiesIn(copy).length === 0) problems.push(`${at}: the headline or the subhead says "AI" or names a model, so a stranger knows this is an AI app`);
    const speakers = [...new Set(quotes.map((entry) => entry.speaker))];
    /** The shape of one text; null when it can be read further. */
    const shapeProblem = (text, where, headlineMax) => {
      if (text === null || typeof text !== "object" || Object.keys(text).some((key) => !["role", "text", "speaker"].includes(key))) return `${where}: keys are role, text and speaker`;
      if (!TEXT_ROLES.includes(text.role)) return `${where}: role is one of ${TEXT_ROLES.join(", ")}`;
      const max = text.role === "headline" ? headlineMax : 400;
      if (!isText(text.text, 1, max)) return `${where}: text is 1-${max} characters${typeof text.text === "string" ? ` (it has ${text.text.length})` : ""}`;
      return null;
    };
    const readable = [];
    for (const [index, text] of concept.texts.entries()) {
      const where = `${at} texts[${index}]`;
      const shape = shapeProblem(text, where, 70);
      readable.push(!shape);
      if (shape) {
        problems.push(shape);
        continue;
      }
      if (text.speaker !== undefined && (text.role !== "answer" || !isText(text.speaker, 1, 40))) problems.push(`${where}: only an answer has a speaker (a name tag or chip is a label with the name as its text)`);
      problems.push(...textProblems(text.text, { locale: "en", where, role: text.role, models }));
      // An answer shown under a real model name is that model's recorded answer, word for word (design guide 10).
      if (text.role === "answer" && typeof text.speaker === "string" && (familiesIn(text.speaker).length > 0 || models.includes(text.speaker))) {
        const said = bareQuote(text.text);
        const recorded = said.length > 0 && quotes.some((entry) => entry.speaker === text.speaker && bareQuote(entry.quote).includes(said));
        if (!recorded) {
          problems.push(`${where}: an answer under ${text.speaker} is its recorded answer in features.json word for word, nothing added (recorded answers exist only for ${speakers.join(" and ")}; any other answer has no speaker)`);
        }
      }
    }

    if (concept.translations === null || typeof concept.translations !== "object" || Object.keys(concept.translations).sort().join(",") !== [...TRANSLATED].sort().join(",")) {
      problems.push(`${at}: translations has exactly ${TRANSLATED.join(", ")}`);
    } else {
      for (const locale of TRANSLATED) {
        const list = concept.translations[locale];
        if (!Array.isArray(list) || list.length !== concept.texts.length) {
          problems.push(`${at} ${locale}: one translation per text, in order (${concept.texts.length} texts${Array.isArray(list) ? `, ${list.length} translations` : ""})`);
          continue;
        }
        for (const [index, text] of list.entries()) {
          const source = concept.texts[index];
          const where = `${at} ${locale}[${index}]`;
          const shape = shapeProblem(text, where, 40);
          if (shape) {
            problems.push(shape);
            continue;
          }
          if (!readable[index]) continue;
          if (text.role !== source.role || text.speaker !== source.speaker) problems.push(`${where}: same role and speaker as the English text`);
          problems.push(...textProblems(text.text, { locale, where, role: text.role, models }));
          for (const name of familiesIn(source.text)) if (!text.text.includes(name)) problems.push(`${where}: "${name}" of the English text stays in the translation, as written`);
          if (/\+\s*more\b/iu.test(source.text) && !text.text.includes(locale === "ko" ? "+ 기타 AI" : "+ 其他 AI")) {
            problems.push(`${where}: "+ more" is "${locale === "ko" ? "+ 기타 AI" : "+ 其他 AI"}"`);
          }
          // A recorded quote stays in its own language (design guide 12).
          if (source.role === "answer" && source.speaker !== undefined && text.text !== source.text) problems.push(`${where}: a recorded answer is not translated: repeat the English text exactly`);
        }
      }
    }

    if (concept.alt === null || typeof concept.alt !== "object" || Object.keys(concept.alt).sort().join(",") !== [...LOCALES].sort().join(",")) {
      problems.push(`${at}: alt has exactly ${LOCALES.join(", ")}`);
    } else {
      for (const locale of LOCALES) {
        // Korean and Chinese say as much in fewer characters.
        const min = locale === "en" ? 20 : locale === "ko" ? 10 : 8;
        if (!isText(concept.alt[locale], min, 400)) problems.push(`${at} alt.${locale}: ${min}-400 characters`);
        else if (URL_LIKE.test(concept.alt[locale])) problems.push(`${at} alt.${locale}: say "web address", never the address`);
      }
    }
    return problems;
  };
  const kept = [];
  const dropped = [];
  for (const concept of concepts) {
    const problems = problemsOf(concept);
    if (problems.length > 0) dropped.push({ id: typeof concept?.id === "string" ? concept.id : null, problems });
    else kept.push(concept);
  }
  return { kept, dropped };
}

/**
 * Asks for the day's concepts until they pass. `ask(again, attempt)` returns
 * the parsed answer or null (`again` is "" or the section that says what was
 * refused); `sort` is `sortConcepts` for the day.
 *
 * A refused concept is asked for once more with every reason. The concepts
 * that passed are kept from either answer, and only what is still broken is
 * dropped. A third try only when nothing has passed yet, so one hard day is
 * not lost. Returns `{concepts, dropped: [{id, problems}], refusal}`.
 */
export function gatherConcepts({ ask, sort }) {
  const passed = new Map();
  let dropped = [];
  let refusal = null;
  for (let attempt = 1; attempt <= (passed.size > 0 ? 2 : 3); attempt += 1) {
    const kept = [...passed.keys()];
    const again = refusal
      ? `\n\n## Your last answer was refused\n\n${refusal}\n\nAnswer again with the whole line.${kept.length > 0 ? ` Repeat ${kept.join(" and ")} exactly as ${kept.length > 1 ? "they were" : "it was"}: ${kept.length > 1 ? "they" : "it"} passed.` : ""} Fix everything listed, and check the rest of each concept against the rules above before answering.`
      : "";
    const answer = ask(again, attempt);
    const sorted = answer ? sort(answer) : { problem: "the answer held no line of JSON with `concepts`: answer with exactly one line of JSON and nothing else" };
    if (sorted.problem) {
      refusal = sorted.problem;
      continue;
    }
    // The newer version of a concept wins; one that passed before stays unless a newer one passed too.
    for (const concept of sorted.kept) passed.set(concept.id, concept);
    dropped = sorted.dropped.filter((entry) => !passed.has(entry.id));
    if (sorted.dropped.length === 0) break;
    refusal = sorted.dropped.flatMap((entry) => entry.problems).slice(0, 30).join("\n");
  }
  // Kept from two answers, two concepts may share a scene: the later one goes.
  const scenes = new Set();
  const concepts = [...passed.values()]
    .filter((concept) => {
      const scene = compact(concept.device);
      if (scenes.has(scene)) return false;
      scenes.add(scene);
      return true;
    })
    .slice(0, 3);
  return { concepts, dropped, refusal };
}
