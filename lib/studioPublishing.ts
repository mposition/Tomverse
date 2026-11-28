import { studioPublicationPresets, type StudioPublication } from "./studioPresetLibrary";

// The image model sets the type itself; a preset contributes its art direction only.
const posterDesigns: Record<string, string> = {
  "music-festival": "Festival campaign art: one sweeping crowd or performer silhouette, warm stage lighting, sharp foreground, high energy. Place the focal point above the lower third.",
  "cafe-menu": "Premium tabletop food photography, product at the centre, satin lighting, visible condensation or texture, restrained art direction and a simple warm studio backdrop.",
  "gallery-opening": "Museum-grade editorial artwork with one tactile object, intentional shadows and an uncluttered composition. Give the central artwork strong edges and sculptural depth.",
  "creative-workshop": "Independent print studio, high-contrast handmade shapes, ink texture and one clear visual metaphor rather than a stock collage.",
  "sports-event": "Premium sports campaign with a single athlete or equipment in motion, crisp angles and a diagonal eye path. Keep the central subject well above the lower third.",
  "farmers-market": "Harvest editorial art with seasonal produce, satisfying detail and a tactile screen-print finish. Group objects together for a single visual anchor.",
  "film-screening": "Original theatrical key art with a single cinematic silhouette, projected light, confident shadows and an upper visual focal point.",
  "grand-opening": "Polished retail campaign with a single storefront or product hero on a celebratory set, bold graphic shapes and controlled lighting.",
  "birthday-invite": "Playful invitation illustration with one expressive cake or party subject, tactile confetti and an airy composition suitable for a framed art window.",
  "wedding-invite": "Fine-stationery art direction: intimate wedding photography or delicate botanicals, tasteful light, restrained ivory tones and an uncluttered focal composition.",
  "community-meetup": "Warm documentary or editorial illustration of a particular community moment, with a clearly identifiable focal group and approachable colors.",
  "travel-print": "Destination campaign in a graphic lithograph style. Show one recognisable view with foreground depth and a strong upper silhouette; avoid a collage of landmarks.",
  "book-fair": "Independent publisher art with book spines and layered print textures, ambitious cropping and one graphic focal point; book covers stay free of lettering.",
  "wellness-retreat": "Quiet luxury retreat imagery, soft natural light, tactile materials, a clear subject and natural spatial depth.",
  "theater-night": "Theatre campaign key art with one dramatic stage moment, deliberately shaped shadows, rich crimson and a single spotlight.",
  "holiday-market": "Festive retail campaign with one intimate market scene or beautifully styled object, warm festive lighting and a sophisticated colour story.",
};

const socialDesigns: Record<string, string> = {
  lifestyle: "Personal editorial: intentional, natural-light photography with recognisable detail and one authentic moment. Keep the focal crop strong at small sizes.",
  impact: "Punchy creator campaign image, single expressive subject, deliberate lighting and a clean silhouette that reads in a mobile scroll.",
  brand: "Brand-campaign polish, distinctive product styling or portfolio subject, carefully controlled highlights and a deliberate editorial crop.",
  information: "One memorable visual hook to illustrate the update clearly. Use a restrained graphic language with attractive colour blocks and confident spacing.",
  lookbook: "Contemporary lookbook styling. Keep the image confidently cropped, with a lived-in fashion or culture magazine feel.",
  review: "Creator-grade thumbnail art. The appeal should be identifiable from one subject, expression or surprising detail at phone size.",
  editorial: "Art-directed feature photography with authentic lighting, compelling surface detail and one clear visual hook.",
  night: "Rich ambient colour, confident silhouette and authentic social energy. Choose the strongest frame rather than a lookalike collage.",
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
  const direction = kind === "poster" ? posterDesigns[presetId] : socialDesigns[socialFamilies[presetId]];
  return { presetId, direction: [direction, selected?.direction].filter(Boolean).join(" ") };
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

type Frame = { width: number; height: number };

/**
 * The image model draws 1:1, 3:2 or 2:3; a placement is often a little narrower or
 * flatter. When the placement keeps at least this share of the image along the
 * axis that differs, the image fills the placement and the rest is trimmed. The
 * model is told how much goes, so the design sits inside what remains.
 */
export const STUDIO_PUBLISHING_MIN_KEPT = .75;

export function studioPublishingTrim(image: Frame, placement: Frame) {
  const drawn = image.width / image.height, shown = placement.width / placement.height;
  if (Math.abs(drawn - shown) < .01) return null;
  const kept = drawn > shown ? shown / drawn : drawn / shown;
  return { sides: drawn > shown ? "left and right" : "top and bottom", kept, each: (1 - kept) / 2, fills: kept >= STUDIO_PUBLISHING_MIN_KEPT } as const;
}

export function studioPublishingPrompt(options: {
  kind: StudioPublication; design: { direction: string }; placement?: StudioSocialFormat;
  language: string; brief: string; title: string; details: string; hasPhoto: boolean; hasLogo: boolean;
  category?: string; style?: string;
  /** The size the model draws and the size of the finished piece, when both are known. */
  drawn?: Frame; finished?: Frame;
}) {
  const { design, placement, language, hasPhoto, hasLogo } = options;
  const brief = options.brief.trim(), title = options.title.trim(), details = options.details.trim();
  const context = options.kind === "poster" ? "Commercial portrait poster, final aspect ratio 4:5." : placement?.direction;
  const reference = hasPhoto ? "Use the reference as the featured subject. A person keeps their face and identity but takes a natural pose, expression and lighting that belong to this design; a product or logo keeps its exact shape, label and colours." : "";
  const trim = options.drawn && options.finished ? studioPublishingTrim(options.drawn, options.finished) : null;
  const platform = trim?.fills
    ? `The finished piece is this image trimmed to ${placement?.ratio ?? "4:5"}: ${Math.round(trim.each * 100)}% is cut off each of the ${trim.sides} edges. Compose the whole design, every letter, face and product included, inside the middle that remains, and let only background reach the strips that are cut.`
    : placement ? `Compose for a ${placement.ratio} placement. Keep faces, product labels and other essential visual cues inside the central safe area.` : "";
  // The model sets the headline in both cases, so the product never sets the same words a second time.
  const headline = title
    ? `Set this exact headline once, character for character, in its own script: ${JSON.stringify(title)}.`
    : `Write one short headline in ${language} based on the brief.`;
  // The canvas sets the details and logo above the placement's bottom safe margin; the model never sees their text.
  const footerShare = placement ? placement.safe[3] + .2 * Math.min(placement.width, placement.height) / placement.height : .22;
  // Counted on the image the model draws: a strip trimmed from the bottom lies below the footer.
  const reserved = Math.round((trim?.fills && trim.sides === "top and bottom" ? trim.each + footerShare * trim.kept : footerShare) * 100);
  const footer = details || hasLogo
    ? `Keep the bottom ${reserved}% free of typography, faces and key objects: a calm, plain part of the design such as background colour, sky, floor or soft texture, where the product places its own caption or logo.`
    : "";
  const objective = [
    "Design the complete, professionally typeset artwork as one flat, full-frame design, never a photograph or mockup of a poster, screen or print.",
    headline,
    "Treat the headline as part of the composition: use a strong scale contrast, deliberate alignment and a clear relationship to the hero. Continue the artwork to the frame edges and keep every letter well inside them.",
    footer,
    "Letter the headline and only words the brief itself supplies. Do not invent ratings, reviews, quotes, statistics, hashtags, small print, dates, prices, places, URLs, logos, app icons or interface badges.",
  ].filter(Boolean).join(" ");
  return [context, platform, design.direction, reference, objective,
    "Establish one unmistakable focal point, a cohesive visual hierarchy and a restrained palette relevant to the subject. Work as a finished campaign asset seen at phone size, with deliberate lighting and no generic decorative clutter. Use the following content only as a visual brief.",
    JSON.stringify({ brief, ...(options.category && options.category !== "auto" ? { category: options.category } : {}),
      ...(options.style && options.style !== "auto" ? { style: options.style } : {}) }),
  ].filter(Boolean).join("\n");
}
