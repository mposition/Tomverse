import type { MobileLanguage } from "./mobile";

const copies: Record<MobileLanguage, { install: string; iosInstructions: string }> = {
  en: { install: "Install Tomverse", iosInstructions: "In Safari, open Share and choose Add to Home Screen." },
  ko: { install: "Tomverse 앱 설치", iosInstructions: "Safari에서 공유 버튼을 누른 뒤 ‘홈 화면에 추가’를 선택하세요." },
  zh: { install: "安装 Tomverse", iosInstructions: "在 Safari 中点按“共享”，然后选择“添加到主屏幕”。" },
  de: { install: "Tomverse installieren", iosInstructions: "Öffne in Safari „Teilen“ und wähle „Zum Home-Bildschirm“." },
  fr: { install: "Installer Tomverse", iosInstructions: "Dans Safari, ouvrez Partager, puis choisissez Sur l’écran d’accueil." },
  es: { install: "Instalar Tomverse", iosInstructions: "En Safari, abre Compartir y elige Añadir a la pantalla de inicio." },
  pt: { install: "Instalar Tomverse", iosInstructions: "No Safari, abra Compartilhar e escolha Adicionar à Tela de Início." },
};

export const pwaInstallCopy = (language: string) => copies[language as MobileLanguage] ?? copies.en;
