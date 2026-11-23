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

type EditorExtensionsCopy = {
    menuTitle: string;
    menuDescription: string;
    guideTitle: string;
    description: string;
    mobileDescription: string;
    sharedKey: string;
    installAction: string;
    vscode: readonly [requirements: string, install: string, open: string];
    visualStudio: readonly [requirements: string, install: string, open: string];
};

export const editorExtensionsCopy = {
    en: {
        menuTitle: "Editor extensions",
        menuDescription: "Install for VS Code or Visual Studio",
        guideTitle: "VS Code guide",
        description: "Use Tomverse in VS Code and Visual Studio. Ask about your code, then review and approve the file changes and commands Agent proposes.",
        mobileDescription: "Ask about your code. Review and approve Agent’s file changes and commands.",
        sharedKey: "Use one Tomverse API key to connect both extensions.",
        installAction: "Install from Marketplace",
        vscode: ["VS Code Desktop 1.146 or later · Local workspace", "After installation, open the Tomverse sidebar.", "Connect your Tomverse API key in the sidebar."],
        visualStudio: ["Visual Studio 2022 / 2026 · Windows x64", "Close all Visual Studio windows to start installation.", "After installation, reopen Visual Studio and go to Tools → Tomverse."],
    },
    ko: {
        menuTitle: "에디터 확장",
        menuDescription: "VS Code · Visual Studio 설치",
        guideTitle: "VS Code 사용 안내",
        description: "VS Code와 Visual Studio에서 Tomverse를 사용하세요. Ask로 코드를 묻고, Agent가 제안한 파일 변경과 명령은 검토한 뒤 승인할 수 있습니다.",
        mobileDescription: "Ask로 코드를 묻고, Agent의 파일 변경과 명령은 검토한 뒤 승인하세요.",
        sharedKey: "Tomverse API 키 하나로 두 확장을 연결할 수 있습니다.",
        installAction: "Marketplace에서 설치",
        vscode: ["VS Code Desktop 1.146 이상 · 로컬 작업공간", "설치한 뒤 Tomverse 사이드바를 여세요.", "사이드바에서 Tomverse API 키를 연결하세요."],
        visualStudio: ["Visual Studio 2022 / 2026 · Windows x64", "Visual Studio 창을 모두 닫으면 설치가 진행됩니다.", "설치 후 다시 열고 도구 → Tomverse로 이동하세요."],
    },
    zh: {
        menuTitle: "编辑器扩展",
        menuDescription: "安装到 VS Code 或 Visual Studio",
        guideTitle: "VS Code 使用指南",
        description: "在 VS Code 和 Visual Studio 中使用 Tomverse。用 Ask 提问，并在批准前审查 Agent 提议的文件更改和命令。",
        mobileDescription: "用 Ask 提问。审查并批准 Agent 的文件更改和命令。",
        sharedKey: "一个 Tomverse API 密钥即可连接两个扩展。",
        installAction: "从 Marketplace 安装",
        vscode: ["VS Code 桌面版 1.146 或更高版本 · 本地工作区", "安装后打开 Tomverse 侧栏。", "在侧栏中连接 Tomverse API 密钥。"],
        visualStudio: ["Visual Studio 2022 / 2026 · Windows x64", "关闭所有 Visual Studio 窗口后开始安装。", "安装后重新打开 Visual Studio，选择工具 → Tomverse。"],
    },
    "zh-Hant": {
        menuTitle: "編輯器擴充功能",
        menuDescription: "安裝到 VS Code 或 Visual Studio",
        guideTitle: "VS Code 使用指南",
        description: "在 VS Code 和 Visual Studio 中使用 Tomverse。用 Ask 提問，並在核准前檢查 Agent 提出的檔案變更和命令。",
        mobileDescription: "用 Ask 提問。檢查並核准 Agent 的檔案變更和命令。",
        sharedKey: "一組 Tomverse API 金鑰即可連接兩個擴充功能。",
        installAction: "從 Marketplace 安裝",
        vscode: ["VS Code 桌面版 1.146 以上 · 本機工作區", "安裝後開啟 Tomverse 側邊欄。", "在側邊欄連接 Tomverse API 金鑰。"],
        visualStudio: ["Visual Studio 2022 / 2026 · Windows x64", "關閉所有 Visual Studio 視窗後開始安裝。", "安裝後重新開啟 Visual Studio，選擇工具 → Tomverse。"],
    },
    fr: {
        menuTitle: "Extensions d’éditeur",
        menuDescription: "Installer pour VS Code ou Visual Studio",
        guideTitle: "Guide VS Code",
        description: "Utilisez Tomverse dans VS Code et Visual Studio. Posez vos questions avec Ask, puis vérifiez et approuvez les modifications de fichiers et les commandes proposées par Agent.",
        mobileDescription: "Posez vos questions avec Ask. Vérifiez et approuvez les modifications et les commandes d’Agent.",
        sharedKey: "Une seule clé API Tomverse permet de connecter les deux extensions.",
        installAction: "Installer depuis Marketplace",
        vscode: ["VS Code Desktop 1.146 ou ultérieur · Espace de travail local", "Après l’installation, ouvrez la barre latérale Tomverse.", "Connectez votre clé API Tomverse dans la barre latérale."],
        visualStudio: ["Visual Studio 2022 / 2026 · Windows x64", "Fermez toutes les fenêtres de Visual Studio pour lancer l’installation.", "Une fois l’installation terminée, rouvrez Visual Studio et choisissez Outils → Tomverse."],
    },
    de: {
        menuTitle: "Editor-Erweiterungen",
        menuDescription: "Für VS Code oder Visual Studio installieren",
        guideTitle: "VS Code-Anleitung",
        description: "Nutzen Sie Tomverse in VS Code und Visual Studio. Stellen Sie mit Ask Fragen zum Code und prüfen und genehmigen Sie die von Agent vorgeschlagenen Dateiänderungen und Befehle.",
        mobileDescription: "Stellen Sie mit Ask Fragen zum Code. Prüfen und genehmigen Sie die Änderungen und Befehle von Agent.",
        sharedKey: "Mit einem Tomverse-API-Schlüssel können Sie beide Erweiterungen verbinden.",
        installAction: "Aus dem Marketplace installieren",
        vscode: ["VS Code Desktop 1.146 oder höher · Lokaler Arbeitsbereich", "Öffnen Sie nach der Installation die Tomverse-Seitenleiste.", "Verbinden Sie Ihren Tomverse-API-Schlüssel in der Seitenleiste."],
        visualStudio: ["Visual Studio 2022 / 2026 · Windows x64", "Schließen Sie alle Visual-Studio-Fenster, um die Installation zu starten.", "Öffnen Sie nach der Installation Visual Studio erneut und wählen Sie Extras → Tomverse."],
    },
    es: {
        menuTitle: "Extensiones de editor",
        menuDescription: "Instalar en VS Code o Visual Studio",
        guideTitle: "Guía de VS Code",
        description: "Usa Tomverse en VS Code y Visual Studio. Haz preguntas sobre tu código con Ask y revisa los cambios de archivos y los comandos que propone Agent antes de aprobarlos.",
        mobileDescription: "Pregunta por tu código con Ask. Revisa y aprueba los cambios y comandos de Agent.",
        sharedKey: "Usa una sola clave API de Tomverse para conectar ambas extensiones.",
        installAction: "Instalar desde Marketplace",
        vscode: ["VS Code Desktop 1.146 o posterior · Espacio de trabajo local", "Tras la instalación, abre la barra lateral de Tomverse.", "Conecta tu clave API de Tomverse en la barra lateral."],
        visualStudio: ["Visual Studio 2022 / 2026 · Windows x64", "Cierra todas las ventanas de Visual Studio para iniciar la instalación.", "Después de instalar, vuelve a abrir Visual Studio y ve a Herramientas → Tomverse."],
    },
    pt: {
        menuTitle: "Extensões de editor",
        menuDescription: "Instalar no VS Code ou no Visual Studio",
        guideTitle: "Guia do VS Code",
        description: "Use o Tomverse no VS Code e no Visual Studio. Tire dúvidas sobre seu código com Ask e revise as alterações em arquivos e os comandos que Agent propõe antes de aprová-los.",
        mobileDescription: "Tire dúvidas sobre seu código com Ask. Revise e aprove as alterações e os comandos de Agent.",
        sharedKey: "Use uma única chave de API do Tomverse para conectar as duas extensões.",
        installAction: "Instalar pelo Marketplace",
        vscode: ["VS Code Desktop 1.146 ou posterior · Espaço de trabalho local", "Após instalar, abra a barra lateral do Tomverse.", "Conecte sua chave de API do Tomverse na barra lateral."],
        visualStudio: ["Visual Studio 2022 / 2026 · Windows x64", "Feche todas as janelas do Visual Studio para iniciar a instalação.", "Após instalar, reabra o Visual Studio e acesse Ferramentas → Tomverse."],
    },
} satisfies Record<Language, EditorExtensionsCopy>;

type VscodeGuideCopy = {
    title: readonly [string, string];
    steps: readonly [string, string][];
    supportTitle: string;
    support: readonly [string, string, string, string];
    createKey: string;
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
        steps: [
            ["Install the extension", "Install from Marketplace. If you already have a VSIX file, use Extensions: Install from VSIX to install it."],
            ["Connect your API key", "Select Connect API key in the Tomverse sidebar and enter your key. The key stays in VS Code SecretStorage."],
            ["Ask questions. Edit with Agent.", "Attach files, a selection, or diagnostics. Ask is read-only. Agent requests approval for each edit and command."],
            ["Track costs and undo changes", "See the credits spent on each request in the sidebar. Undo changes made by the extension one at a time."],
        ],
        supportTitle: "Compatibility",
        support: ["VS Code Desktop 1.146 or later", "Windows x64 verified", "macOS arm64 and Linux x64 verification pending", "Remote, WSL, containers and web unsupported"],
        createKey: "Create an API key",
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
        steps: [
            ["확장 설치", "Marketplace에서 설치합니다. VSIX 파일을 이미 받았다면 Extensions: Install from VSIX로 설치할 수 있습니다."],
            ["API 키 연결", "Tomverse 사이드바에서 API 키 연결을 누르고 키를 입력합니다. 키는 VS Code의 보안 저장소에만 남습니다."],
            ["Ask로 묻고, Agent로 고칩니다", "파일·선택 영역·진단을 첨부합니다. Ask는 읽기만 하고, Agent는 수정과 명령마다 승인을 받습니다."],
            ["비용과 되돌리기", "요청마다 쓴 크레딧이 사이드바에 남고, 확장이 만든 변경은 하나씩 되돌릴 수 있습니다."],
        ],
        supportTitle: "지원 범위",
        support: ["VS Code Desktop 1.146 이상", "Windows x64 검증", "macOS arm64 · Linux x64 검증 예정", "원격·WSL·컨테이너·웹 미지원"],
        createKey: "API 키 만들기",
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
        steps: [
            ["安装扩展", "从 Marketplace 安装。若已有 VSIX 文件，可使用 Extensions: Install from VSIX 安装。"],
            ["连接 API 密钥", "在 Tomverse 侧栏中选择连接 API 密钥并输入密钥。密钥仅保存在 VS Code 的安全存储中。"],
            ["用 Ask 提问，用 Agent 修改", "附加文件、选区或诊断。Ask 为只读模式，Agent 会为每项修改和命令请求批准。"],
            ["查看费用并撤销更改", "每次请求消耗的额度都记录在侧栏中。可以逐一撤销扩展所做的更改。"],
        ],
        supportTitle: "支持范围",
        support: ["VS Code Desktop 1.146 或更高版本", "Windows x64 已验证", "macOS arm64 和 Linux x64 待验证", "不支持远程、WSL、容器和网页"],
        createKey: "创建 API 密钥",
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
        steps: [
            ["安裝擴充功能", "從 Marketplace 安裝。若已有 VSIX 檔案，可使用 Extensions: Install from VSIX 安裝。"],
            ["連接 API 金鑰", "在 Tomverse 側邊欄選取連接 API 金鑰並輸入金鑰。金鑰只會保存在 VS Code 的安全儲存空間。"],
            ["用 Ask 提問，用 Agent 修改", "附加檔案、選取範圍或診斷。Ask 為唯讀模式，Agent 會為每項修改和命令請求核准。"],
            ["查看費用並復原變更", "每次請求消耗的額度都記錄在側邊欄中。可以逐一復原擴充功能所做的變更。"],
        ],
        supportTitle: "支援範圍",
        support: ["VS Code Desktop 1.146 或更新版本", "Windows x64 已驗證", "macOS arm64 和 Linux x64 待驗證", "不支援遠端、WSL、容器和網頁"],
        createKey: "建立 API 金鑰",
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
        steps: [
            ["Installer l’extension", "Installez l’extension depuis Marketplace. Si vous avez déjà un fichier VSIX, utilisez Extensions: Install from VSIX."],
            ["Connecter votre clé API", "Dans la barre latérale Tomverse, choisissez de connecter une clé API, puis saisissez-la. Elle reste dans le stockage sécurisé de VS Code."],
            ["Interroger avec Ask, modifier avec Agent", "Joignez des fichiers, une sélection ou des diagnostics. Ask est en lecture seule. Agent demande votre accord pour chaque modification et commande."],
            ["Suivre les coûts et annuler des modifications", "Les crédits utilisés pour chaque requête figurent dans la barre latérale. Annulez les modifications de l’extension une par une."],
        ],
        supportTitle: "Compatibilité",
        support: ["VS Code Desktop 1.146 ou ultérieur", "Windows x64 vérifié", "macOS arm64 et Linux x64 à vérifier", "Distant, WSL, conteneurs et web non pris en charge"],
        createKey: "Créer une clé API",
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
        steps: [
            ["Erweiterung installieren", "Installieren Sie die Erweiterung aus dem Marketplace. Wenn Sie bereits eine VSIX-Datei haben, verwenden Sie Extensions: Install from VSIX."],
            ["API-Schlüssel verbinden", "Wählen Sie in der Tomverse-Seitenleiste die Option zum Verbinden eines API-Schlüssels und geben Sie ihn ein. Er bleibt im sicheren Speicher von VS Code."],
            ["Mit Ask fragen, mit Agent ändern", "Fügen Sie Dateien, eine Auswahl oder Diagnosen an. Ask hat nur Lesezugriff. Agent fragt bei jeder Änderung und jedem Befehl nach Zustimmung."],
            ["Kosten prüfen und Änderungen rückgängig machen", "Die Seitenleiste zeigt die verbrauchten Credits pro Anfrage. Änderungen der Erweiterung lassen sich einzeln rückgängig machen."],
        ],
        supportTitle: "Kompatibilität",
        support: ["VS Code Desktop ab 1.146", "Windows x64 geprüft", "macOS arm64 und Linux x64 noch zu prüfen", "Kein Remote-, WSL-, Container- oder Web-Support"],
        createKey: "API-Schlüssel erstellen",
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
        steps: [
            ["Instalar la extensión", "Instala desde Marketplace. Si ya tienes un archivo VSIX, puedes instalarlo con Extensions: Install from VSIX."],
            ["Conectar tu clave API", "Selecciona Conectar clave API en la barra lateral de Tomverse e introdúcela. La clave se guarda en el almacenamiento seguro de VS Code."],
            ["Pregunta con Ask y edita con Agent", "Adjunta archivos, una selección o diagnósticos. Ask es de solo lectura. Agent pide aprobación para cada cambio y comando."],
            ["Controlar los costes y deshacer cambios", "Consulta los créditos utilizados por solicitud en la barra lateral. Deshaz uno por uno los cambios realizados por la extensión."],
        ],
        supportTitle: "Compatibilidad",
        support: ["VS Code Desktop 1.146 o posterior", "Windows x64 verificado", "macOS arm64 y Linux x64 pendientes", "Remoto, WSL, contenedores y web no compatibles"],
        createKey: "Crear una clave API",
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
        steps: [
            ["Instalar a extensão", "Instale pelo Marketplace. Se você já tem um arquivo VSIX, pode instalá-lo com Extensions: Install from VSIX."],
            ["Conectar sua chave de API", "Na barra lateral do Tomverse, selecione Conectar chave de API e digite a chave. Ela fica no armazenamento seguro do VS Code."],
            ["Pergunte com Ask e edite com Agent", "Anexe arquivos, uma seleção ou diagnósticos. Ask é somente leitura. Agent pede aprovação para cada alteração e comando."],
            ["Acompanhar custos e desfazer alterações", "Os créditos gastos em cada solicitação aparecem na barra lateral. Desfaça uma a uma as alterações feitas pela extensão."],
        ],
        supportTitle: "Compatibilidade",
        support: ["VS Code Desktop 1.146 ou posterior", "Windows x64 testado", "macOS arm64 e Linux x64 ainda em validação", "Sem suporte a remoto, WSL, contêineres ou web"],
        createKey: "Criar uma chave de API",
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
