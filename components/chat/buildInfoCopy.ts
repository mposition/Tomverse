import type { Language } from "@/components/LanguageProvider";

// Dedicated copy for the STG-F010 build-info menu row/detail panel, kept
// separate from chatHelpCopy.ts (which is one large object already) rather
// than growing that file's type for a handful of small labels -- same
// pattern as chatModelSummaryCopy.ts for STG-F009.
export type BuildInfoCopy = {
  menuLabel: string;
  panelTitle: string;
  environmentLabel: string;
  commitLabel: string;
  builtLabel: string;
  deploymentStartedLabel: string;
  deployedLabel: string;
  deploymentLabel: string;
  deploymentStatusLabel: string;
  notAvailable: string;
  copyButton: string;
  copySuccess: string;
  copyFailure: string;
  environmentNames: Record<"development" | "staging" | "production" | "test", string>;
  deploymentStatusNames: Record<"success" | "in_progress" | "failed" | "unknown", string>;
};

export const buildInfoCopy: Record<Language, BuildInfoCopy> = {
  en: {
    menuLabel: "Build info",
    panelTitle: "Build info",
    environmentLabel: "Environment",
    commitLabel: "Build",
    builtLabel: "Built",
    deploymentStartedLabel: "Deployment started",
    deployedLabel: "Deployment completed",
    deploymentLabel: "Deployment",
    deploymentStatusLabel: "Deployment status",
    notAvailable: "Not available",
    copyButton: "Copy build info",
    copySuccess: "Build info copied.",
    copyFailure: "Couldn't copy build info.",
    environmentNames: {
      development: "Local",
      staging: "Staging",
      production: "Production",
      test: "Test",
    },
    deploymentStatusNames: {
      success: "Success",
      in_progress: "In progress",
      failed: "Failed",
      unknown: "Unknown",
    },
  },
  ko: {
    menuLabel: "빌드 정보",
    panelTitle: "빌드 정보",
    environmentLabel: "환경",
    commitLabel: "빌드",
    builtLabel: "빌드 시각",
    deploymentStartedLabel: "배포 시작 시각",
    deployedLabel: "배포 완료 시각",
    deploymentLabel: "배포 ID",
    deploymentStatusLabel: "배포 상태",
    notAvailable: "확인 불가",
    copyButton: "빌드 정보 복사",
    copySuccess: "빌드 정보를 복사했습니다.",
    copyFailure: "빌드 정보를 복사하지 못했습니다.",
    environmentNames: {
      development: "로컬",
      staging: "스테이징",
      production: "프로덕션",
      test: "테스트",
    },
    deploymentStatusNames: {
      success: "성공",
      in_progress: "진행 중",
      failed: "실패",
      unknown: "확인 불가",
    },
  },
  zh: {
    menuLabel: "构建信息",
    panelTitle: "构建信息",
    environmentLabel: "环境",
    commitLabel: "构建",
    builtLabel: "构建时间",
    deploymentStartedLabel: "部署开始时间",
    deployedLabel: "部署完成时间",
    deploymentLabel: "部署 ID",
    deploymentStatusLabel: "部署状态",
    notAvailable: "不可用",
    copyButton: "复制构建信息",
    copySuccess: "已复制构建信息。",
    copyFailure: "复制构建信息失败。",
    environmentNames: {
      development: "本地",
      staging: "预发布",
      production: "生产",
      test: "测试",
    },
    deploymentStatusNames: {
      success: "成功",
      in_progress: "进行中",
      failed: "失败",
      unknown: "不可用",
    },
  },
  fr: {
    menuLabel: "Infos de build",
    panelTitle: "Infos de build",
    environmentLabel: "Environnement",
    commitLabel: "Build",
    builtLabel: "Compilé",
    deploymentStartedLabel: "Déploiement démarré",
    deployedLabel: "Déploiement terminé",
    deploymentLabel: "Déploiement",
    deploymentStatusLabel: "Statut du déploiement",
    notAvailable: "Non disponible",
    copyButton: "Copier les infos de build",
    copySuccess: "Infos de build copiées.",
    copyFailure: "Impossible de copier les infos de build.",
    environmentNames: {
      development: "Local",
      staging: "Préproduction",
      production: "Production",
      test: "Test",
    },
    deploymentStatusNames: {
      success: "Réussi",
      in_progress: "En cours",
      failed: "Échoué",
      unknown: "Inconnu",
    },
  },
  de: {
    menuLabel: "Build-Info",
    panelTitle: "Build-Info",
    environmentLabel: "Umgebung",
    commitLabel: "Build",
    builtLabel: "Erstellt",
    deploymentStartedLabel: "Deployment gestartet",
    deployedLabel: "Deployment abgeschlossen",
    deploymentLabel: "Deployment",
    deploymentStatusLabel: "Deployment-Status",
    notAvailable: "Nicht verfügbar",
    copyButton: "Build-Info kopieren",
    copySuccess: "Build-Info kopiert.",
    copyFailure: "Build-Info konnte nicht kopiert werden.",
    environmentNames: {
      development: "Lokal",
      staging: "Staging",
      production: "Produktion",
      test: "Test",
    },
    deploymentStatusNames: {
      success: "Erfolgreich",
      in_progress: "Läuft",
      failed: "Fehlgeschlagen",
      unknown: "Unbekannt",
    },
  },
  es: {
    menuLabel: "Info de compilación",
    panelTitle: "Info de compilación",
    environmentLabel: "Entorno",
    commitLabel: "Compilación",
    builtLabel: "Compilado",
    deploymentStartedLabel: "Despliegue iniciado",
    deployedLabel: "Despliegue completado",
    deploymentLabel: "Despliegue",
    deploymentStatusLabel: "Estado del despliegue",
    notAvailable: "No disponible",
    copyButton: "Copiar info de compilación",
    copySuccess: "Info de compilación copiada.",
    copyFailure: "No se pudo copiar la info de compilación.",
    environmentNames: {
      development: "Local",
      staging: "Staging",
      production: "Producción",
      test: "Prueba",
    },
    deploymentStatusNames: {
      success: "Correcto",
      in_progress: "En curso",
      failed: "Fallido",
      unknown: "Desconocido",
    },
  },
  pt: {
    menuLabel: "Info de build",
    panelTitle: "Info de build",
    environmentLabel: "Ambiente",
    commitLabel: "Build",
    builtLabel: "Compilado",
    deploymentStartedLabel: "Implantação iniciada",
    deployedLabel: "Implantação concluída",
    deploymentLabel: "Implantação",
    deploymentStatusLabel: "Status da implantação",
    notAvailable: "Não disponível",
    copyButton: "Copiar info de build",
    copySuccess: "Info de build copiada.",
    copyFailure: "Não foi possível copiar a info de build.",
    environmentNames: {
      development: "Local",
      staging: "Staging",
      production: "Produção",
      test: "Teste",
    },
    deploymentStatusNames: {
      success: "Sucesso",
      in_progress: "Em andamento",
      failed: "Falhou",
      unknown: "Desconhecido",
    },
  },
};
