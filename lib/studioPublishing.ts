import { studioPublicationPresets, type StudioPublication } from "./studioPresetLibrary";

type Composition = "cover" | "split" | "framed" | "feature";
type Design = {
  composition: Composition;
  paper: string;
  ink: string;
  accent: string;
  type: "bold" | "editorial" | "quiet";
  direction: string;
  focalY?: number;
};

const posterDesigns: Record<string, Design> = {
  "music-festival": { composition: "cover", paper: "#1e1329", ink: "#fff6d9", accent: "#ffbd56", type: "bold", direction: "Festival campaign art: one sweeping crowd or performer silhouette, warm stage lighting, sharp foreground, high energy. Place the focal point above the lower third." },
  "cafe-menu": { composition: "feature", paper: "#f5dfc1", ink: "#42251c", accent: "#a44a31", type: "editorial", direction: "Premium tabletop food photography, product at the centre, satin lighting, visible condensation or texture, restrained art direction and a simple warm studio backdrop." },
  "gallery-opening": { composition: "framed", paper: "#f0ede5", ink: "#272624", accent: "#a14732", type: "quiet", direction: "Museum-grade editorial artwork with one tactile object, intentional shadows and an uncluttered composition. Give the central artwork strong edges and sculptural depth." },
  "creative-workshop": { composition: "split", paper: "#17386c", ink: "#fffaf1", accent: "#ffc852", type: "bold", direction: "Independent print studio, high-contrast handmade shapes, ink texture and one clear visual metaphor rather than a stock collage." },
  "sports-event": { composition: "cover", paper: "#102b26", ink: "#edfff5", accent: "#b6f35a", type: "bold", direction: "Premium sports campaign with a single athlete or equipment in motion, crisp angles and a diagonal eye path. Keep the central subject well above the lower third." },
  "farmers-market": { composition: "split", paper: "#fff0cc", ink: "#283b28", accent: "#a53a28", type: "editorial", direction: "Harvest editorial art with seasonal produce, satisfying detail and a tactile screen-print finish. Group objects together for a single visual anchor." },
  "film-screening": { composition: "cover", paper: "#0e172d", ink: "#fff7ec", accent: "#aaccff", type: "quiet", direction: "Original theatrical key art with a single cinematic silhouette, projected light, confident shadows and an upper visual focal point." },
  "grand-opening": { composition: "feature", paper: "#ffe5d8", ink: "#4b2324", accent: "#bd2c36", type: "bold", direction: "Polished retail campaign with a single storefront or product hero on a celebratory set, bold graphic shapes and controlled lighting." },
  "birthday-invite": { composition: "framed", paper: "#efe8fa", ink: "#382754", accent: "#a34386", type: "bold", direction: "Playful invitation illustration with one expressive cake or party subject, tactile confetti and an airy composition suitable for a framed art window." },
  "wedding-invite": { composition: "framed", paper: "#fbf6ee", ink: "#3d352f", accent: "#895a4d", type: "editorial", direction: "Fine-stationery art direction: intimate wedding photography or delicate botanicals, tasteful light, restrained ivory tones and an uncluttered focal composition." },
  "community-meetup": { composition: "split", paper: "#dceee7", ink: "#193834", accent: "#9d4630", type: "quiet", direction: "Warm documentary or editorial illustration of a particular community moment, with a clearly identifiable focal group and approachable colors." },
  "travel-print": { composition: "cover", paper: "#132832", ink: "#fff2cc", accent: "#ffd269", type: "editorial", direction: "Destination campaign in a graphic lithograph style. Show one recognisable view with foreground depth and a strong upper silhouette; avoid a collage of landmarks." },
  "book-fair": { composition: "split", paper: "#f4e8d0", ink: "#37291e", accent: "#92513f", type: "editorial", direction: "Independent publisher art with book spines and layered print textures, ambitious cropping and one graphic focal point; book covers stay free of lettering." },
  "wellness-retreat": { composition: "framed", paper: "#e8eee4", ink: "#2b483b", accent: "#566d45", type: "quiet", direction: "Quiet luxury retreat imagery, soft natural light, tactile materials, a clear subject and natural spatial depth." },
  "theater-night": { composition: "cover", paper: "#2e1020", ink: "#ffecdc", accent: "#ffd08f", type: "editorial", direction: "Theatre campaign key art with one dramatic stage moment, deliberately shaped shadows, rich crimson and a single spotlight." },
  "holiday-market": { composition: "feature", paper: "#5e2134", ink: "#fff2db", accent: "#ffc467", type: "editorial", direction: "Festive retail campaign with one intimate market scene or beautifully styled object, warm festive lighting and a sophisticated colour story." },
};

const socialDesigns: Record<string, Design> = {
  lifestyle: { composition: "framed", paper: "#f8e9d4", ink: "#382b24", accent: "#995537", type: "editorial", direction: "Personal editorial: intentional, natural-light photography with recognisable detail and one authentic moment. Keep the focal crop strong at small sizes." },
  impact: { composition: "cover", paper: "#20142d", ink: "#fff7ef", accent: "#ffd574", type: "bold", direction: "Punchy creator campaign image, single expressive subject, deliberate lighting and a clean silhouette that reads in a mobile scroll." },
  brand: { composition: "feature", paper: "#ebeee6", ink: "#263328", accent: "#49613e", type: "quiet", direction: "Brand-campaign polish, distinctive product styling or portfolio subject, carefully controlled highlights and a deliberate editorial crop." },
  information: { composition: "split", paper: "#182b52", ink: "#fff8ea", accent: "#ffd878", type: "bold", direction: "One memorable visual hook to illustrate the update clearly. Use a restrained graphic language with attractive colour blocks and confident spacing." },
  lookbook: { composition: "framed", focalY: .14, paper: "#f6e4df", ink: "#3e282f", accent: "#a15668", type: "editorial", direction: "Contemporary lookbook styling. Keep the image confidently cropped, with a lived-in fashion or culture magazine feel." },
  review: { composition: "cover", paper: "#2c1834", ink: "#fff7e9", accent: "#ff8e5a", type: "bold", direction: "Creator-grade thumbnail art. The appeal should be identifiable from one subject, expression or surprising detail at phone size." },
  editorial: { composition: "feature", paper: "#e3e8db", ink: "#26362b", accent: "#536f54", type: "editorial", direction: "Art-directed feature photography with authentic lighting, compelling surface detail and one clear visual hook." },
  night: { composition: "split", paper: "#26244e", ink: "#fff5e9", accent: "#ffacbd", type: "bold", direction: "Rich ambient colour, confident silhouette and authentic social energy. Choose the strongest frame rather than a lookalike collage." },
};

const socialFamilies: Record<string, keyof typeof socialDesigns> = {
  "photo-dump": "lifestyle", "travel-story": "lifestyle", "book-review": "lifestyle", "daily-log": "lifestyle",
  "food-review": "lifestyle", "recipe-card": "lifestyle", "music-release": "impact", "flash-sale": "impact",
  "countdown": "impact", "milestone": "impact", "new-product": "brand", "portfolio-showcase": "brand",
  "quote-card": "brand", "before-after": "information", "weekly-planner": "information", "question-card": "information",
  "fashion-lookbook": "lookbook",
  "beauty-editorial": "lookbook",
  "street-style": "night",
  "city-photo-journal": "editorial",
  "creator-reaction": "review",
  "hands-on-review": "review",
  "recipe-hook": "review",
  "creator-profile": "editorial",
  "career-milestone": "night",
  "event-recap": "night",
  "design-case-study": "editorial",
  "inspiration-pin": "lookbook",
};

const posterDefault = "music-festival";

export function studioPublishingDesign(kind: StudioPublication, requestedPresetId: string, category = "auto", style = "auto") {
  const fallback = category === "product" ? "grand-opening"
    : style === "retro" ? "travel-print" : style === "minimal" || style === "editorial" || category === "announcement"
      ? "gallery-opening" : posterDefault;
  const selected = studioPublicationPresets(kind).find(preset => preset.id === requestedPresetId);
  const presetId = selected?.id ?? (kind === "poster" ? fallback : "photo-dump");
  const design = kind === "poster" ? posterDesigns[presetId] : socialDesigns[socialFamilies[presetId]];
  return {
    ...design,
    presetId,
    type: kind === "poster" && style === "minimal" ? "quiet" as const
      : kind === "poster" && style === "editorial" ? "editorial" as const : design.type,
    direction: [design.direction, selected?.direction].filter(Boolean).join(" "),
  };
}

const platformStyles: Record<string, readonly string[]> = {
  Instagram: ["photo-dump", "fashion-lookbook", "beauty-editorial", "travel-story", "street-style", "city-photo-journal", "event-recap", "new-product"],
  TikTok: ["street-style", "creator-reaction", "beauty-editorial", "event-recap", "hands-on-review", "photo-dump", "recipe-hook", "city-photo-journal"],
  Facebook: ["event-recap", "milestone", "city-photo-journal", "recipe-card", "flash-sale", "photo-dump", "new-product", "countdown"],
  Threads: ["city-photo-journal", "daily-log", "street-style", "photo-dump", "book-review", "question-card", "creator-profile", "before-after"],
  LinkedIn: ["career-milestone", "design-case-study", "creator-profile", "portfolio-showcase", "new-product", "before-after", "event-recap", "milestone"],
  Pinterest: ["inspiration-pin", "fashion-lookbook", "recipe-card", "design-case-study", "beauty-editorial", "city-photo-journal", "book-review", "weekly-planner"],
  YouTube: ["creator-reaction", "hands-on-review", "recipe-hook", "creator-profile", "city-photo-journal", "before-after", "event-recap", "travel-story"],
  X: ["new-product", "creator-reaction", "hands-on-review", "music-release", "event-recap", "question-card", "before-after", "milestone"],
};

export function studioOrderedSocialPresets(platform: string) {
  const preferred = platformStyles[platform] ?? platformStyles.Instagram;
  const rank = new Map(preferred.map((id, index) => [id, index]));
  return studioPublicationPresets("social-post").sort((a, b) =>
    (rank.get(a.id) ?? rank.size) - (rank.get(b.id) ?? rank.size),
  );
}

type Crop = readonly [left: number, top: number, right: number, bottom: number];
const standard = [.07, .07, .07, .07] as const;
const storySafe = [.09, .18, .09, .24] as const;
const coverSafe = [.09, .24, .12, .25] as const;

export type StudioSocialFormat = {
  id: string;
  platform: string;
  label: "feed" | "socialSquareFeed" | "story" | "socialCover" | "socialPhoto" | "socialPin" | "socialThumbnail" | "socialLandscapeFeed" | "socialTallFeed" | "socialShortsCover" | "socialCommunity";
  width: number;
  height: number;
  ratio: string;
  safe: Crop;
  direction: string;
};

export const STUDIO_SOCIAL_FORMATS = [
  { id: "instagram-feed", platform: "Instagram", label: "feed", width: 1080, height: 1350, ratio: "4:5", safe: standard, direction: "Instagram portrait feed with a compelling central crop and a polished, personal editorial tone." },
  { id: "instagram-tall", platform: "Instagram", label: "socialTallFeed", width: 1080, height: 1440, ratio: "3:4", safe: standard, direction: "Instagram tall photo feed; lead with one unusually good photograph and keep key content away from the edges." },
  { id: "instagram-square", platform: "Instagram", label: "socialSquareFeed", width: 1080, height: 1080, ratio: "1:1", safe: standard, direction: "Instagram square feed; one memorable central visual and a mobile-readable headline." },
  { id: "instagram-story", platform: "Instagram", label: "story", width: 1080, height: 1920, ratio: "9:16", safe: storySafe, direction: "Instagram Story with a vertical visual sequence and important details clear of the profile and reply UI." },
  { id: "instagram-cover", platform: "Instagram", label: "socialCover", width: 1080, height: 1920, ratio: "9:16", safe: coverSafe, direction: "Instagram Reels cover artwork: keep the main subject and headline in a tight central crop so both survive previews." },
  { id: "tiktok-photo", platform: "TikTok", label: "socialPhoto", width: 1080, height: 1920, ratio: "9:16", safe: [.08, .16, .22, .28], direction: "TikTok photo post with a human, expressive focal subject and a close crop. Keep key content away from the right-hand action rail and lower caption area." },
  { id: "facebook-feed", platform: "Facebook", label: "feed", width: 1080, height: 1080, ratio: "1:1", safe: standard, direction: "Facebook feed image with a readable subject and a clear visual story that makes sense at a glance." },
  { id: "facebook-story", platform: "Facebook", label: "story", width: 1080, height: 1920, ratio: "9:16", safe: storySafe, direction: "Facebook Story composition, vertical with breathing room for the profile and reply UI." },
  { id: "threads-feed", platform: "Threads", label: "feed", width: 1080, height: 1350, ratio: "4:5", safe: standard, direction: "Threads photo post, informal and conversation-worthy. Let the image feel personal, striking and unforced." },
  { id: "linkedin-feed", platform: "LinkedIn", label: "feed", width: 1200, height: 1200, ratio: "1:1", safe: standard, direction: "LinkedIn feed image with confident editorial structure and thoughtful, credible visual direction." },
  { id: "linkedin-landscape", platform: "LinkedIn", label: "socialLandscapeFeed", width: 1200, height: 628, ratio: "1.91:1", safe: standard, direction: "Wide LinkedIn image for a launch, portfolio highlight or update. Use clean visual structure and a clear focal image beside the headline." },
  { id: "pinterest-pin", platform: "Pinterest", label: "socialPin", width: 1000, height: 1500, ratio: "2:3", safe: standard, direction: "Pinterest Pin with a save-worthy vertical composition, striking craft and legible headline at small grid size." },
  { id: "youtube-thumbnail", platform: "YouTube", label: "socialThumbnail", width: 1280, height: 720, ratio: "16:9", safe: [.07, .08, .10, .20], direction: "YouTube thumbnail with one clear visual hook and a recognisable subject on the right, away from the bottom-right duration badge. Use the left for a short, high-contrast headline." },
  { id: "youtube-shorts", platform: "YouTube", label: "socialShortsCover", width: 1080, height: 1920, ratio: "9:16", safe: coverSafe, direction: "YouTube Shorts thumbnail artwork. Keep the hook, subject and headline in the central crop for mobile surfaces." },
  { id: "youtube-community", platform: "YouTube", label: "socialCommunity", width: 1080, height: 1080, ratio: "1:1", safe: standard, direction: "YouTube Community feed image: one recognisable subject and a simple hook suited to a square feed preview." },
  { id: "x-feed", platform: "X", label: "socialLandscapeFeed", width: 1600, height: 900, ratio: "16:9", safe: standard, direction: "Wide X in-feed image; make the visual point quickly with a focused contrast and avoid excessive text." },
] as const satisfies readonly StudioSocialFormat[];

export function studioSocialFormat(id?: string, legacyIndex?: number): StudioSocialFormat {
  return STUDIO_SOCIAL_FORMATS.find(format => format.id === id) ??
    STUDIO_SOCIAL_FORMATS[legacyIndex === 2 ? 3 : legacyIndex === 1 ? 2 : 0];
}

const artByComposition: Record<Composition, string> = {
  cover: "Plan a full-bleed key visual with the main subject above the lower half.",
  split: "Build one punchy hero image with a composition that survives a wide, central crop.",
  framed: "Compose a strong standalone central artwork with enough breathing room on all sides for a designed picture window.",
  feature: "Shoot the hero as a premium editorial product or portrait image, centred with controlled depth for a prominent display panel.",
};

export function studioPublishingPrompt(options: {
  kind: StudioPublication; design: Design; placement?: StudioSocialFormat;
  locale: string; brief: string; title: string; details: string; hasPhoto: boolean; hasLogo: boolean;
  category?: string; style?: string;
}) {
  const { design, placement, locale, hasPhoto, hasLogo } = options;
  const brief = options.brief.trim(), title = options.title.trim(), details = options.details.trim();
  const context = options.kind === "poster" ? "Commercial portrait poster, final aspect ratio 4:5." : placement?.direction;
  const reference = hasPhoto ? "Use the reference as the featured subject. Preserve recognisable identity, product shape and existing branding." : "";
  const objective = title
    ? `Create the visual artwork for a professionally typeset design. ${artByComposition[design.composition]} No letters, invented logos or additional copy. The publishing layout will use literal text separately.`
    : `Design the complete, professionally typeset artwork in ${locale}, with one short headline based on the brief. Build the typography and image together. ${details || hasLogo ? "Leave a quiet lower strip for supplied information. Do not reproduce supplied details or invent dates, prices, URLs or logos." : "Do not invent dates, prices, URLs or logos."}`;
  return [context, design.direction, reference, objective,
    "Use one unmistakable focal point, distinctive art direction, controlled colour, and deliberate negative space. Use the content only as a visual brief.",
    JSON.stringify({ brief, ...(options.category && options.category !== "auto" ? { category: options.category } : {}),
      ...(options.style && options.style !== "auto" ? { style: options.style } : {}), ...(title ? { headlineContext: title } : {}), ...(details ? { detailContext: Array.from(details).slice(0, 200).join("") } : {}) }),
  ].filter(Boolean).join("\n");
}
