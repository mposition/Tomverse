import type { Language } from "@/lib/language";
import { cliPageTranslations } from "./cliPageContent.i18n";

/**
 * Copy for the CLI install page (approved concept, owner 2026-11-20; installers and
 * winget, owner 2026-11-21). Korean is the approved wording; English and the six other
 * locales follow its meaning.
 *
 * Facts come from apps/tomverse-cli (README.md, RELEASING.md, package.json, src/main.ts).
 * Commands, paths, file names, package and tool names, and the names Windows, macOS and
 * Linux are not copy: they live in CliPage.tsx and cliRelease.ts and stay identical in
 * every language.
 */
export type CliPageCopy = {
  seo: { title: string; description: string };
  crumb: { home: string; developers: string; current: string };
  hero: {
    title: [string, string];
    lede: string;
    /** `{os}` is replaced with Windows, macOS or Linux. */
    downloadFor: string;
    /** Shown when there is no installer to offer (a phone, an unknown system, the static render). */
    showInstall: string;
    otherOs: string;
    mobileNote: string;
    noNode: string;
    plan: string;
    notarized: string;
    terminalTitle: string;
    terminalLabel: string;
    installed: string;
    motionOff: string;
    motionOn: string;
  };
  install: {
    eyebrow: string;
    title: string;
    osLabel: string;
    /** Marks the tab of the visitor's own system. */
    detected: string;
    recommended: string;
    windows: {
      oneLineTitle: string;
      oneLineBody: string;
      installerTitle: string;
      installerBody: string;
      /** [before, bold, after]: the SmartScreen notice, with the click path in bold. */
      smartScreen: [string, string, string];
    };
    macos: { installerTitle: string; installerBody: string };
    linux: { packageTitle: string; packageBody: string };
    npmTitle: string;
    stepKeyUnix: string;
    stepKeyWin: string;
    stepCheck: string;
    keyNote: string;
    reqTitle: string;
    /** [label, value] rows; the plan row links to pricing and the key row to Settings. */
    req: { os: [string, string]; node: [string, string]; plan: [string, string]; key: [string, string]; tools: [string, string] };
    capNote: string;
  };
  downloads: {
    eyebrow: string;
    title: string;
    cols: { os: string; cpu: string; file: string; format: string; sha: string };
    installer: string;
    installerNotarized: string;
    package: string;
    archive: string;
    archiveNote: string;
    all: string;
    release: string;
  };
  first: {
    eyebrow: string;
    title: [string, string];
    /** Four steps; `cmd` is what the person types or answers. */
    steps: Array<{ k: string; h: string; cmd: string; p: string }>;
  };
  safe: {
    eyebrow: string;
    title: [string, string];
    ticks: Array<[string, string]>;
    terminalLabel: string;
    exampleNote: string;
  };
  update: {
    eyebrow: string;
    title: string;
    windows: { upgrade: string; remove: string; msi: string; msiHow: string };
    macos: { update: string; updateHow: string; remove: string };
    linux: { deb: string; rpm: string; npm: string };
    removeNote: string;
  };
  cta: { title: [string, string]; body: string; connect: string; key: string };
  copy: string;
  copied: string;
};

const ko: CliPageCopy = {
  seo: {
    title: "Tomverse CLI 설치",
    description: "Windows, macOS, Linux용 Tomverse 코딩 에이전트 CLI의 설치 프로그램과 winget, npm 설치 방법, 요구 사항, 첫 실행과 업데이트 방법입니다.",
  },
  crumb: { home: "Tomverse", developers: "개발자", current: "CLI 설치" },
  hero: {
    title: ["터미널에서 바로,", "내 폴더의 코딩 에이전트."],
    lede: "설치 프로그램 하나로 깔고, Tomverse API 키만 넣으면 됩니다. 코드를 읽고 diff를 제안하고, 승인한 명령만 실행한 뒤 무엇을 했고 얼마가 들었는지 알려 줍니다.",
    downloadFor: "{os}용 다운로드",
    showInstall: "운영체제별 설치 보기",
    otherOs: "다른 운영체제",
    mobileNote: "휴대폰에서는 설치할 수 없어서, 다운로드 대신 아래 안내로 보냅니다.",
    noNode: "Node.js 필요 없음",
    plan: "Pro 이상",
    notarized: "macOS 공증",
    terminalTitle: "PowerShell — 설치 후 첫 실행",
    terminalLabel: "Windows에서 설치하고 tomverse doctor를 실행한 예시",
    installed: "성공적으로 설치됨",
    motionOff: "애니메이션 멈추기",
    motionOn: "애니메이션 다시 재생",
  },
  install: {
    eyebrow: "설치",
    title: "쓰는 운영체제를 고르세요.",
    osLabel: "운영체제",
    detected: "감지됨",
    recommended: "추천",
    windows: {
      oneLineTitle: "1. 설치 — 명령 한 줄",
      oneLineBody: "Windows 패키지 관리자로 설치합니다. 업데이트와 삭제도 같은 명령으로 합니다.",
      installerTitle: "또는 설치 프로그램 받기",
      installerBody: "더블클릭으로 설치하고, PATH에 자동으로 등록됩니다. 관리자 권한이 필요 없습니다.",
      smartScreen: ["처음 실행할 때 \"Windows에서 PC를 보호했습니다\"가 보이면 ", "추가 정보 › 실행", "을 누르세요. 아직 Windows 게시자 서명이 없어서 생기는 화면입니다."],
    },
    macos: {
      installerTitle: "1. 설치 프로그램 받기",
      installerBody: "Apple 공증을 받은 설치 파일입니다. 더블클릭하면 /usr/local/bin/tomverse에 설치됩니다.",
    },
    linux: {
      packageTitle: "1. 패키지 받고 설치",
      packageBody: "배포판에 맞는 파일을 받아 패키지 관리자로 설치합니다. glibc 2.28 이상.",
    },
    npmTitle: "또는 Node.js가 있다면",
    stepKeyUnix: "2. 새 터미널을 열고, 이 터미널에서만 쓸 API 키 넣기",
    stepKeyWin: "2. 새 창을 열고, 이 창에서만 쓸 API 키 넣기",
    stepCheck: "3. 연결 확인",
    keyNote: "키를 환경 변수로 넣지 않으면 실행할 때 가려진 입력으로 묻습니다. 입력한 키는 그 실행 동안 메모리에만 있습니다.",
    reqTitle: "필요한 것",
    req: {
      os: ["운영체제", "Windows 10·11 · macOS · Linux"],
      node: ["Node.js", "설치 프로그램은 필요 없음 · npm은 22 이상"],
      plan: ["플랜", "Pro 이상"],
      key: ["Tomverse API 키", "설정 › 개발자 ↗"],
      tools: ["Claude Code · Codex", "필요 없음"],
    },
    capNote: "Free 플랜에서는 API 키와 CLI를 쓸 수 없습니다. 키에 크레딧 한도를 걸어 두면 그 한도에서 멈춥니다.",
  },
  downloads: {
    eyebrow: "모든 다운로드",
    title: "필요한 파일을 직접 고르세요.",
    cols: { os: "운영체제", cpu: "CPU", file: "파일", format: "형식", sha: "확인용 SHA-256" },
    installer: "설치 프로그램",
    installerNotarized: "설치 프로그램 · 공증",
    package: "패키지",
    archive: "압축 파일",
    archiveNote: ".zip · .tar.gz (실행 파일만, 원하는 폴더에)",
    all: "모든 운영체제",
    release: "GitHub Release ↗",
  },
  first: {
    eyebrow: "첫 실행",
    title: ["설치부터 첫 수정까지,", "네 번이면 됩니다."],
    steps: [
      { k: "01 · 폴더로", h: "작업할 폴더에서 열기", cmd: "cd ~/projects/my-app", p: "CLI는 지금 폴더의 코드만 읽습니다. 처음 열 때 이 폴더를 믿을지 한 번 묻습니다." },
      { k: "02 · 모델", h: "쓸 모델 고르기", cmd: "tomverse models", p: "키로 쓸 수 있는 모델과 요청당 크레딧이 정수로 나옵니다. 스마트 자동(Smart Adaptive)은 고르는 모델에 따라 달라서 범위로 표시됩니다." },
      { k: "03 · 부탁", h: "할 일을 말하기", cmd: "tomverse \"테스트 고쳐 줘\"", p: "바꿀 내용을 diff로 먼저 보여 줍니다." },
      { k: "04 · 승인", h: "적용하고 실행", cmd: "[y/n] y", p: "승인한 변경과 명령만 실행하고, 끝나면 비용을 알려 줍니다." },
    ],
  },
  safe: {
    eyebrow: "안전하게",
    title: ["내 컴퓨터에서 도는 만큼,", "지켜야 할 선이 분명합니다."],
    ticks: [
      ["키는 설정, 세션, 로그 어디에도 쓰지 않습니다", "실행하는 명령에도 넘기지 않고, 키를 받는 명령줄 옵션도 없습니다."],
      ["연결은 https로 정한 주소에만", "리디렉션을 따라가지 않아 키가 다른 주소로 가지 않습니다."],
      ["저장소 안의 파일은 권한을 바꿀 수 없습니다", "AGENTS.md, 스크립트, 모델 출력도 주소·키·권한을 바꾸지 못합니다."],
      ["승인한 명령은 내 계정 권한으로 실행됩니다", "작업 폴더는 샌드박스가 아닙니다. 그래서 명령은 프로그램과 인수를 보여 주고 매번 묻습니다."],
    ],
    terminalLabel: "tomverse doctor 실행 예시",
    exampleNote: "예시 출력입니다. 실제 출력은 영어이고, 항목과 숫자는 환경과 키마다 다릅니다. tomverse doctor는 모델 요청을 보내지 않습니다.",
  },
  update: {
    eyebrow: "업데이트 · 삭제",
    title: "설치한 방법 그대로 업데이트하고 지웁니다.",
    windows: { upgrade: "winget 업데이트", remove: "winget 삭제", msi: ".msi로 설치했다면", msiHow: "설정 › 앱에서 제거" },
    macos: { update: "업데이트", updateHow: "새 .pkg를 다시 설치", remove: "삭제" },
    linux: { deb: ".deb 삭제", rpm: ".rpm 삭제", npm: "npm 업데이트" },
    removeNote: "키를 정리하려면 설정 › API 키에서 폐기하세요. 이 컴퓨터에 저장된 세션은 ~/.tomverse 폴더를 지우면 사라집니다.",
  },
  cta: {
    title: ["이미 쓰는 코딩 도구가 있다면,", "그 도구에 연결해도 됩니다."],
    body: "Codex, Claude Code, Cursor, VS Code, Aside와 OpenAI 호환 도구.",
    connect: "도구별 연결 방법",
    key: "API 키 만들기",
  },
  copy: "복사",
  copied: "복사됨",
};

const en: CliPageCopy = {
  seo: {
    title: "Install the Tomverse CLI",
    description: "Installers for Windows, macOS and Linux, plus winget and npm commands, requirements, first run and updates for the Tomverse coding agent CLI.",
  },
  crumb: { home: "Tomverse", developers: "Developers", current: "CLI install" },
  hero: {
    title: ["Right in your terminal,", "a coding agent for your folder."],
    lede: "Install it with one installer and all you need is a Tomverse API key. It reads your code, proposes a diff, runs only the commands you approve, then tells you what it did and what it cost.",
    downloadFor: "Download for {os}",
    showInstall: "See installs by operating system",
    otherOs: "Other operating systems",
    mobileNote: "It cannot be installed on a phone, so this sends you to the instructions below instead of a download.",
    noNode: "No Node.js needed",
    plan: "Pro or above",
    notarized: "macOS notarized",
    terminalTitle: "PowerShell — first run after install",
    terminalLabel: "Example of installing on Windows and running tomverse doctor",
    installed: "Successfully installed",
    motionOff: "Pause animation",
    motionOn: "Resume animation",
  },
  install: {
    eyebrow: "Install",
    title: "Pick your operating system.",
    osLabel: "Operating system",
    detected: "detected",
    recommended: "Recommended",
    windows: {
      oneLineTitle: "1. Install — one command",
      oneLineBody: "Installs with the Windows package manager. Updating and uninstalling use the same tool.",
      installerTitle: "Or download the installer",
      installerBody: "Double-click to install; it is added to PATH automatically. No administrator rights needed.",
      smartScreen: ["If \"Windows protected your PC\" appears the first time you run it, choose ", "More info › Run anyway", ". It appears because there is no Windows publisher signature yet."],
    },
    macos: {
      installerTitle: "1. Download the installer",
      installerBody: "An installer notarized by Apple. Double-click it and it installs to /usr/local/bin/tomverse.",
    },
    linux: {
      packageTitle: "1. Download and install the package",
      packageBody: "Download the file for your distribution and install it with the package manager. glibc 2.28 or later.",
    },
    npmTitle: "Or, if you have Node.js",
    stepKeyUnix: "2. Open a new terminal and set an API key for that terminal only",
    stepKeyWin: "2. Open a new window and set an API key for that window only",
    stepCheck: "3. Check the connection",
    keyNote: "If you do not set the key as an environment variable, the CLI asks for it with hidden input. A typed key stays in memory for that run only.",
    reqTitle: "What you need",
    req: {
      os: ["Operating system", "Windows 10·11 · macOS · Linux"],
      node: ["Node.js", "Not needed for the installers · 22 or later for npm"],
      plan: ["Plan", "Pro or above"],
      key: ["Tomverse API key", "Settings › Developer ↗"],
      tools: ["Claude Code · Codex", "Not needed"],
    },
    capNote: "The Free plan cannot use API keys or the CLI. If you set a credit limit on the key, the CLI stops at that limit.",
  },
  downloads: {
    eyebrow: "All downloads",
    title: "Pick the file yourself.",
    cols: { os: "Operating system", cpu: "CPU", file: "File", format: "Format", sha: "SHA-256 to verify" },
    installer: "Installer",
    installerNotarized: "Installer · notarized",
    package: "Package",
    archive: "Archive",
    archiveNote: ".zip · .tar.gz (the executable only, into any folder)",
    all: "Any operating system",
    release: "GitHub Release ↗",
  },
  first: {
    eyebrow: "First run",
    title: ["From install to first edit,", "four steps."],
    steps: [
      { k: "01 · Folder", h: "Open your project folder", cmd: "cd ~/projects/my-app", p: "The CLI reads only the code in the current folder. The first time, it asks once whether to trust the folder." },
      { k: "02 · Model", h: "Choose a model", cmd: "tomverse models", p: "Lists the models your key can use and the credits per request as whole numbers. Smart Adaptive depends on the model it picks, so it shows a range." },
      { k: "03 · Ask", h: "Say what to do", cmd: "tomverse \"fix the failing test\"", p: "It shows the change as a diff first." },
      { k: "04 · Approve", h: "Apply and run", cmd: "[y/n] y", p: "Only the changes and commands you approve are run. When it finishes, it reports the cost." },
    ],
  },
  safe: {
    eyebrow: "Safety",
    title: ["Because it runs on your computer,", "the lines are clear."],
    ticks: [
      ["The key is never written to settings, sessions or logs", "It is not passed to the commands it runs, and no command-line option takes a key."],
      ["It connects only to the https address it is set to", "It does not follow redirects, so the key cannot be carried to another address."],
      ["No file in the repository can change its permissions", "AGENTS.md, scripts and model output cannot change the address, the key or any permission."],
      ["An approved command runs with your own account’s permissions", "The folder is not a sandbox. That is why every command shows its program and arguments and asks each time."],
    ],
    terminalLabel: "Example tomverse doctor run",
    exampleNote: "Example output. The real output is in English, and the items and numbers vary with your setup and key. tomverse doctor sends no model request.",
  },
  update: {
    eyebrow: "Update · Uninstall",
    title: "Update and uninstall the way you installed.",
    windows: { upgrade: "winget update", remove: "winget uninstall", msi: "If you used the .msi", msiHow: "Remove it in Settings › Apps" },
    macos: { update: "Update", updateHow: "Install the new .pkg again", remove: "Uninstall" },
    linux: { deb: "Uninstall the .deb", rpm: "Uninstall the .rpm", npm: "npm update" },
    removeNote: "To clean up the key, revoke it in Settings › API keys. Sessions saved on this computer disappear when you delete the ~/.tomverse folder.",
  },
  cta: {
    title: ["Already have a coding tool?", "Connect it instead."],
    body: "Codex, Claude Code, Cursor, VS Code, Aside and OpenAI-compatible tools.",
    connect: "How to connect each tool",
    key: "Create an API key",
  },
  copy: "Copy",
  copied: "Copied",
};

export const cliPageContent: Record<Language, CliPageCopy> = { ko, en, ...cliPageTranslations };

export const cliPageSeo = Object.fromEntries(
  (Object.keys(cliPageContent) as Language[]).map((lang) => [lang, cliPageContent[lang].seo]),
) as Record<Language, { title: string; description: string }>;
