import type { Language } from "../lib/language";
import type { CliAccount } from "../apps/desktop/src/code-execution";

type Copy = Record<CliAccount["status"] | CliAccount["billingSource"], string> & {
  account: string; billing: string; guide: string; check: string; cancel: string; fixture: string; codexApproval: string;
};

export const desktopCliAccountCopy = {
  en: {
    account: "Provider sign-in", billing: "Billing source", guide: "Official sign-in guide", check: "Check isolated sign-in", cancel: "Cancel sign-in check",
    fixture: "This check uses a fresh CLI test profile.", codexApproval: "Commercial integration approval required",
    signedIn: "Signed in", signInRequired: "Sign-in required", signInExpired: "Sign-in expired", accountUnknown: "Sign-in unconfirmed",
    networkBlocked: "Sign-in unconfirmed · network request blocked",
    provider_subscription: "Provider subscription", provider_api: "Provider API billing", unknown: "Unknown",
  },
  ko: {
    account: "공급자 로그인", billing: "결제 출처", guide: "공식 로그인 안내", check: "격리 프로필 로그인 확인", cancel: "로그인 확인 취소",
    fixture: "이 확인에는 비어 있는 CLI 테스트 프로필을 사용합니다.", codexApproval: "상용 연동 승인 필요",
    signedIn: "로그인됨", signInRequired: "로그인 필요", signInExpired: "로그인 만료", accountUnknown: "로그인 미확인",
    networkBlocked: "로그인 미확인 · 외부 연결 차단",
    provider_subscription: "공급자 구독", provider_api: "공급자 API 과금", unknown: "알 수 없음",
  },
  zh: {
    account: "供应商登录", billing: "计费来源", guide: "官方登录指南", check: "检查隔离环境的登录状态", cancel: "取消登录检查",
    fixture: "此检查使用全新的 CLI 测试配置。", codexApproval: "需要商业集成审批",
    signedIn: "已登录", signInRequired: "需要登录", signInExpired: "登录已过期", accountUnknown: "登录状态未确认",
    networkBlocked: "登录状态未确认 · 网络请求已阻止",
    provider_subscription: "供应商订阅", provider_api: "供应商 API 计费", unknown: "未知",
  },
  "zh-Hant": {
    account: "供應商登入", billing: "計費來源", guide: "官方登入指南", check: "檢查隔離環境的登入狀態", cancel: "取消登入檢查",
    fixture: "此檢查使用全新的 CLI 測試設定檔。", codexApproval: "需要商業整合核准",
    signedIn: "已登入", signInRequired: "需要登入", signInExpired: "登入已過期", accountUnknown: "登入狀態未確認",
    networkBlocked: "登入狀態未確認 · 網路請求已封鎖",
    provider_subscription: "供應商訂閱", provider_api: "供應商 API 計費", unknown: "未知",
  },
  fr: {
    account: "Connexion au fournisseur", billing: "Source de facturation", guide: "Guide de connexion officiel", check: "Vérifier la connexion isolée", cancel: "Annuler la vérification de connexion",
    fixture: "Cette vérification utilise un nouveau profil de test CLI.", codexApproval: "Approbation de l’intégration commerciale requise",
    signedIn: "Connecté", signInRequired: "Connexion requise", signInExpired: "Connexion expirée", accountUnknown: "Connexion non confirmée",
    networkBlocked: "Connexion non confirmée · requête réseau bloquée",
    provider_subscription: "Abonnement au fournisseur", provider_api: "Facturation par l’API du fournisseur", unknown: "Inconnue",
  },
  de: {
    account: "Anbieteranmeldung", billing: "Abrechnungsquelle", guide: "Offizielle Anmeldeanleitung", check: "Anmeldung im Testprofil prüfen", cancel: "Anmeldeprüfung abbrechen",
    fixture: "Diese Prüfung verwendet ein neues CLI-Testprofil.", codexApproval: "Genehmigung für die kommerzielle Integration erforderlich",
    signedIn: "Angemeldet", signInRequired: "Anmeldung erforderlich", signInExpired: "Anmeldung abgelaufen", accountUnknown: "Anmeldung nicht bestätigt",
    networkBlocked: "Anmeldung nicht bestätigt · Netzwerkanfrage blockiert",
    provider_subscription: "Anbieterabonnement", provider_api: "API-Abrechnung des Anbieters", unknown: "Unbekannt",
  },
  es: {
    account: "Inicio de sesión en el proveedor", billing: "Fuente de facturación", guide: "Guía oficial de inicio de sesión", check: "Comprobar inicio de sesión aislado", cancel: "Cancelar la comprobación de inicio de sesión",
    fixture: "Esta comprobación utiliza un perfil de prueba nuevo de la CLI.", codexApproval: "Se requiere aprobación para la integración comercial",
    signedIn: "Sesión iniciada", signInRequired: "Debes iniciar sesión", signInExpired: "La sesión ha caducado", accountUnknown: "Inicio de sesión sin confirmar",
    networkBlocked: "Inicio de sesión sin confirmar · solicitud de red bloqueada",
    provider_subscription: "Suscripción al proveedor", provider_api: "Facturación de la API del proveedor", unknown: "Desconocida",
  },
  pt: {
    account: "Início de sessão no fornecedor", billing: "Origem da faturação", guide: "Guia oficial de início de sessão", check: "Verificar início de sessão isolado", cancel: "Cancelar a verificação de início de sessão",
    fixture: "Esta verificação usa um novo perfil de teste da CLI.", codexApproval: "A integração comercial requer aprovação",
    signedIn: "Sessão iniciada", signInRequired: "É necessário iniciar sessão", signInExpired: "Sessão expirada", accountUnknown: "Início de sessão por confirmar",
    networkBlocked: "Início de sessão por confirmar · pedido de rede bloqueado",
    provider_subscription: "Subscrição do fornecedor", provider_api: "Faturação pela API do fornecedor", unknown: "Desconhecida",
  },
} satisfies Record<Language, Copy>;
