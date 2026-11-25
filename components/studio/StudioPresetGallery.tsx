"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Search } from "lucide-react";
import { STUDIO_PHOTO_CATEGORIES, STUDIO_PHOTO_PRESETS, studioPresetName, type StudioPhotoCategory } from "@/lib/studioPresetLibrary";
import { useStudioCopy } from "./StudioControls";
import styles from "./studio.module.css";

const categoryLabels = {
  film: "presetFilm", art: "presetArt", animation: "presetAnimation", miniature: "presetMiniature",
  style: "presetStyle", scene: "presetScene", design: "presetDesign", playful: "presetPlayful",
} as const;
const pageSize = 12;

export function StudioPresetGallery({ studioPath }: { studioPath: string }) {
  const { copy, lang } = useStudioCopy();
  const [category, setCategory] = useState<StudioPhotoCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(pageSize);
  const query = search.trim().toLocaleLowerCase(lang);
  const filtered = STUDIO_PHOTO_PRESETS.filter(preset => (
    (category === "all" || preset.category === category) &&
    (!query || [studioPresetName(preset, lang), studioPresetName(preset, "en"), copy[categoryLabels[preset.category]]]
      .some(label => label.toLocaleLowerCase(lang).includes(query)))
  ));

  return <>
    <div className={styles.presetToolbar}>
      <label className={styles.presetSearch}>
        <Search size={17} aria-hidden />
        <input type="search" aria-label={copy.photoPresetSearch} placeholder={copy.photoPresetSearch} value={search}
          onChange={event => { setSearch(event.target.value); setLimit(pageSize); }} />
      </label>
      <div className={styles.presetCategories} aria-label={copy.designGroup} role="group">
        {(["all", ...STUDIO_PHOTO_CATEGORIES] as const).map(option => (
          <button key={option} type="button" className={category === option ? styles.choiceActive : styles.secondary}
            aria-pressed={category === option}
            onClick={() => { setCategory(option); setLimit(pageSize); }}>
            {option === "all" ? copy.allPresets : copy[categoryLabels[option]]}
          </button>
        ))}
      </div>
    </div>
    {filtered.length === 0 ? <p className={styles.hint} role="status">{copy.noMatchingPresets}</p> : (
      <ul className={styles.presetGrid}>
        {filtered.slice(0, limit).map(preset => (
          <li key={preset.id}>
            <Link className={styles.presetCard} data-testid={`studio-preset-${preset.id}`}
              href={{ pathname: `${studioPath}/${preset.tool}`, query: { lang, preset: preset.id } }}>
              <Image src={`/studio/${preset.artwork}`} alt="" width={360} height={360} unoptimized data-cutout={preset.id === "transparent" || undefined} />
              <span>{studioPresetName(preset, lang)}<ArrowRight size={16} aria-hidden /></span>
            </Link>
          </li>
        ))}
      </ul>
    )}
    {filtered.length > limit && <button type="button" className={styles.presetMore + " " + styles.secondary}
      onClick={() => setLimit(current => current + pageSize)}>{copy.showMorePresets}</button>}
  </>;
}
