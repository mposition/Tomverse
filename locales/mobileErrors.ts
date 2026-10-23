import type { MobileLanguage } from "./mobile";

const copy: Record<MobileLanguage, { unsupported: string; size: string; file: string; plan: string; limited: string }> = {
  en: { unsupported: "This file format is not supported. Choose another file.", size: "This file is too large. Choose a smaller file.", file: "This file could not be read. Check its format and password protection.", plan: "This model or feature is not available with your current plan.", limited: "Too many requests. Wait a moment before trying again." },
  ko: { unsupported: "지원하지 않는 파일 형식입니다. 다른 파일을 선택하세요.", size: "파일이 너무 큽니다. 더 작은 파일을 선택하세요.", file: "파일을 읽지 못했습니다. 파일 형식과 암호 설정을 확인하세요.", plan: "현재 플랜에서는 이 모델 또는 기능을 사용할 수 없습니다.", limited: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." },
  zh: { unsupported: "不支持此文件格式，请选择其他文件。", size: "文件过大，请选择较小的文件。", file: "无法读取文件，请检查格式和密码保护。", plan: "当前套餐无法使用此模型或功能。", limited: "请求过多，请稍后重试。" },
  de: { unsupported: "Dieses Dateiformat wird nicht unterstützt. Wähle eine andere Datei.", size: "Die Datei ist zu groß. Wähle eine kleinere Datei.", file: "Datei nicht lesbar. Prüfe Format und Passwortschutz.", plan: "Dieses Modell oder diese Funktion ist in deinem Tarif nicht verfügbar.", limited: "Zu viele Anfragen. Bitte versuche es später erneut." },
  fr: { unsupported: "Ce format n’est pas pris en charge. Choisissez un autre fichier.", size: "Ce fichier est trop volumineux. Choisissez un fichier plus petit.", file: "Fichier illisible. Vérifiez le format et la protection par mot de passe.", plan: "Ce modèle ou cette fonction n’est pas disponible avec votre forfait.", limited: "Trop de demandes. Réessayez dans un instant." },
  es: { unsupported: "Formato no compatible. Elige otro archivo.", size: "El archivo es demasiado grande. Elige uno más pequeño.", file: "No se pudo leer el archivo. Revisa el formato y la contraseña.", plan: "Este modelo o función no está disponible en tu plan.", limited: "Demasiadas solicitudes. Espera un momento antes de intentarlo de nuevo." },
  pt: { unsupported: "Formato não suportado. Escolha outro ficheiro.", size: "O ficheiro é demasiado grande. Escolha um mais pequeno.", file: "Não foi possível ler o ficheiro. Verifique o formato e a proteção por palavra-passe.", plan: "Este modelo ou funcionalidade não está disponível no seu plano.", limited: "Demasiados pedidos. Aguarde um momento antes de tentar novamente." },
};
const retry: Record<MobileLanguage, string> = {
  en: "Requests are being sent too quickly. Please try again in {seconds} seconds.",
  ko: "요청이 너무 빠르게 전송되었습니다. {seconds}초 후 다시 시도해 주세요.",
  zh: "请求发送过快，请在 {seconds} 秒后重试。",
  de: "Anfragen werden zu schnell gesendet. Bitte versuchen Sie es in {seconds} Sekunden erneut.",
  fr: "Les requêtes sont envoyées trop rapidement. Réessayez dans {seconds} secondes.",
  es: "Las solicitudes se están enviando demasiado rápido. Inténtalo de nuevo en {seconds} segundos.",
  pt: "As solicitações estão sendo enviadas rápido demais. Tente novamente em {seconds} segundos.",
};
export function mobileErrorText(error: unknown, language: MobileLanguage, fallback: string): string {
  const input = (error ?? {}) as { code?: unknown; status?: unknown; retryAfterSeconds?: unknown; traceId?: unknown };
  const annotate = (text: string) => text + (typeof input.traceId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(input.traceId) ? ` · Trace ID: ${input.traceId}` : "");
  const code = typeof input.code === "string" ? input.code : "";
  const status = typeof input.status === "number" ? input.status : undefined;
  if (["ATTACHMENT_UNSUPPORTED_FORMAT", "UNSUPPORTED_ATTACHMENT_TYPE"].includes(code)) return annotate(copy[language].unsupported);
  if (code.includes("TOO_LARGE") || status === 413) return annotate(copy[language].size);
  if (code.startsWith("ATTACHMENT_") || code.startsWith("ARCHIVE_")) return annotate(copy[language].file);
  if (code.startsWith("PLAN_") || status === 403) return annotate(copy[language].plan);
  if (status === 429) {
    const text = typeof input.retryAfterSeconds === "number" && input.retryAfterSeconds > 0 && input.retryAfterSeconds <= 86400 ? retry[language].replace("{seconds}", String(Math.ceil(input.retryAfterSeconds))) : copy[language].limited;
    return annotate(text);
  }
  return annotate(fallback);
}
