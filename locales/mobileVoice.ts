import type { MobileLanguage } from "./mobile";
const en = { permission: "Microphone access was denied. Check Tomverse’s microphone permission in device settings.", device: "The microphone could not start. Close other recording apps and try again.", unsupported: "Audio recording is unavailable. Update the system WebView and try again.", empty: "No audio was recorded. Speak for a little longer and try again.", network: "The recording could not be sent. Check your connection and record again.", failed: "Speech could not be converted to text. Please try again.", unavailable: "Voice input is not available on the server right now.", limited: "The voice input limit has been reached. Please try again later.", recording: "Recording", transcribing: "Converting speech to text…" };
const ko: typeof en = { permission: "마이크 접근이 거부되었습니다. 기기 설정에서 Tomverse의 마이크 권한을 확인하세요.", device: "마이크 녹음을 시작하지 못했습니다. 다른 녹음 앱을 종료하고 다시 시도하세요.", unsupported: "음성 녹음을 사용할 수 없습니다. 시스템 WebView를 업데이트한 뒤 다시 시도하세요.", empty: "녹음된 소리가 없습니다. 조금 더 길게 말씀해 주세요.", network: "녹음을 전송하지 못했습니다. 연결을 확인하고 다시 녹음해 주세요.", failed: "음성을 텍스트로 변환하지 못했습니다. 다시 시도하세요.", unavailable: "현재 서버에서 음성 입력을 사용할 수 없습니다.", limited: "음성 입력 한도에 도달했습니다. 잠시 후 다시 시도하세요.", recording: "녹음 중", transcribing: "음성을 텍스트로 변환하는 중…" };
export const mobileVoiceCopy = (language: MobileLanguage) => language === "ko" ? ko : en;
export function mobileVoiceError(language: MobileLanguage, code: string, serverCode?: string | null) {
  const c = mobileVoiceCopy(language);
  if (code === "VOICE_PERMISSION_DENIED") return c.permission;
  if (code === "VOICE_DEVICE_UNAVAILABLE") return c.device;
  if (code === "VOICE_UNSUPPORTED_BROWSER") return c.unsupported;
  if (code === "VOICE_CLIP_EMPTY" || serverCode === "VOICE_TRANSCRIPT_EMPTY") return c.empty;
  if (code === "VOICE_NETWORK_ERROR") return c.network;
  if (serverCode?.includes("LIMIT") || serverCode?.includes("BUDGET")) return c.limited;
  if (serverCode === "VOICE_DISABLED" || serverCode === "VOICE_INPUT_DISABLED" || serverCode === "VOICE_UNAVAILABLE" || serverCode === "VOICE_PROVIDER_UNAVAILABLE") return c.unavailable;
  return c.failed;
}

// Existing approved voice notice, copied verbatim from the web locales.
const privacy: Record<MobileLanguage, string> = {
  "en": "Audio is sent to the speech-to-text provider for conversion only. Tomverse does not save the recording, and the text goes into the input box for you to check before sending.",
  "ko": "음성은 변환을 위해서만 음성 인식 제공업체로 전송됩니다. Tomverse는 녹음을 저장하지 않으며, 변환된 문장은 입력창에 들어가 보내기 전에 직접 확인할 수 있습니다.",
  "zh": "音频仅为转写发送给语音识别服务商。Tomverse 不保存录音，转写结果会填入输入框，发送前可自行确认和修改。",
  "de": "Die Audiodaten gehen ausschließlich zur Umwandlung an den Spracherkennungsanbieter. Tomverse speichert die Aufnahme nicht, und der Text landet im Eingabefeld, damit Sie ihn vor dem Senden prüfen können.",
  "fr": "L'audio est envoyé au prestataire de reconnaissance vocale uniquement pour la conversion. Tomverse ne conserve pas l'enregistrement, et le texte obtenu arrive dans la zone de saisie pour que vous puissiez le vérifier avant l'envoi.",
  "es": "El audio se envía al proveedor de reconocimiento de voz solo para convertirlo. Tomverse no guarda la grabación y el texto aparece en el cuadro de entrada para que lo revises antes de enviarlo.",
  "pt": "O áudio é enviado ao provedor de reconhecimento de voz apenas para a conversão. A Tomverse não guarda a gravação, e o texto entra na caixa de digitação para você conferir antes de enviar."
};
export const mobileVoicePrivacy = (language: MobileLanguage) => privacy[language];
