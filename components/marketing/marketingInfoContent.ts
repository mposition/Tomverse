import type { Language } from "@/components/LanguageProvider";
import type { MarketingInfoCopy } from "./MarketingInfoPage";

export const infoPages = {
  faq: {
    en: {
      eyebrow: "FAQ",
      title: "Frequently asked questions",
      description: "Quick answers about Tomverse AI, accounts, models, files, sharing, and Private Mode.",
      sections: [
        { title: "What is Tomverse AI?", body: "Tomverse AI is a multi-model AI workspace that lets you compare answers from several AI models, attach files, and organize conversations in one place." },
        { title: "Can I use more than one model at once?", body: "Yes. You can compare up to three models in a single conversation so the experience stays readable and cost-controlled." },
        { title: "What does Private Mode mean?", body: "Private Mode means Tomverse does not save the conversation to the Tomverse database. Your prompt may still be sent to the selected AI provider to generate a response." },
        { title: "Can I share a conversation?", body: "Logged-in users can create read-only public share links or download conversations as text files. Locked conversations require unlock verification before sharing." },
      ],
    },
    ko: {
      eyebrow: "FAQ",
      title: "자주 묻는 질문",
      description: "Tomverse AI, 계정, 모델, 파일, 공유, Private Mode에 대한 빠른 답변입니다.",
      sections: [
        { title: "Tomverse AI는 무엇인가요?", body: "Tomverse AI는 여러 AI 모델의 답변을 비교하고, 파일을 첨부하며, 대화를 한곳에서 정리할 수 있는 멀티 모델 AI 워크스페이스입니다." },
        { title: "여러 모델을 동시에 사용할 수 있나요?", body: "네. 한 대화에서 최대 3개 모델까지 비교할 수 있습니다. 가독성과 비용 통제를 위해 3개로 제한합니다." },
        { title: "Private Mode는 어떤 의미인가요?", body: "Private Mode는 Tomverse 데이터베이스에 대화를 저장하지 않는다는 뜻입니다. 답변 생성을 위해 선택한 AI 공급자에게 질문이 전송될 수 있습니다." },
        { title: "대화를 공유할 수 있나요?", body: "로그인 사용자는 읽기 전용 공개 링크를 만들거나 대화를 텍스트 파일로 다운로드할 수 있습니다. 잠긴 대화는 공유 전 잠금 해제가 필요합니다." },
      ],
    },
    zh: {
      eyebrow: "FAQ",
      title: "常见问题",
      description: "关于 Tomverse AI、账户、模型、文件、分享和 Private Mode 的快速说明。",
      sections: [
        { title: "Tomverse AI 是什么？", body: "Tomverse AI 是一个多模型 AI 工作区，可在一个地方比较多个 AI 模型的回答、附加文件并整理对话。" },
        { title: "可以同时使用多个模型吗？", body: "可以。单个对话最多可比较三个模型，以保持界面清晰并控制成本。" },
        { title: "Private Mode 是什么意思？", body: "Private Mode 表示 Tomverse 不会把对话保存到 Tomverse 数据库。为了生成回答，提示仍可能发送给所选 AI 供应商。" },
        { title: "可以分享对话吗？", body: "登录用户可以创建只读公开链接，或将对话下载为文本文件。锁定对话在分享前需要完成解锁验证。" },
      ],
    },
  },
  terms: {
    en: {
      eyebrow: "Legal",
      title: "Terms and Conditions",
      description: "These terms govern free and paid use of Tomverse AI, including accounts, AI providers, subscriptions, monthly and additional credits, cancellation, and disputes.",
      updated: "Last updated: July 15, 2026",
      sections: [
        {
          title: "Agreement, operator, and contact",
          body: "Tomverse AI is the service and operating name used for tomverse.app (\"Tomverse\", \"we\", \"us\"). The legal seller or contracting operator for a paid transaction is the entity identified on the Stripe Checkout page, receipt, or invoice for that transaction. Billing and legal notices can be sent to support@tomverse.app or through the support form at tomverse.app/support.",
        },
        {
          title: "Accounts and use of the service",
          body: "You must provide accurate account information, protect access to your account, and take responsibility for account activity, prompts, uploaded files, and content you use or share. We may reasonably limit, suspend, or terminate access where necessary to address abuse, security risk, non-payment, legal requirements, or a material breach of these terms.",
        },
        {
          title: "Third-party AI providers and outputs",
          body: "Tomverse routes prompts and selected context to third-party AI providers and displays their responses. AI outputs can be inaccurate, incomplete, outdated, unsafe, or unsuitable and are not professional legal, medical, financial, safety, or other advice. Verify important outputs and obtain qualified advice before making high-impact decisions.",
        },
        {
          title: "Plans, AI credits, and fair use",
          body: "Free, Pro, and Max provide the features and monthly AI-credit allowances shown on the pricing and account pages. Credit use varies by model, reasoning mode, and input size. Monthly credits reset at the beginning of each calendar month in UTC, do not roll over, are not transferable, and have no cash value. Fair-use, abuse-prevention, model, provider-cost, file, and context limits continue to apply.",
        },
        {
          title: "Additional credit packs",
          body: "An additional credit pack is a one-time purchase that is separate from a subscription and its monthly credits. Additional credits expire 12 months (365 days) after purchase, are not transferable, and cannot be redeemed for cash. Tomverse deducts available monthly plan credits first and then additional-credit lots in order of earliest expiry. A pack increases only the credit balance available for usage: it does not upgrade the plan or increase model access, features, daily limits, plan-specific higher-cost model limits, fair-use limits, or other safeguards.",
        },
        {
          title: "Monthly and annual subscriptions; automatic renewal",
          body: "Pro and Max are recurring subscriptions processed by Stripe. Monthly subscriptions are charged in advance and renew each month. Annual subscriptions are charged in advance for the year and renew each year. Unless you cancel before the next renewal, you authorise Stripe to charge the payment method on file for the amount and currency shown at checkout. We will give reasonable notice of a material price change where required and you may cancel before it takes effect.",
        },
        {
          title: "Promotions and annual discounts",
          body: "A promotion applies only to the plan, billing interval, duration, redemption limit, and expiry disclosed for that code. Promotions do not combine with the annual-plan discount unless the specific promotion expressly permits stacking. When a limited promotion ends, the subscription renews at the then-disclosed regular price unless cancelled. A discount has no separate cash value.",
        },
        {
          title: "Cancellation and end of paid access",
          body: "You can schedule cancellation from the account billing controls. Cancellation stops the next automatic renewal; it does not normally end access immediately. Paid features remain available until the current monthly or annual period ends, after which the account moves to the available Free plan. There is no early-termination fee and cancellation alone does not create an automatic prorated refund. An approved refund or a termination for cause may end paid access earlier. Cancelling or downgrading a subscription does not by itself remove valid additional credits: they remain available until their stated expiry, but can be used only with the model access, features, daily limits, and safeguards of the account's then-current plan.",
        },
        {
          title: "Refunds and provider failures",
          body: "Subscription and additional-credit refund requests are governed by the Refund Policy at tomverse.app/refund and any rights that cannot be excluded by law. A failed or empty provider response normally releases reserved AI credits automatically; a user-cancelled response that already produced usable output may consume a proportionate amount. An approved full or partial additional-credit refund, or a chargeback, reverses the corresponding credit entitlement. Available credits are revoked first; any corresponding entitlement already used may be recorded as credit debt and offset against future monthly or additional-credit grants, and access may be temporarily limited while a payment dispute remains unresolved. If an incident appears to have consumed credits incorrectly, contact support with the trace ID so we can review the logs.",
        },
        {
          title: "Currency, taxes, and payment processing",
          body: "Local-currency estimates shown before checkout are informational. The amount, billing interval, currency, and any applicable tax shown by Stripe Checkout before confirmation control the transaction. Your bank, card issuer, wallet, or payment provider may apply its own exchange rate or fee. Tomverse does not store complete payment-card details.",
        },
        {
          title: "Acceptable use and rights in content",
          body: "Do not use Tomverse to violate law, infringe rights, abuse providers, bypass limits, upload malicious material, or process content you are not entitled to use. You retain rights you hold in your input. You grant Tomverse the limited rights necessary to process that input, operate requested features, and send relevant context to the AI providers you select.",
        },
        {
          title: "Consumer rights, governing law, and disputes",
          body: "Nothing in these terms excludes guarantees, remedies, or other rights that cannot lawfully be excluded, including rights that may apply under the Australian Consumer Law. To the extent permitted by law, these terms are governed by the laws of Queensland, Australia. Please contact support first so we can try to resolve a dispute; this does not restrict your right to contact a regulator, tribunal, or court with jurisdiction.",
        },
      ],
      cta: { label: "Contact support", href: "/support" },
    },
    ko: {
      eyebrow: "법적 고지",
      title: "이용약관",
      description: "계정, AI 제공자, 구독, 월 크레딧과 추가 크레딧, 취소 및 분쟁을 포함한 Tomverse AI의 무료·유료 서비스 이용 조건입니다.",
      updated: "최종 업데이트: 2026년 7월 15일",
      sections: [
        {
          title: "약관 동의, 운영 주체 및 연락처",
          body: "Tomverse AI는 tomverse.app에서 제공되는 서비스 및 운영 명칭입니다(이하 ‘Tomverse’ 또는 ‘당사’). 유료 거래의 법적 판매자 또는 계약 운영 주체는 해당 Stripe 결제 화면, 영수증 또는 인보이스에 표시된 사업자입니다. 결제·법률 관련 문의는 support@tomverse.app 또는 tomverse.app/support의 지원 폼으로 접수할 수 있습니다.",
        },
        {
          title: "계정 및 서비스 이용",
          body: "사용자는 정확한 계정 정보를 제공하고 계정 접근을 보호해야 하며, 계정 활동, 프롬프트, 업로드 파일, 사용하거나 공유하는 콘텐츠에 책임을 집니다. 남용, 보안 위험, 미결제, 법적 의무 또는 중대한 약관 위반에 대응하기 위해 합리적으로 필요한 범위에서 접근을 제한·정지·종료할 수 있습니다.",
        },
        {
          title: "제3자 AI 제공자와 출력",
          body: "Tomverse는 프롬프트와 선택된 맥락을 제3자 AI 제공자에게 전송하고 그 응답을 표시합니다. AI 출력은 부정확·불완전·오래되었거나 상황에 부적합할 수 있으며 법률, 의료, 금융, 안전 등 전문적인 조언이 아닙니다. 중요한 결정 전에는 결과를 독립적으로 확인하고 자격 있는 전문가의 조언을 받아야 합니다.",
        },
        {
          title: "플랜, AI 크레딧 및 공정사용",
          body: "Free, Pro, Max에는 요금 및 계정 페이지에 표시된 기능과 월 AI 크레딧 한도가 적용됩니다. 크레딧 사용량은 모델, 추론 방식, 입력 크기에 따라 달라집니다. 월 크레딧은 매월 1일 00:00 UTC에 초기화되며 이월·양도할 수 없고 현금 가치가 없습니다. 공정사용, 남용 방지, 모델, 제공자 비용, 파일 및 맥락 한도는 계속 적용됩니다.",
        },
        {
          title: "추가 크레딧 팩",
          body: "추가 크레딧 팩은 구독 및 구독에 포함된 월 크레딧과 분리된 일회성 구매 상품입니다. 추가 크레딧은 구매일로부터 12개월(365일) 후 만료되며 양도하거나 현금으로 교환할 수 없습니다. Tomverse는 사용 가능한 월 플랜 크레딧을 먼저 차감한 뒤 만료일이 빠른 추가 크레딧 묶음부터 차감합니다. 추가 크레딧은 사용 가능한 크레딧 잔액만 늘리며, 플랜을 업그레이드하거나 모델 접근권한, 기능, 일일 제한, 플랜별 고비용 모델 제한, 공정사용 한도 또는 기타 안전장치를 늘리지 않습니다.",
        },
        {
          title: "월간·연간 구독과 자동 갱신",
          body: "Pro와 Max는 Stripe가 처리하는 정기 구독입니다. 월간 구독은 매월 선결제 후 매월 자동 갱신되고, 연간 구독은 1년분을 선결제한 후 매년 자동 갱신됩니다. 다음 갱신 전에 취소하지 않으면 결제 화면에 표시된 금액과 통화로 저장된 결제수단에 청구하는 데 동의한 것으로 봅니다. 중대한 가격 변경은 법이 요구하는 경우 합리적인 기간 전에 안내하며, 적용 전에 취소할 수 있습니다.",
        },
        {
          title: "프로모션과 연간 할인",
          body: "프로모션은 해당 코드에 표시된 플랜, 결제 주기, 적용 기간, 최대 사용 횟수 및 종료일에만 적용됩니다. 특정 프로모션에서 중복 적용을 명시적으로 허용하지 않는 한 연간 플랜 할인과 중복되지 않습니다. 기간 한정 프로모션이 끝나면 취소하지 않는 한 안내된 정가로 갱신됩니다. 할인 금액 자체에는 별도의 현금 가치가 없습니다.",
        },
        {
          title: "구독 취소와 유료 서비스 종료 시점",
          body: "계정의 결제 관리 영역에서 구독 취소를 예약할 수 있습니다. 취소는 다음 자동 갱신을 중단하며 일반적으로 유료 접근을 즉시 종료하지 않습니다. 현재 월간 또는 연간 결제 기간이 끝날 때까지 유료 기능을 사용할 수 있고, 이후 사용 가능한 Free 플랜으로 전환됩니다. 중도 해지 수수료는 없으며 단순 취소만으로 자동 일할 환불이 발생하지 않습니다. 환불 승인 또는 중대한 위반에 따른 종료 시에는 유료 접근이 더 일찍 끝날 수 있습니다. 구독을 취소하거나 하위 플랜으로 변경해도 유효한 추가 크레딧은 그 자체로 소멸하지 않고 표시된 만료일까지 유지되지만, 변경 후 현재 플랜의 모델 접근권한, 기능, 일일 제한 및 안전장치 안에서만 사용할 수 있습니다.",
        },
        {
          title: "환불과 제공자 장애",
          body: "구독 및 추가 크레딧 환불 요청에는 tomverse.app/refund의 환불 정책과 법률상 배제할 수 없는 권리가 적용됩니다. AI 제공자 요청이 실패하거나 빈 응답으로 끝나면 예약된 크레딧은 일반적으로 자동 복원됩니다. 사용자가 취소하기 전에 사용 가능한 출력이 이미 생성된 경우에는 실제 생성량에 비례한 크레딧이 차감될 수 있습니다. 추가 크레딧의 전액·부분 환불이 승인되거나 차지백이 발생하면 해당 비율의 크레딧 권리가 취소됩니다. 남은 크레딧을 먼저 회수하고 이미 사용되어 회수할 수 없는 부분은 크레딧 부채로 기록해 이후 월 크레딧 또는 추가 크레딧 지급분에서 우선 상계할 수 있으며, 결제 분쟁이 해결될 때까지 사용을 임시 제한할 수 있습니다. 장애로 크레딧이 잘못 차감된 것으로 보이면 추적 ID와 함께 지원팀에 문의해주세요.",
        },
        {
          title: "세금, 환율 및 결제 통화",
          body: "결제 전 표시되는 현지 통화 금액은 참고용 환산값입니다. 최종 확인 전 Stripe 결제 화면에 표시된 금액, 결제 주기, 통화 및 적용 세금이 실제 거래 기준입니다. 은행, 카드사, 지갑 또는 결제 제공자가 자체 환율이나 수수료를 적용할 수 있습니다. Tomverse는 전체 카드 정보를 직접 저장하지 않습니다.",
        },
        {
          title: "허용되는 사용과 콘텐츠 권리",
          body: "법 위반, 권리 침해, 제공자 남용, 한도 우회, 악성 콘텐츠 업로드 또는 권한 없는 데이터 처리를 위해 Tomverse를 사용해서는 안 됩니다. 사용자는 자신이 보유한 입력 콘텐츠의 권리를 유지하며, 요청한 기능 수행과 선택한 AI 제공자에게 필요한 맥락을 전송하는 데 필요한 제한적 처리 권한을 Tomverse에 부여합니다.",
        },
        {
          title: "소비자 권리, 준거법 및 분쟁 처리",
          body: "본 약관은 호주 소비자법을 포함해 법률상 배제할 수 없는 보증, 구제수단 또는 권리를 제한하지 않습니다. 법이 허용하는 범위에서 본 약관에는 호주 퀸즐랜드주 법률이 적용됩니다. 분쟁이 발생하면 먼저 지원팀에 문의해 해결을 시도할 수 있으며, 이는 관할 규제기관, 재판소 또는 법원에 문제를 제기할 권리를 제한하지 않습니다.",
        },
      ],
      cta: { label: "지원팀에 문의", href: "/support" },
    },
    zh: {
      eyebrow: "法律",
      title: "条款与条件",
      description: "这些条款适用于 Tomverse AI 的免费和付费服务，包括账户、AI 提供商、订阅、月度积分、附加积分、取消和争议。",
      updated: "最后更新：2026 年 7 月 15 日",
      sections: [
        { title: "协议、运营方和联系方式", body: "Tomverse AI 是 tomverse.app 使用的服务和运营名称（‘Tomverse’或‘我们’）。付费交易的法定销售方或合同运营方，是相应 Stripe 结账页、收据或发票上标明的实体。账单和法律通知可发送至 support@tomverse.app，或通过 tomverse.app/support 的支持表单提交。" },
        { title: "账户和服务使用", body: "你必须提供准确的账户信息、保护账户访问，并对账户活动、提示词、上传文件以及使用或分享的内容负责。为处理滥用、安全风险、未付款、法律要求或重大违约，我们可在合理必要范围内限制、暂停或终止访问。" },
        { title: "第三方 AI 提供商和输出", body: "Tomverse 会把提示词和所选上下文发送给第三方 AI 提供商并显示其响应。AI 输出可能不准确、不完整、过时、不安全或不适合你的情况，也不构成法律、医疗、金融、安全或其他专业建议。" },
        { title: "方案、AI 积分和公平使用", body: "Free、Pro 和 Max 适用价格页及账户页显示的功能和月度积分额度。积分消耗因模型、推理方式和输入规模而异。月度积分在每个自然月开始时按 UTC 重置，不结转、不可转让且无现金价值。公平使用、防滥用、模型、提供商成本、文件和上下文限制仍然适用。" },
        { title: "附加积分包", body: "附加积分包是与订阅及其月度积分分开的单次购买。附加积分自购买之日起 12 个月（365 天）后到期，不可转让，也不可兑换现金。Tomverse 先扣除可用的月度方案积分，再按最早到期顺序扣除附加积分。积分包只增加可用积分余额，不会升级方案，也不会增加模型访问、功能、每日限制、方案特定的高成本模型限制、公平使用限制或其他保障。" },
        { title: "月付、年付和自动续订", body: "Pro 和 Max 是由 Stripe 处理的定期订阅。月付按月预付并每月续订；年付按年预付并每年续订。除非你在下次续订前取消，否则即授权 Stripe 按结账时显示的金额和币种向已保存的付款方式收费。" },
        { title: "促销和年付折扣", body: "促销仅适用于该代码披露的方案、计费周期、期限、兑换上限和到期日。除非特定促销明确允许，否则不与年付折扣叠加。限时促销结束后，订阅会按已披露的常规价格续订，除非取消。折扣本身没有现金价值。" },
        { title: "取消和付费访问结束", body: "你可以在账户的账单控制中安排取消。取消会停止下一次自动续订，通常不会立即终止访问。付费功能持续到当前月度或年度周期结束，之后账户转为可用的 Free 方案。没有提前解约费，单纯取消不会自动产生按比例退款。取消或降级订阅本身不会删除仍有效的附加积分；积分保留至标示的到期日，但只能在账户届时方案的模型访问、功能、每日限制和保障范围内使用。" },
        { title: "退款和提供商故障", body: "订阅和附加积分退款请求适用 tomverse.app/refund 的退款政策及法律不得排除的权利。提供商请求失败或返回空响应时，预留积分通常会自动释放；如果用户取消前已生成可用输出，可能按实际生成量扣除积分。附加积分的全部或部分退款获批，或发生拒付时，相应比例的积分权益会被撤销。系统先收回可用积分；已使用而无法收回的部分可记为积分债务，并从未来月度积分或附加积分发放中优先抵扣，付款争议未解决期间也可临时限制访问。若故障似乎错误消耗了积分，请附上 trace ID 联系支持。" },
        { title: "币种、税费和付款处理", body: "结账前显示的本地币种换算仅供参考。Stripe 最终确认页显示的金额、计费周期、币种和适用税费是交易依据。银行、发卡机构、钱包或付款服务商可能使用自己的汇率或收取费用。Tomverse 不直接存储完整银行卡信息。" },
        { title: "消费者权利、适用法律和争议", body: "本条款不排除法律不得排除的保证、救济或其他权利，包括可能适用的澳大利亚消费者法权利。在法律允许的范围内，本条款受澳大利亚昆士兰州法律管辖。请先联系支持尝试解决争议；这不限制你联系有管辖权的监管机构、仲裁庭或法院。" },
      ],
      cta: { label: "联系支持", href: "/support" },
    },
  },
  refund: {
    en: {
      eyebrow: "Billing",
      title: "Refund Policy",
      description: "Refund, billing correction, cancellation, subscription-credit, additional-credit, promotion, and provider-incident rules for Tomverse purchases.",
      updated: "Last updated: July 15, 2026",
      sections: [
        {
          title: "Scope and non-excludable consumer rights",
          body: "This policy applies to Pro and Max subscriptions and to one-time additional credit packs purchased through Tomverse and processed by Stripe, including a Starter Credit Pack purchased by a Free-plan user. It does not exclude remedies or guarantees that cannot be excluded by law. Where the Australian Consumer Law applies, you may be entitled to cancellation, a refund for an unused portion, correction, or compensation for a major service failure or another failure that is not remedied within a reasonable time.",
        },
        {
          title: "When a refund or billing correction may be available",
          body: "We will review requests involving duplicate, unauthorised, or incorrect charges; a paid plan or purchased credit pack that was not delivered; a material service failure; or another circumstance where a refund is required by law. We may also approve a discretionary full or partial refund after considering when the charge occurred, the billing interval or pack, how much paid entitlement was used, and the facts supplied.",
          bullets: ["Duplicate, unauthorised, or incorrect charge", "Paid access or purchased credits not delivered, or a material service failure", "A remedy required by applicable consumer law"],
        },
        {
          title: "When a refund is generally not available",
          body: "Except where required by law, refunds are generally not provided for a change of mind, forgetting to cancel before renewal, dissatisfaction with the style or content of a valid AI response, unused time after a normal cancellation, unused monthly credits, or merely leaving purchased additional credits unused after they were correctly issued. Submitting a request does not guarantee approval and does not itself cancel a subscription or credit-pack entitlement.",
        },
        {
          title: "Monthly and annual cancellation",
          body: "Cancellation from the account area stops the next renewal. A monthly subscription normally remains active through the current paid month; an annual subscription normally remains active through the current paid year. Cancellation alone does not produce an automatic prorated refund. If a refund is approved, the current implementation cancels the paid subscription and moves the account to Free when the approval is processed.",
        },
        {
          title: "Monthly credits and additional credits",
          body: "AI credits are a service allowance, not stored money. Monthly plan credits reset each calendar month in UTC, do not roll over, and remain tied to the applicable plan period. Additional credits are a separate one-time purchase, expire 12 months (365 days) after purchase, and do not reset with the monthly allowance. Both balances are non-transferable and cannot be redeemed for cash. Tomverse deducts available monthly plan credits first and then additional-credit lots in order of earliest expiry.",
        },
        {
          title: "Plan cancellation and additional-credit access",
          body: "Cancelling or downgrading Pro or Max does not by itself remove valid additional credits. They remain on the account until their stated expiry, including after the account moves to Free. Additional credits increase usage capacity only: they do not unlock a higher plan, models, files or other features, and they do not increase daily limits, plan-specific higher-cost model limits, fair-use limits, or other safeguards. They can be used only within the permissions and limits of the account's current plan.",
        },
        {
          title: "Additional-credit refunds, partial refunds, and chargebacks",
          body: "If a full or partial refund is approved, Tomverse reverses the corresponding proportion of the purchased additional-credit entitlement. Available additional credits from the purchase are revoked first. If some of that entitlement has already been used and cannot be recovered, the unrecovered credits and associated funded usage allowance may be recorded as credit debt and offset before future monthly credits or additional-credit purchases are made available. A chargeback or payment dispute may trigger the same provisional reversal and a temporary restriction on AI use while the dispute is unresolved. If the dispute is resolved in the purchaser's favour, the related provisional revocation and debt are restored or cleared to the extent recorded by the system. These rules do not limit rights or remedies that cannot be excluded by law.",
        },
        {
          title: "Promotional purchases",
          body: "Any approved refund is limited to the amount actually paid after the promotion; the undiscounted price and the discount itself are not refundable. A zero-dollar promotion has no cash refund value. Unless required by law or caused by a Tomverse billing error, a used or refunded promotion code is not guaranteed to be reissued. Promotion and annual-plan discounts stack only when the specific promotion expressly allows it.",
        },
        {
          title: "Provider incidents and credit restoration",
          body: "When an AI provider request fails before a usable answer or returns empty, Tomverse normally releases the reserved credits automatically. If you cancel after usable output has begun, a proportionate credit charge may remain. Provider downtime does not automatically create a cash refund, but a material unresolved service failure may qualify for a remedy under this policy or applicable law. Send the trace ID to support if credits appear incorrect.",
        },
        {
          title: "Taxes, exchange rates, and payment currency",
          body: "Refunds cannot exceed the amount and currency actually captured by Stripe. Local price estimates may differ from the final amount because Stripe, your bank, card issuer, wallet, or payment provider may apply taxes, exchange rates, or fees. The Stripe receipt or invoice is the record of the captured amount and merchant identity. Third-party exchange or payment fees are governed by that provider.",
        },
        {
          title: "How to request and how we process it",
          body: "Subscription and credit-pack purchasers can submit a refund review from the account billing area or contact support@tomverse.app. Include the account email, plan, pack if applicable, charge date, transaction or receipt reference, reason, and any trace ID. Requests are reviewed individually. If approved, Tomverse submits the eligible refund to Stripe. A subscription refund may cancel or downgrade the related paid plan; a credit-pack refund reverses only the corresponding pack entitlement and does not by itself cancel a subscription. The time for funds to appear depends on Stripe and the payment provider.",
        },
        {
          title: "Operator and disputes",
          body: "Tomverse AI operates tomverse.app, and the legal seller for a transaction is identified on its Stripe receipt or invoice. Questions or disputes can be sent to support@tomverse.app or tomverse.app/support. You may also use any regulator, tribunal, or court process available under applicable law.",
        },
      ],
      cta: { label: "Contact billing support", href: "/support" },
    },
    ko: {
      eyebrow: "결제",
      title: "환불 정책",
      description: "Tomverse 구독 및 추가 크레딧 구매의 환불, 오청구 정정, 취소, 크레딧, 프로모션 및 제공자 장애 처리 기준입니다.",
      updated: "최종 업데이트: 2026년 7월 15일",
      sections: [
        {
          title: "적용 범위와 배제할 수 없는 소비자 권리",
          body: "본 정책은 Tomverse에서 구매하고 Stripe가 처리한 Pro·Max 구독과 일회성 추가 크레딧 팩에 적용되며, Free 플랜 사용자가 구매한 Starter Credit Pack도 포함합니다. 본 정책은 법률상 배제할 수 없는 보증이나 구제수단을 제한하지 않습니다. 호주 소비자법이 적용되는 경우 중대한 서비스 실패 또는 합리적인 기간 안에 해결되지 않은 문제에 대해 계약 취소, 미사용 부분 환불, 문제 시정 또는 손해 배상을 받을 권리가 있을 수 있습니다.",
        },
        {
          title: "환불 또는 결제 정정이 가능한 경우",
          body: "중복·무단·오청구, 결제한 플랜 또는 구매한 크레딧 팩이 지급되지 않은 경우, 중대한 서비스 실패 또는 법률상 환불이 필요한 사유는 검토 후 정정하거나 환불합니다. 그 밖의 요청도 결제 시점, 월간·연간 결제 주기 또는 팩, 사용한 유료 권리의 양 및 제출된 사실관계를 고려해 전액 또는 부분 환불을 재량으로 승인할 수 있습니다.",
          bullets: ["중복, 무단 또는 잘못된 금액의 청구", "유료 접근 또는 구매 크레딧 미지급, 혹은 중대한 서비스 실패", "적용되는 소비자법이 요구하는 구제"],
        },
        {
          title: "일반적으로 환불되지 않는 경우",
          body: "법률상 환불이 필요한 경우를 제외하고, 단순 변심, 갱신 전 취소를 잊은 경우, 정상 생성된 AI 답변의 문체·내용에 대한 불만, 일반 취소 후 남은 기간, 사용하지 않은 월 크레딧 또는 정상 지급된 추가 크레딧을 단순히 사용하지 않은 경우는 원칙적으로 환불 대상이 아닙니다. 환불 요청 제출은 승인을 보장하지 않으며 그 자체로 구독이나 크레딧 팩 권리를 취소하지 않습니다.",
        },
        {
          title: "월간·연간 구독 취소",
          body: "계정 영역에서 취소하면 다음 갱신이 중단됩니다. 월간 구독은 일반적으로 현재 결제 월 말까지, 연간 구독은 현재 결제 연도 말까지 유지됩니다. 단순 취소로 자동 일할 환불이 발생하지 않습니다. 환불이 승인되면 현재 시스템은 승인 처리 시 유료 구독을 취소하고 계정을 Free로 전환합니다.",
        },
        {
          title: "월 크레딧과 추가 크레딧",
          body: "AI 크레딧은 예치금이 아닌 서비스 사용 한도입니다. 월 플랜 크레딧은 매월 1일 00:00 UTC에 초기화되고 이월되지 않으며 해당 플랜 기간에 귀속됩니다. 추가 크레딧은 월 크레딧과 분리된 일회성 구매분으로, 구매일로부터 12개월(365일) 후 만료되고 월 초기화 때 사라지지 않습니다. 두 잔액 모두 양도하거나 현금으로 교환할 수 없습니다. Tomverse는 사용 가능한 월 플랜 크레딧을 먼저 차감한 뒤 만료일이 빠른 추가 크레딧 묶음부터 차감합니다.",
        },
        {
          title: "플랜 해지 후 추가 크레딧 이용",
          body: "Pro 또는 Max를 취소하거나 하위 플랜으로 변경해도 유효한 추가 크레딧은 그 자체로 소멸하지 않으며, 계정이 Free로 전환된 뒤에도 표시된 만료일까지 유지됩니다. 추가 크레딧은 사용량만 늘리고 상위 플랜, 모델, 파일 등 기능을 해제하지 않으며, 일일 제한, 플랜별 고비용 모델 제한, 공정사용 한도 또는 기타 안전장치를 늘리지 않습니다. 항상 계정의 현재 플랜 권한과 제한 안에서만 사용할 수 있습니다.",
        },
        {
          title: "추가 크레딧의 전액·부분 환불 및 차지백",
          body: "추가 크레딧의 전액 또는 부분 환불이 승인되면 해당 구매에서 환불 비율에 해당하는 크레딧 권리를 취소합니다. 먼저 그 구매에서 남아 있는 추가 크레딧을 회수합니다. 이미 사용해 회수할 수 없는 권리와 관련 원가 한도는 크레딧 부채로 기록하고, 이후 월 크레딧 또는 추가 크레딧 구매분을 제공하기 전에 우선 상계할 수 있습니다. 차지백 또는 결제 분쟁에도 같은 임시 회수와 상계가 적용될 수 있고, 분쟁이 해결될 때까지 AI 사용을 임시 제한할 수 있습니다. 구매자에게 유리하게 분쟁이 종결되면 시스템에 기록된 범위에서 관련 임시 회수분과 부채를 복원하거나 해제합니다. 이 기준은 법률상 배제할 수 없는 권리나 구제수단을 제한하지 않습니다.",
        },
        {
          title: "프로모션 결제",
          body: "승인된 환불은 프로모션 적용 후 실제 결제한 금액을 초과할 수 없으며 정가와의 차액이나 할인 자체는 환불되지 않습니다. 100% 할인 결제에는 현금 환불 가치가 없습니다. 법률상 필요하거나 Tomverse 결제 오류가 원인인 경우를 제외하면 사용했거나 환불된 프로모션 코드의 재발급은 보장되지 않습니다. 연간 할인과 프로모션은 해당 코드가 명시적으로 허용한 경우에만 중복됩니다.",
        },
        {
          title: "AI 제공자 장애와 크레딧 복원",
          body: "AI 제공자 요청이 사용 가능한 답변을 만들기 전에 실패하거나 빈 응답을 반환하면 Tomverse는 일반적으로 예약 크레딧을 자동 복원합니다. 사용 가능한 출력이 시작된 후 사용자가 취소하면 생성량에 비례한 크레딧이 남을 수 있습니다. 제공자 장애가 곧바로 현금 환불을 발생시키지는 않지만, 해결되지 않은 중대한 서비스 실패는 본 정책 또는 적용 법률에 따른 구제 대상이 될 수 있습니다. 크레딧이 잘못 차감된 것으로 보이면 추적 ID를 보내주세요.",
        },
        {
          title: "세금, 환율 및 결제 통화",
          body: "환불액은 Stripe가 실제 승인한 금액과 통화를 초과할 수 없습니다. 현지 가격 환산값은 Stripe, 은행, 카드사, 지갑 또는 결제 제공자가 적용하는 세금, 환율이나 수수료로 인해 최종 금액과 다를 수 있습니다. 실제 결제 금액과 판매자 정보는 Stripe 영수증 또는 인보이스를 기준으로 합니다. 제3자의 환전·결제 수수료에는 해당 제공자 정책이 적용됩니다.",
        },
        {
          title: "환불 요청 및 처리 절차",
          body: "구독 또는 크레딧 팩 구매자는 계정 결제 영역에서 환불 심사를 요청하거나 support@tomverse.app으로 문의할 수 있습니다. 계정 이메일, 플랜, 해당하는 경우 팩 이름, 결제일, 거래 또는 영수증 번호, 사유 및 관련 추적 ID를 포함해주세요. 요청은 개별 심사됩니다. 승인되면 Tomverse가 Stripe에 환불을 제출합니다. 구독 환불은 관련 유료 플랜을 취소하거나 하향 전환할 수 있고, 크레딧 팩 환불은 해당 팩 권리만 취소하며 그 자체로 구독을 취소하지 않습니다. 실제 입금 시점은 Stripe와 결제 제공자 처리 기간에 따라 달라집니다.",
        },
        {
          title: "운영 주체와 분쟁",
          body: "Tomverse AI는 tomverse.app을 운영하며 각 거래의 법적 판매자는 Stripe 영수증 또는 인보이스에 표시됩니다. 문의나 분쟁은 support@tomverse.app 또는 tomverse.app/support로 접수할 수 있고, 적용 법률에 따라 이용 가능한 규제기관, 재판소 또는 법원 절차를 이용할 수 있습니다.",
        },
      ],
      cta: { label: "결제 지원 문의", href: "/support" },
    },
    zh: {
      eyebrow: "账单",
      title: "退款政策",
      description: "适用于 Tomverse 订阅和附加积分购买的退款、账单更正、取消、积分、促销和提供商故障规则。",
      updated: "最后更新：2026 年 7 月 15 日",
      sections: [
        { title: "范围和不可排除的消费者权利", body: "本政策适用于通过 Tomverse 购买并由 Stripe 处理的 Pro、Max 订阅和一次性附加积分包，包括 Free 方案用户购买的 Starter Credit Pack。本政策不排除法律不得排除的保证或救济。在澳大利亚消费者法适用时，重大服务故障或未在合理时间内纠正的问题可能使你有权取消、获得未使用部分退款、纠正或赔偿。" },
        { title: "可能退款或更正账单的情况", body: "我们会审查重复、未授权或错误收费；付费方案或购买的积分包未交付；重大服务故障；或法律要求退款的情况。其他请求可根据收费时间、计费周期或积分包、已使用的付费权益及提交的事实，酌情批准全部或部分退款。", bullets: ["重复、未授权或错误收费", "未提供付费访问或购买的积分，或发生重大服务故障", "适用消费者法要求的救济"] },
        { title: "通常不退款的情况", body: "除非法律要求，改变主意、忘记在续订前取消、对有效 AI 回答的风格或内容不满意、正常取消后的未使用时间、未使用月度积分，或正确发放后仅未使用的附加积分，通常不予退款。提交请求不保证批准，也不会自动取消订阅或积分包权益。" },
        { title: "月付和年付取消", body: "账户区域取消会停止下一次续订。月付通常持续到当前付费月结束，年付持续到当前付费年结束。取消本身不会自动按比例退款。批准退款时，当前系统会取消付费订阅并把账户转为 Free。" },
        { title: "月度积分和附加积分", body: "AI 积分是服务额度，不是储值资金。月度方案积分按 UTC 在每个自然月开始时重置，不结转，并归属于相应方案周期。附加积分是独立的一次性购买，自购买之日起 12 个月（365 天）后到期，不会随月度额度重置。两种余额均不可转让或兑换现金。Tomverse 先扣除可用月度方案积分，再按最早到期顺序扣除附加积分。" },
        { title: "取消方案后的附加积分", body: "取消或降级 Pro、Max 本身不会删除仍有效的附加积分。即使账户转为 Free，积分仍保留至标示的到期日。附加积分只增加用量，不会解锁更高方案、模型、文件或其他功能，也不会提高每日限制、方案特定的高成本模型限制、公平使用限制或其他保障；只能在账户当前方案的权限和限制内使用。" },
        { title: "附加积分的全额退款、部分退款和拒付", body: "附加积分的全部或部分退款获批时，Tomverse 会按相应比例撤销购买权益，并先收回该购买中尚未使用的积分。已经使用而无法收回的积分及相关资助用量可记为积分债务，并在未来月度积分或附加积分购买可用前优先抵扣。拒付或付款争议可触发相同的临时撤销，并在争议未解决期间临时限制 AI 使用。若争议最终对购买者有利，系统会在记录范围内恢复或清除相关临时撤销和债务。本规则不限制法律不得排除的权利或救济。" },
        { title: "促销购买", body: "获批退款不超过促销后实际支付的金额；原价差额和折扣本身不退款。零元促销没有现金退款价值。除法律要求或 Tomverse 账单错误外，不保证重新发放已使用或已退款的促销代码。" },
        { title: "提供商故障和积分恢复", body: "AI 提供商在生成可用回答前失败或返回空响应时，Tomverse 通常会自动释放预留积分。可用输出开始后由用户取消时，可能保留按生成量计算的积分消耗。若积分似乎错误扣除，请附 trace ID 联系支持。" },
        { title: "税费、汇率和付款币种", body: "退款不超过 Stripe 实际收取的金额和币种。本地价格换算可能因税费、汇率或第三方费用与最终金额不同。实际金额和销售方身份以 Stripe 收据或发票为准。" },
        { title: "如何申请和处理", body: "订阅或积分包购买者可从账户账单区域申请退款审查，或联系 support@tomverse.app。请提供账户邮箱、方案、适用时的积分包名称、收费日期、交易或收据编号、原因和相关 trace ID。批准后，Tomverse 会向 Stripe 提交退款。订阅退款可能取消或降级相关付费方案；积分包退款只撤销对应积分包权益，不会因此自动取消订阅。到账时间取决于 Stripe 和付款服务商。" },
        { title: "运营方和争议", body: "Tomverse AI 运营 tomverse.app，每笔交易的法定销售方标示在 Stripe 收据或发票上。问题或争议可发送至 support@tomverse.app 或 tomverse.app/support，也可使用适用法律提供的监管机构、仲裁庭或法院程序。" },
      ],
      cta: { label: "联系账单支持", href: "/support" },
    },
  },
  safety: {
    en: {
      eyebrow: "Safety",
      title: "Safety at Tomverse",
      description: "Our safety work focuses on access control, usage limits, secure file handling, privacy-aware product design, and transparent AI limitations.",
      sections: [
        { title: "Safety Approach", body: "We design controls before scale: model access tiers, rate limits, file validation, security headers, and public sharing safeguards.", bullets: ["Model and quota controls", "Attachment validation", "Locked and private conversation modes"] },
        { title: "Security & Privacy", body: "Tomverse separates account access, conversation storage, temporary attachments, and public sharing snapshots to reduce accidental exposure.", bullets: ["Private Mode does not save Tomverse chat history", "Locked conversations require unlock grants", "Public shares are read-only snapshots"] },
        { title: "Trust & Transparency", body: "We communicate model limitations, provider involvement, and data handling clearly so users understand what the product does and does not do." },
      ],
    },
    ko: {
      eyebrow: "안전",
      title: "Tomverse의 안전 원칙",
      description: "Tomverse는 접근 제어, 사용량 제한, 안전한 파일 처리, 개인정보를 고려한 제품 설계, AI 한계의 투명한 안내에 집중합니다.",
      sections: [
        { title: "Safety Approach", body: "확장 전에 통제 장치를 먼저 설계합니다. 모델 권한, 사용량 제한, 파일 검증, 보안 헤더, 공개 공유 보호가 포함됩니다.", bullets: ["모델 및 할당량 통제", "첨부파일 검증", "잠금 대화와 Private Mode"] },
        { title: "Security & Privacy", body: "계정 접근, 대화 저장, 임시 첨부파일, 공개 공유 스냅샷을 분리해 의도치 않은 노출을 줄입니다.", bullets: ["Private Mode는 Tomverse 대화 기록을 저장하지 않음", "잠긴 대화는 잠금 해제 권한 필요", "공개 공유는 읽기 전용 스냅샷"] },
        { title: "Trust & Transparency", body: "모델의 한계, AI 공급자 관여, 데이터 처리 방식을 명확히 안내해 사용자가 제품의 범위를 이해하도록 돕습니다." },
      ],
    },
    zh: {
      eyebrow: "安全",
      title: "Tomverse 的安全原则",
      description: "我们的安全工作聚焦于访问控制、用量限制、安全文件处理、注重隐私的产品设计和透明的 AI 限制说明。",
      sections: [
        { title: "Safety Approach", body: "在规模化之前先设计控制措施：模型访问等级、速率限制、文件验证、安全标头和公开分享保护。", bullets: ["模型与额度控制", "附件验证", "锁定对话和 Private Mode"] },
        { title: "Security & Privacy", body: "Tomverse 将账户访问、对话存储、临时附件和公开分享快照分离，以减少意外暴露。", bullets: ["Private Mode 不保存 Tomverse 聊天历史", "锁定对话需要解锁授权", "公开分享是只读快照"] },
        { title: "Trust & Transparency", body: "我们清楚说明模型限制、供应商参与和数据处理方式，帮助用户理解产品能做什么、不能做什么。" },
      ],
    },
  },
  about: {
    en: {
      eyebrow: "Company",
      title: "About Tomverse AI",
      description: "Tomverse AI is built for people who want to compare the fast-moving AI model market without rebuilding their workflow every week.",
      sections: [
        { title: "Our mission", body: "Make AI model choice practical, transparent, and useful for everyday work." },
        { title: "Product philosophy", body: "We prefer calm, focused tools over flashy demos: compare models, use real context, protect sensitive conversations, and keep useful outputs portable." },
        { title: "Plans and operations", body: "Tomverse currently offers Free, Pro, and Max plans, with monthly and annual paid subscriptions processed through Stripe. We continue to improve account controls, provider coverage, reliability, and support workflows for individual and commercial users." },
        { title: "Operator and contact", body: "Tomverse AI is the service and operating name for tomverse.app. The legal seller for a paid transaction is identified on the Stripe Checkout page, receipt, or invoice. Contact support@tomverse.app or use tomverse.app/support for account, billing, legal, or product enquiries." },
      ],
    },
    ko: {
      eyebrow: "회사",
      title: "Tomverse AI 소개",
      description: "Tomverse AI는 빠르게 변하는 AI 모델 시장을 매주 새로 익히지 않아도 비교하고 활용할 수 있게 만든 제품입니다.",
      sections: [
        { title: "미션", body: "AI 모델 선택을 실용적이고 투명하며 일상 업무에 도움이 되는 경험으로 만드는 것입니다." },
        { title: "제품 철학", body: "화려한 데모보다 차분하고 집중된 도구를 지향합니다. 모델 비교, 실제 맥락 활용, 민감한 대화 보호, 결과물 이동성을 중요하게 봅니다." },
        { title: "플랜과 운영", body: "Tomverse는 현재 Free, Pro, Max 플랜을 제공하며 월간·연간 유료 구독은 Stripe를 통해 처리됩니다. 개인 및 상업 사용자를 위해 계정 제어, 제공자 범위, 안정성과 지원 흐름을 계속 개선하고 있습니다." },
        { title: "운영 주체와 연락처", body: "Tomverse AI는 tomverse.app의 서비스 및 운영 명칭입니다. 유료 거래의 법적 판매자는 Stripe 결제 화면, 영수증 또는 인보이스에 표시됩니다. 계정, 결제, 법률 또는 제품 관련 문의는 support@tomverse.app 또는 tomverse.app/support로 접수할 수 있습니다." },
      ],
    },
    zh: {
      eyebrow: "公司",
      title: "关于 Tomverse AI",
      description: "Tomverse AI 面向希望比较快速变化的 AI 模型市场、但不想每周重建工作流程的用户。",
      sections: [
        { title: "我们的使命", body: "让 AI 模型选择更实用、更透明，并真正服务于日常工作。" },
        { title: "产品理念", body: "我们更偏好冷静、专注的工具，而不是炫目的演示：比较模型、使用真实上下文、保护敏感对话，并保持输出可移植。" },
        { title: "方案和运营", body: "Tomverse 目前提供 Free、Pro 和 Max 方案，月付和年付订阅由 Stripe 处理。我们会继续改进账户控制、提供商覆盖、可靠性以及面向个人和商业用户的支持流程。" },
        { title: "运营方和联系方式", body: "Tomverse AI 是 tomverse.app 的服务和运营名称。付费交易的法定销售方标示在 Stripe 结账页、收据或发票上。账户、账单、法律或产品问题可发送至 support@tomverse.app 或 tomverse.app/support。" },
      ],
    },
  },
  support: {
    en: {
      eyebrow: "Support",
      title: "Support",
      description: "Get help with accounts, model access, files, sharing, active subscriptions, cancellation, refunds, and product feedback.",
      sections: [
        { title: "Help Centre", body: "Start with the Help Centre for common setup and troubleshooting guidance.", bullets: ["Login and OAuth issues", "File upload troubleshooting", "Model access and limits"] },
        { title: "PDF and Office troubleshooting", body: "If a PDF or Office file fails, check that it is not password-protected, corrupted, too large, or a scanned image without extractable text. Re-exporting the document as PDF, reducing the file size, or pasting the key text directly often resolves the issue.", bullets: ["Images, PDFs, Office files, text files, and Google Drive files are supported after login.", "Guest mode does not support attachments.", "Attach up to 5 files, 10 MB each."] },
        { title: "Contact support", body: "For account-specific issues, include your account email, approximate time, browser, and any trace ID shown in the product." },
      ],
      cta: { label: "Open Help Centre", href: "/support/help-centre" },
    },
    ko: {
      eyebrow: "지원",
      title: "지원",
      description: "계정, 모델 접근, 파일, 공유, 유료 구독, 취소, 환불 및 제품 피드백에 대한 도움을 받을 수 있습니다.",
      sections: [
        { title: "Help Centre", body: "일반적인 설정과 문제 해결은 Help Centre에서 먼저 확인할 수 있습니다.", bullets: ["로그인 및 OAuth 문제", "파일 업로드 문제", "모델 접근과 제한"] },
        { title: "지원 문의", body: "계정별 문제는 계정 이메일, 발생 시간, 브라우저, 제품에 표시된 추적 ID를 함께 보내주시면 더 빠르게 확인할 수 있습니다." },
      ],
      cta: { label: "Help Centre 열기", href: "/support/help-centre" },
    },
    zh: {
      eyebrow: "支持",
      title: "支持",
      description: "获取账户、模型访问、文件、分享、付费订阅、取消、退款和产品反馈方面的帮助。",
      sections: [
        { title: "Help Centre", body: "常见设置和故障排查可先查看 Help Centre。", bullets: ["登录和 OAuth 问题", "文件上传排查", "模型访问和限制"] },
        { title: "联系支持", body: "对于账户相关问题，请提供账户邮箱、发生时间、浏览器以及产品中显示的追踪 ID。" },
      ],
      cta: { label: "打开 Help Centre", href: "/support/help-centre" },
    },
  },
  helpCentre: {
    en: {
      eyebrow: "Help Centre",
      title: "Help Centre",
      description: "Find practical guidance for account access, plans, model selection, attachments, sharing, privacy, billing, and support requests.",
      sections: [
        {
          title: "Getting started",
          body: "Tomverse lets you ask once, compare answers from multiple AI models, attach useful context, and keep the result organized in one workspace. Start with one model for simple questions or compare up to three models when you want different perspectives.",
          bullets: ["Use Start Chat to open the app.", "Choose models from the model picker before sending.", "Use projects, pins, and search to keep important conversations easy to find."],
        },
        {
          title: "Login and account access",
          body: "If login fails, retry from the same browser session, confirm that popups and third-party sign-in redirects are allowed, and check whether the provider account email matches an existing Tomverse account.",
          bullets: ["Google, Microsoft, and other OAuth providers may require verified callback settings.", "If you see an account-linking error, contact support with the provider name and account email.", "Account deletion permanently removes conversations, settings, and saved account data."],
        },
        {
          title: "Plans, limits, and upgrades",
          body: "Guest mode is intended for quick trials. Free, Pro, and Max plans unlock more model access and higher usage limits. If a model or feature is unavailable, the app will show the reason in the model picker or plan area.",
          bullets: ["Guest: 100 monthly and 20 daily credits, Standard usage-class models only, no attachments.", "Free: 300 monthly and 30 daily credits, with up to 30 selected higher-cost model responses.", "Pro: 3,000 monthly and 150 daily credits. Max: 10,000 monthly credits; Standard models have no daily limit, while Premium usage follows monthly credits and fair-use."],
        },
        {
          title: "Files and Google Drive",
          body: "Attachments work best when files are not password-protected, corrupted, or unusually large. If a PDF or Office document fails, re-export it, reduce the file size, or paste the key text directly into the prompt.",
          bullets: ["Supported after login: images, PDFs, Office files, text files, and Google Drive files.", "Guest mode does not support attachments.", "Attach up to 5 files, 10 MB each."],
        },
        {
          title: "Model responses and provider status",
          body: "Tomverse shows responses from external AI providers without editing the model output. Providers can temporarily limit a model, return an empty answer, or fail because of balance, rate limit, or service availability.",
          bullets: ["Try a recommended fallback model when one provider is limited.", "Remove attachments and retry if a file-specific error appears.", "Include the trace ID when contacting support."],
        },
        {
          title: "Sharing, downloads, and privacy",
          body: "Shared conversations are read-only snapshots. Private Mode means Tomverse does not save the conversation to the Tomverse database, but your prompt is still sent to the selected AI provider to generate an answer.",
          bullets: ["Use sharing only for content you are comfortable making available through the link.", "Locked conversations require unlock authorization before protected actions.", "Downloads export conversation content for your own records."],
        },
        {
          title: "Contact support",
          body: "If you still need help, send a written request from the support page. Include your account email, approximate time, browser, model name, whether files were attached, and any trace ID shown in the app. Phone support is not offered.",
        },
      ],
      cta: { label: "Contact support", href: "/support" },
    },
    ko: {
      eyebrow: "Help Centre",
      title: "Help Centre",
      description: "계정 접속, 플랜, 모델 선택, 첨부파일, 공유, 개인정보, 결제, 지원 요청에 필요한 실질적인 안내를 확인하세요.",
      sections: [
        {
          title: "처음 시작하기",
          body: "Tomverse는 한 번 질문하고 여러 AI 모델의 답변을 비교하며, 필요한 파일 맥락을 첨부하고, 유용한 결과를 하나의 워크스페이스에 정리할 수 있도록 돕습니다. 간단한 질문은 한 모델로 시작하고, 다양한 관점이 필요할 때는 최대 세 개 모델을 비교하세요.",
          bullets: ["앱 열기 또는 대화 시작으로 채팅 화면을 엽니다.", "질문을 보내기 전에 모델 선택창에서 원하는 모델을 고릅니다.", "프로젝트, 고정, 검색 기능으로 중요한 대화를 쉽게 다시 찾을 수 있습니다."],
        },
        {
          title: "로그인과 계정 접근",
          body: "로그인이 실패하면 같은 브라우저 세션에서 다시 시도하고, 팝업과 외부 로그인 리다이렉트가 허용되어 있는지 확인하세요. 로그인 제공자의 이메일이 기존 Tomverse 계정과 같은지도 확인하는 것이 좋습니다.",
          bullets: ["Google, Microsoft 등 OAuth 제공자는 올바른 callback 설정이 필요할 수 있습니다.", "계정 연결 오류가 보이면 제공자 이름과 계정 이메일을 포함해 지원팀에 문의하세요.", "계정 삭제는 대화, 설정, 저장된 계정 데이터를 영구 삭제합니다."],
        },
        {
          title: "플랜, 제한, 업그레이드",
          body: "게스트 모드는 빠른 체험용입니다. Free, Pro, Max 플랜은 더 넓은 모델 접근과 더 높은 사용량을 제공합니다. 모델이나 기능이 제한되면 모델 선택창 또는 플랜 영역에서 이유를 확인할 수 있습니다.",
          bullets: ["Guest: 월 100 · 일 20 크레딧, Standard 사용량 클래스 모델만 사용, 첨부파일 불가.", "Free: 월 300 · 일 30 크레딧, 선별된 고비용 모델 월 30응답.", "Pro: 월 3,000 · 일 150 크레딧. Max: 월 10,000 크레딧, Standard 모델 일일 제한 없음, Premium 사용량은 월 크레딧 및 공정사용 정책 적용."],
        },
        {
          title: "파일과 Google Drive",
          body: "첨부파일은 암호가 걸려 있지 않고, 손상되지 않았으며, 크기가 너무 크지 않을 때 가장 안정적으로 작동합니다. PDF나 Office 문서가 실패하면 다시 내보내기, 파일 크기 줄이기, 핵심 텍스트 직접 붙여넣기를 시도하세요.",
          bullets: ["로그인 후 이미지, PDF, Office 파일, 텍스트 파일, Google Drive 파일을 사용할 수 있습니다.", "게스트 모드는 첨부파일을 지원하지 않습니다.", "파일은 최대 5개, 각 10MB까지 첨부할 수 있습니다."],
        },
        {
          title: "모델 응답과 Provider 상태",
          body: "Tomverse는 외부 AI 제공자의 답변을 중간 편집 없이 보여줍니다. 제공자는 일시적으로 모델을 제한하거나, 빈 답변을 반환하거나, 잔액·rate limit·서비스 상태 때문에 실패할 수 있습니다.",
          bullets: ["특정 모델이 제한되면 추천 대체 모델로 다시 시도하세요.", "파일 관련 오류가 나오면 첨부파일 없이 다시 시도해 보세요.", "지원팀에 문의할 때는 화면에 표시된 추적 ID를 함께 보내주세요."],
        },
        {
          title: "공유, 다운로드, 개인정보",
          body: "공유된 대화는 읽기 전용 스냅샷입니다. Private Mode는 Tomverse 데이터베이스에 대화를 저장하지 않는다는 뜻이며, 답변 생성을 위해 선택한 AI 제공자에게 프롬프트는 전송됩니다.",
          bullets: ["공유 링크는 외부에 보여도 괜찮은 내용에만 사용하세요.", "잠긴 대화는 보호된 작업 전에 잠금 해제 권한이 필요합니다.", "다운로드는 본인 보관용으로 대화 내용을 내보냅니다."],
        },
        {
          title: "지원팀에 문의하기",
          body: "도움이 더 필요하면 지원 페이지에서 문의를 보내주세요. 계정 이메일, 발생 시간, 브라우저, 모델명, 첨부파일 여부, 앱에 표시된 추적 ID를 포함하면 더 빠르게 확인할 수 있습니다. 전화 상담은 제공하지 않습니다.",
        },
      ],
      cta: { label: "지원팀에 문의하기", href: "/support" },
    },
    zh: {
      eyebrow: "Help Centre",
      title: "Help Centre",
      description: "查看账户访问、套餐、模型选择、附件、分享、隐私、账单和支持请求的实用指南。",
      sections: [
        {
          title: "开始使用",
          body: "Tomverse 可让你一次提问、比较多个 AI 模型的答案、附加必要上下文，并把有价值的结果整理在一个工作区中。简单问题可从一个模型开始；需要不同视角时，可比较最多三个模型。",
          bullets: ["使用 Start Chat 打开应用。", "发送问题前先在模型选择器中选择模型。", "使用项目、置顶和搜索功能找回重要对话。"],
        },
        {
          title: "登录和账户访问",
          body: "如果登录失败，请在同一浏览器会话中重试，确认允许弹窗和第三方登录跳转，并检查提供商账户邮箱是否与 Tomverse 账户一致。",
          bullets: ["Google、Microsoft 等 OAuth 提供商可能需要正确的 callback 设置。", "如果出现账户关联错误，请联系支持并提供提供商名称和账户邮箱。", "删除账户会永久删除对话、设置和已保存的账户数据。"],
        },
        {
          title: "套餐、限制和升级",
          body: "Guest 模式用于快速体验。Free、Pro 和 Max 套餐提供更广的模型访问和更高的使用量。如果某个模型或功能不可用，应用会在模型选择器或套餐区域显示原因。",
          bullets: ["Guest：每月 100、每日 20 积分，仅限 Standard 用量类别模型，不可使用附件。", "Free：每月 300、每日 30 积分，每月 30 次精选高成本模型回复。", "Pro：每月 3,000、每日 150 积分。Max：每月 10,000 积分，Standard 模型无每日限制，Premium 用量适用月度积分和公平使用政策。"],
        },
        {
          title: "文件和 Google Drive",
          body: "文件未加密、未损坏且大小合理时最稳定。如果 PDF 或 Office 文档失败，请重新导出、减小文件大小，或直接粘贴关键文本。",
          bullets: ["登录后支持图片、PDF、Office 文件、文本文件和 Google Drive 文件。", "Guest 模式不支持附件。", "最多可附加 5 个文件，每个 10 MB。"],
        },
        {
          title: "模型响应和提供商状态",
          body: "Tomverse 不编辑模型输出，而是展示外部 AI 提供商返回的答案。提供商可能因余额、rate limit、服务状态或模型限制而失败或返回空答案。",
          bullets: ["某个模型受限时，可尝试推荐的替代模型。", "出现文件相关错误时，可先移除附件重试。", "联系支持时请附上 trace ID。"],
        },
        {
          title: "分享、下载和隐私",
          body: "分享的对话是只读快照。Private Mode 表示 Tomverse 不把对话保存到 Tomverse 数据库，但为了生成回答，提示仍会发送给所选 AI 提供商。",
          bullets: ["仅分享你愿意通过链接公开查看的内容。", "锁定对话在执行受保护操作前需要解锁授权。", "下载功能用于导出对话内容供你自行保存。"],
        },
        {
          title: "联系支持",
          body: "如果仍需帮助，请通过支持页面提交书面请求。请包含账户邮箱、大致时间、浏览器、模型名称、是否附加文件，以及应用中显示的 trace ID。我们不提供电话支持。",
        },
      ],
      cta: { label: "联系支持", href: "/support" },
    },
  },
} satisfies Record<
  string,
  { en: MarketingInfoCopy } & Partial<Record<Language, MarketingInfoCopy>>
>;

export const focusedSafetyPages = {
  approach: {
    en: { ...infoPages.safety.en, eyebrow: "Safety", title: "Safety Approach", description: "How Tomverse designs product controls before scaling usage.", sections: [infoPages.safety.en.sections[0]] },
    ko: { ...infoPages.safety.ko, eyebrow: "안전", title: "Safety Approach", description: "Tomverse가 사용량 확장 전에 제품 통제 장치를 설계하는 방식입니다.", sections: [infoPages.safety.ko.sections[0]] },
    zh: { ...infoPages.safety.zh, eyebrow: "安全", title: "Safety Approach", description: "Tomverse 如何在扩大使用前设计产品控制。", sections: [infoPages.safety.zh.sections[0]] },
  },
  securityPrivacy: {
    en: { ...infoPages.safety.en, eyebrow: "Safety", title: "Security & Privacy", description: "How Tomverse reduces accidental exposure and protects sensitive workflows.", sections: [infoPages.safety.en.sections[1]] },
    ko: { ...infoPages.safety.ko, eyebrow: "안전", title: "Security & Privacy", description: "Tomverse가 의도치 않은 노출을 줄이고 민감한 흐름을 보호하는 방식입니다.", sections: [infoPages.safety.ko.sections[1]] },
    zh: { ...infoPages.safety.zh, eyebrow: "安全", title: "Security & Privacy", description: "Tomverse 如何减少意外暴露并保护敏感工作流。", sections: [infoPages.safety.zh.sections[1]] },
  },
  trustTransparency: {
    en: { ...infoPages.safety.en, eyebrow: "Safety", title: "Trust & Transparency", description: "How Tomverse explains AI limitations, provider involvement, and product behavior.", sections: [infoPages.safety.en.sections[2]] },
    ko: { ...infoPages.safety.ko, eyebrow: "안전", title: "Trust & Transparency", description: "Tomverse가 AI 한계, 공급자 관여, 제품 동작을 설명하는 방식입니다.", sections: [infoPages.safety.ko.sections[2]] },
    zh: { ...infoPages.safety.zh, eyebrow: "安全", title: "Trust & Transparency", description: "Tomverse 如何说明 AI 限制、供应商参与和产品行为。", sections: [infoPages.safety.zh.sections[2]] },
  },
} satisfies Record<
  string,
  { en: MarketingInfoCopy } & Partial<Record<Language, MarketingInfoCopy>>
>;
