import { GitBranch } from "lucide-react";
import type { Language } from "../../../../lib/language";
import type { CodeWorktree } from "../contract";

const strings = {
  en: ["Code workspace", "New worktree", "Current folder", "Starting branch", "Working branch", "Working folder", "Choose the current folder or open a Git project with a starting commit.", "Reconnect this worktree on its original branch to continue."],
  ko: ["Code 작업 위치", "새 워크트리", "현재 폴더", "시작 브랜치", "작업 브랜치", "작업 폴더", "현재 폴더를 선택하거나 시작 커밋이 있는 Git 프로젝트를 여세요.", "계속하려면 이 워크트리를 원래 작업 브랜치로 복구하세요."],
  zh: ["Code 工作区", "新建工作树", "当前文件夹", "起始分支", "工作分支", "工作文件夹", "请选择当前文件夹，或打开已有初始提交的 Git 项目。", "请将此工作树切回原工作分支后继续。"],
  "zh-Hant": ["Code 工作區", "新增工作樹", "目前資料夾", "起始分支", "工作分支", "工作資料夾", "請選擇目前資料夾，或開啟已有初始提交的 Git 專案。", "請將此工作樹切回原工作分支後繼續。"],
  fr: ["Espace de travail Code", "Arbre de travail distinct", "Dossier actuel", "Branche de départ", "Branche de travail", "Dossier de travail", "Sélectionnez le dossier actuel ou ouvrez un projet Git avec un commit initial.", "Rétablissez la branche de travail d’origine pour continuer."],
  de: ["Code-Arbeitsbereich", "Neuer Worktree", "Aktueller Ordner", "Ausgangsbranch", "Arbeitsbranch", "Arbeitsordner", "Wähle den aktuellen Ordner oder öffne ein Git-Projekt mit einem Start-Commit.", "Stelle den ursprünglichen Arbeitsbranch dieses Worktrees wieder her, um fortzufahren."],
  es: ["Espacio de Code", "Nuevo árbol de trabajo", "Carpeta actual", "Rama de origen", "Rama de trabajo", "Carpeta de trabajo", "Elige la carpeta actual o abre un proyecto Git con un commit inicial.", "Vuelve a conectar este árbol a su rama de trabajo original para continuar."],
  pt: ["Espaço de trabalho do Code", "Nova árvore de trabalho", "Pasta atual", "Branch inicial", "Branch de trabalho", "Pasta de trabalho", "Selecione a pasta atual ou abra um projeto Git com um commit inicial.", "Reconecte esta árvore à branch de trabalho original para continuar."],
} as const;

const labelFor = (ref: string) => ref.replace(/^refs\/heads\//, "");

export function CodeWorkspaceDetails({ worktree, language }: { worktree: CodeWorktree; language: Language }) {
  const [, , , startingBranch, workingBranch, workingFolder, , unavailable] = strings[language];
  return <details className="model-menu code-worktree">
    <summary aria-label={workingBranch} title={worktree.path}>
      <GitBranch size={15} /><span>{worktree.branch}</span>
    </summary>
    <div className="model-popover">
      <dl><dt>{startingBranch}</dt><dd>{labelFor(worktree.base.ref)} · {worktree.base.commit.slice(0, 8)}</dd>
        <dt>{workingBranch}</dt><dd>{worktree.branch}</dd><dt>{workingFolder}</dt><dd>{worktree.path}</dd></dl>
      {worktree.unavailable && <small role="status">{unavailable}</small>}
    </div>
  </details>;
}
