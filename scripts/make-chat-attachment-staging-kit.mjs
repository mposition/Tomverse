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
// What this deliberately does NOT produce:
//
//   * a file saved by real Microsoft Office. LibreOffice output is what
//     `tests/fixtures/legacyOffice/` already runs in CI, so a round that used
//     it would be repeating CI by hand rather than verifying anything.
//   * a genuinely encrypted legacy document. LibreOffice accepts
//     `Password=` on the MS Word 97 and MS Excel 97 filters and silently
//     writes an unencrypted file -- verified 2026-08-23, both parsed straight
//     through. Shipping that as an "encrypted" sample would test the opposite
//     of what it claims.
//
// Both are named in the manifest as the human's part, with the reason.

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

## 이 kit이 만들지 않는 것

- **진짜 Microsoft Office가 저장한 \`.doc\`·\`.xls\`·\`.ppt\`.** LibreOffice가
  만든 파일은 \`tests/fixtures/legacyOffice/\`로 CI가 이미 돌리고 있어서,
  그것으로 검증하면 CI를 손으로 반복하는 것이 됩니다.
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
]) {
  console.log(`  ${name}  ${size(name)} bytes`);
}
