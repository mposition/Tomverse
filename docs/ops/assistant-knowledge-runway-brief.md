# Assistant + Knowledge 사용법 영상 제작 명세

## 상태와 교체 경계

Runway Standard의 다국어 음성과 최신 production 빌드의 실제 제품 UI 캡처를
합성해 한국어·영어·중국어 44.04초 MP4를 완성했습니다. 오프닝과 클로징에는
저장소의 실제 Tomverse 로고와 워드마크를 후처리로 합성해 생성형 텍스트 왜곡을
피했습니다. 제품 장면은 합성 데모 데이터와 로컬 API mock만 사용했으며 고객
데이터와 production 자격증명을 사용하지 않았습니다.

검토 대상 파일은 Tomverse가 통제하는
`public/guides/assistant-knowledge/assistant-knowledge.{ko,en,zh}.mp4`에 두었습니다.
외부 Runway URL은 이메일이나 제품에서 사용하지 않습니다. 언어별 WebVTT도 같은
폴더에 있으며 최종 타임라인과 일치합니다. 한국어와 중국어는 각각 해당 언어의
Tomverse UI를 보여주고, 영어를 포함한 나머지 지원 언어는 영어 master를
사용합니다. 영상이 재생되지 않는 환경에서도 `/guides/assistant-knowledge`의
키보드 접근 가능한 인터랙티브 안내와 정적 포스터가 동일한 절차를 제공합니다.

## 결과물

- 언어별 1920×1080, H.264/AAC MP4, 49초 이하, 무음으로 봐도 이해 가능
- 제품 UI는 실제 Tomverse 캡처만 사용한다. Runway는 장면 전환, 커서 강조,
  배경 움직임과 타이틀 모션에만 사용한다.
- 화면 안 설명 문구를 제품 장면에 별도로 구워 넣지 않는다. 언어별 실제 UI,
  음성, 자막과 HTML transcript가 같은 절차를 설명한다.
- 프로필 이름·파일명·프롬프트는 합성 데모 값만 사용하며 실제 고객 데이터는
  캡처하지 않는다.

## 타임라인

1. `00:00–00:05.04` — 실제 로고와 Tomverse 워드마크 오프닝.
2. `00:05.04–00:15.04` — 새 어시스턴트에서 이름과 지시문 입력 후 생성.
3. `00:15.04–00:27.04` — Knowledge 파일 업로드, 파일 선택, 변경사항 저장.
4. `00:27.04–00:39.04` — 대화 도구에서 만든 AI 어시스턴트 선택.
5. `00:39.04–00:44.04` — 실제 Tomverse 로고와 언어별 CTA로 종료.

## 제작 근거

- Runway 음성 task:
  - 한국어 `a70bfb5b-07bd-4b16-9137-6adc7c9cf698`
  - 영어 `c9052336-9fe5-4734-a16a-47c9b76c0b47`
  - 중국어 `ec14a78f-deed-4e45-9b80-1f90fd70b13a`
- Runway 사용 범위: `eleven_multilingual_v2` 음성. 제품 UI와 로고는 생성하지 않는다.
- 제품 캡처: 1920×1080 production build, Playwright, 합성 프로필·파일·대화
- 최종 인코딩: H.264 High, 1920×1080, 30fps, `yuv420p`, AAC, fast-start
- 최종 SHA-256:
  - 한국어 `d5d89ac2a2c7c94f9f9e01bf42899d645c2e2c0988032b7b13b6a55816de2d9e`
  - 영어 `bbb1b34e1b6d746540ff60efc2b7e45c9b81bdc45c9099c70e4c25ff528261be`
  - 중국어 `4e72b08624ef37c492a13ce51c546d273443903c4564df6aa765b73a114e8070`
- 자동 검사: `npm run validate:assistant-knowledge-guide`

## Supademo 배포 경계

언어별 실제 제품 캡처 네 장으로 Supademo 안내를 구성했습니다. 2026-09-15에
제목·설명·hotspot·탐색 문구를 현지화하고 공개 공유 범위와 검색엔진 색인 비활성화를
확인했습니다. production 서비스에는 아래 공개 URL을 대응하는 서버 환경변수로
주입합니다.

| 언어 | 환경변수 | 검증된 공개 URL |
|---|---|---|
| 한국어 | `ASSISTANT_KNOWLEDGE_SUPADEMO_KO_URL` | `https://app.supademo.com/demo/cmu2kip960375x30jconk1m35` |
| 영어 및 기타 locale | `ASSISTANT_KNOWLEDGE_SUPADEMO_EN_URL` | `https://app.supademo.com/demo/cmu2klahy04dmz00jui2461gp` |
| 중국어 | `ASSISTANT_KNOWLEDGE_SUPADEMO_ZH_URL` | `https://app.supademo.com/demo/cmu2kmiiz03wcyy0j8n4up8vu` |

서버는 HTTPS `supademo.com` 및 하위 도메인만 허용합니다. 값이 없거나 잘못된
경우 페이지는 깨지지 않고 Tomverse가 직접 제공하는 키보드 접근 가능한 3단계
튜토리얼을 항상 함께 제공합니다. 외부 안내를 일시 중지해야 하면 해당 환경변수를
제거해 native 안내만 남길 수 있습니다.

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
- 무음 재생, 키보드 대체 흐름, 한국어·영어·중국어 자막에서 같은 단계가 이해된다.
- 각 영상의 음성 언어와 화면 UI 언어가 일치한다. 그 밖의 locale은 영어를 쓴다.
- `prefers-reduced-motion` 사용자는 자동 재생을 강요받지 않는다. 제품 플레이어는
  자동 재생하지 않는다.
