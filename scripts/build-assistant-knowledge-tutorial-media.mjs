import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import sharp from "sharp";

const DURATION_SECONDS = 44.04;
const workDirectory = resolve(
  process.env.CAPTURE_OUTPUT_DIRECTORY ||
    ".tmp/assistant-knowledge-tutorial"
);
const publicDirectory = resolve(
  "public/guides/assistant-knowledge"
);
const logo = await readFile(resolve("public/tomverse-logo.png"));
const logoData = `data:image/png;base64,${logo.toString("base64")}`;

const media = {
  ko: {
    label: "나의 AI 어시스턴트 + Knowledge",
    closing: "이제 Tomverse에서 직접 만들어 보세요",
    captions: [
      ["00:01.200", "00:07.900", "Tomverse에서는 나만의 답변 방식과 자료를 하나의 비공개 AI 어시스턴트에 담을 수 있습니다."],
      ["00:07.900", "00:14.400", "설정의 나의 AI 어시스턴트에서 새 구성을 만들고, 이름과 원하는 답변 방식을 적어 주세요."],
      ["00:14.400", "00:25.600", "이미 사용하던 구성이 있다면 Agent Skill ZIP이나 Tomverse 패키지를 검토해 가져올 수도 있습니다. 스크립트와 외부 도구는 자동으로 실행되거나 연결되지 않습니다."],
      ["00:25.600", "00:33.600", "편집 화면에서 Knowledge 파일을 추가하고 저장한 뒤, 대화 도구에서 방금 만든 어시스턴트를 선택해 질문을 시작하세요."],
      ["00:33.600", "00:41.400", "관련 자료의 발췌가 답변의 참고 맥락으로 사용됩니다."],
      ["00:41.400", "00:43.500", "이제 나의 AI 어시스턴트를 만들어 보세요."],
    ],
  },
  en: {
    label: "My AI Assistant + Knowledge",
    closing: "Build yours in Tomverse",
    captions: [
      ["00:01.200", "00:06.800", "Tomverse lets you keep the way you work and the material you return to in one private AI assistant."],
      ["00:06.800", "00:12.800", "Open My AI Assistants in Settings, create a new setup, then describe how you want answers written."],
      ["00:12.800", "00:21.500", "If you already use an Agent Skill ZIP or a Tomverse package, review it and import it instead. Scripts do not run, and external tools are not connected automatically."],
      ["00:21.500", "00:26.500", "Add a Knowledge file in the editor and save the revision."],
      ["00:26.500", "00:35.000", "Then open a conversation, choose your assistant, and ask a question. Relevant excerpts from your material become reference context for the answer."],
      ["00:35.000", "00:43.500", "Ready to begin? Create your assistant, add Knowledge, and start the first conversation."],
    ],
  },
  zh: {
    label: "我的 AI 助手 + Knowledge",
    closing: "现在就在 Tomverse 中创建",
    captions: [
      ["00:01.200", "00:07.200", "在 Tomverse 中，你可以把自己的回答方式和常用资料放进一个私有 AI 助手。"],
      ["00:07.200", "00:13.300", "打开设置中的“我的 AI 配置”，新建助手，并说明希望它怎样回答。"],
      ["00:13.300", "00:22.000", "如果你已经在使用 Agent Skill 压缩包或 Tomverse 包，也可以先审阅再导入。脚本不会运行，外部工具也不会自动连接。"],
      ["00:22.000", "00:28.800", "在编辑页面添加 Knowledge 文件并保存修订。"],
      ["00:28.800", "00:36.500", "然后进入对话，选择刚创建的助手并开始提问。系统会把相关资料摘录作为回答的参考信息。"],
      ["00:36.500", "00:43.500", "现在就创建你的 AI 助手，添加 Knowledge，并开始第一次对话。"],
    ],
  },
};

const escapeXml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const slateSvg = ({ label, closing = null }) => Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
    <defs>
      <radialGradient id="background" cx="50%" cy="35%" r="72%">
        <stop offset="0%" stop-color="#173b70"/>
        <stop offset="54%" stop-color="#0b1728"/>
        <stop offset="100%" stop-color="#050608"/>
      </radialGradient>
      <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="18" stdDeviation="28" flood-color="#000000" flood-opacity=".45"/>
      </filter>
    </defs>
    <rect width="1920" height="1080" fill="url(#background)"/>
    <circle cx="960" cy="425" r="144" fill="#ffffff" opacity=".98" filter="url(#shadow)"/>
    <image href="${logoData}" x="840" y="305" width="240" height="240"/>
    <text x="960" y="665" text-anchor="middle" fill="#ffffff"
      font-family="Arial, Segoe UI, sans-serif" font-size="82" font-weight="800"
      letter-spacing="-3">Tomverse</text>
    <text x="960" y="738" text-anchor="middle" fill="#b6c9e8"
      font-family="Noto Sans KR, Noto Sans SC, Malgun Gothic, Microsoft YaHei, Arial, sans-serif"
      font-size="30" font-weight="600">${escapeXml(closing || label)}</text>
    ${closing ? `<text x="960" y="810" text-anchor="middle" fill="#6ee7d8"
      font-family="Noto Sans KR, Noto Sans SC, Malgun Gothic, Microsoft YaHei, Arial, sans-serif"
      font-size="21" font-weight="700">${escapeXml(label)}</text>` : ""}
  </svg>
`, "utf8");

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status}:\n${result.stderr || result.stdout}`
    );
  }
};

const vtt = (cues) =>
  [
    "WEBVTT",
    "",
    ...cues.flatMap(([start, end, text], index) => [
      String(index + 1),
      `${start} --> ${end}`,
      text,
      "",
    ]),
  ].join("\n");

for (const [language, copy] of Object.entries(media)) {
  const openingPath = resolve(workDirectory, `${language}-00-opening.png`);
  const closingPath = resolve(workDirectory, `${language}-05-closing.png`);
  await sharp(slateSvg({ label: copy.label })).png().toFile(openingPath);
  await sharp(slateSvg({ ...copy, closing: copy.closing }))
    .png()
    .toFile(closingPath);

  const inputs = [
    openingPath,
    resolve(workDirectory, `${language}-01-assistant-list.png`),
    resolve(workDirectory, `${language}-02-knowledge-editor.png`),
    resolve(workDirectory, `${language}-03-knowledge-files.png`),
    resolve(workDirectory, `${language}-04-chat-picker.png`),
    closingPath,
  ];
  const durations = [4, 7, 9, 10, 10, 4.04];
  const voiceoverPath = resolve(workDirectory, `${language}-voiceover.mp3`);
  const outputPath = resolve(
    publicDirectory,
    `assistant-knowledge.${language}.mp4`
  );
  const filters = inputs.map(
    (_, index) =>
      `[${index}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x050608,setsar=1,fps=30,format=yuv420p,fade=t=in:st=0:d=0.25,fade=t=out:st=${Math.max(0, durations[index] - 0.25)}:d=0.25,setpts=PTS-STARTPTS[v${index}]`
  );
  filters.push(
    `${inputs.map((_, index) => `[v${index}]`).join("")}concat=n=${inputs.length}:v=1:a=0[video]`,
    `[6:a]adelay=1200|1200,apad=whole_dur=${DURATION_SECONDS}[audio]`
  );

  const args = [
    "-y",
    ...inputs.flatMap((input, index) => [
      "-loop",
      "1",
      "-framerate",
      "30",
      "-t",
      String(durations[index]),
      "-i",
      input,
    ]),
    "-i",
    voiceoverPath,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[video]",
    "-map",
    "[audio]",
    "-t",
    String(DURATION_SECONDS),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "19",
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    outputPath,
  ];
  run("ffmpeg", args);
  await writeFile(
    resolve(publicDirectory, `assistant-knowledge.${language}.vtt`),
    vtt(copy.captions),
    "utf8"
  );
}

console.log(
  JSON.stringify(
    {
      durationSeconds: DURATION_SECONDS,
      languages: Object.keys(media),
      resolution: "1920x1080",
      videoCodec: "H.264",
      audioCodec: "AAC",
      source: "localized Tomverse product UI",
    },
    null,
    2
  )
);
