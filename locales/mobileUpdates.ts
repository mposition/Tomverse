import type { MobileLanguage } from "./mobile";

const en = { available: "A new version is ready", ready: "Ready to finish updating", update: "Update", restart: "Restart", later: "Later", retry: "Could not update. Please try again." };
export const mobileUpdatesCopy: Record<MobileLanguage, typeof en> = {
  en,
  ko: { available: "새 버전이 있어요", ready: "재시작하면 업데이트가 완료돼요", update: "업데이트", restart: "재시작", later: "나중에", retry: "업데이트하지 못했습니다. 다시 시도해 주세요." },
  zh: { available: "有新版本可用", ready: "重启即可完成更新", update: "更新", restart: "重启", later: "稍后", retry: "无法更新，请重试。" },
  fr: { available: "Une nouvelle version est disponible", ready: "Redémarrez pour terminer la mise à jour", update: "Mettre à jour", restart: "Redémarrer", later: "Plus tard", retry: "Échec de la mise à jour. Réessayez." },
  de: { available: "Eine neue Version ist verfügbar", ready: "Zum Abschließen neu starten", update: "Aktualisieren", restart: "Neu starten", later: "Später", retry: "Update fehlgeschlagen. Bitte erneut versuchen." },
  es: { available: "Hay una nueva versión disponible", ready: "Reinicia para completar la actualización", update: "Actualizar", restart: "Reiniciar", later: "Más tarde", retry: "No se pudo actualizar. Inténtalo de nuevo." },
  pt: { available: "Uma nova versão está disponível", ready: "Reinicie para concluir a atualização", update: "Atualizar", restart: "Reiniciar", later: "Mais tarde", retry: "Não foi possível atualizar. Tente novamente." },
};
