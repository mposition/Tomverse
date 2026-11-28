/**
 * "Read aloud" through the browser's own speech engine (`speechSynthesis`).
 * It runs on the device: no request is made and nothing is billed. One answer
 * is read at a time; pressing the button again, or another answer's button,
 * stops the first.
 */

import { plainTextForSpeech, splitSpeechChunks } from "@/lib/chatSpeechText";
import type { Language } from "@/lib/language";

const SPEECH_LANGUAGE_TAG: Record<Language, string> = {
  ko: "ko-KR",
  en: "en-US",
  zh: "zh-CN",
  "zh-Hant": "zh-TW",
  fr: "fr-FR",
  de: "de-DE",
  es: "es-ES",
  pt: "pt-BR",
};

export const speechLanguageTag = (language: Language) => SPEECH_LANGUAGE_TAG[language] ?? "en-US";

export function speechSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

let speakingId: string | null = null;
let generation = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export const getSpeakingId = () => speakingId;
export const subscribeSpeaking = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function stopSpeaking() {
  generation += 1;
  if (speechSupported()) window.speechSynthesis.cancel();
  if (speakingId !== null) {
    speakingId = null;
    emit();
  }
}

/** Starts reading `markdown`; a second call for the same id stops instead. */
export function toggleSpeaking(id: string, markdown: string, language: Language) {
  if (!speechSupported()) return;
  if (speakingId === id) {
    stopSpeaking();
    return;
  }
  stopSpeaking();
  const chunks = splitSpeechChunks(plainTextForSpeech(markdown));
  if (chunks.length === 0) return;
  const mine = ++generation;
  speakingId = id;
  emit();
  const lang = speechLanguageTag(language);
  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = lang;
    const finish = () => {
      if (generation !== mine || speakingId !== id) return;
      speakingId = null;
      emit();
    };
    if (index === chunks.length - 1) utterance.onend = finish;
    utterance.onerror = (event) => {
      // `canceled` and `interrupted` are our own stop; anything else ends the read.
      if (generation === mine && event.error !== "canceled" && event.error !== "interrupted") {
        window.speechSynthesis.cancel();
        finish();
      }
    };
    window.speechSynthesis.speak(utterance);
  });
}
