// Build the sample files a chat-attachment staging round needs.
//
//   node scripts/make-chat-attachment-staging-kit.mjs [--out <dir>]
//
// `AGENTS.md` -> "사람에게 남기는 것은 사람만 할 수 있는 것뿐입니다": an agent
// that can make a fixture does not hand the human a shopping list. Everything
// here is machine-makeable, so it is made here, with a manifest that says what
// the right answer is -- a sample without an answer key asks someone to judge a
// model's reply against nothing.
//
// The legacy Office samples are produced here, and what they prove is a
// narrower claim than the one §C makes -- but it is not nothing, and the two
// were conflated once already. CI runs the parsers over
// `tests/fixtures/legacyOffice/` in isolation; it never carries a legacy file
// through upload, R2, finalize and into a prompt on a deployed build. These
// files verify that wiring. Only a file Word itself saved verifies the parser
// against Word's own byte layout, and that is the human's part.
//
// What this deliberately does NOT produce:
//
//   * a genuinely encrypted legacy document. LibreOffice accepts
//     `Password=` on the MS Word 97 and MS Excel 97 filters and silently
//     writes an unencrypted file -- verified 2026-08-23, both parsed straight
//     through. Shipping that as an "encrypted" sample would test the opposite
//     of what it claims.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argument = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] ?? null;
};

const out = argument("out") ?? "chat-attachment-staging-kit";
mkdirSync(out, { recursive: true });

/* ------------------------------------------------------- the source archive */

// Five files the reader takes and two it skips. The two are build output
// (`.class`, `.pyc`), which is skipped rather than fatal precisely because a
// source tree ships it -- so this archive is the ordinary case, not a trap.
const TREE = {
  "README.md": `# Ledger Service

작은 원장 서비스입니다. 계좌별 잔액을 잠금 아래에서 갱신하고,
잔액이 음수가 되는 경로를 거부합니다.

- \`src/app/ledger.py\` — 잔액 갱신
- \`src/main/java/app/Main.java\` — 진입점
- \`src/app/config.yaml\` — 한도 설정
- \`docs/limits.csv\` — 플랜별 한도표
`,
  "src/app/ledger.py": `"""계좌 잔액을 잠금 아래에서 갱신한다."""

MINIMUM_BALANCE = 0


def apply_delta(balance: int, delta: int) -> int:
    result = balance + delta
    if result < MINIMUM_BALANCE:
        raise ValueError("balance would go negative")
    return result


def reserve(balance: int, amount: int) -> int:
    return apply_delta(balance, -amount)
`,
  "src/main/java/app/Main.java": `package app;

public final class Main {
    public static void main(String[] args) {
        System.out.println("ledger service starting");
    }
}
`,
  "src/app/config.yaml": `ledger:
  minimumBalance: 0
  lockTimeoutMs: 5000
plans:
  free: 100
  pro: 5000
  max: 20000
`,
  "docs/limits.csv": `plan,monthlyCredits,concurrentChats
free,100,1
pro,5000,3
max,20000,5
`,
  "build/classes/Main.class": "compiled class placeholder\n",
  "__pycache__/ledger.cpython-311.pyc": "python bytecode placeholder\n",
};

const READ_BY_THE_ARCHIVE = [
  "README.md",
  "docs/limits.csv",
  "src/app/config.yaml",
  "src/app/ledger.py",
  "src/main/java/app/Main.java",
];
const SKIPPED_BY_THE_ARCHIVE = [
  "build/classes/Main.class",
  "__pycache__/ledger.cpython-311.pyc",
];

const staging = mkdtempSync(join(tmpdir(), "attachment-kit-"));
try {
  for (const [path, body] of Object.entries(TREE)) {
    const full = join(staging, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  execFileSync("zip", ["-qr", join(resolve(out), "ledger-source.zip"), "."], {
    cwd: staging,
  });
} finally {
  rmSync(staging, { recursive: true, force: true });
}

/* ------------------------------------------------------------------- images */

const { default: sharp } = await import("sharp");

const W = 480;
const H = 320;
const bars = (a, b, c) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>` +
    `<rect x="40" y="${280 - a}" width="100" height="${a}" fill="#e11d48"/>` +
    `<rect x="190" y="${280 - b}" width="100" height="${b}" fill="#2563eb"/>` +
    `<rect x="340" y="${280 - c}" width="100" height="${c}" fill="#16a34a"/>` +
    `<rect x="20" y="20" width="440" height="280" fill="none" stroke="#111111" stroke-width="4"/>` +
    `</svg>`
);

const still = await sharp(bars(200, 140, 240)).gif().toBuffer();
writeFileSync(join(out, "chart-still.gif"), still);

// The animated one reuses the still's own image block. Re-encoding four
// frames through libvips needs page metadata this does not have, and the
// point of the sample is the frame count, which the block structure carries.
writeFileSync(join(out, "chart-animated.gif"), animate(still, 4));

function animate(gif, frames) {
  if (gif.subarray(0, 3).toString("latin1") !== "GIF") throw new Error("not a GIF");
  let at = 6;
  const screen = gif.subarray(at, at + 7);
  at += 7;
  let palette = Buffer.alloc(0);
  if (screen[4] & 0x80) {
    const size = 3 * 2 ** ((screen[4] & 0x07) + 1);
    palette = gif.subarray(at, at + size);
    at += size;
  }
  const endOfBlocks = (from) => {
    let cursor = from;
    while (gif[cursor] !== 0) cursor += 1 + gif[cursor];
    return cursor + 1;
  };
  let image = null;
  while (at < gif.length && gif[at] !== 0x3b) {
    if (gif[at] === 0x21) {
      at = endOfBlocks(at + 2);
      continue;
    }
    if (gif[at] !== 0x2c) throw new Error(`unexpected block ${gif[at].toString(16)}`);
    const start = at;
    at += 10;
    const packed = gif[start + 9];
    if (packed & 0x80) at += 3 * 2 ** ((packed & 0x07) + 1);
    at += 1;
    image = gif.subarray(start, endOfBlocks(at));
    break;
  }
  if (!image) throw new Error("no image block");
  const control = Buffer.from([0x21, 0xf9, 0x04, 0x04, 0x1e, 0x00, 0x00, 0x00]);
  const loop = Buffer.from("21ff0b4e45545343415045322e300301000000", "hex");
  return Buffer.concat([
    Buffer.from("GIF89a"),
    screen,
    palette,
    loop,
    ...Array.from({ length: frames }, () => Buffer.concat([control, image])),
    Buffer.from([0x3b]),
  ]);
}

/* ------------------------------------ loose files, and one near the ceiling */

// Picked with the OS file picker, not dropped: these are the extensions whose
// browser-reported media type came back empty and was refused before the
// server saw a byte. That regression is why §E exists.
writeFileSync(join(out, "picker-notes.md"), TREE["README.md"]);
writeFileSync(join(out, "picker-limits.csv"), TREE["docs/limits.csv"]);
writeFileSync(join(out, "picker-ledger.py"), TREE["src/app/ledger.py"]);
writeFileSync(
  join(out, "picker-config.json"),
  `{\n  "ledger": { "minimumBalance": 0, "lockTimeoutMs": 5000 },\n  "plans": { "free": 100, "pro": 5000, "max": 20000 }\n}\n`
);

const rows = [];
for (let i = 0; i < 120_000; i += 1) {
  rows.push(
    `${String(i).padStart(7, "0")}  ledger entry  account=acct-${String(i % 997).padStart(4, "0")}` +
      `  delta=${String((i * 37) % 1000 - 500).padStart(5, "+0")}  balance=${String((i * 11) % 100_000).padStart(7, "0")}`
  );
}
writeFileSync(join(out, "large-ledger-log.txt"), rows.join("\n"));

/* ------------------------------------------------------- legacy Office, RTF */

// Written as flat ODF and converted, so the source of every sentence in the
// sample is readable in this file. Korean throughout on purpose: the parsers
// take a different path for it (UTF-16 in `.doc`, the SST in `.xls`,
// TextCharsAtom rather than TextBytesAtom in `.ppt`) than they do for Latin
// text, and a sample that never leaves ASCII never walks it.
const LEGACY_BODY = {
  headline: "원장 서비스 운영 정책 2026년 3분기",
  balance:
    "계좌 잔액은 어떤 경로로도 음수가 될 수 없습니다. 예약과 환급은 같은 " +
    "트랜잭션에서 계좌 잠금을 가장 먼저 잡고, 잠금 없이 잔액을 읽어 판정하는 " +
    "경로는 금지합니다.",
  plans:
    "Free 요금제는 월 100 크레딧에 동시 대화 1개, Pro는 월 5000 크레딧에 3개, " +
    "Max는 월 20000 크레딧에 5개입니다. 이 숫자는 관리자 콘솔에서만 바꿉니다.",
  timeout:
    "계좌 잠금의 시간 초과는 5000밀리초입니다. 초과하면 트랜잭션을 되돌리고 " +
    "사용자에게는 다시 시도하라고 안내합니다. 부분 적용된 상태를 남기지 않습니다.",
};

const FODT = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.text">
<office:body><office:text>
<text:h text:outline-level="1">${LEGACY_BODY.headline}</text:h>
<text:p>이 문서는 채팅 첨부 검증에 쓰이는 견본입니다. 아래 세 문단이 답에 인용되어야 합니다.</text:p>
<text:h text:outline-level="2">1. 잔액 불변식</text:h>
<text:p>${LEGACY_BODY.balance}</text:p>
<text:h text:outline-level="2">2. 플랜별 한도</text:h>
<text:p>${LEGACY_BODY.plans}</text:p>
<text:h text:outline-level="2">3. 잠금 시간 초과</text:h>
<text:p>${LEGACY_BODY.timeout}</text:p>
</office:text></office:body></office:document>
`;

const cell = (value, numeric) =>
  numeric
    ? `<table:table-cell office:value-type="float" office:value="${value}"><text:p>${value}</text:p></table:table-cell>`
    : `<table:table-cell office:value-type="string"><text:p>${value}</text:p></table:table-cell>`;
const row = (cells) => `<table:table-row>${cells}</table:table-row>`;

const FODS = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
<office:body><office:spreadsheet>
<table:table table:name="플랜한도">
${row(cell("플랜") + cell("월 크레딧") + cell("동시 대화"))}
${row(cell("무료") + cell(100, true) + cell(1, true))}
${row(cell("프로") + cell(5000, true) + cell(3, true))}
${row(cell("맥스") + cell(20000, true) + cell(5, true))}
</table:table>
<table:table table:name="잠금설정">
${row(cell("잠금 시간 초과(밀리초)") + cell(5000, true))}
${row(cell("최소 잔액") + cell(0, true))}
</table:table>
</office:spreadsheet></office:body></office:document>
`;

const slide = (title, lines) =>
  `<draw:page draw:name="${title}">` +
  `<draw:frame svg:x="2cm" svg:y="3cm" svg:width="20cm" svg:height="3cm"><draw:text-box><text:p>${title}</text:p></draw:text-box></draw:frame>` +
  `<draw:frame svg:x="2cm" svg:y="7cm" svg:width="20cm" svg:height="8cm"><draw:text-box>` +
  lines.map((line) => `<text:p>${line}</text:p>`).join("") +
  `</draw:text-box></draw:frame></draw:page>`;

const FODP = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.presentation">
<office:body><office:presentation>
${slide("원장 서비스 운영 정책", ["2026년 3분기 검토"])}
${slide("잔액 불변식", ["계좌 잔액은 음수가 될 수 없다", "예약과 환급은 계좌 잠금을 먼저 잡는다", "잠금 시간 초과는 5000밀리초"])}
${slide("플랜별 한도", ["무료 월 100 크레딧 동시 대화 1개", "프로 월 5000 크레딧 동시 대화 3개", "맥스 월 20000 크레딧 동시 대화 5개"])}
</office:presentation></office:body></office:document>
`;

// RTF is written directly: it is text, and going through a converter would
// hide which escapes the sample actually carries. `\\uN` with a `?` fallback
// is what a real word processor emits for Korean, so that is what this emits.
const rtfEscape = (text) =>
  [...text]
    .map((character) => {
      const code = character.codePointAt(0);
      if (code < 128) return character.replace(/([\\{}])/g, "\\$1");
      return `\\u${code}?`;
    })
    .join("");

const RTF =
  `{\\rtf1\\ansi\\ansicpg1252\\deff0` +
  `{\\fonttbl{\\f0\\fnil Malgun Gothic;}}` +
  `{\\stylesheet{\\s0 Normal;}}` +
  `\\f0\\fs24 ` +
  [LEGACY_BODY.headline, LEGACY_BODY.balance, LEGACY_BODY.plans, LEGACY_BODY.timeout]
    .map((paragraph) => rtfEscape(paragraph))
    .join("\\par ") +
  `\\par }`;

writeFileSync(join(out, "policy-libreoffice.rtf"), RTF, "latin1");

const office = mkdtempSync(join(tmpdir(), "attachment-office-"));
const legacyMade = [];
try {
  const convert = (source, body, filter, produced, final) => {
    writeFileSync(join(office, source), body);
    execFileSync(
      "soffice",
      ["--headless", `--convert-to`, filter, "--outdir", office, join(office, source)],
      { env: { ...process.env, HOME: office }, stdio: "ignore" }
    );
    writeFileSync(join(resolve(out), final), readFileSync(join(office, produced)));
    legacyMade.push(final);
  };
  convert("policy.fodt", FODT, "doc:MS Word 97", "policy.doc", "policy-libreoffice.doc");
  convert("policy.fods", FODS, "xls:MS Excel 97", "policy.xls", "policy-libreoffice.xls");
  convert("policy.fodp", FODP, "ppt:MS PowerPoint 97", "policy.ppt", "policy-libreoffice.ppt");

  // LibreOffice writes a ~450KB preview bitmap into `SummaryInformation`
  // that no parser here opens. It is stripped out of the committed test
  // fixture, which has to stay small; this kit is a throwaway that already
  // ships an 8.5MB log, and stripping it would mean importing the repo's own
  // CFBF reader -- a `@/`-aliased TypeScript module that plain `node` cannot
  // resolve. Left in.
} finally {
  rmSync(office, { recursive: true, force: true });
}
legacyMade.push("policy-libreoffice.rtf");

/* ----------------------------------------------------------------- manifest */

const size = (name) => readFileSync(join(out, name)).length;

writeFileSync(
  join(out, "MANIFEST.md"),
  `# 채팅 첨부 staging 시료 — 정답지

\`node scripts/make-chat-attachment-staging-kit.mjs\`가 만든 것입니다. 다시
만들면 같은 파일이 나옵니다.

## ledger-source.zip (${size("ledger-source.zip")} bytes)

**읽혀야 하는 파일 5개**

${READ_BY_THE_ARCHIVE.map((p) => `- \`${p}\``).join("\n")}

**제외돼야 하는 파일 2개** — 빌드 산출물이라 압축 안에서는 실패가 아니라 건너뜁니다.

${SKIPPED_BY_THE_ARCHIVE.map((p) => `- \`${p}\``).join("\n")}

**따라서 제외 개수 안내는 \`2\`여야 합니다.** 폴더 항목 9개와 0바이트 파일은
세지 않습니다 — 사람이 압축한 것과 대응되지 않는 숫자가 되기 때문입니다.

### 답이 무엇을 말해야 하는가

내용을 물었을 때 답은 위 5개만 나열해야 하고, \`Main.class\`나 \`.pyc\`가
있다고 말하면 안 됩니다. 내용도 대조하세요 — 원장 서비스, 음수 잔액 거부,
플랜 한도 free 100 / pro 5000 / max 20000.

## 이미지

| 파일 | bytes | 기대 |
|---|---|---|
| \`chart-still.gif\` | ${size("chart-still.gif")} | 업로드 성공. 빨강·파랑·초록 막대 세 개와 검은 테두리 |
| \`chart-animated.gif\` | ${size("chart-animated.gif")} | **거절** — "애니메이션 GIF는 지원하지 않습니다…" |

## 파일 선택기로 고를 것

\`picker-notes.md\` \`picker-limits.csv\` \`picker-config.json\` \`picker-ledger.py\`

끌어다 놓지 말고 **파일 선택기로** 고르세요. 브라우저가 media type을 비워
보내는 경우가 그 경로에서만 나오고, 그것이 이 작업이 고친 회귀입니다.

## 큰 파일

\`large-ledger-log.txt\` (${size("large-ledger-log.txt")} bytes) — finalize(PATCH)
응답 시간 측정용.

## 레거시 Office · RTF

| 파일 | bytes |
|---|---|
| \`policy-libreoffice.doc\` | ${size("policy-libreoffice.doc")} |
| \`policy-libreoffice.xls\` | ${size("policy-libreoffice.xls")} |
| \`policy-libreoffice.ppt\` | ${size("policy-libreoffice.ppt")} |
| \`policy-libreoffice.rtf\` | ${size("policy-libreoffice.rtf")} |

넷 다 같은 내용입니다. 답이 인용해야 하는 것:

- 계좌 잔액은 **음수가 될 수 없다**
- 예약·환급은 **계좌 잠금을 가장 먼저** 잡는다
- 무료 **100** / 프로 **5000** / 맥스 **20000** 크레딧, 동시 대화 **1 / 3 / 5**
- 잠금 시간 초과 **5000밀리초**

\`.xls\`는 시트가 둘(\`플랜한도\`, \`잠금설정\`)이고, \`.ppt\`는 슬라이드가 셋입니다.

### 이 넷이 증명하는 것과 증명하지 않는 것

**증명합니다** — 배포된 빌드에서 업로드 → R2 → finalize → 파서 → 프롬프트 배선이
legacy 형식에 대해 실제로 동작한다는 것. CI는 파서만 단독으로 돌리므로 이
배선을 지나지 않습니다.

**증명하지 않습니다** — 파서가 **Word 자신이 쓴 바이트 배치**를 읽는다는 것.
그건 Word가 저장한 파일로만 확인됩니다. 그래서 §C-2는 여전히 사람 몫이고,
이 넷은 그 앞에서 배선을 먼저 걸러 내는 용도입니다.

## 이 kit이 만들지 않는 것

- **진짜 Microsoft Office가 저장한 \`.doc\`·\`.xls\`·\`.ppt\`** — 위 §C-2 이유.
  Word에서 다른 이름으로 저장 → Word 97-2003 문서로 만드시면 됩니다.
- **암호가 걸린 legacy 문서.** LibreOffice는 MS Word 97·MS Excel 97 필터에
  \`Password=\`를 받고도 암호화하지 않은 파일을 씁니다(2026-08-23 확인, 둘 다
  그대로 파싱됨). 암호화되지 않은 파일을 "암호 문서"라고 내면 주장과 반대되는
  것을 시험하게 됩니다. 필요하면 Word에서 정보 → 문서 보호 → 암호 설정으로
  10초면 만들 수 있습니다.
`
);

console.log(`Wrote ${out}/`);
for (const name of [
  "MANIFEST.md",
  "ledger-source.zip",
  "chart-still.gif",
  "chart-animated.gif",
  "picker-notes.md",
  "picker-limits.csv",
  "picker-config.json",
  "picker-ledger.py",
  "large-ledger-log.txt",
  ...legacyMade,
]) {
  console.log(`  ${name}  ${size(name)} bytes`);
}
