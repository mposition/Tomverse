import type { Language } from "@/lib/language";
import { projectWorkspaceEn, type ProjectWorkspaceCopy } from "./projectWorkspace.en";
import { projectWorkspaceKo } from "./projectWorkspace.ko";
import { projectWorkspaceZh } from "./projectWorkspace.zh";
import { projectWorkspaceZhHant } from "./projectWorkspace.zhHant";
import { projectWorkspaceFr } from "./projectWorkspace.fr";
import { projectWorkspaceDe } from "./projectWorkspace.de";
import { projectWorkspaceEs } from "./projectWorkspace.es";
import { projectWorkspacePt } from "./projectWorkspace.pt";

/** Project workspace copy for every supported language; each shares the English shape. */
export const projectWorkspaceCopy: Record<Language, ProjectWorkspaceCopy> = {
    en: projectWorkspaceEn,
    ko: projectWorkspaceKo,
    zh: projectWorkspaceZh,
    "zh-Hant": projectWorkspaceZhHant,
    fr: projectWorkspaceFr,
    de: projectWorkspaceDe,
    es: projectWorkspaceEs,
    pt: projectWorkspacePt,
};
