import {
  normalizeTomverseMarketingUrl,
  renderMarketingEmailLayout,
  type MarketingFeature,
} from "@/lib/marketingEmailLayout";

export type ProductAnnouncementPayload = {
  subject: string;
  preheader: string;
  eyebrow: string;
  headline: string;
  intro: string;
  features: MarketingFeature[];
  closing?: string | null;
  ctaLabel: string;
  ctaUrl: string;
};

const requiredText = (
  value: unknown,
  field: string,
  max: number
): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  const text = value.trim();
  if (text.length > max) throw new Error(`${field} must be ${max} characters or fewer.`);
  return text;
};

export const parseProductAnnouncementPayload = (
  raw: unknown
): ProductAnnouncementPayload => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Product announcement content must be an object.");
  }
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.features) || value.features.length < 1 || value.features.length > 4) {
    throw new Error("Product announcement content needs between one and four features.");
  }
  const features = value.features.map((feature, index) => {
    if (!feature || typeof feature !== "object" || Array.isArray(feature)) {
      throw new Error(`features[${index}] must be an object.`);
    }
    const item = feature as Record<string, unknown>;
    return {
      title: requiredText(item.title, `features[${index}].title`, 100),
      body: requiredText(item.body, `features[${index}].body`, 500),
    };
  });

  const ctaUrl = requiredText(value.ctaUrl, "ctaUrl", 500);
  const normalizedCtaUrl = normalizeTomverseMarketingUrl(ctaUrl);

  const closing =
    value.closing === undefined || value.closing === null || value.closing === ""
      ? null
      : requiredText(value.closing, "closing", 500);

  return {
    subject: requiredText(value.subject, "subject", 140),
    preheader: requiredText(value.preheader, "preheader", 200),
    eyebrow: requiredText(value.eyebrow, "eyebrow", 80),
    headline: requiredText(value.headline, "headline", 160),
    intro: requiredText(value.intro, "intro", 900),
    features,
    closing,
    ctaLabel: requiredText(value.ctaLabel, "ctaLabel", 80),
    ctaUrl: normalizedCtaUrl,
  };
};

export const buildProductAnnouncementEmail = (
  raw: unknown,
  language: string
) => {
  const payload = parseProductAnnouncementPayload(raw);
  const rendered = renderMarketingEmailLayout({ ...payload, language });
  return { subject: payload.subject, ...rendered };
};

export const PRODUCT_ANNOUNCEMENT_PLACEHOLDER: ProductAnnouncementPayload = {
  subject: "{{subject}}",
  preheader: "{{preheader}}",
  eyebrow: "{{eyebrow}}",
  headline: "{{headline}}",
  intro: "{{intro}}",
  features: [{ title: "{{featureTitle}}", body: "{{featureBody}}" }],
  closing: "{{closing}}",
  ctaLabel: "{{ctaLabel}}",
  ctaUrl: "https://tomverse.app/{{ctaPath}}",
};

/** Starter copy for Tomverse's first product newsletter. */
export const ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT: Record<
  "ko" | "en",
  ProductAnnouncementPayload
> = {
  ko: {
    subject: "나를 이해하는 AI, 내 지식과 함께 시작하세요",
    preheader: "나의 AI 어시스턴트를 만들고 Knowledge 파일을 대화의 참고 자료로 연결해 보세요.",
    eyebrow: "Tomverse Product Update",
    headline: "나의 AI 어시스턴트에 Knowledge를 더해보세요",
    intro:
      "반복해서 설명하던 일하는 방식과 자주 쓰는 자료를 하나의 비공개 AI 어시스턴트에 담을 수 있습니다.",
    features: [
      {
        title: "내 방식대로 설정",
        body: "어시스턴트의 이름과 지시문을 정하고, 작업에 맞는 기본 AI 모델을 선택하세요.",
      },
      {
        title: "내 자료를 아는 대화",
        body: "Knowledge 파일을 추가하면 질문과 관련된 발췌가 답변을 위한 참고 자료로 사용됩니다.",
      },
      {
        title: "계정 안에서 비공개로 관리",
        body: "어시스턴트와 Knowledge는 계정 전용이며 공개 목록에 노출되거나 다른 사용자와 공유되지 않습니다.",
      },
    ],
    closing: "하나를 만들어 두면 새 대화를 시작할 때 같은 설정과 자료를 다시 준비할 필요가 없습니다.",
    ctaLabel: "나의 AI 어시스턴트 만들기",
    ctaUrl: "https://tomverse.app/settings/assistants",
  },
  en: {
    subject: "An AI that works your way, with your knowledge",
    preheader: "Create a private AI assistant and connect Knowledge files as reference material for your conversations.",
    eyebrow: "Tomverse Product Update",
    headline: "Give your AI assistant the knowledge it needs",
    intro:
      "Put the way you work and the material you return to in one private AI assistant, instead of explaining them again in every conversation.",
    features: [
      {
        title: "Set it up your way",
        body: "Name your assistant, write its instructions and choose the default AI model for the work.",
      },
      {
        title: "Conversations grounded in your material",
        body: "Add Knowledge files and relevant excerpts can be used as reference material when the assistant answers.",
      },
      {
        title: "Private to your account",
        body: "Your assistants and Knowledge are not listed publicly or shared with other users.",
      },
    ],
    closing: "Once it is ready, you can start new conversations without rebuilding the same setup and source material.",
    ctaLabel: "Create my AI assistant",
    ctaUrl: "https://tomverse.app/settings/assistants",
  },
};
