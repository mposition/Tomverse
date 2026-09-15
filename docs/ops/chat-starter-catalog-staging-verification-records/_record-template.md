---
record: staging-verification
checklist: docs/ops/chat-starter-catalog-staging-checklist.md
templateRevision: 2026-09-15a
environment:
deploySha:
startedAtUtc:
completedAtUtc:
executor:
approver:
result:
frozen: false
digest:
---

# Chat 시작 카탈로그 staging 검증 실행 — <날짜> / <deploy SHA>

체크리스트의 **A–F 구획**을 이 파일로 복사해 실행 결과를 채웁니다.

## 실행 환경

| 항목 | 값 |
|---|---|
| 환경 | staging / production / 기타 |
| 배포 SHA (전체 40자리) | |
| SHA를 읽은 방법 | `GET /api/build-info` / 기타 |
| SHA를 읽은 시각 (UTC) | |
| template revision | 2026-09-15a |
| 시작 (UTC) | |
| 종료 (UTC) | |
| 실행자 | |
| 로그인 계정의 플랜 | Free / Pro / Max |
| 실기기 (E 구획을 한 경우) | 기기·OS·브라우저 버전 |

**merge SHA를 옮겨 적지 않습니다.** staging은 develop에 무엇이 병합되든
재배포되므로, 실행 시점에 서빙 중인 SHA와 다를 수 있습니다.

## 이 회차가 가정한 배포 상태

정답지의 입력입니다. 여기가 틀리면 아래 판정이 전부 다른 배포에 대한 것이 됩니다.

| flag | 값 | 어디서 읽었는가 |
|---|---|---|
| `feature.chatStarterEnabled` | | |
| `feature.imageGenerationEnabled` | | |
| `feature.voiceInputEnabled` | | |
| `CHAT_STARTER_KILL_SWITCH` | | |

정답지 생성에 쓴 명령:

```
npm run report:starter-catalog-expectations -- --image=<> --voice=<> --brave=<>
```

## 사전 조건

| 항목 | 확인 | 값·비고 |
|---|---|---|
| staging 서빙 SHA 확보 | | |
| SHA가 `4f300e21` 이후 | | |
| 두 기능 flag 값을 읽어 적음 | | |
| 정답지 생성함 | | |
| 로그인 계정 + 비로그인 세션 | | |

## A. flag off는 비활성이 아니라 부재다 — 차단

| 항목 | 결과 | 관측 |
|---|---|---|
| A-1 갤러리가 전혀 없음 | | |
| A-2 켜고 끄면 나타나고 완전히 사라짐 | | |

## B. 카드는 이 배포가 실제로 하는 일만 약속한다 — 차단

| 항목 | 결과 | 관측 |
|---|---|---|
| B-1 카드 집합이 정답지와 일치 | | 화면에서 본 id를 순서대로 적습니다 |
| B-2 "Must NOT appear"가 하나도 없음 | | |
| B-3 꺼진 기능의 카드가 부재(잠김 아님) | | |

## C. 씨앗은 전송이 아니다 — 차단

| 항목 | 결과 | 관측 |
|---|---|---|
| C-1 클릭이 입력란을 채우고 전송하지 않음 | | |
| C-2 두 번째 카드가 문장을 교체함 | | |
| C-3 타이핑한 문장이 보존됨 | | 타이핑한 문장과 클릭 후 문장을 둘 다 적습니다 |
| C-4 출처 카드가 웹 검색을 켬 | | |

## D. 잠금은 클릭 전에 말한다 — 비차단

| 항목 | 결과 | 관측 |
|---|---|---|
| D-1 잠긴 카드가 보이고 요구사항이 카드 위에 있음 | | |
| D-2 클릭이 로그인으로 감, 초안 안 채움 | | |
| D-3 Free 계정의 이미지 카드가 요금제를 말함 | | |

## E. 실기기 기하 — 비차단

| 항목 | 결과 | 관측 |
|---|---|---|
| E-1 입력란 행 미침범·미중첩 | | |
| E-2 가로 스크롤 없음 | | |
| E-3 최대 글자 크기에서 줄바꿈 | | |
| E-4 한국어 IME 조합 중 클릭 | | |

## F. 문구와 운영 — 비차단

| 항목 | 결과 | 관측 |
|---|---|---|
| F-1 언어별 문구가 그 언어로 나옴 | | 확인한 locale을 적습니다 |
| F-2 카드에 가격 표시 없음 | | |
| F-3 flag 변경이 감사 로그에 남음 | | |

## 발견

| # | 구획 | 무엇을 보았는가 | 차단인가 |
|---|---|---|---|

## 판정

**사람이 씁니다. 에이전트는 비워 둡니다.**

- 결과: 통과 / 조건부 / 실패
- 건너뛴 구획과 그 이유:
- 서명:
- 날짜 (UTC):
