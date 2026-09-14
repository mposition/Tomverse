import {
  normalizeTomverseMarketingUrl,
  renderMarketingEmailLayout,
  type MarketingEmailMedia,
  type MarketingFeature,
} from "@/lib/marketingEmailLayout";
import {
  assistantKnowledgeGuideUrl,
  ASSISTANT_KNOWLEDGE_GUIDE_POSTER_URL,
} from "@/lib/assistantKnowledgeGuide";

export type ProductAnnouncementPayload = {
  subject: string;
  preheader: string;
  eyebrow: string;
  headline: string;
  intro: string;
  media?: MarketingEmailMedia | null;
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

  let media: MarketingEmailMedia | null = null;
  if (value.media !== undefined && value.media !== null) {
    if (typeof value.media !== "object" || Array.isArray(value.media)) {
      throw new Error("media must be an object.");
    }
    const rawMedia = value.media as Record<string, unknown>;
    const posterUrl = requiredText(
      rawMedia.posterUrl,
      "media.posterUrl",
      500
    );
    media = {
      posterUrl: normalizeTomverseMarketingUrl(
        posterUrl,
        "media.posterUrl"
      ),
      alt: requiredText(rawMedia.alt, "media.alt", 240),
      badge: requiredText(rawMedia.badge, "media.badge", 80),
    };
  }

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
    media,
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
  media: {
    posterUrl: ASSISTANT_KNOWLEDGE_GUIDE_POSTER_URL,
    alt: "{{mediaAlt}}",
    badge: "{{mediaBadge}}",
  },
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
    media: {
      posterUrl: ASSISTANT_KNOWLEDGE_GUIDE_POSTER_URL,
      alt: "나의 AI 어시스턴트를 만들고 Knowledge를 추가한 뒤 대화에서 사용하는 3단계 안내",
      badge: "3단계 인터랙티브 사용법 보기",
    },
    features: [
      {
        title: "1. 어시스턴트 만들기",
        body: "이름과 원하는 답변 방식을 적어 첫 버전을 만드세요. 기본 모델은 계정 설정을 그대로 사용할 수 있습니다.",
      },
      {
        title: "2. Knowledge 추가하고 저장하기",
        body: "파일을 업로드하고 사용할 자료를 선택한 뒤 지시문과 모델을 저장하세요. 관련 발췌가 답변의 참고 자료로 사용됩니다.",
      },
      {
        title: "3. 대화에서 선택하기",
        body: "대화 도구의 AI 어시스턴트 메뉴에서 만든 어시스턴트를 선택하고 질문을 시작하세요.",
      },
    ],
    closing: "어시스턴트와 Knowledge는 계정 전용이며 공개 목록이나 다른 사용자에게 공유되지 않습니다.",
    ctaLabel: "3단계 사용법 보고 시작하기",
    ctaUrl: assistantKnowledgeGuideUrl("ko"),
  },
  en: {
    subject: "An AI that works your way, with your knowledge",
    preheader: "Create a private AI assistant and connect Knowledge files as reference material for your conversations.",
    eyebrow: "Tomverse Product Update",
    headline: "Give your AI assistant the knowledge it needs",
    intro:
      "Put the way you work and the material you return to in one private AI assistant, instead of explaining them again in every conversation.",
    media: {
      posterUrl: ASSISTANT_KNOWLEDGE_GUIDE_POSTER_URL,
      alt: "A three-step guide to creating an AI assistant, adding Knowledge, and using it in a conversation",
      badge: "See the interactive three-step guide",
    },
    features: [
      {
        title: "1. Create your assistant",
        body: "Give it a name and describe how you want answers written. You can keep your account's default model.",
      },
      {
        title: "2. Add Knowledge and save",
        body: "Upload a file, select the material this version may use, then save instructions and models. Relevant excerpts become reference material.",
      },
      {
        title: "3. Choose it in a conversation",
        body: "Open AI Assistant in the conversation tools, select the assistant you made, and start asking questions.",
      },
    ],
    closing: "Your assistant and Knowledge stay private to your account and are not listed or shared with other users.",
    ctaLabel: "See the three steps and start",
    ctaUrl: assistantKnowledgeGuideUrl("en"),
  },
};
