/** Shared web and native welcome text and starter prompts. */
export const workspaceWelcomeCopy = {
  en: {
    greeting: "Welcome back. What can I help with?",
    starter: {
        title: "What you can do here",
        hint: "Choose a prompt to fill the message box. Nothing is sent until you press send.",
        scrollMore: "More suggestions",
        lockedSignIn: "Sign in to use this",
        lockedPlan: "Needs the {plan} plan",
        lockedSignInShort: "Sign in required",
        lockedPlanShort: "{plan} required",
        cards: {
            compareAnswers: {
                label: "Compare three answers side by side",
                outcome: "Ask one question and read three models answer it side by side",
                seed: "Explain in plain language what a vector database is for, in about 200 words.",
            },
            documentQuestions: {
                label: "Ask questions about a PDF",
                outcome: "Attach an 18 page PDF and get the decisions and deadlines it holds",
                seed: "I attached a document. Summarise what it asks me to decide, and list every deadline it names.",
            },
            sourcedAnswer: {
                label: "Get an answer with sources",
                outcome: "Get an answer with the source links it was built from",
                seed: "What changed in EU AI Act enforcement this year? Include the sources you used.",
            },
            debugStackTrace: {
                label: "Find the failing line in a stack trace",
                outcome: "Paste a stack trace and get the failing line plus a fix to try",
                seed: "Here is a stack trace from my build. Tell me which line failed and what to change.",
            },
            spreadsheetFromAnswer: {
                label: "Get an .xlsx file",
                outcome: "Turn an answer into an .xlsx file you can download",
                seed: "Build a monthly budget sheet with category, planned amount and actual amount, and save it as a spreadsheet file.",
            },
            readAScreenshot: {
                label: "Ask what a screenshot error means",
                outcome: "Attach a screenshot and ask what the error on it means",
                seed: "I attached a screenshot of an error dialog. Tell me what it means and what to do next.",
            },
            translateAndCompare: {
                label: "Compare two translations",
                outcome: "Translate a draft and read two models versions next to each other",
                seed: "Translate the text below into English and keep the tone formal:",
            },
            compareImageModels: {
                label: "Compare image models",
                outcome: "Send one sentence to several image models and compare what each returns",
                seed: "A quiet reading room at dawn, warm light through tall windows, photographic.",
            },
            makeAnImage: {
                label: "Make an image from a sentence",
                outcome: "Describe a picture in one sentence and get the image in this chat",
                seed: "Make an image: a quiet reading room at dawn, warm light through tall windows, photographic.",
            },
            summarizeText: {
                label: "Summarise a long text in three lines",
                outcome: "Paste a long text and get a three line summary with its key numbers",
                seed: "Summarise the text below in three lines, and list the numbers it mentions separately:",
            },
            draftReply: {
                label: "Draft a reply to an email",
                outcome: "Paste an email you received and get a polite reply to edit",
                seed: "Write a short, polite reply to the email below:",
            },
            explainCode: {
                label: "Explain code line by line",
                outcome: "Paste some code and get each line explained in plain words",
                seed: "Explain in plain words what the code below does, line by line:",
            },
            learnAConcept: {
                label: "Learn a hard idea simply",
                outcome: "Learn an unfamiliar idea in plain words with one everyday example",
                seed: "Explain how compound interest works using one everyday example.",
            },
            planAWeek: {
                label: "Plan your week",
                outcome: "List what you need to do and get a day by day plan",
                seed: "Here is what I need to do this week. Spread it over the days in a realistic plan:",
            },
            speakAQuestion: {
                label: "Speak a question, edit the text",
                outcome: "Speak a long question instead of typing it, and edit the text before it is sent",
                seed: "Turn what I say next into a short, clear set of instructions.",
            },
        },
    },
  },
  ko: {
    greeting: "다시 만나 반가워요. 무엇을 도와드릴까요?",
    starter: {
        title: "여기서 할 수 있는 일",
        hint: "하나를 고르면 입력창에 질문이 채워집니다. 보내기를 누르기 전에는 아무것도 전송되지 않습니다.",
        scrollMore: "추천 질문 더 보기",
        lockedSignIn: "로그인하면 사용할 수 있습니다",
        lockedPlan: "{plan} 플랜이 필요합니다",
        lockedSignInShort: "로그인 필요",
        lockedPlanShort: "{plan} 필요",
        cards: {
            compareAnswers: {
                label: "세 모델 답 나란히 비교",
                outcome: "질문 하나를 세 모델에게 보내고 답을 나란히 읽기",
                seed: "벡터 데이터베이스가 어떤 문제를 푸는지 쉬운 말로 200자 정도로 설명해 주세요.",
            },
            documentQuestions: {
                label: "PDF 붙여 질문하기",
                outcome: "18페이지 PDF를 붙여 결정할 일과 기한 받기",
                seed: "문서를 첨부했습니다. 제가 무엇을 결정해야 하는지 요약하고, 문서에 나오는 기한을 모두 뽑아 주세요.",
            },
            sourcedAnswer: {
                label: "출처 링크 붙은 답 받기",
                outcome: "출처 링크가 함께 붙은 답 받기",
                seed: "올해 EU AI 법 집행에서 달라진 점은 무엇인가요? 참고한 출처도 함께 알려 주세요.",
            },
            debugStackTrace: {
                label: "스택 트레이스로 오류 찾기",
                outcome: "스택 트레이스를 붙여 실패한 줄과 고칠 방법 받기",
                seed: "빌드에서 나온 스택 트레이스입니다. 어느 줄에서 실패했는지와 무엇을 바꿔야 하는지 알려 주세요.",
            },
            spreadsheetFromAnswer: {
                label: ".xlsx 파일로 받기",
                outcome: "답변을 내려받을 수 있는 .xlsx 파일로 만들기",
                seed: "항목, 계획 금액, 실제 금액이 들어간 월별 예산표를 만들어 스프레드시트 파일로 저장해 주세요.",
            },
            readAScreenshot: {
                label: "화면 캡처 속 오류 묻기",
                outcome: "화면 캡처를 붙여 그 오류가 무슨 뜻인지 묻기",
                seed: "오류 대화상자를 캡처해서 첨부했습니다. 무슨 뜻이고 다음에 무엇을 해야 하는지 알려 주세요.",
            },
            translateAndCompare: {
                label: "두 모델 번역 나란히 비교",
                outcome: "초안을 번역하고 두 모델의 결과를 나란히 읽기",
                seed: "아래 문장을 격식 있는 어조를 유지하면서 영어로 번역해 주세요:",
            },
            compareImageModels: {
                label: "이미지 모델 결과 비교",
                outcome: "문장 하나를 여러 이미지 모델에 보내고 결과를 비교하기",
                seed: "새벽의 조용한 열람실, 높은 창으로 들어오는 따뜻한 빛, 사진 느낌.",
            },
            makeAnImage: {
                label: "문장으로 이미지 만들기",
                outcome: "장면을 한 문장으로 쓰고 이 대화 안에서 이미지 받기",
                seed: "이미지를 만들어 주세요: 새벽의 조용한 열람실, 높은 창으로 들어오는 따뜻한 빛, 사진 느낌.",
            },
            summarizeText: {
                label: "긴 글 세 줄로 요약",
                outcome: "긴 글을 붙여 넣고 세 줄 요약과 핵심 숫자 받기",
                seed: "아래 글을 세 줄로 요약하고, 글에 나오는 숫자는 따로 정리해 주세요:",
            },
            draftReply: {
                label: "메일 답장 초안 쓰기",
                outcome: "받은 메일을 붙여 넣고 고쳐 쓸 수 있는 정중한 답장 초안 받기",
                seed: "아래 메일에 정중하게 답하는 짧은 답장 초안을 써 주세요:",
            },
            explainCode: {
                label: "코드 한 줄씩 설명 받기",
                outcome: "코드를 붙여 넣고 한 줄씩 무엇을 하는지 쉬운 말로 설명 받기",
                seed: "아래 코드가 무엇을 하는지 한 줄씩 쉬운 말로 설명해 주세요:",
            },
            learnAConcept: {
                label: "어려운 개념 쉽게 배우기",
                outcome: "낯선 개념을 일상 예시 하나와 함께 쉬운 말로 배우기",
                seed: "복리가 어떻게 작동하는지 일상적인 예시 하나로 쉽게 설명해 주세요.",
            },
            planAWeek: {
                label: "일주일 계획 세우기",
                outcome: "할 일을 적으면 요일별 계획으로 정리 받기",
                seed: "이번 주에 할 일을 적을게요. 요일별로 무리 없는 계획을 세워 주세요:",
            },
            speakAQuestion: {
                label: "말로 질문하고 글로 고치기",
                outcome: "긴 질문을 말로 입력하고 보내기 전에 글로 고치기",
                seed: "지금부터 말하는 내용을 짧고 분명한 지시 목록으로 정리해 주세요.",
            },
        },
    },
  },
  zh: {
    greeting: "欢迎回来，有什么可以帮你的？",
    starter: {
        title: "在这里可以做什么",
        hint: "选择一张卡片即可填入下方输入框。在你点击发送之前不会发出任何内容。",
        scrollMore: "查看更多建议",
        lockedSignIn: "登录后可使用",
        lockedPlan: "需要 {plan} 方案",
        lockedSignInShort: "需要登录",
        lockedPlanShort: "需要 {plan}",
        cards: {
            compareAnswers: {
                label: "并排比较三个回答",
                outcome: "提一个问题，并排阅读三个模型的回答",
                seed: "用通俗的语言解释向量数据库用来解决什么问题，大约 200 字。",
            },
            documentQuestions: {
                label: "上传 PDF 提问",
                outcome: "上传一份 18 页的 PDF，得到其中要做的决定和截止日期",
                seed: "我上传了一份文档。请概括它要我做出什么决定，并列出其中提到的所有截止日期。",
            },
            sourcedAnswer: {
                label: "获得附带来源的回答",
                outcome: "获得一份附带来源链接的回答",
                seed: "今年欧盟人工智能法案的执行有哪些变化？请附上你使用的来源。",
            },
            debugStackTrace: {
                label: "从堆栈跟踪找到出错行",
                outcome: "粘贴一段堆栈跟踪，得到出错的那一行和可尝试的修复",
                seed: "这是我构建时的堆栈跟踪。请告诉我哪一行出错，以及应该改什么。",
            },
            spreadsheetFromAnswer: {
                label: "生成 .xlsx 文件",
                outcome: "把回答变成可下载的 .xlsx 文件",
                seed: "帮我建立一份月度预算表，包含类别、计划金额和实际金额，并保存为电子表格文件。",
            },
            readAScreenshot: {
                label: "询问截图里的错误",
                outcome: "上传一张截图，询问上面的错误是什么意思",
                seed: "我上传了一张错误对话框的截图。请告诉我它是什么意思，以及接下来该怎么做。",
            },
            translateAndCompare: {
                label: "并排比较两份译文",
                outcome: "翻译一段草稿，并排比较两个模型的版本",
                seed: "把下面的文字翻译成英文，保持正式的语气：",
            },
            compareImageModels: {
                label: "比较图像模型",
                outcome: "把同一句话发给多个图像模型，比较各自的结果",
                seed: "清晨安静的阅览室，暖光从高窗照入，摄影风格。",
            },
            makeAnImage: {
                label: "用一句话生成图像",
                outcome: "用一句话描述画面，在这个对话里得到图像",
                seed: "请生成一张图像：清晨安静的阅览室，暖光从高窗照入，摄影风格。",
            },
            summarizeText: {
                label: "三行总结长文",
                outcome: "粘贴长文，得到三行摘要和其中的关键数字",
                seed: "请用三行总结下面的文字，并把其中提到的数字单独列出：",
            },
            draftReply: {
                label: "起草邮件回复",
                outcome: "粘贴收到的邮件，得到一份可修改的礼貌回复",
                seed: "请为下面的邮件写一封简短、礼貌的回复：",
            },
            explainCode: {
                label: "逐行解释代码",
                outcome: "粘贴代码，逐行得到通俗易懂的解释",
                seed: "请用通俗的语言逐行解释下面这段代码在做什么：",
            },
            learnAConcept: {
                label: "轻松理解难懂概念",
                outcome: "用一个日常例子和通俗的语言理解陌生概念",
                seed: "请用一个日常例子简单解释复利是如何运作的。",
            },
            planAWeek: {
                label: "制定一周计划",
                outcome: "写下要做的事，得到按天安排的计划",
                seed: "这是我这周要做的事，请按天安排一个可行的计划：",
            },
            speakAQuestion: {
                label: "用语音提问，再改文字",
                outcome: "用语音说出较长的问题，在发送前再修改文字",
                seed: "把我接下来说的话整理成一份简短清晰的操作说明。",
            },
        },
    },
  },
  "zh-Hant": {
    greeting: "歡迎回來，有什麼可以幫你的？",
    starter: {
        title: "在這裡可以做什麼",
        hint: "選擇一張卡片即可填入下方輸入框。在你按下傳送之前不會發出任何內容。",
        scrollMore: "查看更多建議",
        lockedSignIn: "登入後可使用",
        lockedPlan: "需要 {plan} 方案",
        lockedSignInShort: "需要登入",
        lockedPlanShort: "需要 {plan}",
        cards: {
            compareAnswers: {
                label: "並排比較三個回答",
                outcome: "提出一個問題，並排閱讀三個模型的回答",
                seed: "用淺顯的語言解釋向量資料庫用來解決什麼問題，大約 200 字。",
            },
            documentQuestions: {
                label: "上傳 PDF 提問",
                outcome: "上傳一份 18 頁的 PDF，得到其中要做的決定和截止日期",
                seed: "我上傳了一份文件。請摘要它要我做出什麼決定，並列出其中提到的所有截止日期。",
            },
            sourcedAnswer: {
                label: "取得附帶來源的回答",
                outcome: "取得一份附帶來源連結的回答",
                seed: "今年歐盟人工智慧法案的執行有哪些變化？請附上你使用的來源。",
            },
            debugStackTrace: {
                label: "從堆疊追蹤找出出錯的行",
                outcome: "貼上一段堆疊追蹤，取得出錯的那一行與可嘗試的修正",
                seed: "這是我建置時的堆疊追蹤。請告訴我哪一行出錯，以及應該改什麼。",
            },
            spreadsheetFromAnswer: {
                label: "產生 .xlsx 檔案",
                outcome: "把回答變成可下載的 .xlsx 檔案",
                seed: "幫我建立一份月度預算表，包含類別、計畫金額和實際金額，並儲存為試算表檔案。",
            },
            readAScreenshot: {
                label: "詢問截圖中的錯誤",
                outcome: "上傳一張截圖，詢問上面的錯誤是什麼意思",
                seed: "我上傳了一張錯誤對話框的截圖。請告訴我它是什麼意思，以及接下來該怎麼做。",
            },
            translateAndCompare: {
                label: "並排比較兩份譯文",
                outcome: "翻譯一段草稿，並排比較兩個模型的版本",
                seed: "把下面的文字翻譯成英文，保持正式的語氣：",
            },
            compareImageModels: {
                label: "比較圖像模型",
                outcome: "把同一句話傳給多個圖像模型，比較各自的結果",
                seed: "清晨安靜的閱覽室，暖光從高窗照入，攝影風格。",
            },
            makeAnImage: {
                label: "用一句話生成圖像",
                outcome: "用一句話描述畫面，在這個對話裡得到圖像",
                seed: "請生成一張圖像：清晨安靜的閱覽室，暖光從高窗照入，攝影風格。",
            },
            summarizeText: {
                label: "三行摘要長文",
                outcome: "貼上長文，得到三行摘要和其中的關鍵數字",
                seed: "請用三行摘要下面的文字，並把其中提到的數字另外列出：",
            },
            draftReply: {
                label: "草擬郵件回覆",
                outcome: "貼上收到的郵件，得到一份可修改的禮貌回覆",
                seed: "請為下面的郵件寫一封簡短、禮貌的回覆：",
            },
            explainCode: {
                label: "逐行解釋程式碼",
                outcome: "貼上程式碼，逐行得到淺白的解釋",
                seed: "請用淺白的語言逐行解釋下面這段程式碼在做什麼：",
            },
            learnAConcept: {
                label: "輕鬆理解難懂概念",
                outcome: "用一個日常例子和淺白的語言理解陌生概念",
                seed: "請用一個日常例子簡單解釋複利是如何運作的。",
            },
            planAWeek: {
                label: "規劃一週",
                outcome: "寫下要做的事，得到按天安排的計畫",
                seed: "這是我這週要做的事，請按天安排一個可行的計畫：",
            },
            speakAQuestion: {
                label: "用語音提問，再改文字",
                outcome: "用語音說出較長的問題，在傳送前再修改文字",
                seed: "把我接下來說的話整理成一份簡短清楚的操作說明。",
            },
        },
    },
  },
  de: {
    greeting: "Schön, dich wiederzusehen. Womit kann ich helfen?",
    starter: {
        title: "Was hier möglich ist",
        hint: "Wählen Sie eine Karte, um das Feld unten zu füllen. Gesendet wird erst, wenn Sie auf Senden klicken.",
        scrollMore: "Weitere Vorschläge",
        lockedSignIn: "Zum Verwenden anmelden",
        lockedPlan: "Erfordert den Tarif {plan}",
        lockedSignInShort: "Anmeldung nötig",
        lockedPlanShort: "{plan} nötig",
        cards: {
            compareAnswers: {
                label: "Drei Antworten nebeneinander lesen",
                outcome: "Eine Frage stellen und die Antworten von drei Modellen nebeneinander lesen",
                seed: "Erklären Sie in einfachen Worten, wofür eine Vektordatenbank gedacht ist, in etwa 200 Wörtern.",
            },
            documentQuestions: {
                label: "Fragen zu einem PDF stellen",
                outcome: "Ein PDF mit 18 Seiten anhängen und die Entscheidungen und Fristen darin erhalten",
                seed: "Ich habe ein Dokument angehängt. Fassen Sie zusammen, worüber ich entscheiden soll, und nennen Sie alle Fristen darin.",
            },
            sourcedAnswer: {
                label: "Antwort mit Quellen erhalten",
                outcome: "Eine Antwort mit den Quellenlinks erhalten, auf denen sie beruht",
                seed: "Was hat sich dieses Jahr bei der Durchsetzung des EU-KI-Gesetzes geändert? Nennen Sie die verwendeten Quellen.",
            },
            debugStackTrace: {
                label: "Fehlerzeile im Stacktrace finden",
                outcome: "Einen Stacktrace einfügen und die fehlerhafte Zeile samt Lösungsvorschlag erhalten",
                seed: "Hier ist ein Stacktrace aus meinem Build. Sagen Sie mir, welche Zeile fehlgeschlagen ist und was ich ändern soll.",
            },
            spreadsheetFromAnswer: {
                label: ".xlsx-Datei erhalten",
                outcome: "Eine Antwort in eine herunterladbare .xlsx-Datei verwandeln",
                seed: "Erstellen Sie eine Monatsbudget-Tabelle mit Kategorie, geplantem Betrag und tatsächlichem Betrag und speichern Sie sie als Tabellendatei.",
            },
            readAScreenshot: {
                label: "Fehler auf einem Screenshot erklären",
                outcome: "Einen Screenshot anhängen und fragen, was die Fehlermeldung bedeutet",
                seed: "Ich habe einen Screenshot eines Fehlerdialogs angehängt. Sagen Sie mir, was er bedeutet und was ich als Nächstes tun soll.",
            },
            translateAndCompare: {
                label: "Zwei Übersetzungen vergleichen",
                outcome: "Einen Entwurf übersetzen und die Fassungen zweier Modelle vergleichen",
                seed: "Übersetzen Sie den folgenden Text ins Englische und behalten Sie einen förmlichen Ton bei:",
            },
            compareImageModels: {
                label: "Bildmodelle vergleichen",
                outcome: "Einen Satz an mehrere Bildmodelle schicken und die Ergebnisse vergleichen",
                seed: "Ein ruhiger Lesesaal im Morgengrauen, warmes Licht durch hohe Fenster, fotografisch.",
            },
            makeAnImage: {
                label: "Ein Bild aus einem Satz machen",
                outcome: "Ein Bild in einem Satz beschreiben und es in diesem Chat erhalten",
                seed: "Erstelle ein Bild: ein ruhiger Lesesaal im Morgengrauen, warmes Licht durch hohe Fenster, fotografisch.",
            },
            summarizeText: {
                label: "Langen Text in drei Zeilen zusammenfassen",
                outcome: "Einen langen Text einfügen und eine dreizeilige Zusammenfassung mit den wichtigsten Zahlen erhalten",
                seed: "Fasse den folgenden Text in drei Zeilen zusammen und liste die genannten Zahlen separat auf:",
            },
            draftReply: {
                label: "Antwort auf eine E-Mail entwerfen",
                outcome: "Eine erhaltene E-Mail einfügen und einen höflichen Antwortentwurf zum Bearbeiten erhalten",
                seed: "Schreibe eine kurze, höfliche Antwort auf die folgende E-Mail:",
            },
            explainCode: {
                label: "Code Zeile für Zeile erklären",
                outcome: "Code einfügen und jede Zeile in einfachen Worten erklärt bekommen",
                seed: "Erkläre in einfachen Worten Zeile für Zeile, was der folgende Code macht:",
            },
            learnAConcept: {
                label: "Schwierige Begriffe einfach lernen",
                outcome: "Einen unbekannten Begriff in einfachen Worten mit einem Alltagsbeispiel lernen",
                seed: "Erkläre mit einem Alltagsbeispiel, wie Zinseszins funktioniert.",
            },
            planAWeek: {
                label: "Die Woche planen",
                outcome: "Aufgaben aufschreiben und einen Plan nach Wochentagen erhalten",
                seed: "Das muss ich diese Woche erledigen. Verteile es in einem realistischen Plan auf die Tage:",
            },
            speakAQuestion: {
                label: "Frage diktieren, Text bearbeiten",
                outcome: "Eine lange Frage diktieren statt tippen und den Text vor dem Senden bearbeiten",
                seed: "Verwandeln Sie das, was ich gleich sage, in eine kurze und klare Anleitung.",
            },
        },
    },
  },
  fr: {
    greeting: "Content de vous revoir. Comment puis-je vous aider ?",
    starter: {
        title: "Ce que vous pouvez faire ici",
        hint: "Choisissez une carte pour remplir le champ ci-dessous. Rien n'est envoyé tant que vous n'appuyez pas sur envoyer.",
        scrollMore: "Voir plus de suggestions",
        lockedSignIn: "Connectez-vous pour l'utiliser",
        lockedPlan: "Nécessite le forfait {plan}",
        lockedSignInShort: "Connexion requise",
        lockedPlanShort: "{plan} requis",
        cards: {
            compareAnswers: {
                label: "Comparez trois réponses côte à côte",
                outcome: "Posez une question et lisez la réponse de trois modèles côte à côte",
                seed: "Expliquez simplement à quoi sert une base de données vectorielle, en 200 mots environ.",
            },
            documentQuestions: {
                label: "Posez vos questions sur un PDF",
                outcome: "Joignez un PDF de 18 pages et obtenez les décisions et échéances qu'il contient",
                seed: "J'ai joint un document. Résumez ce qu'il me demande de décider et listez toutes les échéances qu'il cite.",
            },
            sourcedAnswer: {
                label: "Obtenez une réponse sourcée",
                outcome: "Obtenez une réponse accompagnée des liens sources utilisés",
                seed: "Qu'est-ce qui a changé cette année dans l'application du règlement européen sur l'IA ? Indiquez les sources utilisées.",
            },
            debugStackTrace: {
                label: "Trouvez la ligne fautive d'une trace",
                outcome: "Collez une trace d'erreur et obtenez la ligne fautive et un correctif à tester",
                seed: "Voici une trace d'erreur de mon build. Dites-moi quelle ligne a échoué et quoi changer.",
            },
            spreadsheetFromAnswer: {
                label: "Obtenez un fichier .xlsx",
                outcome: "Transformez une réponse en fichier .xlsx téléchargeable",
                seed: "Créez un budget mensuel avec catégorie, montant prévu et montant réel, puis enregistrez-le comme fichier tableur.",
            },
            readAScreenshot: {
                label: "Comprenez l'erreur d'une capture",
                outcome: "Joignez une capture d'écran et demandez ce que signifie l'erreur",
                seed: "J'ai joint la capture d'une boîte de dialogue d'erreur. Dites-moi ce qu'elle signifie et quoi faire ensuite.",
            },
            translateAndCompare: {
                label: "Comparez deux traductions",
                outcome: "Traduisez un brouillon et comparez les versions de deux modèles",
                seed: "Traduisez le texte ci-dessous en anglais en gardant un ton formel :",
            },
            compareImageModels: {
                label: "Comparez des modèles d'image",
                outcome: "Envoyez une phrase à plusieurs modèles d'image et comparez leurs rendus",
                seed: "Une salle de lecture calme à l'aube, lumière chaude par de hautes fenêtres, style photographique.",
            },
            makeAnImage: {
                label: "Créez une image à partir d'une phrase",
                outcome: "Décrivez une image en une phrase et recevez-la dans ce chat",
                seed: "Crée une image : une salle de lecture calme à l'aube, lumière chaude par de hautes fenêtres, style photographique.",
            },
            summarizeText: {
                label: "Résumez un long texte en trois lignes",
                outcome: "Collez un long texte et obtenez un résumé en trois lignes avec ses chiffres clés",
                seed: "Résume le texte ci-dessous en trois lignes et liste à part les chiffres qu'il mentionne :",
            },
            draftReply: {
                label: "Rédigez une réponse à un e-mail",
                outcome: "Collez un e-mail reçu et obtenez une réponse polie à retoucher",
                seed: "Écris une réponse courte et polie à l'e-mail ci-dessous :",
            },
            explainCode: {
                label: "Faites expliquer du code ligne par ligne",
                outcome: "Collez du code et obtenez une explication simple de chaque ligne",
                seed: "Explique simplement, ligne par ligne, ce que fait le code ci-dessous :",
            },
            learnAConcept: {
                label: "Comprenez simplement une notion difficile",
                outcome: "Découvrez une notion inconnue en mots simples avec un exemple du quotidien",
                seed: "Explique le fonctionnement des intérêts composés avec un exemple du quotidien.",
            },
            planAWeek: {
                label: "Planifiez votre semaine",
                outcome: "Listez vos tâches et obtenez un plan jour par jour",
                seed: "Voici ce que je dois faire cette semaine. Répartis-le sur les jours dans un plan réaliste :",
            },
            speakAQuestion: {
                label: "Dictez une question, corrigez le texte",
                outcome: "Dictez une longue question au lieu de la taper, et corrigez le texte avant l'envoi",
                seed: "Transformez ce que je vais dire en une liste d'instructions courte et claire.",
            },
        },
    },
  },
  es: {
    greeting: "Qué bueno verte de nuevo. ¿En qué puedo ayudarte?",
    starter: {
        title: "Lo que puedes hacer aquí",
        hint: "Elige una tarjeta para rellenar el campo de abajo. No se envía nada hasta que pulses enviar.",
        scrollMore: "Ver más sugerencias",
        lockedSignIn: "Inicia sesión para usarlo",
        lockedPlan: "Requiere el plan {plan}",
        lockedSignInShort: "Requiere iniciar sesión",
        lockedPlanShort: "Requiere {plan}",
        cards: {
            compareAnswers: {
                label: "Compara tres respuestas en paralelo",
                outcome: "Haz una pregunta y lee cómo la responden tres modelos en paralelo",
                seed: "Explica en lenguaje sencillo para qué sirve una base de datos vectorial, en unas 200 palabras.",
            },
            documentQuestions: {
                label: "Pregunta sobre un PDF",
                outcome: "Adjunta un PDF de 18 páginas y obtén las decisiones y plazos que contiene",
                seed: "He adjuntado un documento. Resume qué me pide decidir y enumera todos los plazos que menciona.",
            },
            sourcedAnswer: {
                label: "Recibe una respuesta con fuentes",
                outcome: "Recibe una respuesta con los enlaces de las fuentes que usó",
                seed: "¿Qué ha cambiado este año en la aplicación del reglamento europeo de IA? Incluye las fuentes que uses.",
            },
            debugStackTrace: {
                label: "Encuentra la línea que falla en una traza",
                outcome: "Pega una traza de error y obtén la línea que falló y un arreglo que probar",
                seed: "Esta es una traza de error de mi compilación. Dime qué línea falló y qué debo cambiar.",
            },
            spreadsheetFromAnswer: {
                label: "Recibe un archivo .xlsx",
                outcome: "Convierte una respuesta en un archivo .xlsx que puedes descargar",
                seed: "Crea una hoja de presupuesto mensual con categoría, importe previsto e importe real, y guárdala como archivo de hoja de cálculo.",
            },
            readAScreenshot: {
                label: "Pregunta qué significa un error en una captura",
                outcome: "Adjunta una captura de pantalla y pregunta qué significa el error",
                seed: "He adjuntado la captura de un cuadro de diálogo de error. Dime qué significa y qué hacer a continuación.",
            },
            translateAndCompare: {
                label: "Compara dos traducciones",
                outcome: "Traduce un borrador y compara las versiones de dos modelos",
                seed: "Traduce el texto de abajo al inglés y mantén un tono formal:",
            },
            compareImageModels: {
                label: "Compara modelos de imagen",
                outcome: "Envía una frase a varios modelos de imagen y compara lo que devuelve cada uno",
                seed: "Una sala de lectura tranquila al amanecer, luz cálida por ventanales altos, estilo fotográfico.",
            },
            makeAnImage: {
                label: "Crea una imagen con una frase",
                outcome: "Describe una imagen en una frase y recíbela en este chat",
                seed: "Crea una imagen: una sala de lectura tranquila al amanecer, luz cálida por ventanales altos, estilo fotográfico.",
            },
            summarizeText: {
                label: "Resume un texto largo en tres líneas",
                outcome: "Pega un texto largo y obtén un resumen de tres líneas con sus cifras clave",
                seed: "Resume el texto de abajo en tres líneas y enumera aparte las cifras que menciona:",
            },
            draftReply: {
                label: "Redacta una respuesta a un correo",
                outcome: "Pega un correo recibido y obtén una respuesta cortés para editar",
                seed: "Escribe una respuesta breve y cortés al correo de abajo:",
            },
            explainCode: {
                label: "Explica código línea por línea",
                outcome: "Pega código y obtén cada línea explicada con palabras sencillas",
                seed: "Explica con palabras sencillas, línea por línea, qué hace el código de abajo:",
            },
            learnAConcept: {
                label: "Aprende una idea difícil fácilmente",
                outcome: "Aprende una idea desconocida con palabras sencillas y un ejemplo cotidiano",
                seed: "Explica cómo funciona el interés compuesto con un ejemplo cotidiano.",
            },
            planAWeek: {
                label: "Planifica tu semana",
                outcome: "Anota tus tareas y obtén un plan día por día",
                seed: "Esto es lo que tengo que hacer esta semana. Repártelo en los días con un plan realista:",
            },
            speakAQuestion: {
                label: "Dicta una pregunta y edita el texto",
                outcome: "Dicta una pregunta larga en vez de escribirla y edita el texto antes de enviarlo",
                seed: "Convierte lo que voy a decir en una lista de instrucciones corta y clara.",
            },
        },
    },
  },
  pt: {
    greeting: "Que bom te ver de novo. Em que posso ajudar?",
    starter: {
        title: "O que você pode fazer aqui",
        hint: "Escolha um cartão para preencher o campo abaixo. Nada é enviado até você tocar em enviar.",
        scrollMore: "Ver mais sugestões",
        lockedSignIn: "Entre na conta para usar",
        lockedPlan: "Requer o plano {plan}",
        lockedSignInShort: "Requer login",
        lockedPlanShort: "Requer {plan}",
        cards: {
            compareAnswers: {
                label: "Compare três respostas lado a lado",
                outcome: "Faça uma pergunta e leia três modelos respondendo lado a lado",
                seed: "Explique em linguagem simples para que serve um banco de dados vetorial, em cerca de 200 palavras.",
            },
            documentQuestions: {
                label: "Pergunte sobre um PDF",
                outcome: "Anexe um PDF de 18 páginas e receba as decisões e prazos que ele contém",
                seed: "Anexei um documento. Resuma o que ele pede que eu decida e liste todos os prazos citados.",
            },
            sourcedAnswer: {
                label: "Receba uma resposta com fontes",
                outcome: "Receba uma resposta com os links das fontes usadas",
                seed: "O que mudou neste ano na aplicação do regulamento europeu de IA? Inclua as fontes usadas.",
            },
            debugStackTrace: {
                label: "Ache a linha que falhou em um stack trace",
                outcome: "Cole um stack trace e receba a linha que falhou e uma correção para testar",
                seed: "Este é um stack trace da minha compilação. Diga qual linha falhou e o que devo mudar.",
            },
            spreadsheetFromAnswer: {
                label: "Receba um arquivo .xlsx",
                outcome: "Transforme uma resposta em um arquivo .xlsx para baixar",
                seed: "Crie uma planilha de orçamento mensal com categoria, valor previsto e valor real, e salve como arquivo de planilha.",
            },
            readAScreenshot: {
                label: "Pergunte o que significa o erro de uma captura",
                outcome: "Anexe uma captura de tela e pergunte o que o erro significa",
                seed: "Anexei a captura de uma caixa de diálogo de erro. Diga o que significa e o que fazer em seguida.",
            },
            translateAndCompare: {
                label: "Compare duas traduções",
                outcome: "Traduza um rascunho e compare as versões de dois modelos",
                seed: "Traduza o texto abaixo para o inglês mantendo um tom formal:",
            },
            compareImageModels: {
                label: "Compare modelos de imagem",
                outcome: "Envie uma frase para vários modelos de imagem e compare o que cada um devolve",
                seed: "Uma sala de leitura tranquila ao amanhecer, luz quente por janelas altas, estilo fotográfico.",
            },
            makeAnImage: {
                label: "Crie uma imagem com uma frase",
                outcome: "Descreva uma imagem em uma frase e receba-a neste chat",
                seed: "Crie uma imagem: uma sala de leitura tranquila ao amanhecer, luz quente por janelas altas, estilo fotográfico.",
            },
            summarizeText: {
                label: "Resuma um texto longo em três linhas",
                outcome: "Cole um texto longo e receba um resumo de três linhas com os números principais",
                seed: "Resuma o texto abaixo em três linhas e liste à parte os números que ele menciona:",
            },
            draftReply: {
                label: "Escreva uma resposta a um e-mail",
                outcome: "Cole um e-mail recebido e receba uma resposta educada para editar",
                seed: "Escreva uma resposta curta e educada ao e-mail abaixo:",
            },
            explainCode: {
                label: "Explique código linha por linha",
                outcome: "Cole um código e receba cada linha explicada em palavras simples",
                seed: "Explique em palavras simples, linha por linha, o que o código abaixo faz:",
            },
            learnAConcept: {
                label: "Aprenda uma ideia difícil de forma simples",
                outcome: "Aprenda uma ideia desconhecida em palavras simples com um exemplo do dia a dia",
                seed: "Explique como funcionam os juros compostos com um exemplo do dia a dia.",
            },
            planAWeek: {
                label: "Planeje sua semana",
                outcome: "Liste suas tarefas e receba um plano dia a dia",
                seed: "Isto é o que preciso fazer esta semana. Distribua pelos dias em um plano realista:",
            },
            speakAQuestion: {
                label: "Dite uma pergunta e edite o texto",
                outcome: "Dite uma pergunta longa em vez de digitar e edite o texto antes do envio",
                seed: "Transforme o que eu disser a seguir em uma lista de instruções curta e clara.",
            },
        },
    },
  }
};
