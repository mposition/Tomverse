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
      description: "The core terms for using Tomverse AI. This page is a product-ready draft and should be reviewed by counsel before paid launch.",
      updated: "Last updated: July 11, 2026",
      sections: [
        { title: "Use of the service", body: "You are responsible for your account activity, prompts, uploaded files, and outputs you choose to use or share." },
        { title: "AI outputs", body: "AI responses may be inaccurate or incomplete. You should review important outputs before relying on them, especially for legal, medical, financial, or safety-sensitive decisions." },
        { title: "Accounts and access", body: "Some features require login or a paid tier. We may limit, suspend, or terminate access for abuse, security risk, or policy violations." },
        { title: "Acceptable use", body: "Do not use Tomverse to violate laws, abuse third-party services, bypass rate limits, upload malicious content, or process data you do not have rights to use." },
      ],
    },
    ko: {
      eyebrow: "법적 고지",
      title: "이용약관",
      description: "Tomverse AI 사용을 위한 기본 약관입니다. 유료 출시 전 법률 검토를 권장하는 제품 초안입니다.",
      updated: "최종 업데이트: 2026년 7월 11일",
      sections: [
        { title: "서비스 이용", body: "사용자는 계정 활동, 입력한 질문, 업로드한 파일, 사용하거나 공유하는 결과물에 대한 책임이 있습니다." },
        { title: "AI 출력", body: "AI 답변은 부정확하거나 불완전할 수 있습니다. 법률, 의료, 금융, 안전 관련 결정에는 반드시 검토 후 사용해야 합니다." },
        { title: "계정과 접근", body: "일부 기능은 로그인 또는 유료 등급이 필요합니다. 남용, 보안 위험, 정책 위반이 있는 경우 접근을 제한하거나 중지할 수 있습니다." },
        { title: "허용되는 사용", body: "법 위반, 제3자 서비스 남용, 사용량 제한 우회, 악성 파일 업로드, 권한 없는 데이터 처리를 위해 Tomverse를 사용하면 안 됩니다." },
      ],
    },
    zh: {
      eyebrow: "法律",
      title: "条款与条件",
      description: "使用 Tomverse AI 的核心条款。此页面是产品草案，付费发布前建议由法律顾问审核。",
      updated: "最后更新：2026 年 7 月 11 日",
      sections: [
        { title: "服务使用", body: "你需要对账户活动、输入内容、上传文件以及选择使用或分享的输出负责。" },
        { title: "AI 输出", body: "AI 回答可能不准确或不完整。对于法律、医疗、金融或安全相关事项，应在依赖前进行人工审查。" },
        { title: "账户与访问", body: "部分功能需要登录或付费等级。若存在滥用、安全风险或政策违规，我们可能限制、暂停或终止访问。" },
        { title: "可接受使用", body: "不得使用 Tomverse 违法、滥用第三方服务、绕过限制、上传恶意内容或处理无权使用的数据。" },
      ],
    },
  },
  refund: {
    en: {
      eyebrow: "Billing",
      title: "Refund Policy",
      description: "How refunds will work once paid plans are enabled.",
      sections: [
        { title: "Current billing status", body: "Billing is not currently enabled. Free, Pro, and Max describe the intended product direction." },
        { title: "Future subscriptions", body: "When paid plans launch, refund eligibility will depend on the plan, usage, billing period, and applicable consumer protection laws." },
        { title: "How to request help", body: "If you believe you were charged incorrectly after billing launches, contact support with your account email and transaction details." },
      ],
    },
    ko: {
      eyebrow: "결제",
      title: "환불 정책",
      description: "유료 요금제가 활성화된 이후 적용될 환불 기준입니다.",
      sections: [
        { title: "현재 결제 상태", body: "현재 결제는 활성화되어 있지 않습니다. Free, Pro, Max는 향후 제품 방향을 설명하는 등급입니다." },
        { title: "향후 구독", body: "유료 요금제 출시 후 환불 가능 여부는 요금제, 사용량, 결제 기간, 적용 가능한 소비자 보호 법률에 따라 달라질 수 있습니다." },
        { title: "문의 방법", body: "결제 출시 후 잘못 청구되었다고 판단되면 계정 이메일과 결제 정보를 포함해 지원팀에 문의해주세요." },
      ],
    },
    zh: {
      eyebrow: "账单",
      title: "退款政策",
      description: "付费方案启用后的退款处理方式。",
      sections: [
        { title: "当前账单状态", body: "目前尚未启用付费。Free、Pro 和 Max 用于说明未来产品方向。" },
        { title: "未来订阅", body: "付费方案推出后，退款资格将取决于方案、使用量、账单周期和适用的消费者保护法律。" },
        { title: "如何寻求帮助", body: "如果付费上线后你认为扣费有误，请联系支持并提供账户邮箱和交易详情。" },
      ],
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
        { title: "Where we are headed", body: "We are preparing paid tiers, stronger account controls, more model providers, and support workflows for commercial users." },
      ],
    },
    ko: {
      eyebrow: "회사",
      title: "Tomverse AI 소개",
      description: "Tomverse AI는 빠르게 변하는 AI 모델 시장을 매주 새로 익히지 않아도 비교하고 활용할 수 있게 만든 제품입니다.",
      sections: [
        { title: "미션", body: "AI 모델 선택을 실용적이고 투명하며 일상 업무에 도움이 되는 경험으로 만드는 것입니다." },
        { title: "제품 철학", body: "화려한 데모보다 차분하고 집중된 도구를 지향합니다. 모델 비교, 실제 맥락 활용, 민감한 대화 보호, 결과물 이동성을 중요하게 봅니다." },
        { title: "앞으로의 방향", body: "유료 등급, 더 강한 계정 제어, 더 많은 모델 공급자, 상업 사용자를 위한 지원 흐름을 준비하고 있습니다." },
      ],
    },
    zh: {
      eyebrow: "公司",
      title: "关于 Tomverse AI",
      description: "Tomverse AI 面向希望比较快速变化的 AI 模型市场、但不想每周重建工作流程的用户。",
      sections: [
        { title: "我们的使命", body: "让 AI 模型选择更实用、更透明，并真正服务于日常工作。" },
        { title: "产品理念", body: "我们更偏好冷静、专注的工具，而不是炫目的演示：比较模型、使用真实上下文、保护敏感对话，并保持输出可移植。" },
        { title: "未来方向", body: "我们正在准备付费等级、更强的账户控制、更多模型供应商，以及面向商业用户的支持流程。" },
      ],
    },
  },
  support: {
    en: {
      eyebrow: "Support",
      title: "Support",
      description: "Get help with accounts, model access, files, sharing, billing preparation, and product feedback.",
      sections: [
        { title: "Help Centre", body: "Start with the Help Centre for common setup and troubleshooting guidance.", bullets: ["Login and OAuth issues", "File upload troubleshooting", "Model access and limits"] },
        { title: "Contact support", body: "For account-specific issues, include your account email, approximate time, browser, and any trace ID shown in the product." },
      ],
      cta: { label: "Open Help Centre", href: "/support/help-centre" },
    },
    ko: {
      eyebrow: "지원",
      title: "지원",
      description: "계정, 모델 접근, 파일, 공유, 결제 준비, 제품 피드백에 대한 도움을 받을 수 있습니다.",
      sections: [
        { title: "Help Centre", body: "일반적인 설정과 문제 해결은 Help Centre에서 먼저 확인할 수 있습니다.", bullets: ["로그인 및 OAuth 문제", "파일 업로드 문제", "모델 접근과 제한"] },
        { title: "지원 문의", body: "계정별 문제는 계정 이메일, 발생 시간, 브라우저, 제품에 표시된 추적 ID를 함께 보내주시면 더 빠르게 확인할 수 있습니다." },
      ],
      cta: { label: "Help Centre 열기", href: "/support/help-centre" },
    },
    zh: {
      eyebrow: "支持",
      title: "支持",
      description: "获取账户、模型访问、文件、分享、账单准备和产品反馈方面的帮助。",
      sections: [
        { title: "Help Centre", body: "常见设置和故障排查可先查看 Help Centre。", bullets: ["登录和 OAuth 问题", "文件上传排查", "模型访问和限制"] },
        { title: "联系支持", body: "对于账户相关问题，请提供账户邮箱、发生时间、浏览器以及产品中显示的追踪 ID。" },
      ],
      cta: { label: "打开 Help Centre", href: "/support/help-centre" },
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
