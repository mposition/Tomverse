import type { Language } from "../lib/language";

/** The browser panel's element comments and the agent's control of its tab. */
const en = {
  pick: "Select element",
  pickCancel: "Cancel selecting",
  pickHint: "Click an element in the page to comment on it.",
  pinsHeading: "Element comments",
  commentLabel: "Comment on the selected element",
  commentPlaceholder: "What should change here?",
  removePin: "Remove this comment",
  addToMessage: "Add to message",
  pinsFull: "Eight comments is the most one message carries.",
  thumbnailAlt: "The selected element",
  agentUsing: "The agent is using this tab.",
  agentStopped: "You took this tab from the agent.",
  stopAgent: "Take over",
  resumeAgent: "Let the agent continue",
  agentSetting: "Let Code use the browser panel",
  agentSettingDetail: "The agent can open a local page in the browser panel, read it, take pictures, read console errors, and click or type after you approve each action. Off by default. The panel itself works without it.",
  agentOn: "On",
  agentOff: "Off",
};
type Copy = typeof en;

export const desktopCodeBrowserCopy = {
  en,
  ko: {
    pick: "요소 선택", pickCancel: "선택 취소", pickHint: "페이지의 요소를 클릭하면 코멘트를 남길 수 있습니다.",
    pinsHeading: "요소 코멘트", commentLabel: "선택한 요소에 대한 코멘트", commentPlaceholder: "여기에서 무엇을 바꿔야 하나요?",
    removePin: "이 코멘트 삭제", addToMessage: "메시지에 추가", pinsFull: "한 메시지에는 코멘트를 8개까지 담을 수 있습니다.",
    thumbnailAlt: "선택한 요소", agentUsing: "에이전트가 이 탭을 사용 중입니다.", agentStopped: "이 탭을 에이전트에게서 가져왔습니다.",
    stopAgent: "직접 제어", resumeAgent: "에이전트가 계속하게 하기",
    agentSetting: "Code가 브라우저 패널을 사용하게 하기", agentSettingDetail: "에이전트가 브라우저 패널에서 로컬 페이지를 열고, 읽고, 화면을 찍고, 콘솔 오류를 읽을 수 있으며, 클릭과 입력은 매번 승인한 뒤에만 합니다. 기본값은 꺼짐입니다. 패널 자체는 이 설정과 상관없이 쓸 수 있습니다.", agentOn: "켜짐", agentOff: "꺼짐",
  },
  zh: {
    pick: "选择元素", pickCancel: "取消选择", pickHint: "点击页面中的元素即可添加评论。",
    pinsHeading: "元素评论", commentLabel: "对所选元素的评论", commentPlaceholder: "这里需要改什么？",
    removePin: "删除此评论", addToMessage: "添加到消息", pinsFull: "一条消息最多附带 8 条评论。",
    thumbnailAlt: "所选元素", agentUsing: "智能体正在使用此标签页。", agentStopped: "你已从智能体手中接管此标签页。",
    stopAgent: "接管", resumeAgent: "让智能体继续",
    agentSetting: "允许 Code 使用浏览器面板", agentSettingDetail: "智能体可在浏览器面板中打开本地页面、读取内容、截图、读取控制台错误，点击和输入需逐次经您批准。默认关闭。面板本身不受此设置影响。", agentOn: "开", agentOff: "关",
  },
  "zh-Hant": {
    pick: "選取元素", pickCancel: "取消選取", pickHint: "點擊頁面中的元素即可新增評論。",
    pinsHeading: "元素評論", commentLabel: "對所選元素的評論", commentPlaceholder: "這裡需要改什麼？",
    removePin: "刪除此評論", addToMessage: "加入訊息", pinsFull: "一則訊息最多附帶 8 則評論。",
    thumbnailAlt: "所選元素", agentUsing: "代理程式正在使用此分頁。", agentStopped: "你已從代理程式手中接管此分頁。",
    stopAgent: "接管", resumeAgent: "讓代理程式繼續",
    agentSetting: "允許 Code 使用瀏覽器面板", agentSettingDetail: "代理程式可在瀏覽器面板中開啟本機頁面、讀取內容、截圖、讀取主控台錯誤，點擊與輸入需逐次經您核准。預設關閉。面板本身不受此設定影響。", agentOn: "開", agentOff: "關",
  },
  fr: {
    pick: "Sélectionner un élément", pickCancel: "Annuler la sélection", pickHint: "Cliquez sur un élément de la page pour le commenter.",
    pinsHeading: "Commentaires sur les éléments", commentLabel: "Commentaire sur l’élément sélectionné", commentPlaceholder: "Que faut-il changer ici ?",
    removePin: "Supprimer ce commentaire", addToMessage: "Ajouter au message", pinsFull: "Un message porte au plus huit commentaires.",
    thumbnailAlt: "L’élément sélectionné", agentUsing: "L’agent utilise cet onglet.", agentStopped: "Vous avez repris cet onglet à l’agent.",
    stopAgent: "Reprendre la main", resumeAgent: "Laisser l’agent continuer",
    agentSetting: "Laisser Code utiliser le panneau du navigateur", agentSettingDetail: "L'agent peut ouvrir une page locale dans le panneau, la lire, faire des captures, lire les erreurs de la console, puis cliquer ou saisir après votre approbation de chaque action. Désactivé par défaut. Le panneau fonctionne sans ce réglage.", agentOn: "Activé", agentOff: "Désactivé",
  },
  de: {
    pick: "Element auswählen", pickCancel: "Auswahl abbrechen", pickHint: "Klicken Sie auf ein Element der Seite, um es zu kommentieren.",
    pinsHeading: "Elementkommentare", commentLabel: "Kommentar zum ausgewählten Element", commentPlaceholder: "Was soll sich hier ändern?",
    removePin: "Diesen Kommentar entfernen", addToMessage: "Zur Nachricht hinzufügen", pinsFull: "Eine Nachricht trägt höchstens acht Kommentare.",
    thumbnailAlt: "Das ausgewählte Element", agentUsing: "Der Agent verwendet diesen Tab.", agentStopped: "Sie haben diesen Tab dem Agenten abgenommen.",
    stopAgent: "Übernehmen", resumeAgent: "Agent fortfahren lassen",
    agentSetting: "Code das Browser-Panel nutzen lassen", agentSettingDetail: "Der Agent kann im Browser-Panel eine lokale Seite öffnen, lesen, Bilder aufnehmen, Konsolenfehler lesen und nach Ihrer Genehmigung jeder Aktion klicken oder tippen. Standardmäßig aus. Das Panel selbst funktioniert auch ohne diese Einstellung.", agentOn: "An", agentOff: "Aus",
  },
  es: {
    pick: "Seleccionar elemento", pickCancel: "Cancelar selección", pickHint: "Haz clic en un elemento de la página para comentarlo.",
    pinsHeading: "Comentarios de elementos", commentLabel: "Comentario sobre el elemento seleccionado", commentPlaceholder: "¿Qué hay que cambiar aquí?",
    removePin: "Quitar este comentario", addToMessage: "Añadir al mensaje", pinsFull: "Un mensaje lleva como máximo ocho comentarios.",
    thumbnailAlt: "El elemento seleccionado", agentUsing: "El agente está usando esta pestaña.", agentStopped: "Has quitado esta pestaña al agente.",
    stopAgent: "Tomar el control", resumeAgent: "Dejar que el agente continúe",
    agentSetting: "Permitir que Code use el panel del navegador", agentSettingDetail: "El agente puede abrir una página local en el panel, leerla, hacer capturas, leer los errores de la consola y hacer clic o escribir tras tu aprobación de cada acción. Desactivado por defecto. El panel funciona sin este ajuste.", agentOn: "Activado", agentOff: "Desactivado",
  },
  pt: {
    pick: "Selecionar elemento", pickCancel: "Cancelar seleção", pickHint: "Clique num elemento da página para o comentar.",
    pinsHeading: "Comentários de elementos", commentLabel: "Comentário sobre o elemento selecionado", commentPlaceholder: "O que deve mudar aqui?",
    removePin: "Remover este comentário", addToMessage: "Adicionar à mensagem", pinsFull: "Uma mensagem leva no máximo oito comentários.",
    thumbnailAlt: "O elemento selecionado", agentUsing: "O agente está a usar este separador.", agentStopped: "Retirou este separador ao agente.",
    stopAgent: "Assumir o controlo", resumeAgent: "Deixar o agente continuar",
    agentSetting: "Permitir que o Code use o painel do navegador", agentSettingDetail: "O agente pode abrir uma página local no painel, lê-la, tirar capturas, ler erros da consola e clicar ou escrever depois de aprovar cada ação. Desativado por predefinição. O painel funciona sem esta definição.", agentOn: "Ativado", agentOff: "Desativado",
  },
} satisfies Record<Language, Copy>;
