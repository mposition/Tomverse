import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for Plans & pricing (`/admin/billing`): the plan cards, market prices,
 * promotion codes and the one save bar they share (`BillingAdminPanel`).
 *
 * Refusal sentences produced by `fixedAmountPromotionRefusal()` and errors
 * returned by `/api/admin/billing` are shared with the API and are shown as
 * they arrive; they are not in this namespace.
 */
export const adminBillingMessages = defineAdminMessages({
  en: {
    readFailed: {
      title: "Plans and prices could not be read",
      detail: "Nothing was changed. Reload the page to try again.",
      promotionsTitle: "Promotions could not be read",
      promotionsDetail: "Nothing was changed. Reload the page to try again.",
      riskTitle: "Promotion risk signals could not be read",
      riskDetail: "The promotion codes above are fine to edit. Reload the page to read the signals again.",
    },
    plan: {
      active: "Active",
      perMonth: "/ month",
      annualLine: (price: string, savings: number) =>
        `Annual US$ ${price}${savings > 0 ? ` · saves ${savings}%` : ""}`,
      noPayment: "No payment",
      stripeConnected: "Stripe connected",
      priceIdNeeded: "Price ID needed",
      subscribers: "Subscribers",
      users: "Users",
      unreadCount: "Unavailable",
      monthlyCredits: "Monthly credits",
      comparedModels: "Compared models",
      monthlyPriceUsd: "Monthly price (USD)",
      annualPriceUsd: "Annual price (USD)",
      dailyCredits: "Daily credits (0 = no daily limit)",
      stripeIdsSummary: "Stripe product and price IDs",
      stripeProductId: "Stripe Product ID",
      stripeMonthlyPriceId: "Stripe Monthly Price ID",
      stripeAnnualPriceId: "Stripe Annual Price ID",
      features: {
        allowAttachments: "Attachments",
        allowSharing: "Sharing",
        allowDownloads: "Downloads",
      },
      changedNote: (text: string) => `Changed · ${text}`,
      changeLabel: {
        isActive: "Active",
        monthlyPriceCents: "Monthly price",
        annualPriceCents: "Annual price",
        dailyMessageLimit: "Daily credits",
        monthlyMessageLimit: "Monthly credits",
        maxModels: "Compared models",
        allowAttachments: "Attachments",
        allowSharing: "Sharing",
        allowDownloads: "Downloads",
      },
      change: (label: string, from: string, to: string) => `${label} ${from} → ${to}`,
      stripeIdsChanged: "Stripe IDs",
      on: "on",
      off: "off",
    },
    promotion: {
      active: "Active",
      paused: "Paused",
      redeemed: (
        redeemed: number,
        maxRedemptions: number | null,
        remaining: number | null
      ) =>
        `Redeemed ${redeemed}${maxRedemptions ? ` / ${maxRedemptions}` : ""}${
          remaining !== null ? `, ${remaining} left` : ""
        }`,
      deletePromotion: "Delete promotion",
      code: "Code",
      discountPercent: "Discount percent",
      fixedDiscountUsd: "Fixed discount USD (deprecated)",
      fixedAmountEditableNote:
        "USD checkout only. This amount can be lowered, never raised, and this code cannot be reactivated once paused.",
      fixedAmountLockedNote:
        "New fixed-amount promotions are not accepted -- the amount is USD and would be unusable in every other market. Use a percentage discount.",
      fulfillment: "Fulfillment",
      stripeSubscription: "Stripe subscription",
      internalPass: "Internal pass (no renewal)",
      passDurationDays: "Pass duration days",
      durationMonths: "Duration months",
      maxRedemptions: "Max redemptions",
      starts: "Starts",
      ends: "Ends",
      eligiblePlans: "Eligible plans",
      internalPassNote:
        "Internal passes collect no payment method, do not renew, and return the user to Free after the configured number of days. Use 100% discount and Pro-only eligibility.",
      allowAnnualStacking: "Allow stacking with annual discount",
      stackingNote:
        "Annual stacking is denied by default and must be explicitly enabled for this code. Active codes always require both a redemption cap and an end date.",
      stripeCouponLinkage: "Stripe coupon and promotion code IDs",
      stripeCouponId: "Stripe Coupon ID",
      stripePromotionCodeId: "Stripe Promotion Code ID",
      stripeIdsChanged: "Stripe IDs",
      added: (code: string) => `Code ${code} added`,
      removed: (code: string) => `Code ${code} removed`,
      changed: (code: string, fields: string) => `Code ${code}: ${fields}`,
      unset: "none",
    },
    prices: {
      subscriptionTitle: "Fixed subscription prices",
      subscriptionDescription:
        "These are the exact amounts Stripe charges in each billing market. USD is managed on the plan cards. KRW has no decimals; other currencies take two decimal places. Changes apply to new checkouts; existing subscriptions keep the price they signed up at.",
      lastSaved: (time: string) => `Last saved ${time}`,
      currency: "Currency",
      proMonthly: "Pro monthly",
      proAnnual: "Pro annual",
      maxMonthly: "Max monthly",
      maxAnnual: "Max annual",
      priceInputLabel: (planId: string, interval: string, currency: string) =>
        `${planId} ${interval} ${currency}`,
      creditPackTitle: "Fixed credit-pack prices",
      creditPackDescription:
        "Credit amounts stay the same; only the one-time checkout price is edited here.",
      creditPacks: {
        starter_500: "Starter · 500 credits",
        project_1500: "Project · 1,500 credits",
        power_4000: "Power · 4,000 credits",
      },
      packInputLabel: (pack: string, currency: string) => `${pack} ${currency}`,
      fallbackCreated:
        "There was no stored price catalogue, so these are the code defaults and they have just been written to the database.",
      fallbackUnreadable:
        "The stored price catalogue could not be read, so these are the code defaults. The timestamp above belongs to the unreadable row, not to these numbers. Saving replaces the row.",
    },
    warnings: {
      productId: (plan: string) =>
        `${plan}: Stripe product ID should start with prod_.`,
      monthlyPriceId: (plan: string) =>
        `${plan}: monthly Stripe price ID should start with price_.`,
      annualPriceId: (plan: string) =>
        `${plan}: annual Stripe price ID should start with price_.`,
      discountOver100: (code: string) =>
        `${code}: discount percent cannot exceed 100%.`,
      noEligiblePlan: (code: string) =>
        `${code}: choose at least one eligible plan.`,
      activeNeedsCapAndEnd: (code: string) =>
        `${code}: active codes require max redemptions and an end date.`,
      endBeforeStart: (code: string) =>
        `${code}: end date must be after start date.`,
      couponId: (code: string) =>
        `${code}: Stripe coupon ID should start with coupon_.`,
      promotionCodeId: (code: string) =>
        `${code}: Stripe promotion code ID should start with promo_.`,
    },
    toasts: {
      reloaded: "Billing settings reloaded. The form now matches what is stored.",
      reloadFailed:
        "Billing settings could not be reloaded, so the form still shows the values it had. Retry before editing.",
      nothingSaved: (reason: string) => `${reason} Nothing was saved.`,
      saved:
        "Billing settings saved. Plans, promotions and the price catalogue are live.",
      saveFailed:
        "Billing settings were not saved. Nothing changed -- retry, or reload to discard the edit.",
      stripeIssues: "Stripe validation found issues.",
      stripeValidated: "Stripe IDs validated.",
      stripeValidationFailed: "Stripe validation failed.",
    },
    toolbar: {
      reload: "Reload",
      validateStripe: "Validate Stripe",
      synced: (time: string) => `Reloaded ${time}`,
      loadedOnOpen: "Showing what was stored when the page opened",
    },
    validation: {
      title: "Check before saving",
      refusalsHeading: "These edits will be refused",
      warningsHeading: "These need a look",
      plusMore: (count: number) => `Plus ${count} more.`,
    },
    saveBar: {
      region: "Unsaved billing changes",
      title: (count: number) => `${count} unsaved change${count === 1 ? "" : "s"}`,
      detail: "Saving applies to checkout right away.",
      revert: "Revert",
      review: "Review changes and save",
    },
    review: {
      title: "Review billing changes",
      summary: (plans: number, prices: number, promotions: number) =>
        `${plans} plan change${plans === 1 ? "" : "s"} · ${prices} market price change${
          prices === 1 ? "" : "s"
        } · ${promotions} promotion change${promotions === 1 ? "" : "s"}`,
      liveNote: "Checkout uses these values as soon as you save.",
      warningsNote: (count: number) =>
        `${count} check${count === 1 ? "" : "s"} above need a look. You can still save.`,
      pricesChanged: "Market prices or credit-pack prices",
      more: (count: number) => `…and ${count} more`,
      confirm: "Save changes",
    },
    stripeValidation: {
      title: "Stripe validation",
      description: "What Stripe says about each plan's product and prices.",
      plan: "Plan",
      product: "Product",
      monthly: "Monthly price",
      annual: "Annual price",
      firstError: "First error",
    },
    promotions: {
      title: "Promotion codes",
      description:
        "Active codes need a redemption cap and an end date. Stacking with the annual discount is off unless you turn it on for a code.",
      addCode: "Add code",
      emptyTitle: "No promotion codes yet",
      emptyDetail: "Add a code to offer a discount at checkout.",
    },
  },
  ko: {
    readFailed: {
      title: "플랜과 가격을 읽지 못했어요",
      detail: "바뀐 건 없어요. 페이지를 새로 고쳐서 다시 시도해 주세요.",
      promotionsTitle: "프로모션을 읽지 못했어요",
      promotionsDetail: "바뀐 건 없어요. 페이지를 새로 고쳐서 다시 시도해 주세요.",
      riskTitle: "프로모션 위험 신호를 읽지 못했어요",
      riskDetail: "위의 프로모션 코드는 그대로 고칠 수 있어요. 신호는 페이지를 새로 고쳐서 다시 읽어 주세요.",
    },
    plan: {
      active: "활성",
      perMonth: "/ 월",
      annualLine: (price: string, savings: number) =>
        `연간 US$ ${price}${savings > 0 ? ` · ${savings}% 할인` : ""}`,
      noPayment: "결제 없음",
      stripeConnected: "Stripe 연결됨",
      priceIdNeeded: "Price ID가 필요해요",
      subscribers: "구독자",
      users: "사용자",
      unreadCount: "확인 불가",
      monthlyCredits: "월 크레딧",
      comparedModels: "비교 모델",
      monthlyPriceUsd: "월간 가격(USD)",
      annualPriceUsd: "연간 가격(USD)",
      dailyCredits: "일일 크레딧(0 = 일일 한도 없음)",
      stripeIdsSummary: "Stripe 상품·가격 ID",
      stripeProductId: "Stripe Product ID",
      stripeMonthlyPriceId: "Stripe 월간 Price ID",
      stripeAnnualPriceId: "Stripe 연간 Price ID",
      features: {
        allowAttachments: "첨부파일",
        allowSharing: "공유",
        allowDownloads: "다운로드",
      },
      changedNote: (text: string) => `바뀌었어요 · ${text}`,
      changeLabel: {
        isActive: "활성",
        monthlyPriceCents: "월간 가격",
        annualPriceCents: "연간 가격",
        dailyMessageLimit: "일일 크레딧",
        monthlyMessageLimit: "월 크레딧",
        maxModels: "비교 모델",
        allowAttachments: "첨부파일",
        allowSharing: "공유",
        allowDownloads: "다운로드",
      },
      change: (label: string, from: string, to: string) => `${label} ${from} → ${to}`,
      stripeIdsChanged: "Stripe ID",
      on: "켜짐",
      off: "꺼짐",
    },
    promotion: {
      active: "활성",
      paused: "일시 중지",
      redeemed: (
        redeemed: number,
        maxRedemptions: number | null,
        remaining: number | null
      ) =>
        `사용 ${redeemed}${maxRedemptions ? ` / ${maxRedemptions}` : ""}${
          remaining !== null ? `, 남은 횟수 ${remaining}` : ""
        }`,
      deletePromotion: "프로모션 삭제",
      code: "코드",
      discountPercent: "할인율(%)",
      fixedDiscountUsd: "고정 할인액 USD(지원 중단)",
      fixedAmountEditableNote:
        "USD 결제에만 적용돼요. 이 금액은 낮출 수만 있고 올릴 수 없어요. 일시 중지한 코드는 다시 활성화할 수 없어요.",
      fixedAmountLockedNote:
        "새 고정액 프로모션은 받지 않아요. 금액이 USD라서 다른 시장에서는 쓸 수 없어요. 정률 할인을 써 주세요.",
      fulfillment: "제공 방식",
      stripeSubscription: "Stripe 구독",
      internalPass: "내부 이용권(갱신 없음)",
      passDurationDays: "이용권 기간(일)",
      durationMonths: "적용 기간(개월)",
      maxRedemptions: "최대 사용 횟수",
      starts: "시작일",
      ends: "종료일",
      eligiblePlans: "적용 플랜",
      internalPassNote:
        "내부 이용권은 결제 수단을 받지 않고 갱신되지 않아요. 정한 일수가 지나면 사용자를 Free로 되돌려요. 100% 할인과 Pro 전용으로 설정해 주세요.",
      allowAnnualStacking: "연간 할인과 중복 허용",
      stackingNote:
        "연간 할인과의 중복은 기본으로 막혀 있어요. 이 코드에서 직접 켜야 해요. 활성 코드에는 항상 사용 횟수 상한과 종료일이 둘 다 필요해요.",
      stripeCouponLinkage: "Stripe coupon·promotion code ID",
      stripeCouponId: "Stripe Coupon ID",
      stripePromotionCodeId: "Stripe Promotion Code ID",
      stripeIdsChanged: "Stripe ID",
      added: (code: string) => `코드 ${code} 추가`,
      removed: (code: string) => `코드 ${code} 삭제`,
      changed: (code: string, fields: string) => `코드 ${code}: ${fields}`,
      unset: "없음",
    },
    prices: {
      subscriptionTitle: "고정 구독 가격",
      subscriptionDescription:
        "결제 시장마다 Stripe가 실제로 청구하는 금액이에요. USD는 플랜 카드에서 관리해요. KRW는 소수점이 없고, 다른 통화는 소수점 둘째 자리까지 넣을 수 있어요. 바꾼 가격은 새 결제부터 적용돼요. 이미 구독 중인 사람은 가입할 때의 가격을 그대로 내요.",
      lastSaved: (time: string) => `마지막 저장 ${time}`,
      currency: "통화",
      proMonthly: "Pro 월간",
      proAnnual: "Pro 연간",
      maxMonthly: "Max 월간",
      maxAnnual: "Max 연간",
      priceInputLabel: (planId: string, interval: string, currency: string) =>
        `${planId} ${interval === "monthly" ? "월간" : interval === "annual" ? "연간" : interval} ${currency}`,
      creditPackTitle: "고정 크레딧 팩 가격",
      creditPackDescription:
        "크레딧 지급량은 그대로이고, 여기서는 한 번 내는 결제 가격만 고쳐요.",
      creditPacks: {
        starter_500: "Starter · 500 크레딧",
        project_1500: "Project · 1,500 크레딧",
        power_4000: "Power · 4,000 크레딧",
      },
      packInputLabel: (pack: string, currency: string) => `${pack} ${currency}`,
      fallbackCreated:
        "저장된 가격 카탈로그가 없어서 코드 기본값을 보여 주고 있어요. 이 값은 방금 데이터베이스에 기록됐어요.",
      fallbackUnreadable:
        "저장된 가격 카탈로그를 읽지 못해서 코드 기본값을 보여 주고 있어요. 위의 시각은 이 숫자가 아니라 읽지 못한 행의 시각이에요. 저장하면 그 행을 대체해요.",
    },
    warnings: {
      productId: (plan: string) =>
        `${plan}: Stripe product ID는 prod_로 시작해야 해요.`,
      monthlyPriceId: (plan: string) =>
        `${plan}: 월간 Stripe price ID는 price_로 시작해야 해요.`,
      annualPriceId: (plan: string) =>
        `${plan}: 연간 Stripe price ID는 price_로 시작해야 해요.`,
      discountOver100: (code: string) =>
        `${code}: 할인율은 100%를 넘을 수 없어요.`,
      noEligiblePlan: (code: string) =>
        `${code}: 적용 플랜을 하나 이상 골라 주세요.`,
      activeNeedsCapAndEnd: (code: string) =>
        `${code}: 활성 코드에는 최대 사용 횟수와 종료일이 필요해요.`,
      endBeforeStart: (code: string) =>
        `${code}: 종료일은 시작일보다 뒤여야 해요.`,
      couponId: (code: string) =>
        `${code}: Stripe coupon ID는 coupon_으로 시작해야 해요.`,
      promotionCodeId: (code: string) =>
        `${code}: Stripe promotion code ID는 promo_로 시작해야 해요.`,
    },
    toasts: {
      reloaded: "결제 설정을 다시 불러왔어요. 이제 화면이 저장된 값과 같아요.",
      reloadFailed:
        "결제 설정을 다시 불러오지 못해서 화면에 이전 값이 그대로 있어요. 고치기 전에 다시 시도해 주세요.",
      nothingSaved: (reason: string) => `${reason} 아무것도 저장되지 않았어요.`,
      saved:
        "결제 설정을 저장했어요. 플랜, 프로모션, 가격 카탈로그가 적용됐어요.",
      saveFailed:
        "결제 설정을 저장하지 못했어요. 바뀐 건 없어요. 다시 시도하거나, 다시 불러와서 고친 내용을 버려 주세요.",
      stripeIssues: "Stripe 검증에서 문제가 나왔어요.",
      stripeValidated: "Stripe ID를 검증했어요.",
      stripeValidationFailed: "Stripe 검증에 실패했어요.",
    },
    toolbar: {
      reload: "다시 불러오기",
      validateStripe: "Stripe 검증",
      synced: (time: string) => `${time}에 다시 불러왔어요`,
      loadedOnOpen: "페이지를 열 때 저장돼 있던 값이에요",
    },
    validation: {
      title: "저장하기 전에 확인해요",
      refusalsHeading: "이 수정은 거절돼요",
      warningsHeading: "확인이 필요해요",
      plusMore: (count: number) => `외 ${count}건 더 있어요.`,
    },
    saveBar: {
      region: "저장하지 않은 결제 변경",
      title: (count: number) => `저장하지 않은 변경 ${count}건`,
      detail: "저장하면 바로 결제에 적용돼요.",
      revert: "되돌리기",
      review: "변경 내용 검토하고 저장",
    },
    review: {
      title: "결제 변경 내용을 확인해요",
      summary: (plans: number, prices: number, promotions: number) =>
        `플랜 변경 ${plans}건 · 시장 가격 변경 ${prices}건 · 프로모션 변경 ${promotions}건`,
      liveNote: "저장하면 결제가 바로 이 값을 써요.",
      warningsNote: (count: number) =>
        `위에서 확인이 필요한 항목이 ${count}건 있어요. 그래도 저장할 수 있어요.`,
      pricesChanged: "시장 가격 또는 크레딧 팩 가격",
      more: (count: number) => `…외 ${count}건`,
      confirm: "변경 내용 저장",
    },
    stripeValidation: {
      title: "Stripe 검증",
      description: "플랜마다 상품과 가격에 대해 Stripe가 알려 준 결과예요.",
      plan: "플랜",
      product: "상품",
      monthly: "월간 가격",
      annual: "연간 가격",
      firstError: "첫 오류",
    },
    promotions: {
      title: "프로모션 코드",
      description:
        "활성 코드에는 사용 횟수 상한과 종료일이 필요해요. 연간 할인과의 중복은 코드마다 직접 켜지 않으면 꺼져 있어요.",
      addCode: "코드 추가",
      emptyTitle: "아직 프로모션 코드가 없어요",
      emptyDetail: "코드를 추가하면 결제할 때 할인을 줄 수 있어요.",
    },
  },
});
