import type { Language } from "@/lib/language";
import type { McpProvider, McpProviderCategory } from "@/lib/mcpProviderCatalog";

const categories: Record<Language, Record<McpProviderCategory, string>> = {
  en: { productivity: "Work with documents, tasks and communication tools.", design: "Work with design and media tools.", development: "Work with code and development tools.", data: "Search and work with data sources.", monitoring: "Inspect service health and operational data.", security: "Inspect security and compliance information.", finance: "Work with finance and commerce tools.", other: "Use the provider's available tools and resources." },
  ko: { productivity: "문서·작업·커뮤니케이션 도구를 활용합니다.", design: "디자인·미디어 작업 도구를 활용합니다.", development: "코드·개발 작업 도구를 활용합니다.", data: "데이터를 검색하고 데이터 소스를 활용합니다.", monitoring: "서비스 상태와 운영 정보를 확인합니다.", security: "보안·규정 준수 정보를 확인합니다.", finance: "금융·커머스 작업 도구를 활용합니다.", other: "공급자가 제공하는 도구와 자료를 활용합니다." },
  zh: { productivity: "使用文档、任务和沟通工具。", design: "使用设计和媒体工具。", development: "使用代码和开发工具。", data: "搜索并使用数据源。", monitoring: "查看服务状态和运行数据。", security: "查看安全与合规信息。", finance: "使用财务与商务工具。", other: "使用提供商的可用工具与资源。" },
  "zh-Hant": { productivity: "使用文件、工作與溝通工具。", design: "使用設計與媒體工具。", development: "使用程式碼與開發工具。", data: "搜尋並使用資料來源。", monitoring: "查看服務狀態與運作資料。", security: "查看安全與合規資訊。", finance: "使用財務與商務工具。", other: "使用供應商提供的工具與資源。" },
  fr: { productivity: "Utilisez les outils de documents, de tâches et de communication.", design: "Utilisez les outils de création et de médias.", development: "Utilisez les outils de code et de développement.", data: "Recherchez et utilisez des sources de données.", monitoring: "Consultez l'état des services et les données opérationnelles.", security: "Consultez les informations de sécurité et de conformité.", finance: "Utilisez les outils de finance et de commerce.", other: "Utilisez les outils et ressources disponibles du fournisseur." },
  de: { productivity: "Nutzen Sie Dokument-, Aufgaben- und Kommunikationstools.", design: "Nutzen Sie Design- und Medientools.", development: "Nutzen Sie Code- und Entwicklungstools.", data: "Durchsuchen und nutzen Sie Datenquellen.", monitoring: "Prüfen Sie Dienststatus und Betriebsdaten.", security: "Prüfen Sie Sicherheits- und Compliance-Informationen.", finance: "Nutzen Sie Finanz- und Handelstools.", other: "Nutzen Sie die verfügbaren Tools und Ressourcen des Anbieters." },
  es: { productivity: "Use herramientas de documentos, tareas y comunicación.", design: "Use herramientas de diseño y contenido multimedia.", development: "Use herramientas de código y desarrollo.", data: "Busque y utilice fuentes de datos.", monitoring: "Consulte el estado del servicio y los datos operativos.", security: "Consulte información de seguridad y cumplimiento.", finance: "Use herramientas de finanzas y comercio.", other: "Use las herramientas y los recursos disponibles del proveedor." },
  pt: { productivity: "Use ferramentas de documentos, tarefas e comunicação.", design: "Use ferramentas de design e multimédia.", development: "Use ferramentas de código e desenvolvimento.", data: "Pesquise e utilize fontes de dados.", monitoring: "Consulte o estado dos serviços e os dados operacionais.", security: "Consulte informações de segurança e conformidade.", finance: "Use ferramentas de finanças e comércio.", other: "Use as ferramentas e os recursos disponíveis do fornecedor." },
};

const providerSummaries: Record<string, { en: string; ko: string }> = {
  aiven: { en: "Inspect and manage Aiven database and streaming services.", ko: "Aiven 데이터베이스·스트리밍 서비스를 조회하고 관리합니다." },
  airwallex: { en: "Explore Airwallex payment API documentation and integration examples.", ko: "Airwallex 결제 API 문서와 연동 예제를 찾아봅니다." },
  github: { en: "Work with repositories, issues and pull requests.", ko: "저장소·이슈·PR을 확인하고 작업합니다." },
  railway: { en: "Inspect projects, deployments and service logs.", ko: "프로젝트·배포 상태와 서비스 로그를 확인합니다." },
  slack: { en: "Find conversations and work with channel messages.", ko: "대화를 찾고 채널 메시지로 협업합니다." },
  notion: { en: "Find and work with workspace pages and databases.", ko: "워크스페이스 페이지와 데이터베이스를 찾아 활용합니다." },
  linear: { en: "Find and manage project issues.", ko: "프로젝트 이슈를 검색하고 관리합니다." },
  figma: { en: "Inspect designs and work with design files.", ko: "디자인을 확인하고 디자인 파일을 활용합니다." },
  canva: { en: "Find and work with visual designs.", ko: "시각 디자인을 찾고 제작 도구를 활용합니다." },
  atlassian: { en: "Work with Jira issues and Confluence pages.", ko: "Jira 이슈와 Confluence 페이지로 협업합니다." },
  sentry: { en: "Investigate application errors and performance.", ko: "애플리케이션 오류와 성능을 조사합니다." },
  cloudflare: { en: "Inspect and work with Cloudflare services.", ko: "Cloudflare 서비스 상태를 확인하고 관리합니다." },
};

export function mcpProviderSummary(provider: McpProvider, lang: Language): string {
  const summary = providerSummaries[provider.id];
  return summary && (lang === "en" || lang === "ko") ? summary[lang] : categories[lang][provider.category];
}
