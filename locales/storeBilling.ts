const deletionNotices: Record<string, string> = {
  en: "Deleting your Tomverse account stops renewal only for subscriptions billed directly by Tomverse. App Store and Google Play subscriptions must be cancelled separately in that store; deleting the account does not stop store billing.",
  ko: "계정 삭제 시 Tomverse에서 직접 결제한 구독의 자동 갱신만 중지됩니다. App Store와 Google Play 구독은 해당 스토어에서 별도로 취소해야 하며, 계정을 삭제해도 스토어 결제는 중지되지 않습니다.",
  zh: "删除 Tomverse 账户只会停止通过 Tomverse 直接付费的订阅续订。App Store 和 Google Play 订阅必须在相应商店单独取消，删除账户不会停止商店扣款。",
  fr: "La suppression du compte arrête uniquement le renouvellement des abonnements facturés directement par Tomverse. Les abonnements App Store et Google Play doivent être annulés séparément dans la boutique concernée ; supprimer le compte ne met pas fin à leur facturation.",
  de: "Die Kontolöschung beendet nur die Verlängerung direkt über Tomverse abgerechneter Abonnements. App Store- und Google Play-Abonnements müssen separat im jeweiligen Store gekündigt werden; die Kontolöschung beendet deren Abrechnung nicht.",
  es: "Eliminar la cuenta solo detiene la renovación de las suscripciones facturadas directamente por Tomverse. Las suscripciones de App Store y Google Play deben cancelarse por separado en la tienda correspondiente; eliminar la cuenta no detiene esos cobros.",
  pt: "Excluir a conta interrompe apenas a renovação de assinaturas cobradas diretamente pela Tomverse. Assinaturas da App Store e do Google Play devem ser canceladas separadamente na respectiva loja; excluir a conta não interrompe essas cobranças.",
};
export const storeBillingDeletionNotice = (language: string) => deletionNotices[language.split("-")[0]] || deletionNotices.en;
