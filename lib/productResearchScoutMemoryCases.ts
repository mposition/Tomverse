/** Hand-authored synthetic source and user questions. Never read account memory or imported user data. */
import { SUPPORTED_LANGUAGES, type Language } from "./language";
export const MEMORY_CASE_COPY = {
  en: [
    "Draft only: route every booking to {old}. No final decision yet.",
    "Meeting note: the team reviewed the venue and signage.",
    "Final decision: use {main} for all bookings. Only members of {group} who book before noon use {special}. At noon or later, the normal rule applies. The earlier proposal is withdrawn.",
    "Which route applies under the final decision? A: a regular booking. B: a {group} member at 11:00. C: a {group} member at 12:00. D: a {other} member at 11:00. Give the route code for each. If the final rule is unavailable, use UNKNOWN. Return only JSON with string fields A, B, C, D and reason (one sentence in English).",
  ],
  ko: [
    "초안: 모든 예약을 {old} 경로로 보내자는 제안. 최종 결정은 아직 없음.",
    "회의 메모: 장소와 안내판 배치를 검토했다.",
    "최종 결정: 모든 예약은 {main} 경로로 보낸다. 단, {group} 회원이 정오 전에 예약한 경우에만 {special} 경로를 쓴다. 정오부터는 일반 규칙을 적용한다. 이전 제안은 철회했다.",
    "최종 결정에 따르면 각각 어느 경로인가요? A: 일반 예약. B: {group} 회원이 11시에 예약. C: {group} 회원이 12시 정각에 예약. D: {other} 회원이 11시에 예약. 최종 규칙을 알 수 없으면 UNKNOWN을 쓰세요. 문자열 필드 A, B, C, D와 reason(한국어 한 문장)으로 이루어진 JSON만 답해주세요.",
  ],
  de: [
    "Nur ein Entwurf: Alle Buchungen sollen über {old} laufen. Es gibt noch keinen Beschluss.",
    "Sitzungsnotiz: Der Veranstaltungsort und die Beschilderung wurden besprochen.",
    "Endgültiger Beschluss: Für alle Buchungen gilt {main}. Nur Mitglieder von {group}, die vor zwölf Uhr mittags buchen, nutzen {special}. Ab zwölf Uhr gilt die normale Regel. Der frühere Vorschlag ist zurückgezogen.",
    "Welche Route gilt nach dem endgültigen Beschluss? A: reguläre Buchung. B: Mitglied von {group} um 11 Uhr. C: Mitglied von {group} um 12 Uhr. D: Mitglied von {other} um 11 Uhr. Nennen Sie je den Code, bei fehlendem Beschluss UNKNOWN. Antworten Sie nur als JSON mit den Textfeldern A, B, C, D und reason (ein deutscher Satz).",
  ],
  es: [
    "Solo un borrador: enviar todas las reservas por {old}. Aún no hay decisión definitiva.",
    "Nota de la reunión: se revisaron el recinto y la señalización.",
    "Decisión definitiva: todas las reservas van por {main}. Solo los miembros de {group} que reserven antes del mediodía usan {special}. Desde las doce en punto rige la regla general. Se retira la propuesta anterior.",
    "¿Qué ruta corresponde según la decisión definitiva? A: reserva normal. B: miembro de {group} a las 11:00. C: miembro de {group} a las 12:00. D: miembro de {other} a las 11:00. Indica el código en cada caso o UNKNOWN si no consta la regla definitiva. Responde solo con un JSON con los campos de texto A, B, C, D y reason (una frase en español).",
  ],
  fr: [
    "Simple proposition : faire passer toutes les réservations par {old}. Rien n’est encore décidé.",
    "Note de réunion : le lieu et la signalétique ont été examinés.",
    "Décision définitive : utiliser {main} pour toutes les réservations. Seuls les membres de {group} qui réservent avant midi utilisent {special}. Dès midi, la règle générale s’applique. La proposition précédente est retirée.",
    "Quel circuit faut-il suivre selon la décision définitive ? A : réservation ordinaire. B : membre de {group} à 11 h. C : membre de {group} à midi pile. D : membre de {other} à 11 h. Indiquez le code de chaque circuit, ou UNKNOWN si la règle définitive manque. Répondez uniquement en JSON avec les champs texte A, B, C, D et reason (une phrase en français).",
  ],
  pt: [
    "Apenas um rascunho: encaminhar todas as reservas por {old}. Ainda não há decisão final.",
    "Nota da reunião: a equipe revisou o local e a sinalização.",
    "Decisão final: use {main} para todas as reservas. Somente membros de {group} que reservarem antes do meio-dia usam {special}. A partir do meio-dia, vale a regra geral. A proposta anterior foi retirada.",
    "Qual rota se aplica segundo a decisão final? A: reserva comum. B: membro de {group} às 11h. C: membro de {group} ao meio-dia em ponto. D: membro de {other} às 11h. Indique o código de cada rota ou UNKNOWN se a regra final não estiver disponível. Responda somente em JSON com os campos de texto A, B, C, D e reason (uma frase em português).",
  ],
  zh: [
    "草案：建议所有预订都走 {old}。尚未定案。",
    "会议记录：团队讨论了场地和指示牌。",
    "最终决定：所有预订都走 {main}。只有在中午十二点之前预订的 {group} 会员才走 {special}。从十二点整起按一般规则处理。之前的提案已撤回。",
    "根据最终决定，以下预订分别走哪条路线？A：普通预订。B：{group} 会员在 11:00 预订。C：{group} 会员在 12:00 整预订。D：{other} 会员在 11:00 预订。请给出各自的路线代码；若没有最终规则，请填 UNKNOWN。只返回 JSON，字符串字段为 A、B、C、D 和 reason（一句简体中文说明）。",
  ],
  "zh-Hant": [
    "草案：建議所有預訂都走 {old}。尚未定案。",
    "會議紀錄：團隊討論了場地及指示牌。",
    "最終決議：所有預訂都走 {main}。只有在中午十二點之前預訂的 {group} 會員才走 {special}。從十二點整起適用一般規則。先前的提案已撤回。",
    "依照最終決議，下列預訂各應走哪條路線？A：一般預訂。B：{group} 會員於 11:00 預訂。C：{group} 會員於 12:00 整預訂。D：{other} 會員於 11:00 預訂。請給出各自的路線代碼；若沒有最終規則，請填 UNKNOWN。只回傳 JSON，字串欄位為 A、B、C、D 和 reason（一句繁體中文說明）。",
  ],
} as const satisfies Record<
  Language,
  readonly [string, string, string, string]
>;
export type MemoryProbeLocale = Language;
export const MEMORY_PROBE_LOCALES = SUPPORTED_LANGUAGES;
