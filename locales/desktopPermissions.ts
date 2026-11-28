import type { Language } from "../lib/language";

type Copy = {
  modeHeading: string;
  readOnly: string;
  readOnlyDetail: string;
  ask: string;
  askDetail: string;
  autoReview: string;
  autoReviewDetail: string;
  autoReviewCost: string;
  allowAll: string;
  allowAllDetail: string;
  allowAllConfirmTitle: string;
  allowAllConfirmBody: string;
  allowAllConfirm: string;
  cancel: string;
  allowAllBadge: string;
  rulesHeading: string;
  rulesDetail: string;
  userRules: string;
  projectRules: string;
  noProject: string;
  noRules: string;
  projectFile: string;
  removeRule: string;
  effectAllow: string;
  effectAsk: string;
  effectDeny: string;
  toolEdit: string;
  toolCommand: string;
  toolWeb: string;
  toolMcp: string;
  patternEdit: string;
  patternCommand: string;
  patternWeb: string;
  mcpName: string;
  scopeUser: string;
  scopeProject: string;
  exact: string;
  add: string;
  trustTitle: string;
  trustBody: string;
  trustChanged: string;
  trustApply: string;
  trustRevoke: string;
  saveFailed: string;
  problems: string;
  newRule: string;
  effect: string;
  tool: string;
  pattern: string;
  scope: string;
};

export const desktopPermissionsCopy = {
  en: {
    modeHeading: "Permission mode",
    readOnly: "Read only", readOnlyDetail: "The agent can read and search. It cannot change files or run commands.",
    ask: "Ask each time", askDetail: "You approve every file change and command. This is the default.",
    autoReview: "Auto review", autoReviewDetail: "A separate model request judges each approval. If it is unsure, fails, or declines three times in a row, you decide.",
    autoReviewCost: "Every approval sends one extra model request, charged like any other request.",
    allowAll: "Allow all", allowAllDetail: "Runs without asking. Anything that leaves this app, credential files and files outside the project folder are still not decided by this mode.",
    allowAllConfirmTitle: "Allow everything without asking?",
    allowAllConfirmBody: "The agent will change files and run commands in your project without asking, and it can make mistakes. Pushing code, opening pull requests and other actions that leave this app still ask you. This turns off when you close the app.",
    allowAllConfirm: "Allow all", cancel: "Cancel", allowAllBadge: "Allow all is on",
    rulesHeading: "Allow, ask and deny rules",
    rulesDetail: "Deny wins over ask, and ask over allow. Rules never override the protections for credential files, files outside the project and actions that leave this app.",
    userRules: "Your rules (all projects)", projectRules: "This project's rules",
    noProject: "Open a project folder to add rules for it.", noRules: "No rules.",
    projectFile: "Saved in .tomverse/permissions.json in the project folder.",
    removeRule: "Remove rule {rule}",
    effectAllow: "Allow", effectAsk: "Ask", effectDeny: "Deny",
    toolEdit: "File edits", toolCommand: "Commands", toolWeb: "Web pages", toolMcp: "MCP tool",
    patternEdit: "Path, for example src/**", patternCommand: "Start of the command, for example npm test", patternWeb: "Site, for example docs.python.org", mcpName: "mcp__server__tool",
    scopeUser: "All projects", scopeProject: "This project", exact: "This exact command only", add: "Add rule",
    trustTitle: "This project brought its own allow rules",
    trustBody: "They are not applied until you confirm them. Read them first:",
    trustChanged: "These rules changed since you confirmed them, so they are not applied.",
    trustApply: "Apply these rules", trustRevoke: "Stop applying this project's allow rules",
    saveFailed: "The change could not be saved.", problems: "A rules file has a problem",
    newRule: "New rule", effect: "Effect", tool: "Applies to", pattern: "Pattern", scope: "Where",
  },
  ko: {
    modeHeading: "권한 모드",
    readOnly: "읽기 전용", readOnlyDetail: "에이전트가 읽고 검색만 합니다. 파일을 바꾸거나 명령을 실행하지 않습니다.",
    ask: "매번 묻기", askDetail: "파일 변경과 명령을 모두 직접 승인합니다. 기본값입니다.",
    autoReview: "자동 검토", autoReviewDetail: "별도의 모델 요청이 승인마다 판정합니다. 판단이 어렵거나 실패하거나 3번 연속 거부하면 직접 결정합니다.",
    autoReviewCost: "승인마다 모델 요청이 한 번 더 발생하며, 다른 요청처럼 과금됩니다.",
    allowAll: "전체 허용", allowAllDetail: "묻지 않고 실행합니다. 앱 밖으로 나가는 동작, 자격 증명 파일, 프로젝트 폴더 밖의 파일은 이 모드로 정해지지 않습니다.",
    allowAllConfirmTitle: "묻지 않고 모두 허용할까요?",
    allowAllConfirmBody: "에이전트가 프로젝트의 파일을 바꾸고 명령을 묻지 않고 실행하며, 실수할 수 있습니다. 코드 push, pull request 생성처럼 앱 밖으로 나가는 동작은 계속 묻습니다. 앱을 닫으면 꺼집니다.",
    allowAllConfirm: "전체 허용", cancel: "취소", allowAllBadge: "전체 허용 켜짐",
    rulesHeading: "허용·확인·거부 규칙",
    rulesDetail: "거부가 확인보다, 확인이 허용보다 우선합니다. 규칙은 자격 증명 파일, 프로젝트 밖 파일, 앱 밖으로 나가는 동작의 보호를 넘지 못합니다.",
    userRules: "내 규칙 (모든 프로젝트)", projectRules: "이 프로젝트의 규칙",
    noProject: "프로젝트 폴더를 열면 프로젝트 규칙을 추가할 수 있습니다.", noRules: "규칙이 없습니다.",
    projectFile: "프로젝트 폴더의 .tomverse/permissions.json에 저장됩니다.",
    removeRule: "규칙 삭제 {rule}",
    effectAllow: "허용", effectAsk: "확인", effectDeny: "거부",
    toolEdit: "파일 편집", toolCommand: "명령", toolWeb: "웹 페이지", toolMcp: "MCP 도구",
    patternEdit: "경로, 예: src/**", patternCommand: "명령의 시작, 예: npm test", patternWeb: "사이트, 예: docs.python.org", mcpName: "mcp__server__tool",
    scopeUser: "모든 프로젝트", scopeProject: "이 프로젝트", exact: "이 명령만 정확히", add: "규칙 추가",
    trustTitle: "이 프로젝트가 자체 허용 규칙을 가져왔습니다",
    trustBody: "확인하기 전에는 적용되지 않습니다. 먼저 내용을 읽어 보세요.",
    trustChanged: "확인한 뒤 규칙이 바뀌어 적용되지 않습니다.",
    trustApply: "이 규칙 적용", trustRevoke: "이 프로젝트의 허용 규칙 적용 중단",
    saveFailed: "변경을 저장하지 못했습니다.", problems: "규칙 파일에 문제가 있습니다",
    newRule: "새 규칙", effect: "동작", tool: "대상", pattern: "패턴", scope: "범위",
  },
  zh: {
    modeHeading: "权限模式",
    readOnly: "只读", readOnlyDetail: "智能体只能读取和搜索，不能修改文件或运行命令。",
    ask: "每次询问", askDetail: "每次文件修改和命令都由你批准。这是默认设置。",
    autoReview: "自动审查", autoReviewDetail: "由单独的模型请求判断每次批准。如果无法判断、请求失败或连续拒绝三次，则由你决定。",
    autoReviewCost: "每次批准会多发出一次模型请求，与其他请求一样计费。",
    allowAll: "全部允许", allowAllDetail: "不询问直接运行。离开本应用的操作、凭据文件和项目文件夹之外的文件不由此模式决定。",
    allowAllConfirmTitle: "要不经询问允许全部操作吗？",
    allowAllConfirmBody: "智能体将不经询问修改项目中的文件并运行命令，可能出错。推送代码、创建拉取请求等离开本应用的操作仍会询问你。关闭应用后此模式会关闭。",
    allowAllConfirm: "全部允许", cancel: "取消", allowAllBadge: "已开启全部允许",
    rulesHeading: "允许、询问和拒绝规则",
    rulesDetail: "拒绝优先于询问，询问优先于允许。规则不能突破对凭据文件、项目之外的文件以及离开本应用的操作的保护。",
    userRules: "我的规则（所有项目）", projectRules: "此项目的规则",
    noProject: "打开项目文件夹后可添加项目规则。", noRules: "暂无规则。",
    projectFile: "保存在项目文件夹的 .tomverse/permissions.json 中。",
    removeRule: "删除规则 {rule}",
    effectAllow: "允许", effectAsk: "询问", effectDeny: "拒绝",
    toolEdit: "文件编辑", toolCommand: "命令", toolWeb: "网页", toolMcp: "MCP 工具",
    patternEdit: "路径，例如 src/**", patternCommand: "命令开头，例如 npm test", patternWeb: "网站，例如 docs.python.org", mcpName: "mcp__server__tool",
    scopeUser: "所有项目", scopeProject: "此项目", exact: "仅限这条完全相同的命令", add: "添加规则",
    trustTitle: "此项目自带允许规则",
    trustBody: "在你确认之前不会生效。请先阅读：",
    trustChanged: "这些规则在你确认之后发生了变化，因此不会生效。",
    trustApply: "应用这些规则", trustRevoke: "停止应用此项目的允许规则",
    saveFailed: "无法保存更改。", problems: "规则文件有问题",
    newRule: "新规则", effect: "操作", tool: "适用于", pattern: "模式", scope: "范围",
  },
  "zh-Hant": {
    modeHeading: "權限模式",
    readOnly: "唯讀", readOnlyDetail: "代理程式只能讀取和搜尋，不能修改檔案或執行指令。",
    ask: "每次詢問", askDetail: "每次檔案修改和指令都由你核准。這是預設值。",
    autoReview: "自動審查", autoReviewDetail: "由獨立的模型請求判斷每次核准。若無法判斷、請求失敗或連續拒絕三次，則由你決定。",
    autoReviewCost: "每次核准會多送出一次模型請求，與其他請求一樣計費。",
    allowAll: "全部允許", allowAllDetail: "不詢問直接執行。離開本應用程式的操作、憑證檔案和專案資料夾以外的檔案不由此模式決定。",
    allowAllConfirmTitle: "要不經詢問允許全部操作嗎？",
    allowAllConfirmBody: "代理程式將不經詢問修改專案中的檔案並執行指令，可能出錯。推送程式碼、建立 pull request 等離開本應用程式的操作仍會詢問你。關閉應用程式後此模式會關閉。",
    allowAllConfirm: "全部允許", cancel: "取消", allowAllBadge: "已開啟全部允許",
    rulesHeading: "允許、詢問和拒絕規則",
    rulesDetail: "拒絕優先於詢問，詢問優先於允許。規則不能突破對憑證檔案、專案以外的檔案以及離開本應用程式的操作的保護。",
    userRules: "我的規則（所有專案）", projectRules: "此專案的規則",
    noProject: "開啟專案資料夾後可新增專案規則。", noRules: "尚無規則。",
    projectFile: "儲存在專案資料夾的 .tomverse/permissions.json 中。",
    removeRule: "刪除規則 {rule}",
    effectAllow: "允許", effectAsk: "詢問", effectDeny: "拒絕",
    toolEdit: "檔案編輯", toolCommand: "指令", toolWeb: "網頁", toolMcp: "MCP 工具",
    patternEdit: "路徑，例如 src/**", patternCommand: "指令開頭，例如 npm test", patternWeb: "網站，例如 docs.python.org", mcpName: "mcp__server__tool",
    scopeUser: "所有專案", scopeProject: "此專案", exact: "僅限這條完全相同的指令", add: "新增規則",
    trustTitle: "此專案自帶允許規則",
    trustBody: "在你確認之前不會生效。請先閱讀：",
    trustChanged: "這些規則在你確認之後發生了變化，因此不會生效。",
    trustApply: "套用這些規則", trustRevoke: "停止套用此專案的允許規則",
    saveFailed: "無法儲存變更。", problems: "規則檔案有問題",
    newRule: "新規則", effect: "操作", tool: "適用於", pattern: "模式", scope: "範圍",
  },
  fr: {
    modeHeading: "Mode d'autorisation",
    readOnly: "Lecture seule", readOnlyDetail: "L'agent peut lire et rechercher. Il ne peut ni modifier de fichiers ni exécuter de commandes.",
    ask: "Demander à chaque fois", askDetail: "Vous approuvez chaque modification de fichier et chaque commande. C'est le réglage par défaut.",
    autoReview: "Revue automatique", autoReviewDetail: "Une requête de modèle distincte juge chaque approbation. En cas de doute, d'échec ou de trois refus d'affilée, c'est vous qui décidez.",
    autoReviewCost: "Chaque approbation envoie une requête de modèle supplémentaire, facturée comme les autres.",
    allowAll: "Tout autoriser", allowAllDetail: "S'exécute sans demander. Ce qui sort de l'application, les fichiers d'identifiants et les fichiers hors du dossier du projet ne sont pas décidés par ce mode.",
    allowAllConfirmTitle: "Tout autoriser sans demander ?",
    allowAllConfirmBody: "L'agent modifiera des fichiers et exécutera des commandes dans votre projet sans demander, et il peut se tromper. Pousser du code, ouvrir des pull requests et toute action qui sort de l'application vous sont toujours demandés. Ce mode s'éteint à la fermeture de l'application.",
    allowAllConfirm: "Tout autoriser", cancel: "Annuler", allowAllBadge: "Tout autoriser est activé",
    rulesHeading: "Règles d'autorisation, de demande et de refus",
    rulesDetail: "Le refus l'emporte sur la demande, et la demande sur l'autorisation. Aucune règle ne lève la protection des fichiers d'identifiants, des fichiers hors du projet et des actions qui sortent de l'application.",
    userRules: "Vos règles (tous les projets)", projectRules: "Règles de ce projet",
    noProject: "Ouvrez un dossier de projet pour y ajouter des règles.", noRules: "Aucune règle.",
    projectFile: "Enregistrées dans .tomverse/permissions.json, dans le dossier du projet.",
    removeRule: "Supprimer la règle {rule}",
    effectAllow: "Autoriser", effectAsk: "Demander", effectDeny: "Refuser",
    toolEdit: "Modifications de fichiers", toolCommand: "Commandes", toolWeb: "Pages web", toolMcp: "Outil MCP",
    patternEdit: "Chemin, par exemple src/**", patternCommand: "Début de la commande, par exemple npm test", patternWeb: "Site, par exemple docs.python.org", mcpName: "mcp__server__tool",
    scopeUser: "Tous les projets", scopeProject: "Ce projet", exact: "Cette commande exacte seulement", add: "Ajouter la règle",
    trustTitle: "Ce projet apporte ses propres règles d'autorisation",
    trustBody: "Elles ne s'appliquent qu'après votre confirmation. Lisez-les d'abord :",
    trustChanged: "Ces règles ont changé depuis votre confirmation : elles ne sont pas appliquées.",
    trustApply: "Appliquer ces règles", trustRevoke: "Ne plus appliquer les règles d'autorisation de ce projet",
    saveFailed: "La modification n'a pas pu être enregistrée.", problems: "Un fichier de règles pose problème",
    newRule: "Nouvelle règle", effect: "Effet", tool: "S'applique à", pattern: "Motif", scope: "Portée",
  },
  de: {
    modeHeading: "Berechtigungsmodus",
    readOnly: "Nur lesen", readOnlyDetail: "Der Agent kann lesen und suchen. Er ändert keine Dateien und führt keine Befehle aus.",
    ask: "Jedes Mal fragen", askDetail: "Sie genehmigen jede Dateiänderung und jeden Befehl. Das ist die Standardeinstellung.",
    autoReview: "Automatische Prüfung", autoReviewDetail: "Eine getrennte Modellanfrage beurteilt jede Genehmigung. Ist sie unsicher, schlägt sie fehl oder lehnt dreimal hintereinander ab, entscheiden Sie.",
    autoReviewCost: "Jede Genehmigung sendet eine zusätzliche Modellanfrage, die wie jede andere Anfrage berechnet wird.",
    allowAll: "Alles erlauben", allowAllDetail: "Läuft ohne Rückfrage. Was die App verlässt, Dateien mit Zugangsdaten und Dateien außerhalb des Projektordners entscheidet dieser Modus nicht.",
    allowAllConfirmTitle: "Alles ohne Rückfrage erlauben?",
    allowAllConfirmBody: "Der Agent ändert Dateien und führt Befehle in Ihrem Projekt ohne Rückfrage aus und kann Fehler machen. Code pushen, Pull Requests öffnen und andere Aktionen, die die App verlassen, werden weiterhin abgefragt. Der Modus endet, wenn Sie die App schließen.",
    allowAllConfirm: "Alles erlauben", cancel: "Abbrechen", allowAllBadge: "Alles erlauben ist aktiv",
    rulesHeading: "Regeln zum Erlauben, Nachfragen und Verweigern",
    rulesDetail: "Verweigern geht vor Nachfragen, Nachfragen vor Erlauben. Keine Regel hebt den Schutz von Dateien mit Zugangsdaten, von Dateien außerhalb des Projekts und von Aktionen auf, die die App verlassen.",
    userRules: "Ihre Regeln (alle Projekte)", projectRules: "Regeln dieses Projekts",
    noProject: "Öffnen Sie einen Projektordner, um Regeln dafür hinzuzufügen.", noRules: "Keine Regeln.",
    projectFile: "Gespeichert in .tomverse/permissions.json im Projektordner.",
    removeRule: "Regel {rule} entfernen",
    effectAllow: "Erlauben", effectAsk: "Nachfragen", effectDeny: "Verweigern",
    toolEdit: "Dateiänderungen", toolCommand: "Befehle", toolWeb: "Webseiten", toolMcp: "MCP-Werkzeug",
    patternEdit: "Pfad, zum Beispiel src/**", patternCommand: "Anfang des Befehls, zum Beispiel npm test", patternWeb: "Website, zum Beispiel docs.python.org", mcpName: "mcp__server__tool",
    scopeUser: "Alle Projekte", scopeProject: "Dieses Projekt", exact: "Nur genau dieser Befehl", add: "Regel hinzufügen",
    trustTitle: "Dieses Projekt bringt eigene Erlauben-Regeln mit",
    trustBody: "Sie gelten erst nach Ihrer Bestätigung. Lesen Sie sie zuerst:",
    trustChanged: "Diese Regeln haben sich seit Ihrer Bestätigung geändert und werden nicht angewendet.",
    trustApply: "Diese Regeln anwenden", trustRevoke: "Erlauben-Regeln dieses Projekts nicht mehr anwenden",
    saveFailed: "Die Änderung konnte nicht gespeichert werden.", problems: "Eine Regeldatei hat ein Problem",
    newRule: "Neue Regel", effect: "Wirkung", tool: "Gilt für", pattern: "Muster", scope: "Bereich",
  },
  es: {
    modeHeading: "Modo de permisos",
    readOnly: "Solo lectura", readOnlyDetail: "El agente puede leer y buscar. No puede cambiar archivos ni ejecutar comandos.",
    ask: "Preguntar siempre", askDetail: "Usted aprueba cada cambio de archivo y cada comando. Es el valor predeterminado.",
    autoReview: "Revisión automática", autoReviewDetail: "Una solicitud de modelo aparte juzga cada aprobación. Si duda, falla o rechaza tres veces seguidas, decide usted.",
    autoReviewCost: "Cada aprobación envía una solicitud de modelo adicional, que se cobra como cualquier otra.",
    allowAll: "Permitir todo", allowAllDetail: "Se ejecuta sin preguntar. Lo que sale de la aplicación, los archivos de credenciales y los archivos fuera de la carpeta del proyecto no los decide este modo.",
    allowAllConfirmTitle: "¿Permitir todo sin preguntar?",
    allowAllConfirmBody: "El agente cambiará archivos y ejecutará comandos en su proyecto sin preguntar, y puede equivocarse. Hacer push de código, abrir pull requests y otras acciones que salen de la aplicación se siguen preguntando. Se desactiva al cerrar la aplicación.",
    allowAllConfirm: "Permitir todo", cancel: "Cancelar", allowAllBadge: "Permitir todo está activado",
    rulesHeading: "Reglas de permitir, preguntar y denegar",
    rulesDetail: "Denegar prevalece sobre preguntar, y preguntar sobre permitir. Ninguna regla anula la protección de los archivos de credenciales, de los archivos fuera del proyecto y de las acciones que salen de la aplicación.",
    userRules: "Sus reglas (todos los proyectos)", projectRules: "Reglas de este proyecto",
    noProject: "Abra una carpeta de proyecto para añadirle reglas.", noRules: "Sin reglas.",
    projectFile: "Se guardan en .tomverse/permissions.json, dentro de la carpeta del proyecto.",
    removeRule: "Eliminar la regla {rule}",
    effectAllow: "Permitir", effectAsk: "Preguntar", effectDeny: "Denegar",
    toolEdit: "Ediciones de archivos", toolCommand: "Comandos", toolWeb: "Páginas web", toolMcp: "Herramienta MCP",
    patternEdit: "Ruta, por ejemplo src/**", patternCommand: "Inicio del comando, por ejemplo npm test", patternWeb: "Sitio, por ejemplo docs.python.org", mcpName: "mcp__server__tool",
    scopeUser: "Todos los proyectos", scopeProject: "Este proyecto", exact: "Solo este comando exacto", add: "Añadir regla",
    trustTitle: "Este proyecto trae sus propias reglas de permitir",
    trustBody: "No se aplican hasta que usted las confirme. Léalas primero:",
    trustChanged: "Estas reglas cambiaron desde que las confirmó, así que no se aplican.",
    trustApply: "Aplicar estas reglas", trustRevoke: "Dejar de aplicar las reglas de permitir de este proyecto",
    saveFailed: "No se pudo guardar el cambio.", problems: "Un archivo de reglas tiene un problema",
    newRule: "Nueva regla", effect: "Efecto", tool: "Se aplica a", pattern: "Patrón", scope: "Ámbito",
  },
  pt: {
    modeHeading: "Modo de permissões",
    readOnly: "Somente leitura", readOnlyDetail: "O agente pode ler e pesquisar. Não pode alterar arquivos nem executar comandos.",
    ask: "Perguntar sempre", askDetail: "Você aprova cada alteração de arquivo e cada comando. É o padrão.",
    autoReview: "Revisão automática", autoReviewDetail: "Uma solicitação de modelo separada julga cada aprovação. Se tiver dúvida, falhar ou recusar três vezes seguidas, você decide.",
    autoReviewCost: "Cada aprovação envia uma solicitação de modelo extra, cobrada como qualquer outra.",
    allowAll: "Permitir tudo", allowAllDetail: "Executa sem perguntar. O que sai do aplicativo, arquivos de credenciais e arquivos fora da pasta do projeto não são decididos por este modo.",
    allowAllConfirmTitle: "Permitir tudo sem perguntar?",
    allowAllConfirmBody: "O agente vai alterar arquivos e executar comandos no seu projeto sem perguntar, e pode errar. Enviar código com push, abrir pull requests e outras ações que saem do aplicativo continuam sendo perguntadas. Este modo desliga quando você fecha o aplicativo.",
    allowAllConfirm: "Permitir tudo", cancel: "Cancelar", allowAllBadge: "Permitir tudo está ativado",
    rulesHeading: "Regras de permitir, perguntar e negar",
    rulesDetail: "Negar vale mais que perguntar, e perguntar mais que permitir. Nenhuma regra supera a proteção de arquivos de credenciais, de arquivos fora do projeto e de ações que saem do aplicativo.",
    userRules: "Suas regras (todos os projetos)", projectRules: "Regras deste projeto",
    noProject: "Abra uma pasta de projeto para adicionar regras a ele.", noRules: "Nenhuma regra.",
    projectFile: "Salvas em .tomverse/permissions.json, na pasta do projeto.",
    removeRule: "Remover a regra {rule}",
    effectAllow: "Permitir", effectAsk: "Perguntar", effectDeny: "Negar",
    toolEdit: "Edições de arquivos", toolCommand: "Comandos", toolWeb: "Páginas da web", toolMcp: "Ferramenta MCP",
    patternEdit: "Caminho, por exemplo src/**", patternCommand: "Início do comando, por exemplo npm test", patternWeb: "Site, por exemplo docs.python.org", mcpName: "mcp__server__tool",
    scopeUser: "Todos os projetos", scopeProject: "Este projeto", exact: "Somente este comando exato", add: "Adicionar regra",
    trustTitle: "Este projeto trouxe suas próprias regras de permitir",
    trustBody: "Elas só valem depois que você confirmar. Leia-as primeiro:",
    trustChanged: "Estas regras mudaram desde que você as confirmou, então não são aplicadas.",
    trustApply: "Aplicar estas regras", trustRevoke: "Parar de aplicar as regras de permitir deste projeto",
    saveFailed: "Não foi possível salvar a alteração.", problems: "Um arquivo de regras tem um problema",
    newRule: "Nova regra", effect: "Efeito", tool: "Vale para", pattern: "Padrão", scope: "Escopo",
  },
} as const satisfies Record<Language, Copy>;
