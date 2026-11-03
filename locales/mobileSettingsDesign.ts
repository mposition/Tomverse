import type { MobileLanguage } from "./mobile";
const copies = {
  en: { accountInformation: "Account information", appearance: "Appearance", languageAndTime: "Language & time", deviceSummary: "Use your device's fingerprint or PIN when signing in again." },
  ko: { accountInformation: "계정 정보", appearance: "화면 설정", languageAndTime: "언어 및 시간 설정", deviceSummary: "다시 로그인할 때 기기의 지문·PIN으로 인증해요." },
  zh: { accountInformation: "账号信息", appearance: "显示设置", languageAndTime: "语言与时间", deviceSummary: "重新登录时，使用设备指纹或 PIN 验证。" },
  de: { accountInformation: "Kontoinformationen", appearance: "Darstellung", languageAndTime: "Sprache und Zeit", deviceSummary: "Beim erneuten Anmelden den Fingerabdruck oder die PIN des Geräts verwenden." },
  fr: { accountInformation: "Informations du compte", appearance: "Apparence", languageAndTime: "Langue et heure", deviceSummary: "Utilisez l’empreinte ou le code PIN de votre appareil à la reconnexion." },
  es: { accountInformation: "Información de la cuenta", appearance: "Apariencia", languageAndTime: "Idioma y hora", deviceSummary: "Usa la huella o el PIN del dispositivo al volver a iniciar sesión." },
  pt: { accountInformation: "Informações da conta", appearance: "Aspeto", languageAndTime: "Idioma e hora", deviceSummary: "Use a impressão digital ou o PIN do dispositivo ao iniciar sessão novamente." },
};
export const mobileSettingsDesignCopy = (language: MobileLanguage) => copies[language];
