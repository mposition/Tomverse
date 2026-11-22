import type { Language } from "@/lib/language";

export const developerToolsCopy = {
    "en": {
        "intro": "Connect your tools with one API key and shared credits.",
        "cli": "A coding agent in your terminal",
        "editor": "Ask and Agent in your editor · Preview",
        "otherTitle": "Other coding tools",
        "other": "Codex, Claude Code, Cursor and more",
        "install": "Install guide",
        "guide": "Preview guide",
        "connect": "Connect guide",
        "reference": "API documentation",
        "limits": "Usage and key limits are in API key management."
    },
    "ko": {
        "intro": "API 키 하나와 공유 크레딧으로 개발 도구를 연결하세요.",
        "cli": "터미널의 코딩 에이전트",
        "editor": "에디터에서 Ask와 Agent · 프리뷰",
        "otherTitle": "다른 코딩 도구",
        "other": "Codex, Claude Code, Cursor 등",
        "install": "설치 안내",
        "guide": "프리뷰 안내",
        "connect": "연결 안내",
        "reference": "API 문서",
        "limits": "사용량과 키별 한도는 API 키 관리에서 확인합니다."
    },
    "zh": {
        "intro": "使用一个 API 密钥和共享额度连接开发工具。",
        "cli": "终端中的编程代理",
        "editor": "编辑器中的 Ask 和 Agent · 预览",
        "otherTitle": "其他编程工具",
        "other": "Codex、Claude Code、Cursor 等",
        "install": "安装指南",
        "guide": "预览指南",
        "connect": "连接指南",
        "reference": "API 文档",
        "limits": "用量和密钥限额可在 API 密钥管理中查看。"
    },
    "zh-Hant": {
        "intro": "使用一個 API 金鑰和共享額度連接開發工具。",
        "cli": "終端機中的程式代理",
        "editor": "編輯器中的 Ask 和 Agent · 預覽",
        "otherTitle": "其他程式工具",
        "other": "Codex、Claude Code、Cursor 等",
        "install": "安裝指南",
        "guide": "預覽指南",
        "connect": "連接指南",
        "reference": "API 文件",
        "limits": "用量和金鑰限額可在 API 金鑰管理中查看。"
    },
    "fr": {
        "intro": "Connectez vos outils avec une clé API et vos crédits partagés.",
        "cli": "Un agent de code dans votre terminal",
        "editor": "Ask et Agent dans votre éditeur · Aperçu",
        "otherTitle": "Autres outils de code",
        "other": "Codex, Claude Code, Cursor et plus",
        "install": "Installation",
        "guide": "Guide de l’aperçu",
        "connect": "Connexion",
        "reference": "Documentation API",
        "limits": "Consultez l’usage et les plafonds dans la gestion des clés API."
    },
    "de": {
        "intro": "Verbinden Sie Ihre Tools mit einem API-Schlüssel und gemeinsamen Credits.",
        "cli": "Ein Coding-Agent in Ihrem Terminal",
        "editor": "Ask und Agent im Editor · Vorschau",
        "otherTitle": "Andere Coding-Tools",
        "other": "Codex, Claude Code, Cursor und mehr",
        "install": "Installation",
        "guide": "Vorschau-Anleitung",
        "connect": "Verbindung",
        "reference": "API-Dokumentation",
        "limits": "Nutzung und Limits finden Sie in der API-Schlüsselverwaltung."
    },
    "es": {
        "intro": "Conecta tus herramientas con una clave API y créditos compartidos.",
        "cli": "Un agente de programación en tu terminal",
        "editor": "Ask y Agent en tu editor · Vista previa",
        "otherTitle": "Otras herramientas de código",
        "other": "Codex, Claude Code, Cursor y más",
        "install": "Instalación",
        "guide": "Guía de vista previa",
        "connect": "Conexión",
        "reference": "Documentación API",
        "limits": "Consulta el uso y los límites en la gestión de claves API."
    },
    "pt": {
        "intro": "Conecte suas ferramentas com uma chave API e créditos compartilhados.",
        "cli": "Um agente de programação no terminal",
        "editor": "Ask e Agent no editor · Prévia",
        "otherTitle": "Outras ferramentas de código",
        "other": "Codex, Claude Code, Cursor e mais",
        "install": "Instalação",
        "guide": "Guia da prévia",
        "connect": "Conexão",
        "reference": "Documentação da API",
        "limits": "Consulte o uso e os limites no gerenciamento de chaves API."
    }
} satisfies Record<Language, Record<string, string>>;

type VscodeGuideCopy = {
    title: readonly [string, string];
    description: string;
    steps: readonly [string, string][];
    supportTitle: string;
    support: readonly [string, string, string, string];
    createKey: string;
    availability: string;
    mock: {
        proposal: string;
        model: string;
        effort: string;
        selection: string;
        prompt: string;
        change: string;
        once: string;
        run: string;
        deny: string;
        receipt: string;
    };
};

export const vscodeGuideCopy = {
    en: {
        title: ["Stay in your editor.", "Approved edits only"],
        description: "Ask about your project in the VS Code sidebar. Review file edits and commands one at a time before approving them. It works with one Tomverse API key, with no Copilot or other AI extension required.",
        steps: [
            ["Install from VSIX", "Run Extensions: Install from VSIX in VS Code and choose the file you received. No CLI or other AI extension is required."],
            ["Connect your API key", "Select Connect API key in the Tomverse sidebar and enter your key. The key stays in VS Code SecretStorage."],
            ["Ask questions. Edit with Agent.", "Attach files, a selection, or diagnostics. Ask is read-only. Agent requests approval for each edit and command."],
            ["Track costs and undo changes", "See the credits spent on each request in the sidebar. Undo changes made by the extension one at a time."],
        ],
        supportTitle: "Compatibility",
        support: ["VS Code Desktop 1.146 or later", "Windows x64 verified", "macOS arm64 and Linux x64 verification pending", "Remote, WSL, containers and web unsupported"],
        createKey: "Create an API key",
        availability: "The stable VSIX is available from GitHub Releases.",
        mock: {
            proposal: "Tomverse proposal",
            model: "Smart Adaptive",
            effort: "Default effort",
            selection: "calc.ts · Lines 12–19",
            prompt: "Make sum return 0 for an empty array.",
            change: "Proposed edit",
            once: "Allow once",
            run: "Allow for this run",
            deny: "Deny",
            receipt: "2 requests · 4 credits settled",
        },
    },
    ko: {
        title: ["에디터를 떠나지 않고,", "승인한 변경만."],
        description: "VS Code 사이드바에서 프로젝트를 묻고, 파일 수정과 명령은 하나씩 확인한 뒤 승인합니다. Tomverse API 키 하나로 동작하고 Copilot이나 다른 AI 확장은 필요 없습니다.",
        steps: [
            ["VSIX로 설치", "VS Code에서 Extensions: Install from VSIX를 실행하고 받은 파일을 고릅니다. CLI나 다른 AI 확장은 필요 없습니다."],
            ["API 키 연결", "Tomverse 사이드바에서 API 키 연결을 누르고 키를 입력합니다. 키는 VS Code의 보안 저장소에만 남습니다."],
            ["Ask로 묻고, Agent로 고칩니다", "파일·선택 영역·진단을 첨부합니다. Ask는 읽기만 하고, Agent는 수정과 명령마다 승인을 받습니다."],
            ["비용과 되돌리기", "요청마다 쓴 크레딧이 사이드바에 남고, 확장이 만든 변경은 하나씩 되돌릴 수 있습니다."],
        ],
        supportTitle: "지원 범위",
        support: ["VS Code Desktop 1.146 이상", "Windows x64 검증", "macOS arm64 · Linux x64 검증 예정", "원격·WSL·컨테이너·웹 미지원"],
        createKey: "API 키 만들기",
        availability: "정식 VSIX는 GitHub Releases에서 받을 수 있습니다.",
        mock: {
            proposal: "Tomverse 제안",
            model: "스마트 자동",
            effort: "사고 수준 기본",
            selection: "calc.ts · 12–19행",
            prompt: "빈 배열이면 sum이 0을 돌려주게 고쳐 줘",
            change: "수정 제안",
            once: "이번만 허용",
            run: "이번 실행 동안 허용",
            deny: "거부",
            receipt: "요청 2회 · 4 크레딧 정산",
        },
    },
    zh: {
        title: ["无需离开编辑器，", "只做已批准的更改。"],
        description: "在 VS Code 侧栏中询问项目相关问题，逐项查看文件修改和命令后再批准。只需一个 Tomverse API 密钥，无需 Copilot 或其他 AI 扩展。",
        steps: [
            ["从 VSIX 安装", "在 VS Code 中运行 Extensions: Install from VSIX 并选择收到的文件。无需 CLI 或其他 AI 扩展。"],
            ["连接 API 密钥", "在 Tomverse 侧栏中选择连接 API 密钥并输入密钥。密钥仅保存在 VS Code 的安全存储中。"],
            ["用 Ask 提问，用 Agent 修改", "附加文件、选区或诊断。Ask 为只读模式，Agent 会为每项修改和命令请求批准。"],
            ["查看费用并撤销更改", "每次请求消耗的额度都记录在侧栏中。可以逐一撤销扩展所做的更改。"],
        ],
        supportTitle: "支持范围",
        support: ["VS Code Desktop 1.146 或更高版本", "Windows x64 已验证", "macOS arm64 和 Linux x64 待验证", "不支持远程、WSL、容器和网页"],
        createKey: "创建 API 密钥",
        availability: "正式版 VSIX 可在 GitHub Releases 下载。",
        mock: {
            proposal: "Tomverse 建议",
            model: "智能自动",
            effort: "默认思考级别",
            selection: "calc.ts · 第 12–19 行",
            prompt: "让 sum 在数组为空时返回 0。",
            change: "修改建议",
            once: "仅允许一次",
            run: "本次运行均允许",
            deny: "拒绝",
            receipt: "2 次请求 · 已结算 4 额度",
        },
    },
    "zh-Hant": {
        title: ["無需離開編輯器，", "只做已核准的變更。"],
        description: "在 VS Code 側邊欄詢問專案相關問題，逐項檢視檔案修改和命令後再核准。只需一個 Tomverse API 金鑰，無需 Copilot 或其他 AI 擴充功能。",
        steps: [
            ["從 VSIX 安裝", "在 VS Code 中執行 Extensions: Install from VSIX 並選取收到的檔案。無需 CLI 或其他 AI 擴充功能。"],
            ["連接 API 金鑰", "在 Tomverse 側邊欄選取連接 API 金鑰並輸入金鑰。金鑰只會保存在 VS Code 的安全儲存空間。"],
            ["用 Ask 提問，用 Agent 修改", "附加檔案、選取範圍或診斷。Ask 為唯讀模式，Agent 會為每項修改和命令請求核准。"],
            ["查看費用並復原變更", "每次請求消耗的額度都記錄在側邊欄中。可以逐一復原擴充功能所做的變更。"],
        ],
        supportTitle: "支援範圍",
        support: ["VS Code Desktop 1.146 或更新版本", "Windows x64 已驗證", "macOS arm64 和 Linux x64 待驗證", "不支援遠端、WSL、容器和網頁"],
        createKey: "建立 API 金鑰",
        availability: "正式版 VSIX 可在 GitHub Releases 下載。",
        mock: {
            proposal: "Tomverse 建議",
            model: "智慧自動",
            effort: "預設思考程度",
            selection: "calc.ts · 第 12–19 行",
            prompt: "讓 sum 在陣列為空時傳回 0。",
            change: "修改建議",
            once: "僅允許一次",
            run: "本次執行均允許",
            deny: "拒絕",
            receipt: "2 次請求 · 已結算 4 額度",
        },
    },
    fr: {
        title: ["Restez dans votre éditeur.", "Validez chaque changement."],
        description: "Posez vos questions sur le projet dans la barre latérale de VS Code. Examinez chaque modification de fichier et chaque commande avant de donner votre accord. Une clé API Tomverse suffit, sans Copilot ni autre extension d’IA.",
        steps: [
            ["Installer depuis un VSIX", "Exécutez Extensions: Install from VSIX dans VS Code et sélectionnez le fichier reçu. Aucun CLI ni autre extension d’IA n’est nécessaire."],
            ["Connecter votre clé API", "Dans la barre latérale Tomverse, choisissez de connecter une clé API, puis saisissez-la. Elle reste dans le stockage sécurisé de VS Code."],
            ["Interroger avec Ask, modifier avec Agent", "Joignez des fichiers, une sélection ou des diagnostics. Ask est en lecture seule. Agent demande votre accord pour chaque modification et commande."],
            ["Suivre les coûts et annuler des modifications", "Les crédits utilisés pour chaque requête figurent dans la barre latérale. Annulez les modifications de l’extension une par une."],
        ],
        supportTitle: "Compatibilité",
        support: ["VS Code Desktop 1.146 ou ultérieur", "Windows x64 vérifié", "macOS arm64 et Linux x64 à vérifier", "Distant, WSL, conteneurs et web non pris en charge"],
        createKey: "Créer une clé API",
        availability: "Le VSIX de la version stable est disponible dans GitHub Releases.",
        mock: {
            proposal: "Proposition Tomverse",
            model: "Smart Adaptive",
            effort: "Effort par défaut",
            selection: "calc.ts · Lignes 12–19",
            prompt: "Fais en sorte que sum renvoie 0 si le tableau est vide.",
            change: "Modification proposée",
            once: "Autoriser une fois",
            run: "Autoriser pour cette exécution",
            deny: "Refuser",
            receipt: "2 requêtes · 4 crédits débités",
        },
    },
    de: {
        title: ["Bleiben Sie im Editor.", "Nur genehmigte Änderungen."],
        description: "Stellen Sie Fragen zu Ihrem Projekt in der VS Code-Seitenleiste. Prüfen Sie jede Dateiänderung und jeden Befehl, bevor Sie sie genehmigen. Ein Tomverse-API-Schlüssel genügt, ganz ohne Copilot oder andere KI-Erweiterungen.",
        steps: [
            ["Aus einer VSIX installieren", "Führen Sie in VS Code Extensions: Install from VSIX aus und wählen Sie die erhaltene Datei. Eine CLI oder eine weitere KI-Erweiterung ist nicht erforderlich."],
            ["API-Schlüssel verbinden", "Wählen Sie in der Tomverse-Seitenleiste die Option zum Verbinden eines API-Schlüssels und geben Sie ihn ein. Er bleibt im sicheren Speicher von VS Code."],
            ["Mit Ask fragen, mit Agent ändern", "Fügen Sie Dateien, eine Auswahl oder Diagnosen an. Ask hat nur Lesezugriff. Agent fragt bei jeder Änderung und jedem Befehl nach Zustimmung."],
            ["Kosten prüfen und Änderungen rückgängig machen", "Die Seitenleiste zeigt die verbrauchten Credits pro Anfrage. Änderungen der Erweiterung lassen sich einzeln rückgängig machen."],
        ],
        supportTitle: "Kompatibilität",
        support: ["VS Code Desktop ab 1.146", "Windows x64 geprüft", "macOS arm64 und Linux x64 noch zu prüfen", "Kein Remote-, WSL-, Container- oder Web-Support"],
        createKey: "API-Schlüssel erstellen",
        availability: "Die stabile VSIX-Datei ist über GitHub Releases verfügbar.",
        mock: {
            proposal: "Tomverse-Vorschlag",
            model: "Smart Adaptive",
            effort: "Standard-Denkaufwand",
            selection: "calc.ts · Zeilen 12–19",
            prompt: "Lass sum bei einem leeren Array 0 zurückgeben.",
            change: "Änderungsvorschlag",
            once: "Einmal zulassen",
            run: "Für diesen Lauf zulassen",
            deny: "Ablehnen",
            receipt: "2 Anfragen · 4 Credits abgerechnet",
        },
    },
    es: {
        title: ["Sin salir del editor.", "Solo cambios aprobados."],
        description: "Haz preguntas sobre tu proyecto en la barra lateral de VS Code. Revisa cada cambio de archivo y cada comando antes de aprobarlos. Solo necesitas una clave API de Tomverse, sin Copilot ni otras extensiones de IA.",
        steps: [
            ["Instalar desde VSIX", "Ejecuta Extensions: Install from VSIX en VS Code y selecciona el archivo recibido. No necesitas una CLI ni otra extensión de IA."],
            ["Conectar tu clave API", "Selecciona Conectar clave API en la barra lateral de Tomverse e introdúcela. La clave se guarda en el almacenamiento seguro de VS Code."],
            ["Pregunta con Ask y edita con Agent", "Adjunta archivos, una selección o diagnósticos. Ask es de solo lectura. Agent pide aprobación para cada cambio y comando."],
            ["Controlar los costes y deshacer cambios", "Consulta los créditos utilizados por solicitud en la barra lateral. Deshaz uno por uno los cambios realizados por la extensión."],
        ],
        supportTitle: "Compatibilidad",
        support: ["VS Code Desktop 1.146 o posterior", "Windows x64 verificado", "macOS arm64 y Linux x64 pendientes", "Remoto, WSL, contenedores y web no compatibles"],
        createKey: "Crear una clave API",
        availability: "El VSIX de la versión estable está disponible en GitHub Releases.",
        mock: {
            proposal: "Propuesta de Tomverse",
            model: "Smart Adaptive",
            effort: "Esfuerzo predeterminado",
            selection: "calc.ts · Líneas 12–19",
            prompt: "Haz que sum devuelva 0 si el array está vacío.",
            change: "Cambio propuesto",
            once: "Permitir una vez",
            run: "Permitir durante esta ejecución",
            deny: "Denegar",
            receipt: "2 solicitudes · 4 créditos cobrados",
        },
    },
    pt: {
        title: ["Sem sair do editor.", "Só as mudanças aprovadas."],
        description: "Faça perguntas sobre o projeto na barra lateral do VS Code. Revise cada alteração de arquivo e cada comando antes de aprovar. Basta uma chave de API do Tomverse, sem precisar do Copilot ou de outra extensão de IA.",
        steps: [
            ["Instalar pelo VSIX", "Execute Extensions: Install from VSIX no VS Code e selecione o arquivo recebido. Não é preciso ter uma CLI nem outra extensão de IA."],
            ["Conectar sua chave de API", "Na barra lateral do Tomverse, selecione Conectar chave de API e digite a chave. Ela fica no armazenamento seguro do VS Code."],
            ["Pergunte com Ask e edite com Agent", "Anexe arquivos, uma seleção ou diagnósticos. Ask é somente leitura. Agent pede aprovação para cada alteração e comando."],
            ["Acompanhar custos e desfazer alterações", "Os créditos gastos em cada solicitação aparecem na barra lateral. Desfaça uma a uma as alterações feitas pela extensão."],
        ],
        supportTitle: "Compatibilidade",
        support: ["VS Code Desktop 1.146 ou posterior", "Windows x64 testado", "macOS arm64 e Linux x64 ainda em validação", "Sem suporte a remoto, WSL, contêineres ou web"],
        createKey: "Criar uma chave de API",
        availability: "O VSIX da versão estável está disponível no GitHub Releases.",
        mock: {
            proposal: "Proposta do Tomverse",
            model: "Smart Adaptive",
            effort: "Esforço padrão",
            selection: "calc.ts · Linhas 12–19",
            prompt: "Faça sum retornar 0 quando o array estiver vazio.",
            change: "Alteração proposta",
            once: "Permitir uma vez",
            run: "Permitir nesta execução",
            deny: "Negar",
            receipt: "2 solicitações · 4 créditos cobrados",
        },
    },
} satisfies Record<Language, VscodeGuideCopy>;
