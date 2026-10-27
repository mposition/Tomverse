import type { MobileLanguage } from "./mobile";
const en = {
  title: "Use your current location?",
  description: "Allow approximate location for local answers such as nearby places and weather. While Current location is on, each message shares a fresh approximate location with AI providers. There is no background tracking.",
  control: "Allowing turns on Current location after sign-in. You can turn it off anytime in message tools.",
  allow: "Allow location", later: "Not now",
};
export const mobileLocationConsentCopy: Record<MobileLanguage, typeof en> = {
  en,
  ko: { title: "현재 위치를 사용할까요?", description: "주변 장소나 날씨처럼 지역에 맞는 답변에 대략적인 위치를 사용합니다. ‘현재 위치’가 켜져 있으면 메시지마다 새로 확인한 대략적인 위치를 AI 제공자에게 전달합니다. 백그라운드에서는 추적하지 않습니다.", control: "허용하면 로그인 후 ‘현재 위치’가 켜집니다. 메시지 도구에서 언제든 끌 수 있습니다.", allow: "위치 사용 허용", later: "나중에" },
  zh: { title: "使用当前位置？", description: "使用大致位置回答附近地点、天气等本地问题。开启“当前位置”时，每条消息会向 AI 提供商分享新获取的大致位置。不会在后台跟踪。", control: "允许后，登录时将开启“当前位置”。你可以随时在消息工具中关闭。", allow: "允许使用位置", later: "暂不" },
  fr: { title: "Utiliser votre position ?", description: "Autorisez une position approximative pour les lieux proches et la météo. Lorsque la position est activée, chaque message partage une position approximative actualisée avec les fournisseurs IA. Aucun suivi en arrière-plan.", control: "L’autorisation active la position après connexion. Vous pouvez la désactiver dans les outils du message.", allow: "Autoriser la position", later: "Pas maintenant" },
  de: { title: "Aktuellen Standort verwenden?", description: "Erlauben Sie den ungefähren Standort für Orte in der Nähe und das Wetter. Bei aktivem Standort wird mit jeder Nachricht ein neuer ungefährer Standort an KI-Anbieter übermittelt. Keine Ortung im Hintergrund.", control: "Nach der Anmeldung wird der Standort aktiviert. Sie können ihn jederzeit in den Nachrichtenwerkzeugen ausschalten.", allow: "Standort erlauben", later: "Nicht jetzt" },
  es: { title: "¿Usar tu ubicación actual?", description: "Permite la ubicación aproximada para lugares cercanos y el tiempo. Cuando está activada, cada mensaje comparte una ubicación aproximada actualizada con los proveedores de IA. No hay seguimiento en segundo plano.", control: "Al permitirla, se activa tras iniciar sesión. Puedes desactivarla en las herramientas del mensaje.", allow: "Permitir ubicación", later: "Ahora no" },
  pt: { title: "Usar sua localização atual?", description: "Permita a localização aproximada para lugares próximos e o clima. Quando ativada, cada mensagem compartilha uma localização aproximada atualizada com os provedores de IA. Não há rastreamento em segundo plano.", control: "Ao permitir, ela é ativada após entrar na conta. Você pode desativá-la nas ferramentas da mensagem.", allow: "Permitir localização", later: "Agora não" },
};
