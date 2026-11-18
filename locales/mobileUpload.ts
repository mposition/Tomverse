import type { MobileLanguage } from "./mobile";

type UploadCopy = { title: string; completed: string; automaticClose: string; sizeLimit: string };
export const mobileUploadCopy: Record<MobileLanguage, UploadCopy> = {
  en: { title: "Uploading files", completed: "{completed} / {total} complete", automaticClose: "This closes automatically when finished.", sizeLimit: "Each file can be up to 50 MB, and a message up to 100 MB in all." },
  ko: { title: "파일 업로드 중", completed: "{completed} / {total} 완료", automaticClose: "완료되면 자동으로 닫힙니다.", sizeLimit: "파일은 각 50MB, 한 메시지에 합계 100MB까지 첨부할 수 있습니다." },
  zh: { title: "正在上传文件", completed: "已完成 {completed} / {total}", automaticClose: "完成后将自动关闭。", sizeLimit: "每个文件最大 50MB，一条消息合计最多 100MB。" },
  de: { title: "Dateien werden hochgeladen", completed: "{completed} / {total} fertig", automaticClose: "Wird nach Abschluss automatisch geschlossen.", sizeLimit: "Jede Datei darf bis zu 50 MB groß sein, eine Nachricht insgesamt bis zu 100 MB." },
  fr: { title: "Envoi des fichiers", completed: "{completed} / {total} terminés", automaticClose: "Cette fenêtre se ferme automatiquement à la fin.", sizeLimit: "Chaque fichier peut faire jusqu'à 50 Mo, et un message jusqu'à 100 Mo au total." },
  es: { title: "Subiendo archivos", completed: "{completed} / {total} completados", automaticClose: "Se cerrará automáticamente al terminar.", sizeLimit: "Cada archivo puede tener hasta 50 MB y un mensaje hasta 100 MB en total." },
  pt: { title: "Enviando arquivos", completed: "{completed} / {total} concluídos", automaticClose: "Esta janela fecha automaticamente ao concluir.", sizeLimit: "Cada arquivo pode ter até 50 MB e uma mensagem até 100 MB no total." },
};
