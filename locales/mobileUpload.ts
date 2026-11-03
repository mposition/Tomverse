import type { MobileLanguage } from "./mobile";

type UploadCopy = { title: string; completed: string; automaticClose: string };
export const mobileUploadCopy: Record<MobileLanguage, UploadCopy> = {
  en: { title: "Uploading files", completed: "{completed} / {total} complete", automaticClose: "This closes automatically when finished." },
  ko: { title: "파일 업로드 중", completed: "{completed} / {total} 완료", automaticClose: "완료되면 자동으로 닫힙니다." },
  zh: { title: "正在上传文件", completed: "已完成 {completed} / {total}", automaticClose: "完成后将自动关闭。" },
  de: { title: "Dateien werden hochgeladen", completed: "{completed} / {total} fertig", automaticClose: "Wird nach Abschluss automatisch geschlossen." },
  fr: { title: "Envoi des fichiers", completed: "{completed} / {total} terminés", automaticClose: "Cette fenêtre se ferme automatiquement à la fin." },
  es: { title: "Subiendo archivos", completed: "{completed} / {total} completados", automaticClose: "Se cerrará automáticamente al terminar." },
  pt: { title: "Enviando arquivos", completed: "{completed} / {total} concluídos", automaticClose: "Esta janela fecha automaticamente ao concluir." },
};
