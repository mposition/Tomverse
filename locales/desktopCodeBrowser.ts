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
  },
  zh: {
    pick: "选择元素", pickCancel: "取消选择", pickHint: "点击页面中的元素即可添加评论。",
    pinsHeading: "元素评论", commentLabel: "对所选元素的评论", commentPlaceholder: "这里需要改什么？",
    removePin: "删除此评论", addToMessage: "添加到消息", pinsFull: "一条消息最多附带 8 条评论。",
    thumbnailAlt: "所选元素", agentUsing: "智能体正在使用此标签页。", agentStopped: "你已从智能体手中接管此标签页。",
    stopAgent: "接管", resumeAgent: "让智能体继续",
  },
  "zh-Hant": {
    pick: "選取元素", pickCancel: "取消選取", pickHint: "點擊頁面中的元素即可新增評論。",
    pinsHeading: "元素評論", commentLabel: "對所選元素的評論", commentPlaceholder: "這裡需要改什麼？",
    removePin: "刪除此評論", addToMessage: "加入訊息", pinsFull: "一則訊息最多附帶 8 則評論。",
    thumbnailAlt: "所選元素", agentUsing: "代理程式正在使用此分頁。", agentStopped: "你已從代理程式手中接管此分頁。",
    stopAgent: "接管", resumeAgent: "讓代理程式繼續",
  },
  fr: {
    pick: "Sélectionner un élément", pickCancel: "Annuler la sélection", pickHint: "Cliquez sur un élément de la page pour le commenter.",
    pinsHeading: "Commentaires sur les éléments", commentLabel: "Commentaire sur l’élément sélectionné", commentPlaceholder: "Que faut-il changer ici ?",
    removePin: "Supprimer ce commentaire", addToMessage: "Ajouter au message", pinsFull: "Un message porte au plus huit commentaires.",
    thumbnailAlt: "L’élément sélectionné", agentUsing: "L’agent utilise cet onglet.", agentStopped: "Vous avez repris cet onglet à l’agent.",
    stopAgent: "Reprendre la main", resumeAgent: "Laisser l’agent continuer",
  },
  de: {
    pick: "Element auswählen", pickCancel: "Auswahl abbrechen", pickHint: "Klicken Sie auf ein Element der Seite, um es zu kommentieren.",
    pinsHeading: "Elementkommentare", commentLabel: "Kommentar zum ausgewählten Element", commentPlaceholder: "Was soll sich hier ändern?",
    removePin: "Diesen Kommentar entfernen", addToMessage: "Zur Nachricht hinzufügen", pinsFull: "Eine Nachricht trägt höchstens acht Kommentare.",
    thumbnailAlt: "Das ausgewählte Element", agentUsing: "Der Agent verwendet diesen Tab.", agentStopped: "Sie haben diesen Tab dem Agenten abgenommen.",
    stopAgent: "Übernehmen", resumeAgent: "Agent fortfahren lassen",
  },
  es: {
    pick: "Seleccionar elemento", pickCancel: "Cancelar selección", pickHint: "Haz clic en un elemento de la página para comentarlo.",
    pinsHeading: "Comentarios de elementos", commentLabel: "Comentario sobre el elemento seleccionado", commentPlaceholder: "¿Qué hay que cambiar aquí?",
    removePin: "Quitar este comentario", addToMessage: "Añadir al mensaje", pinsFull: "Un mensaje lleva como máximo ocho comentarios.",
    thumbnailAlt: "El elemento seleccionado", agentUsing: "El agente está usando esta pestaña.", agentStopped: "Has quitado esta pestaña al agente.",
    stopAgent: "Tomar el control", resumeAgent: "Dejar que el agente continúe",
  },
  pt: {
    pick: "Selecionar elemento", pickCancel: "Cancelar seleção", pickHint: "Clique num elemento da página para o comentar.",
    pinsHeading: "Comentários de elementos", commentLabel: "Comentário sobre o elemento selecionado", commentPlaceholder: "O que deve mudar aqui?",
    removePin: "Remover este comentário", addToMessage: "Adicionar à mensagem", pinsFull: "Uma mensagem leva no máximo oito comentários.",
    thumbnailAlt: "O elemento selecionado", agentUsing: "O agente está a usar este separador.", agentStopped: "Retirou este separador ao agente.",
    stopAgent: "Assumir o controlo", resumeAgent: "Deixar o agente continuar",
  },
} satisfies Record<Language, Copy>;
