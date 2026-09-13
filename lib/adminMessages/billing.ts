import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for the billing catalogue editor (`BillingAdminPanel`): plans, market
 * prices and promotion codes.
 *
 * Refusal sentences produced by `fixedAmountPromotionRefusal()` and errors
 * returned by `/api/admin/billing` are shared with the API and are shown as
 * they arrive; they are not in this namespace.
 */
export const adminBillingMessages = defineAdminMessages({
  en: {
    plan: {
      active: "Active",
      hidden: "Hidden",
      monthly: "Monthly",
      annual: "Annual",
      annualSave: "Annual save",
      monthlyPriceUsd: "Monthly price USD",
      annualPriceUsd: "Annual price USD",
      dailyCredits: "Daily AI response credits (0 = no daily guardrail)",
      monthlyCredits: "Monthly AI response credits",
      maxModels: "Max compared models",
      stripeStatus: "Stripe status",
      linked: "Linked",
      priceIdNeeded: "Price ID needed",
      stripeProductId: "Stripe Product ID",
      stripeMonthlyPriceId: "Stripe Monthly Price ID",
      stripeAnnualPriceId: "Stripe Annual Price ID",
      features: {
        allowAttachments: "Attachments",
        allowSharing: "Sharing",
        allowDownloads: "Downloads",
      },
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
      internalPassNote:
        "Internal passes collect no payment method, do not renew, and return the user to Free after the configured number of days. Use 100% discount and Pro-only eligibility.",
      allowAnnualStacking: "Allow stacking with annual discount",
      stackingNote:
        "Annual stacking is denied by default and must be explicitly enabled for this code. Active codes always require both a redemption cap and an end date.",
      stripeCouponLinkage: "Stripe coupon linkage",
      stripeCouponId: "Stripe Coupon ID",
      stripePromotionCodeId: "Stripe Promotion Code ID",
    },
    prices: {
      subscriptionTitle: "Fixed subscription prices",
      subscriptionDescription:
        "These are the exact amounts charged by Stripe for each billing market. USD remains managed in the Plans tab. KRW is zero-decimal; all other currencies accept two decimal places. Changes apply to new checkouts; existing subscriptions retain the price accepted at purchase.",
      currency: "Currency",
      proMonthly: "Pro monthly",
      proAnnual: "Pro annual",
      maxMonthly: "Max monthly",
      maxAnnual: "Max annual",
      priceInputLabel: (planId: string, interval: string, currency: string) =>
        `${planId} ${interval} ${currency}`,
      creditPackTitle: "Fixed credit-pack prices",
      creditPackDescription:
        "Credit entitlements stay unchanged; only the one-time checkout amount is edited here.",
      creditPacks: {
        starter_500: "Starter · 500 credits",
        project_1500: "Project · 1,500 credits",
        power_4000: "Power · 4,000 credits",
      },
      checkoutAmount: (currency: string) => `${currency} checkout amount`,
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
    header: {
      eyebrow: "Billing control center",
      title: "Plans, fixed market prices, Stripe IDs, and promotion codes",
      description:
        "These values are loaded from the production database and saved back through the admin API. Stripe checkout reads the same records for monthly, annual, and zero-dollar promotional upgrades.",
      reloadDb: "Reload DB",
      saveToDb: "Save to DB",
    },
    stats: {
      paidUsers: "Paid users",
      activeStripe: (count: number) => `Active Stripe: ${count}`,
      stripeLinked: "Stripe linked",
      paidPlanTypes: "Paid plan types",
      activePromos: "Active promos",
      dbSync: "DB sync",
      synced: (time: string) => `Synced ${time}`,
      loadedOnOpen: "Loaded on page open",
    },
    unsaved: {
      title: "Unsaved changes",
      summary: (plans: number, prices: number, promotions: number) =>
        `${plans} plan change${plans === 1 ? "" : "s"} · ${prices} market price change${
          prices === 1 ? "" : "s"
        } · ${promotions} promotion change${promotions === 1 ? "" : "s"}`,
      note: "Review this preview before saving. Checkout uses these DB records immediately after publish.",
    },
    validation: {
      title: "Pre-save validation",
      plusMore: (count: number) => `Plus ${count} more.`,
      ready: "Stripe ID formats and promotion rules look ready.",
    },
    review: {
      title: "Review before publishing billing changes",
      description:
        "Checkout uses these values immediately. Confirm that plan limits, promotion windows, redemption caps, and Stripe IDs are correct.",
      keepEditing: "Keep editing",
      publish: "Publish changes",
    },
    tabs: {
      plans: "Plans",
      prices: "Market prices",
      promotions: "Promotions",
    },
    toolbar: {
      connected: "Connected to BillingPlan / AppSetting / BillingPromotion",
      reload: "Reload",
      validateStripe: "Validate Stripe",
      saveChanges: "Save changes",
    },
    stripeValidation: {
      title: "Stripe validation",
      result: (product: string, monthly: string, annual: string) =>
        `Product ${product} · Monthly ${monthly} · Annual ${annual}`,
    },
    promotions: {
      title: "Promotion codes",
      description:
        "Active codes require a redemption cap and end date. Annual discount stacking is denied unless explicitly enabled per code.",
      addCode: "Add code",
    },
    footer: {
      title: "Ready to publish billing changes?",
      description:
        "Plan prices, localized market prices, Stripe IDs, and promotion rules are applied after saving to DB.",
    },
  },
  ko: {
    plan: {
      active: "활성",
      hidden: "숨김",
      monthly: "월간",
      annual: "연간",
      annualSave: "연간 할인율",
      monthlyPriceUsd: "월간 가격(USD)",
      annualPriceUsd: "연간 가격(USD)",
      dailyCredits: "일일 AI 응답 크레딧(0 = 일일 guardrail 없음)",
      monthlyCredits: "월간 AI 응답 크레딧",
      maxModels: "최대 비교 모델 수",
      stripeStatus: "Stripe 상태",
      linked: "연결됨",
      priceIdNeeded: "Price ID 필요",
      stripeProductId: "Stripe Product ID",
      stripeMonthlyPriceId: "Stripe 월간 Price ID",
      stripeAnnualPriceId: "Stripe 연간 Price ID",
      features: {
        allowAttachments: "첨부파일",
        allowSharing: "공유",
        allowDownloads: "다운로드",
      },
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
        "USD 결제에만 적용됩니다. 이 금액은 낮출 수만 있고 올릴 수 없으며, 일시 중지한 코드는 다시 활성화할 수 없습니다.",
      fixedAmountLockedNote:
        "새 고정액 프로모션은 받지 않습니다. 금액이 USD라 다른 모든 시장에서 사용할 수 없습니다. 정률 할인을 사용하세요.",
      fulfillment: "제공 방식",
      stripeSubscription: "Stripe 구독",
      internalPass: "내부 이용권(갱신 없음)",
      passDurationDays: "이용권 기간(일)",
      durationMonths: "적용 기간(개월)",
      maxRedemptions: "최대 사용 횟수",
      starts: "시작일",
      ends: "종료일",
      internalPassNote:
        "내부 이용권은 결제 수단을 받지 않고 갱신되지 않으며, 설정한 일수가 지나면 사용자를 Free로 되돌립니다. 100% 할인과 Pro 전용 적용 대상으로 설정하세요.",
      allowAnnualStacking: "연간 할인과 중복 허용",
      stackingNote:
        "연간 할인 중복은 기본적으로 거부되며, 이 코드에서 명시적으로 켜야 합니다. 활성 코드에는 항상 사용 횟수 상한과 종료일이 모두 필요합니다.",
      stripeCouponLinkage: "Stripe coupon 연결",
      stripeCouponId: "Stripe Coupon ID",
      stripePromotionCodeId: "Stripe Promotion Code ID",
    },
    prices: {
      subscriptionTitle: "고정 구독 가격",
      subscriptionDescription:
        "결제 시장별로 Stripe가 실제로 청구하는 정확한 금액입니다. USD는 계속 플랜 탭에서 관리합니다. KRW는 소수점이 없고, 그 밖의 통화는 소수점 둘째 자리까지 입력할 수 있습니다. 변경은 새 결제에 적용되며, 기존 구독은 구매 시점에 수락한 가격을 유지합니다.",
      currency: "통화",
      proMonthly: "Pro 월간",
      proAnnual: "Pro 연간",
      maxMonthly: "Max 월간",
      maxAnnual: "Max 연간",
      priceInputLabel: (planId: string, interval: string, currency: string) =>
        `${planId} ${interval === "monthly" ? "월간" : interval === "annual" ? "연간" : interval} ${currency}`,
      creditPackTitle: "고정 크레딧 팩 가격",
      creditPackDescription:
        "크레딧 지급량은 그대로이며, 여기서는 일회성 결제 금액만 수정합니다.",
      creditPacks: {
        starter_500: "Starter · 500 크레딧",
        project_1500: "Project · 1,500 크레딧",
        power_4000: "Power · 4,000 크레딧",
      },
      checkoutAmount: (currency: string) => `${currency} 결제 금액`,
      fallbackCreated:
        "저장된 가격 카탈로그가 없어 코드 기본값을 표시하며, 이 값은 방금 데이터베이스에 기록되었습니다.",
      fallbackUnreadable:
        "저장된 가격 카탈로그를 읽지 못해 코드 기본값을 표시합니다. 위의 타임스탬프는 이 숫자가 아니라 읽지 못한 행의 것입니다. 저장하면 그 행을 대체합니다.",
    },
    warnings: {
      productId: (plan: string) =>
        `${plan}: Stripe product ID는 prod_로 시작해야 합니다.`,
      monthlyPriceId: (plan: string) =>
        `${plan}: 월간 Stripe price ID는 price_로 시작해야 합니다.`,
      annualPriceId: (plan: string) =>
        `${plan}: 연간 Stripe price ID는 price_로 시작해야 합니다.`,
      discountOver100: (code: string) =>
        `${code}: 할인율은 100%를 넘을 수 없습니다.`,
      noEligiblePlan: (code: string) =>
        `${code}: 적용 대상 플랜을 하나 이상 선택하세요.`,
      activeNeedsCapAndEnd: (code: string) =>
        `${code}: 활성 코드에는 최대 사용 횟수와 종료일이 필요합니다.`,
      endBeforeStart: (code: string) =>
        `${code}: 종료일은 시작일보다 뒤여야 합니다.`,
      couponId: (code: string) =>
        `${code}: Stripe coupon ID는 coupon_으로 시작해야 합니다.`,
      promotionCodeId: (code: string) =>
        `${code}: Stripe promotion code ID는 promo_로 시작해야 합니다.`,
    },
    toasts: {
      reloaded: "결제 설정을 다시 불러왔습니다. 이제 양식이 저장된 값과 일치합니다.",
      reloadFailed:
        "결제 설정을 다시 불러오지 못해 양식에 이전 값이 그대로 표시됩니다. 수정하기 전에 다시 시도하세요.",
      nothingSaved: (reason: string) => `${reason} 아무것도 저장되지 않았습니다.`,
      saved:
        "결제 설정을 저장했습니다. 플랜, 프로모션, 가격 카탈로그가 적용되었습니다.",
      saveFailed:
        "결제 설정을 저장하지 못했습니다. 변경된 것은 없습니다. 다시 시도하거나, 다시 불러와 수정 내용을 버리세요.",
      stripeIssues: "Stripe 검증에서 문제를 발견했습니다.",
      stripeValidated: "Stripe ID를 검증했습니다.",
      stripeValidationFailed: "Stripe 검증에 실패했습니다.",
    },
    header: {
      eyebrow: "결제 관리 센터",
      title: "플랜, 시장별 고정 가격, Stripe ID, 프로모션 코드",
      description:
        "이 값은 production 데이터베이스에서 불러오고 관리자 API를 통해 다시 저장됩니다. Stripe 결제는 월간, 연간, 0달러 프로모션 업그레이드에 같은 레코드를 읽습니다.",
      reloadDb: "DB 다시 불러오기",
      saveToDb: "DB에 저장",
    },
    stats: {
      paidUsers: "유료 사용자",
      activeStripe: (count: number) => `활성 Stripe: ${count}`,
      stripeLinked: "Stripe 연결",
      paidPlanTypes: "유료 플랜 종류",
      activePromos: "활성 프로모션",
      dbSync: "DB 동기화",
      synced: (time: string) => `${time} 동기화`,
      loadedOnOpen: "페이지를 열 때 불러옴",
    },
    unsaved: {
      title: "저장되지 않은 변경",
      summary: (plans: number, prices: number, promotions: number) =>
        `플랜 변경 ${plans}건 · 시장 가격 변경 ${prices}건 · 프로모션 변경 ${promotions}건`,
      note: "저장하기 전에 이 미리보기를 검토하세요. 게시하는 즉시 결제가 이 DB 레코드를 사용합니다.",
    },
    validation: {
      title: "저장 전 검증",
      plusMore: (count: number) => `외 ${count}건 더 있습니다.`,
      ready: "Stripe ID 형식과 프로모션 규칙에 문제가 없습니다.",
    },
    review: {
      title: "결제 변경을 게시하기 전에 검토하세요",
      description:
        "결제는 이 값을 즉시 사용합니다. 플랜 한도, 프로모션 기간, 사용 횟수 상한, Stripe ID가 맞는지 확인하세요.",
      keepEditing: "계속 편집",
      publish: "변경 게시",
    },
    tabs: {
      plans: "플랜",
      prices: "시장 가격",
      promotions: "프로모션",
    },
    toolbar: {
      connected: "BillingPlan / AppSetting / BillingPromotion에 연결됨",
      reload: "다시 불러오기",
      validateStripe: "Stripe 검증",
      saveChanges: "변경 저장",
    },
    stripeValidation: {
      title: "Stripe 검증",
      result: (product: string, monthly: string, annual: string) =>
        `Product ${product} · 월간 ${monthly} · 연간 ${annual}`,
    },
    promotions: {
      title: "프로모션 코드",
      description:
        "활성 코드에는 사용 횟수 상한과 종료일이 필요합니다. 연간 할인 중복은 코드별로 명시적으로 켜지 않으면 거부됩니다.",
      addCode: "코드 추가",
    },
    footer: {
      title: "결제 변경을 게시할 준비가 되었나요?",
      description:
        "플랜 가격, 시장별 가격, Stripe ID, 프로모션 규칙은 DB에 저장한 뒤 적용됩니다.",
    },
  },
});
