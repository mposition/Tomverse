import type { Language } from "../lib/language";

const fields = ["providerUsage", "billingUnknown", "usageUnknown", "threadTokens", "turnTokens", "cacheRead", "cacheWrite", "recentRequests",
  "sessionTokens", "requestTokens"] as const;
const translations = {
  en: ["Provider usage", "Billing source unconfirmed", "Token usage unconfirmed", "Reported thread total · {total} tokens",
    "Reported turn usage · {input} input · {output} output tokens", "{tokens} cached input tokens read", "{tokens} input tokens written to cache", "Showing the latest {count} requests.",
    "Reported session total · {input} input · {output} output tokens",
    "Reported usage for {reported} of {requests} model requests · Input tokens {input} · Output tokens {output}"],
  ko: ["공급자 사용량", "청구 출처 미확인", "토큰 사용량 미확인", "보고된 스레드 누계 · 토큰 {total}개",
    "보고된 턴 사용량 · 입력 {input}개 · 출력 {output}개", "캐시에서 읽은 입력 토큰 {tokens}개", "캐시에 저장한 입력 토큰 {tokens}개", "최근 요청 {count}건을 표시합니다.",
    "보고된 세션 누계 · 입력 {input}개 · 출력 {output}개",
    "모델 요청 {requests}건 중 {reported}건의 사용량 · 입력 토큰 {input}개 · 출력 토큰 {output}개"],
  zh: ["供应商用量", "计费来源未确认", "令牌用量未确认", "报告的线程累计用量 · {total} 个令牌",
    "报告的轮次用量 · {input} 个输入令牌 · {output} 个输出令牌", "从缓存读取 {tokens} 个输入令牌", "写入缓存 {tokens} 个输入令牌", "显示最近的 {count} 个请求。",
    "报告的会话累计用量 · {input} 个输入令牌 · {output} 个输出令牌",
    "已报告用量的模型请求：{reported}/{requests} · 输入令牌 {input} · 输出令牌 {output}"],
  "zh-Hant": ["供應商用量", "計費來源未確認", "權杖用量未確認", "回報的執行緒用量 · {total} 個權杖",
    "回報的回合用量 · {input} 個輸入權杖 · {output} 個輸出權杖", "讀取 {tokens} 個快取輸入權杖", "寫入 {tokens} 個快取輸入權杖", "顯示最近的 {count} 筆請求。",
    "回報的工作階段累計用量 · {input} 個輸入權杖 · {output} 個輸出權杖",
    "已回報用量的模型請求：{reported}/{requests} · 輸入權杖 {input} · 輸出權杖 {output}"],
  fr: ["Utilisation du fournisseur", "Source de facturation non confirmée", "Utilisation des jetons non confirmée", "Total déclaré pour le fil · {total} jetons",
    "Utilisation déclarée pour le tour · {input} jetons en entrée · {output} en sortie", "{tokens} jetons d’entrée lus dans le cache", "{tokens} jetons d’entrée mis en cache", "Affichage des {count} dernières requêtes.",
    "Total déclaré pour la session · {input} jetons en entrée · {output} en sortie",
    "Utilisation déclarée pour {reported} requêtes sur {requests} · Jetons en entrée {input} · Jetons en sortie {output}"],
  de: ["Anbieternutzung", "Abrechnungsquelle unbestätigt", "Tokenverbrauch unbestätigt", "Gemeldete Thread-Summe · {total} Tokens",
    "Gemeldeter Verbrauch · {input} Eingabe- · {output} Ausgabe-Tokens", "{tokens} Eingabe-Tokens aus dem Cache gelesen", "{tokens} Eingabe-Tokens im Cache gespeichert", "Die letzten {count} Anfragen werden angezeigt.",
    "Gemeldete Sitzungssumme · {input} Eingabe- · {output} Ausgabe-Tokens",
    "Verbrauch für {reported} von {requests} Modellanfragen gemeldet · Eingabe-Tokens {input} · Ausgabe-Tokens {output}"],
  es: ["Uso del proveedor", "Origen de facturación sin confirmar", "Uso de tokens sin confirmar", "Total indicado para el hilo · {total} tokens",
    "Uso indicado para el turno · {input} tokens de entrada · {output} de salida", "{tokens} tokens de entrada leídos de la caché", "{tokens} tokens de entrada guardados en la caché", "Se muestran las últimas {count} solicitudes.",
    "Total indicado para la sesión · {input} tokens de entrada · {output} de salida",
    "Uso informado para {reported} de {requests} solicitudes al modelo · Tokens de entrada {input} · Tokens de salida {output}"],
  pt: ["Utilização do fornecedor", "Origem da faturação por confirmar", "Utilização de tokens por confirmar", "Total indicado para a sessão · {total} tokens",
    "Utilização indicada para o turno · {input} tokens de entrada · {output} de saída", "{tokens} tokens de entrada lidos da cache", "{tokens} tokens de entrada guardados na cache", "A mostrar os últimos {count} pedidos.",
    "Total indicado para a sessão · {input} tokens de entrada · {output} de saída",
    "Utilização indicada para {reported} de {requests} pedidos ao modelo · Tokens de entrada {input} · Tokens de saída {output}"],
} satisfies Record<Language, readonly [string, string, string, string, string, string, string, string, string, string]>;

export function desktopCodeUsageCopy(language: Language) {
  return Object.fromEntries(fields.map((field, index) => [field, translations[language][index]])) as Record<(typeof fields)[number], string>;
}
