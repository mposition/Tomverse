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
import {
  releaseNotesLinkPath,
  releaseNotesLinkUrl,
} from "@/lib/releaseNotesLinks";

/**
 * A feature as it is written, before anything is resolved.
 *
 * The destination is an id and a label; `MarketingFeature.link` is what the
 * parser builds from them. They were the same type until 2026-09-23 and that
 * was wrong in three ways at once: a literal declared with this type could not
 * carry `linkId` at all, because the excess property check refuses it; a
 * feature carrying an already-resolved `link` type-checked and the parser
 * silently dropped it, so an approved destination disappeared without an
 * error; and feeding a parsed payload back through the parser produced a mail
 * with no feature links and no complaint.
 */
export type ProductAnnouncementFeatureInput = {
  title: string;
  body: string;
  linkId?: string;
  linkLabel?: string;
};

/** A message as it is written. What the composer holds and the literals below. */
export type ProductAnnouncementContent = {
  subject: string;
  preheader: string;
  eyebrow: string;
  headline: string;
  intro: string;
  media?: MarketingEmailMedia | null;
  features: ProductAnnouncementFeatureInput[];
  closing?: string | null;
  ctaLabel: string;
  ctaUrl: string;
};

/** A message as it renders. Every destination resolved to a URL we built. */
export type ProductAnnouncementPayload = Omit<
  ProductAnnouncementContent,
  "features"
> & {
  features: MarketingFeature[];
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

    // An already-resolved destination is not an input.
    //
    // Refused rather than ignored: dropping it produced a feature with no link
    // and no error, so an approved destination vanished exactly as quietly as
    // a commercial one would have. The caller that sent it believes the link
    // went out.
    for (const resolved of ["link", "url"]) {
      if (item[resolved] !== undefined) {
        throw new Error(
          `features[${index}].${resolved} is a rendered value; write linkId and linkLabel instead.`
        );
      }
    }

    // The destination is a path id, never a URL.
    //
    // A validator over a URL somebody wrote can only answer "does this look
    // acceptable"; the question section 8 asks is "is this one of the places
    // we decided to send people", and only a table can answer that. The
    // commercial paths are the ones it must not contain, and
    // lib/releaseNotesLinks.ts holds that rule with its own test.
    let link: { label: string; url: string } | null = null;
    if (item.linkId !== undefined && item.linkId !== null) {
      const path = releaseNotesLinkPath(String(item.linkId));
      if (path === null) {
        throw new Error(
          `features[${index}].linkId is not an approved release-notes destination.`
        );
      }
      link = {
        label: requiredText(item.linkLabel, `features[${index}].linkLabel`, 80),
        url: releaseNotesLinkUrl(path, `features[${index}].linkId`),
      };
    } else if (item.linkLabel !== undefined && item.linkLabel !== null) {
      // A label with nowhere to go renders as text that looks like a link and
      // is not one, which is worse than no label at all.
      throw new Error(
        `features[${index}].linkLabel needs a linkId to go with it.`
      );
    }

    return {
      title: requiredText(item.title, `features[${index}].title`, 100),
      body: requiredText(item.body, `features[${index}].body`, 500),
      link,
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

export const PRODUCT_ANNOUNCEMENT_PLACEHOLDER: ProductAnnouncementContent = {
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
  "ko" | "en" | "zh",
  ProductAnnouncementContent
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
  zh: {
    subject: "让 AI 按你的方式工作，也读懂你的资料",
    preheader:
      "创建私有 AI 助手，并把 Knowledge 文件作为对话的参考资料。",
    eyebrow: "Tomverse 产品更新",
    headline: "为你的 AI 助手添加真正需要的 Knowledge",
    intro:
      "把你的工作方式和经常使用的资料放进一个私有 AI 助手，不必在每次对话中重复说明。",
    media: {
      posterUrl: ASSISTANT_KNOWLEDGE_GUIDE_POSTER_URL,
      alt: "创建 AI 助手、添加 Knowledge 并在对话中使用的三步指南",
      badge: "查看三步互动指南",
    },
    features: [
      {
        title: "1. 创建助手",
        body: "填写名称和期望的回答方式，创建第一个版本。你可以继续使用账户的默认模型。",
      },
      {
        title: "2. 添加 Knowledge 并保存",
        body: "上传文件、选择此版本可使用的资料，然后保存指令和模型。相关摘录会成为回答的参考资料。",
      },
      {
        title: "3. 在对话中选择",
        body: "在对话工具的 AI 助手菜单中选择刚创建的助手，然后开始提问。",
      },
    ],
    closing:
      "你的助手和 Knowledge 仅限当前账户使用，不会公开展示或与其他用户共享。",
    ctaLabel: "查看三步指南并开始",
    ctaUrl: assistantKnowledgeGuideUrl("zh"),
  },
};

export type AssistantKnowledgeCampaignLanguage =
  keyof typeof ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT;

const ASSISTANT_PACKAGE_IMPORT_FEATURE: Record<
  AssistantKnowledgeCampaignLanguage,
  MarketingFeature
> = {
  ko: {
    title: "4. 기존 구성이 있다면 가져오기",
    body: "Agent Skill ZIP 또는 Tomverse 패키지를 검토해 새 어시스턴트로 가져올 수 있습니다. 스크립트와 외부 도구는 자동 실행·연결되지 않습니다.",
  },
  en: {
    title: "4. Import an existing setup",
    body: "Review an Agent Skill ZIP or Tomverse package and bring it into a new assistant. Scripts do not run, and external tools are not connected automatically.",
  },
  zh: {
    title: "4. 导入现有配置",
    body: "审阅 Agent Skill ZIP 或 Tomverse 包，并将其导入为新助手。脚本不会运行，外部工具也不会自动连接。",
  },
};

/**
 * The composer only advertises package import when the same rollout flag that
 * guards the product route is on. A draft created while the flag is off must
 * not promise a button recipients cannot see.
 */
export const assistantKnowledgeCampaignContent = ({
  includePackageImport,
}: {
  includePackageImport: boolean;
}): Record<
  AssistantKnowledgeCampaignLanguage,
  ProductAnnouncementPayload
> =>
  Object.fromEntries(
    (
      Object.entries(ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT) as Array<
        [
          AssistantKnowledgeCampaignLanguage,
          ProductAnnouncementPayload,
        ]
      >
    ).map(([language, payload]) => [
      language,
      {
        ...payload,
        features: includePackageImport
          ? [...payload.features, ASSISTANT_PACKAGE_IMPORT_FEATURE[language]]
          : [...payload.features],
      },
    ])
  ) as Record<
    AssistantKnowledgeCampaignLanguage,
    ProductAnnouncementPayload
  >;
