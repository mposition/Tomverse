# Assistant + Knowledge 사용법 영상 제작 명세

## 상태와 교체 경계

Runway MCP가 연결된 작업에서 아래 명세로 49초 이내 MP4를 생성·검토합니다. 현재
코드 작업 세션에는 Runway 호출 도구가 노출되지 않아 영상을 생성한 것으로 간주하지
않습니다. 영상이 없을 때 `/guides/assistant-knowledge`는 같은 내용을 모두 담은
키보드 접근 가능한 인터랙티브 안내와 정적 포스터를 표시합니다.

검토를 통과한 파일은 Tomverse가 통제하는 경로에 두고
`lib/assistantKnowledgeGuide.ts`의 `ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_PATH`만 그 경로로
바꿉니다. 외부 Runway URL을 이메일이나 제품에 직접 넣지 않습니다. 한국어·영어
WebVTT 초안은 `public/guides/assistant-knowledge/`에 있으며 최종 타임라인과 맞춘 뒤
함께 검토합니다.

## 결과물

- 1920×1080, H.264 MP4, 49초 이하, 무음으로 봐도 이해 가능
- 제품 UI는 실제 Tomverse 캡처만 사용한다. Runway는 장면 전환, 커서 강조,
  배경 움직임과 타이틀 모션에만 사용한다.
- 화면 안 설명 문구를 영상 이미지에 구워 넣지 않는다. 언어별 자막과 HTML
  transcript가 설명을 담당한다.
- 프로필 이름·파일명·프롬프트는 합성 데모 값만 사용하며 실제 고객 데이터는
  캡처하지 않는다.

## 타임라인

1. `00:00–00:06` — Tomverse / My AI Assistant + Knowledge 타이틀.
2. `00:06–00:18` — 새 어시스턴트에서 이름과 지시문 입력 후 생성.
3. `00:18–00:30` — Knowledge 파일 업로드, 처리 완료, 파일 선택, 변경사항 저장.
4. `00:30–00:43` — 대화 도구에서 AI 어시스턴트를 열고 생성한 항목 선택.
5. `00:43–00:49` — 질문과 함께 “관련 발췌가 참고 자료로 사용됨”을 표시하고 종료.

## Runway 프롬프트

```text
Create restrained premium motion design for a real SaaS product walkthrough.
Use the supplied Tomverse screen recordings exactly as the product UI; do not
redesign, replace, hallucinate, or alter controls or text. Add only subtle
graphite-to-teal ambient depth, clean cursor emphasis, short 200–300 ms focus
transitions, and quiet section title motion. No people, avatars, stock footage,
3D objects, neon cyberpunk effects, floating fake interfaces, or extra logos.
Keep every recorded screen legible and stationary long enough to follow without
audio. Output 1920x1080 H.264, under 49 seconds, with safe margins for captions.
```

## 승인 체크

- 영상의 클릭 순서와 현재 production UI가 일치한다.
- Knowledge를 “모델 학습”이나 “항상 정답”으로 표현하지 않는다.
- 관련 발췌가 참고 자료로 사용된다는 경계를 말한다.
- 무음 재생, 키보드 대체 흐름, 한국어·영어 자막에서 같은 단계가 이해된다.
- `prefers-reduced-motion` 사용자는 자동 재생을 강요받지 않는다. 제품 플레이어는
  자동 재생하지 않는다.
