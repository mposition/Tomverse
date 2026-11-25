import type { Language } from "../lib/language";
import type { CliProtocolCheck } from "../apps/desktop/src/code-execution";

type Copy = Record<CliProtocolCheck["status"], string> &
  Record<"check" | "cancel" | "catalog" | "access" | "partial" | "empty", string>;

export const desktopCliProtocolCopy = {
  en: {
    networkBlocked: "The local protocol check blocked a network request from the CLI.",
    partial: "The CLI reported a partial model list.", empty: "The CLI reported no models.",
    check: "Check local protocol", cancel: "Cancel protocol check", catalog: "Advertised models", access: "Model access requires a connected account.",
    verified: "Protocol verified", unavailable: "A verified CLI file is required.", failed: "The protocol check failed.", cancelled: "Protocol check cancelled.",
  },
  ko: {
    networkBlocked: "로컬 프로토콜 확인 중 CLI의 네트워크 요청을 차단했습니다.",
    partial: "CLI가 모델 목록의 일부만 제공했습니다.", empty: "CLI가 제공한 모델이 없습니다.",
    check: "로컬 프로토콜 확인", cancel: "프로토콜 확인 취소", catalog: "CLI가 제공한 모델 목록", access: "모델 사용 권한은 연결한 계정에서 확인합니다.",
    verified: "프로토콜 확인됨", unavailable: "확인된 CLI 파일이 필요합니다.", failed: "프로토콜을 확인하지 못했습니다.", cancelled: "프로토콜 확인을 취소했습니다.",
  },
  zh: {
    networkBlocked: "本地协议检查阻止了 CLI 发起的网络请求。",
    partial: "CLI 仅返回了部分模型列表。", empty: "CLI 未返回任何模型。",
    check: "检查本地协议", cancel: "取消协议检查", catalog: "CLI 提供的模型", access: "模型访问权限需要通过已连接的账户确认。",
    verified: "协议已验证", unavailable: "需要已验证的 CLI 文件。", failed: "协议检查失败。", cancelled: "协议检查已取消。",
  },
  "zh-Hant": {
    networkBlocked: "本機通訊協定檢查封鎖了 CLI 發出的網路請求。",
    partial: "CLI 只提供了部分模型清單。", empty: "CLI 未提供任何模型。",
    check: "檢查本機通訊協定", cancel: "取消通訊協定檢查", catalog: "CLI 提供的模型", access: "模型存取權限需透過已連線的帳戶確認。",
    verified: "通訊協定已驗證", unavailable: "需要已驗證的 CLI 檔案。", failed: "通訊協定檢查失敗。", cancelled: "已取消通訊協定檢查。",
  },
  fr: {
    networkBlocked: "La vérification du protocole local a bloqué une requête réseau de la CLI.",
    partial: "La CLI a fourni une liste de modèles partielle.", empty: "La CLI n’a fourni aucun modèle.",
    check: "Vérifier le protocole local", cancel: "Annuler la vérification", catalog: "Modèles annoncés", access: "L’accès aux modèles nécessite un compte connecté.",
    verified: "Protocole vérifié", unavailable: "Un fichier CLI vérifié est requis.", failed: "Échec de la vérification du protocole.", cancelled: "Vérification du protocole annulée.",
  },
  de: {
    networkBlocked: "Die lokale Protokollprüfung hat eine Netzwerkanfrage der CLI blockiert.",
    partial: "Die CLI hat eine unvollständige Modellliste gemeldet.", empty: "Die CLI hat keine Modelle gemeldet.",
    check: "Lokales Protokoll prüfen", cancel: "Protokollprüfung abbrechen", catalog: "Gemeldete Modelle", access: "Der Modellzugriff erfordert ein verbundenes Konto.",
    verified: "Protokoll geprüft", unavailable: "Eine geprüfte CLI-Datei ist erforderlich.", failed: "Die Protokollprüfung ist fehlgeschlagen.", cancelled: "Protokollprüfung abgebrochen.",
  },
  es: {
    networkBlocked: "La comprobación del protocolo local bloqueó una solicitud de red de la CLI.",
    partial: "La CLI informó de una lista parcial de modelos.", empty: "La CLI no informó de ningún modelo.",
    check: "Comprobar el protocolo local", cancel: "Cancelar la comprobación", catalog: "Modelos anunciados", access: "El acceso a los modelos requiere una cuenta conectada.",
    verified: "Protocolo verificado", unavailable: "Se requiere un archivo CLI verificado.", failed: "Falló la comprobación del protocolo.", cancelled: "Comprobación del protocolo cancelada.",
  },
  pt: {
    networkBlocked: "A verificação do protocolo local bloqueou um pedido de rede da CLI.",
    partial: "A CLI devolveu uma lista parcial de modelos.", empty: "A CLI não devolveu nenhum modelo.",
    check: "Verificar o protocolo local", cancel: "Cancelar a verificação", catalog: "Modelos anunciados", access: "O acesso aos modelos requer uma conta ligada.",
    verified: "Protocolo verificado", unavailable: "É necessário um ficheiro CLI verificado.", failed: "A verificação do protocolo falhou.", cancelled: "Verificação do protocolo cancelada.",
  },
} satisfies Record<Language, Copy>;
