---
status: approved
implementationBlockedUntilApproved: true
approvedScopes:
  - RELEASE_A_IMPORT
  - RELEASE_B_MEMORY
  - RELEASE_C_ASSISTANT_PROFILES
approvedBy: @mposition
approvedAt: 2026-08-13
approvalTicket: N/A
---

# 외부 대화 Import · 계정 장기 메모리 · 사용자 정의 AI 프로필

이 문서는 세 제품 영역 — 외부 AI 서비스 대화 Import(릴리스 A), 계정 장기
메모리(릴리스 B), 사용자 정의 AI 프로필(릴리스 C) — 의 릴리스 차단 계약입니다.
구현의 사후 설명이 아니라 구현 전에 확정된 정책이며, 이 문서와 충돌하는 변경은
릴리스 차단 사유입니다.

**승인은 릴리스 scope 단위입니다.** `status: approved`는 문서 방향의 승인일
뿐이며, 릴리스 구현은 `approvedScopes`에 해당 릴리스가 명시된 경우에만 시작할
수 있습니다.

- `approvedScopes: [RELEASE_A_IMPORT]` → 릴리스 A만 해제. B/C는 **pending
  approval** 상태로 남습니다.
- 릴리스 B는 §23의 B 관련 미결정 항목(오류 HTTP 의미, manual evidence 구조,
  source 삭제 시 상태 등)을 이 문서에서 확정한 뒤 별도로
  `RELEASE_B_MEMORY`를 `approvedScopes`에 추가해야 시작할 수 있습니다.
  (2026-08-03 확정 완료 — 각 결정은 §23에 기록되어 있습니다. 단, §23의
  staging 체크리스트 실행·승인은 코드 착수와 별개로 릴리스 B의 staging
  반영 전 완료 조건으로 남습니다.)
- 릴리스 C도 같은 방식으로 `RELEASE_C_ASSISTANT_PROFILES` scope 승인이
  필요합니다.

사람이 검토하여 frontmatter에 승인 상태·scope·승인자·승인 시점·승인 티켓을
기록해야 하며, 에이전트는 이 필드를 스스로 기입할 수 없습니다.

관련 기존 계약 — 이 문서는 아래를 대체하지 않고 그 위에 쌓입니다.

- `AGENTS.md`
- `docs/policy/credit-and-cost-limits.md` (entitlement / operational guardrail 분리)
- `docs/policy/chat-concurrency-and-identity.md` (동시 실행 층, admission token, lease)
- `docs/policy/default-model-luna-migration.md`
- `docs/ops/migration-baseline.md`
- `docs/ui-contracts/**` (mobile composer · mobile drawer · comparison rail · typography)

## 1. 릴리스 경계

| 릴리스 | 범위 | 명시적 비목표 |
|---|---|---|
| **A — Import** | ChatGPT·Claude 공식 export의 브라우저 파싱, 선택 대화의 정규화 저장, account-private read-only viewer, 삭제·export | Gemini, memory 추출·주입, 이어서 대화하기, password lock, 공유 링크, `Conversation` 변환 |
| **A2 — Gemini Import** | Google Takeout parser. 설계는 `docs/policy/external-import-gemini-a2.md` — 대화는 Takeout의 `Gemini` 항목이 아니라 `My Activity → Gemini Apps`에 있고 JSON 선택이 가능하므로, 여기 적힌 "locale 의존 HTML" 연기 사유는 A2 설계 §1에서 정정됐습니다. 남은 진행 조건은 활동 항목에 대화 식별자가 있는지입니다 | — |
| **B — 계정 장기 메모리** | 메모리 후보 추출·검토·승인, 서버 주도 retrieval·주입, context bundle, external conversation lock 일반화 + memory suspension | Assistant Profile, knowledge, 외부 embedding |
| **C — Assistant Profile** | private 프로필(지시문·모델·도구·memory 범위·지식 파일), 버전 고정, searchTerms 기반 knowledge RAG | public marketplace, 공유·판매, Actions, OAuth connector, 코드 실행, 외부 embedding |

- 세 릴리스는 독립적으로 배포·롤백·검증합니다.
- 한 릴리스 안에서도 `DELIVERY_SLICE` 단위의 작은 PR로 나눕니다. 특히 릴리스 B는
  B1(schema·validator) → B2(extraction run·비용·동시성) → B3(검토 UI) →
  B4(retrieval·context bundle 통합) → B5(lock 일반화·suspension)를 권장합니다.
- 다음 릴리스의 schema·API·feature flag·UI placeholder를 선제 추가하지 않습니다.

## 2. 용어

| 용어 | 의미 |
|---|---|
| External conversation | 외부 제공자 export에서 가져온 원본 대화. 계정 소유의 immutable read-only 자료 |
| Memory candidate | 추출됐지만 아직 사용되지 않는 제안 상태의 메모리 |
| Active memory | 사용자가 승인했거나 직접 작성해 새 대화에서 사용 가능한 메모리 |
| Answer style | 과거 assistant 답변에서 추정한 어조·길이·구성 선호. 사용자 사실과 분리 |
| Assistant Profile | GPTs/Gems형 private 사용자 정의 AI 프로필 (내부 코드명 `AssistantProfile`) |
| Knowledge | 프로필에 사용자가 추가한 장기 지식 파일. 일반 채팅 첨부와 수명·권한 분리 |
| Context bundle | 서버가 확정·서명한 memory/profile/retrieval snapshot의 opaque 결속 토큰 |

## 3. 층 분리 — 새 어휘의 확정

`docs/policy/credit-and-cost-limits.md`와 `docs/policy/chat-concurrency-and-identity.md`가
정의한 층(entitlement / operational guardrail / concurrency / operational_admission)에
다음을 **추가**하며, 기존 층과 코드·문구·환경변수를 섞지 않습니다.

| 층 | 무엇 | `limitLayer` | 대표 오류 코드 |
|---|---|---|---|
| **Background 동시 실행** | 사용자당 memory extraction run 동시 수 | `background_concurrency` | `MEMORY_EXTRACTION_ALREADY_RUNNING` |
| **Extraction batch 예산** | provider 일간·월간 운영 예산 중 batch 몫 | `operational_guardrail` (코드로 구분) | `MEMORY_EXTRACTION_PROVIDER_BUDGET_EXHAUSTED` |

- `limitScope=memory_extraction_user`, 로그인 사용자당 active run 최대 1개.
- extraction run은 interactive chat lease를 소비하지 않고, IP 기반 chat
  admission과 혼합하지 않습니다.
- durable lease·heartbeat(또는 chunk 단위 완료)·만료·멱등 해제·15분 주기
  reconciliation을 기존 lease 계약(`chat-concurrency-and-identity.md` §4)과 동일
  수준으로 갖춥니다.
- batch 예산의 환경변수 namespace(권장, 기존 `CHAT_PROVIDER_*` 관례에 맞춰 구현
  시 최종 확정):

```
MEMORY_EXTRACTION_PROVIDER_<PROVIDER>_MAX_PERCENT_PER_DAY    (기본 10)
MEMORY_EXTRACTION_PROVIDER_<PROVIDER>_MAX_PERCENT_PER_MONTH  (기본 10)
MEMORY_EXTRACTION_PROVIDER_<PROVIDER>_COST_MICROUSD_PER_DAY   (절대값 override, 선택)
MEMORY_EXTRACTION_PROVIDER_<PROVIDER>_COST_MICROUSD_PER_MONTH (절대값 override, 선택)
```

- extraction은 provider **총예산**을 계속 검사하고, 그 위에 batch sub-budget을
  추가로 검사합니다. batch는 interactive 몫을 추가로 빌릴 수 없습니다.
- **sub-budget 값 확정(§23 항목 5, 2026-08-03)**: 일간·월간 모두 **기본
  10%를 유지**합니다. interactive 우선 원칙의 가장 보수적인 시작값이며,
  변경은 코드가 아니라 위 환경변수로만 하고 admin 지표(§22)의 소진율을
  관찰한 뒤에 조정합니다.
- entitlement 부족(`CREDIT_*`)과 batch 예산 소진은 오류 코드·문구를 분리합니다.
- production에서는 관련 환경변수를 코드보다 먼저 배포합니다.

## 4. 외부 대화 저장 모델

외부 대화는 기존 `Conversation`·`Message`에 저장하지 않고 전용 리소스
(`ExternalImport` · `ExternalConversation` · `ExternalMessage`)를 사용합니다.

목적:

- 외부 model label이 runtime `modelId`(`Message.modelId`, model registry)를
  오염시키지 않음
- comparison panel·share·export·billing 의미론을 분리
- staging·idempotency·provenance를 명확히 관리
- memory evidence source를 immutable하게 보존

계약:

- 외부 제공자의 모델명은 `sourceModelLabel`(표시용 provenance)로만 저장합니다.
- 외부 ID는 서버 리소스 ID나 권한 경계로 신뢰하지 않습니다. 소유권은 항상
  서버가 `userId`로 판정합니다.
- HTML을 active content로 저장·렌더링하지 않습니다. viewer는 sanitised plain
  text 또는 안전한 제한 Markdown만 렌더링합니다.
- 릴리스 A schema에는 password lock 필드를 추가하지 않습니다(§7).

### 4.1 content digest 계약

- **client fingerprint는 hint입니다.** UX 최적화·빠른 중복 후보 탐지에만 쓰고
  authoritative dedup 근거로 쓰지 않습니다.
- 서버는 수신한 normalized content를 canonicalize한 뒤 digest를 **직접
  재계산**합니다. message digest → (정렬된 message digest + provenance) →
  conversation digest → (정렬된 conversation digest) → import digest.
- truncation이 필요한 message는 truncation 전 원문의 `originalContentDigest`와
  저장 content의 `contentDigest`를 각각 계산합니다. 잘려서 저장되지 않는 원문은
  digest 계산 후 보관하지 않습니다. inbound 한도와 대형 message의 chunk 전송·
  streaming digest 방식은 §5.4가 정의합니다.
- **`digestVersion=1` 확정값**: algorithm은 **SHA-256**입니다.
  canonicalization은 다음과 같습니다.
  - `contentDigest` / `originalContentDigest` = SHA-256(UTF-8(NFC 정규화 +
    개행을 `\n`으로 통일한 content)). content만 포함합니다.
  - message dedup digest = SHA-256(UTF-8(`provider` + `\n` + 원본 external
    conversation key + `\n` + `role` + `\n` + `ordinal` + `\n` +
    source content digest)). source content digest는 truncated message면
    `originalContentDigest`, 아니면 `contentDigest`입니다 — truncation 승인
    여부가 source 동일성 판정을 바꾸지 않습니다.
  - `conversationDigest` = SHA-256(UTF-8(`provider` + `\n` + 원본 external
    conversation key + `\n` + ordinal 순으로 이어 붙인 message dedup digest)).
  - `importDigest` = SHA-256(UTF-8(사전순 정렬한 conversationDigest 연결)).
  - 이 정의는 중앙 모듈 하나에서 관리하고, 변경 시 `digestVersion`을 올립니다.
- digest는 인증·소유권·접근 권한 증명이 아니며, digest 원문과 client
  fingerprint를 로그·telemetry에 남기지 않습니다.

### 4.2 중복·재-import 의미론 (릴리스 A 확정)

저장된 `ExternalConversation`은 **immutable snapshot**입니다. 재-import 시
기존 row에 message를 추가·수정·삭제하지 않습니다.

- **완전 일치**: 같은 계정에 같은 `conversationDigest`가 이미 finalized로
  존재하면 중복으로 skip합니다. preview에 "중복(제외됨)"으로 표시합니다.
- **같은 source의 다른 버전**: 같은 `externalStableId`(source lineage)에
  `conversationDigest`가 다른 export가 오면 — 더 최신 export에 message가
  추가된 경우 포함 — **새 immutable snapshot row로 저장**합니다. 기존
  snapshot은 유지되며, viewer는 같은 lineage를 묶어 최신 snapshot을 기본으로
  표시하고 이전 snapshot은 개별 삭제할 수 있습니다.
- message digest 비교는 preview 안내("이전 Import본 대비 message N개
  추가/변경")에만 사용하고, **저장 병합에는 사용하지 않습니다.** 개별
  message를 건너뛰어 불완전한 conversation을 만드는 방식을 금지합니다.
- 부분 병합(기존 snapshot에 신규 message만 추가)은 첫 릴리스에서 구현하지
  않으며, 도입하려면 이 문서를 먼저 갱신합니다.
- quota는 snapshot별 실제 저장 bytes를 각각 계산합니다. 같은 lineage의 여러
  snapshot이 저장 공간을 중복 소비하는 것은 알려진 비용이며 preview에
  표시합니다.

## 5. Import 생명주기

### 5.1 파싱 위치 — 브라우저 Web Worker (확정)

- 원본 ZIP/JSON은 Tomverse API·R2·로그 어디로도 전송하지 않습니다.
- 서버에는 사용자가 선택한 정규화 텍스트 batch만 전송합니다.
- 서버 raw archive staging fallback은 구현하지 않습니다.
- media entry는 압축 해제 없이 skip하고, 필요한 JSON·metadata entry만 streaming
  으로 읽습니다. 다중 ZIP은 클라이언트에서 순차 분석 후 preview에서 통합·중복
  제거합니다.
- ChatGPT `conversations.json`처럼 최상위가 대형 배열인 entry는
  incremental/streaming JSON parser로 처리합니다. 일반 `JSON.parse()`는 중앙
  상수로 정한 safe threshold(권장 16MB) 이하 entry에만 허용합니다. 목적이 좁고
  유지되는 streaming JSON dependency 추가를 허용하며 선정 근거·bundle 영향을
  구현 보고에 남깁니다.

### 5.2 클라이언트 archive 한도 (중앙 상수)

| 항목 | 한도 |
|---|---|
| archive container | 1GB |
| archive entry 수 | 50,000 |
| nested archive | 0 (거부) |
| 실제 파싱하는 단일 entry | 250MB |
| 실제 파싱한 text 총량 | 300MB |
| 실제 parsed entry 압축률 | 100:1 |

- 전체 ZIP이 크다는 이유만으로 거부하지 않습니다 — media로 비대한 archive도
  필요한 conversation entry만 안전하게 읽을 수 있으면 진행합니다.
- 모바일 safe threshold 초과 시 crash를 감수하고 강행하지 않고 데스크톱 사용을
  안내합니다. `EXTERNAL_IMPORT_DESKTOP_RECOMMENDED`는 **서버 오류 코드가 아니라**
  클라이언트 상태 enum이자 content-free telemetry label입니다.

### 5.3 서버 authoritative quota (중앙 상수 `EXTERNAL_IMPORT_STORAGE_LIMITS`)

| 항목 | 기본값 |
|---|---|
| normalized external text / 계정 | 50MB (UTF-8 bytes) |
| external conversations / 계정 | 2,000 |
| external messages / 계정 | 100,000 |
| 단일 message **저장** 한도 | 100,000 Unicode code points |
| 단일 message **inbound(pre-truncation)** hard limit | 1,000,000 Unicode code points |

한도의 의미를 구분합니다.

- **저장 한도(100,000 code points)**: `ExternalMessage.content`로 저장되는
  상한. 초과분은 §5.4의 truncation 계약을 따릅니다.
- **inbound hard limit(1,000,000 code points)**: truncation 전 원문으로 서버가
  수신(streaming digest 계산)하는 상한. 이를 넘는 message는 truncation
  대상조차 아니며, 서버가 개별 message를 누락하지 않으므로 **해당
  conversation 전체를 선택 불가로 표시**하고 preview에서 사유를 안내합니다.
- **계정 quota(50MB)**: 중복 skip 판정 이후 **실제로 저장되는**(truncation
  이후 retained) normalized content의 net-new UTF-8 bytes 기준입니다. skip된
  중복과 잘려나간 원문 부분은 quota에 계산하지 않습니다.
- **동시 finalize 직렬화**: quota 판정과 저장은 계정 단위 advisory lock(기존
  `STORAGE_LIMITS`·`assertConversationCapacity` 계약과 같은 방식) 안에서 한
  transaction으로 직렬화합니다. 두 finalize가 동시에 진행돼도 합산이 quota를
  넘을 수 없습니다.

- 강제 권한은 서버에 있고 클라이언트는 preview 표시용 미러입니다.
- 파싱 시작 전 `GET /api/imports/external/capacity`로 잔여 quota를 먼저
  표시하고, 파싱 중에도 예상 저장량과 비교 표시합니다. 장시간 분석 후에야
  한도를 알게 되는 흐름을 금지합니다.
- **all-or-nothing**: 선택 집합이 quota를 초과하면 finalize를
  `409 EXTERNAL_IMPORT_QUOTA_EXCEEDED`로 전체 거부합니다. 서버가 임의로 최신·
  과거 순 부분 저장이나 message 누락을 하지 않습니다.

### 5.4 메시지 truncation과 대형 message 전송

저장 한도(100,000 code points) 초과 ~ inbound hard limit(1,000,000 code
points) 이하 message는 사용자가 preview에서 명시적으로 승인한 경우에만:

- Unicode code point 경계 보존, 앞 약 75% + 뒤 약 25%, locale 독립 내부 marker
- `truncated`, `originalCharacterCount`, `retainedCharacterCount`,
  `originalContentDigest`, `contentDigest` 기록
- preview에 영향 conversation/message 수·원래/저장 문자 수·정책 설명·media
  미포함 사실을 표시

**전송·digest 방식**: batch body는 기존 API 보안 정책의 크기 제한을
따르므로, 저장 한도를 넘는 message의 truncation 전 원문은 **message-part
chunk로 분할 전송**하고 서버가 **streaming digest**로
`originalContentDigest`를 계산합니다. 서버는 원문 전체를 한 번에 메모리에
올리거나 저장하지 않으며, digest 계산이 끝나면 retained 부분(75/25)만
저장하고 나머지는 요청 처리 범위를 벗어나 보관하지 않습니다. part 전송에도
batch sequence·idempotency 계약이 동일하게 적용됩니다.

- 승인하지 않으면 해당 conversation을 선택에서 제거합니다.
- inbound hard limit을 넘는 message가 있는 conversation은 truncation 승인
  대상이 아니라 선택 불가입니다(§5.3).
- truncated content를 완전한 원문으로 표시하지 않습니다.

### 5.5 staging → seal → finalize

capacity 조회 → worker 파싱 → normalized chunk 전송 → 서버 재검증(schema·
owner·quota·size) → 서버 digest 재계산 → 중복·idempotency 판정 → **seal** →
preview → 명시적 finalize → transaction으로 원자 저장.

- staging row는 일반 목록·검색·export에 노출하지 않습니다.
- staging TTL은 **마지막 활동 기준 24시간**, absolute maximum lifetime은
  **생성 기준 72시간**입니다(중앙 상수). 만료 시
  `EXTERNAL_IMPORT_STAGING_EXPIRED`를 반환하고 reconciliation이 payload를
  자동 정리합니다. **`preview_ready`도 같은 두 시계를 그대로 적용받습니다** —
  seal은 업로드 완료를 확정할 뿐 수명을 연장하지 않습니다. 서버가 idle·
  absolute 중 먼저 도래하는 `effectiveExpiresAt`을 계산해 응답에 담습니다.

#### seal — 업로드 완료 확정 (`POST .../[importId]/seal`)

seal이 확정하는 것은 **오직 두 가지**입니다.

1. 클라이언트가 의도한 batch 업로드가 끝났다.
2. 클라이언트가 들고 있는 staged 결과가 서버가 저장한 상태와 일치한다.

seal은 **무엇을 최종 저장할지 확정하거나 freeze하지 않습니다.** finalize는
seal된 staged 집합의 **부분집합**을 받을 수 있고, `expectedImportDigest`는
그때 선택된 subset으로 **다시 계산**합니다. seal이 반환하는 전체 집합
digest(`sealedSelectionDigest`)를 subset finalize에 재사용하면 정상적인 부분
저장이 `EXTERNAL_IMPORT_SELECTION_CHANGED`로 거절됩니다.

- 클라이언트 선언: `finalSequence`, `expectedStagedConversationIds`,
  `expectedDuplicateCount`.
- 서버 검증(모두 서버가 직접 쓴 값과 대조): 인증·소유권, feature flag, rate
  limit, strict schema, status가 `staging`(또는 이미 `preview_ready`), TTL
  미만, `lastBatchSequence === finalSequence`, 실제 staged ID 집합과 선언된
  집합의 정확한 일치, staged row 수 일치, `duplicateCount` 일치.
- 서버는 전체 export나 사용자가 원래 선택한 항목 전체를 독립적으로 알지
  못합니다. 계약은 "클라이언트 완료 선언 + 서버 저장 결과와 대조 검증"입니다.
- 검증 실패는 `409 EXTERNAL_IMPORT_SELECTION_CHANGED` 계열이며 상태를 바꾸지
  않습니다. 성공 시에만 `preview_ready`로 전환합니다.
- **멱등**: staged row·`lastBatchSequence`·`duplicateCount`는 `preview_ready`
  에서 더 이상 변하지 않으므로, 같은 선언의 재시도는 동일한 검증을 통과해
  `200` replay가 되고 다른 선언은 같은 검증에서 409가 됩니다. 별도 seal
  선언 컬럼을 두지 않는 이유입니다.

#### `preview_ready` lifecycle

- batch append는 계속 `staging`에서만 허용합니다. sealed import에 append하면
  409 `EXTERNAL_IMPORT_SELECTION_CHANGED`입니다.
- finalize는 `staging`과 `preview_ready`를 모두 처리하고, 양쪽 모두 subset을
  받습니다. 성공 시 선택되지 않은 staged row는 기존 계약대로 삭제합니다.
- quota 실패는 아무것도 쓰지 않으므로 `preview_ready` 상태와 staged row가
  그대로 남고, 사용자는 선택을 줄여 재업로드 없이 다시 finalize합니다.
- DELETE는 `preview_ready`를 staging 취소와 동일하게 처리합니다.
- lazy expiry와 15분 reconciliation sweep은 `staging`·`preview_ready`를 모두
  대상으로 합니다.
- **배포 호환성 창은 닫혔습니다.** seal 이전 버전 클라이언트가 이미 열어 둔
  화면을 위해 `staging` finalize 경로를 absolute TTL(72시간) 동안 유지했고,
  그 기간이 지나 finalize는 `preview_ready`만 받습니다.
  - **기준 시각**: seal 코드의 production 배포는 **2026-08-04T01:38:42Z**
    입니다 — Railway production 환경의 배포 `4f0dda13`(commit `18d1e891`,
    "Release: … external import Release A completion …")이 컨테이너를 시작한
    시각이고, 그 직전 production 배포 `c266ea8d`(2026-08-03T12:36Z)의
    `lib/externalImportService.ts`에는 `preview_ready`가 없습니다. 창 종료
    가능 시각은 **2026-08-07T01:38:42Z**이며, 그 이후에 닫았습니다. 종료
    시각 자체는 이 변경 commit의 날짜가 기록입니다 — 작업 환경의 시계를
    분 단위 근거로 인용하지 않습니다.
  - **develop 병합 시각(2026-08-03T23:24Z)이 기준이 아닙니다.** pre-seal
    클라이언트가 존재할 수 있었던 마지막 순간은 새 코드가 서비스되기 시작한
    시점이므로, 세어야 할 것은 배포 시각입니다.
  - **창의 길이는 추정이 아니라 absolute TTL에서 나옵니다.** seal되지 않은
    import는 `stagingAbsoluteMaxLifetimeMs`(72시간)를 넘겨 살아남을 수 없고
    finalize가 그 전에 `isStagingExpired`로 거절하므로, seal 배포로부터 72시간
    뒤에는 **pre-seal 세션이 이미 만들어 둔 import 중 finalize 가능한 것이
    없습니다.** 그래서 닫을 때 migration도, 저장된 업로드를 옮기는 절차도
    필요하지 않습니다 — **필요한 사실은 production 배포 시각 하나뿐입니다.**
  - **이 경계는 import에 대한 것이지 세션에 대한 것이 아닙니다.** 창보다 오래
    열려 있던 탭이 지금 *새* import를 시작해 seal 없이 finalize할 수는 있으며,
    §5.5는 창의 길이를 세션 수명이 아니라 TTL로 정할 때 이 잔여를 받아들였습니다.
    그런 탭이 받는 답은 아래 409이고, 저장된 업로드를 잃는 것이 아닙니다.
  - **`status='staging'` 행 수를 세는 것은 이 판단을 바꾸지 못합니다.** 지금
    남아 있는 `staging` 행은 대부분 seal 단계에 아직 도달하지 않은 정상 진행
    중인 업로드이고, 그 사용자들은 seal을 거쳐 finalize하므로 영향을 받지
    않습니다. 행 수는 영향받는 집단과 정상 집단을 구분하지 못합니다.
  - **seal되지 않은 살아 있는 import는 409 `EXTERNAL_IMPORT_SELECTION_CHANGED`
    입니다**(410이 아님). §18이 이미 그 의미 — "클라이언트가 들고 있는 선택
    상태와 서버 상태가 어긋났다" — 를 갖고 있고 복구도 같습니다(seal 후
    finalize). 410으로 답하면 한 번의 호출로 풀리는 상황에 처음부터 다시
    하라고 말하게 됩니다. TTL이 지난 import는 계속 410입니다.
  - 새 UI는 `preview_ready`만 재개 가능으로 취급하며, seal되지 않은 부분
    업로드에는 재개 CTA를 제공하지 않습니다. 클라이언트 계약 변경은
    `EXTERNAL_IMPORT_PARSER_VERSION`으로 구분합니다.
- **finalize 멱등 계약**:
  - 같은 idempotency key + 같은 import digest·selection의 재요청 →
    **`200`으로 기존 완료 결과를 반환**합니다(no-op). 오류가 아닙니다.
  - 같은 key + 다른 payload/digest → `409 EXTERNAL_IMPORT_BATCH_CONFLICT`.
  - 이미 완료된 import를 **다른 key**로 재-finalize →
    `409 EXTERNAL_IMPORT_ALREADY_FINALIZED`(명시적 상태 충돌, 응답에 완료
    상태 포함).

### 5.6 정규화 규칙

- `user`·`assistant` 텍스트 메시지만 가져옵니다. `system`·`developer`·`tool`·
  내부 reasoning·provider metadata를 사용자 메시지로 위장 저장하지 않습니다.
- 알 수 없는 role·content part·field는 조용히 변환하지 않고 warning + count로
  preview에 표시합니다.
- 이미지·오디오·첨부는 첫 릴리스에서 복제하지 않고 건너뛴 수를 표시합니다.
- ChatGPT 분기 대화는 current branch 우선, 추가 branch를 별도 conversation으로
  제시할 경우 preview에서 명시합니다.

## 6. 외부 대화 이어가기 — 예약 (비목표)

릴리스 A에서는 imported conversation에서 이어서 채팅할 수 없습니다. 금지:
imported message의 `Message` 복제, 외부 assistant message에 runtime model ID
부여, external conversation ID의 account chat API 전달, viewer의 즉흥 "계속
대화" bridge, 전체 transcript의 첫 요청 첨부.

향후 continuation bridge는 별도 릴리스·별도 수용 기준으로 다음 방향을
예약합니다: 사용자가 명시적으로 선택 → 새 서버 `Conversation` 생성 → 외부
source는 immutable 유지 → 승인된 요약·선택 turn·제한된 context seed만 초기
서버 context로 연결 → source ID·seed version을 provenance로 기록 → context
window·credit·privacy disclosure 적용. 릴리스 B의 memory 사용은 이 bridge와
다른 기능입니다.

## 7. Lock 릴리스 결정

- **릴리스 A**: external password lock을 구현하지 않습니다. 기존
  `conversationLock` 모듈·unlock cookie·grant namespace를 수정·일반화하지
  않으며, placeholder 필드도 추가하지 않습니다. ExternalConversation은 계정
  소유권으로 private입니다.
- **릴리스 B (B5 slice)**: memory suspension과 한 slice에서 lock을 일반화합니다.
  - `resourceType: conversation | external_conversation`. grant는 resource
    type과 resource ID에 모두 결속되고, type 간 ID 충돌로 재사용될 수 없습니다.
  - 기존 Conversation unlock cookie·TTL 계약과 호환. password 검증·시도 제한·
    audit·owner 검증·잠긴 리소스 접근 차단·external message/evidence 조회 차단.
  - **기존 Conversation lock 소비 route 전체 무회귀**: conversation/message
    조회, share, export, comparison review, unlock cookie, TTL, password 실패,
    attempt limit, audit, 비소유자 접근, cross-resource grant 차단. 기존
    테스트를 삭제·완화·대체하지 않습니다. native lock 경로는 보존하고 external
    adapter를 additive하게 구현합니다.

### 7.1 source lock과 memory suspension

- source가 잠기면 그 source가 유일한 유효 evidence인 active memory를 **한
  transaction 또는 동등하게 원자적인 service에서** `suspended_by_source_lock`
  으로 전환합니다. 잠긴 evidence는 retrieval에서 즉시 제외됩니다.
- 잠기지 않은 evidence가 하나 이상 남은 memory는 active를 유지할 수 있습니다.
- 잠금 해제 시 evidence를 재검증한 뒤 다른 차단 사유가 없으면 이전 상태로
  복귀합니다. lock·unlock·suspension·restore는 audit를 남깁니다.
- 잠금 상태에서 evidence 원문을 열람하거나 새 chat에서 우회 노출할 수 없습니다.
- **삭제는 잠금으로 막지 않습니다.** lock이 지키는 것은 내용 노출이고 삭제는
  내용을 드러내지 않습니다. 반대로 삭제를 막으면 비밀번호를 잊은 snapshot이
  영구히 지워지지 않는 상태가 되어 §13.1의 무조건적 삭제 권리와 §15의
  "imported data를 소유자 손이 닿지 않는 곳에 남기지 않는다"를 어깁니다.
  native Conversation route와 다른 판단이며, 의도된 차이입니다.
- **suspension 대상은 `active`뿐입니다.** `suspended_by_source_lock`은 이 경로만
  쓰고 `active`만 덮으므로 상태 자체가 복귀 지점의 기록이 되고, 별도 이전 상태
  컬럼이 필요 없습니다. `candidate`까지 정지시키면 복귀가 사용자가 승인한 적
  없는 승격이 됩니다.
- 복귀 시 만료가 이미 지난 memory는 `active`가 아니라 `expired`로 보냅니다
  (§7.1의 "다른 차단 사유" 항). `active`로 되돌리면 §8.6 sweep이 다시 지날
  때까지 만료된 memory가 retrieval에 남습니다.
- 부분 실패로 lock과 memory 상태가 불일치하면 reconciliation이 탐지·복구합니다.

## 8. 계정 장기 메모리 계약

### 8.1 변경 불가 불변식 4개

1. **Conversation별 memory mode** — `inherit | on | off`. `inherit`는 계정
   기본값, `off`는 해당 대화에서 retrieval·injection 금지. 계정 master toggle이
   꺼져 있으면 `on`도 우회하지 못하고, mode가 feature flag·revocation·인증·
   소유권 검사를 우회하지 못합니다. mode는 서버 저장·서버 판정입니다.
   구현: 해석은 `lib/conversationMemoryMode.ts`의 순수 resolver 한 곳이고,
   저장은 `PATCH /api/conversations/[id]`, 적용은 `/api/chat`과
   `/api/chat/preflight` **양쪽**입니다.
   - **`inherit`는 저장 값으로 남습니다.** 저장 시점의 계정 기본값을 복사해
     넣으면 이후 계정 설정을 바꿔도 그 대화만 옛 값에 묶입니다. 사용자가 고른
     것은 "기본값을 따른다"이지 "그때의 기본값"이 아닙니다.
   - **정확히 `off` 문자열만 끕니다.** 컬럼이 문자열이므로 예상 못 한 값이
     사용자가 켜져 있다고 믿는 기능을 조용히 꺼서는 안 됩니다. 반대 실수는 위의
     flag·revocation·계정 toggle이 여전히 막으므로 봉쇄됩니다.
   - **양쪽 경로가 모두 읽어야 합니다.** preflight만 읽으면 memory가 꺼진 대화가
     memory block 없이 가격이 매겨지고 block이 담겨 전송되거나 그 반대가 됩니다.
2. **Guest 제외** — guest에는 extraction·candidate 생성·retrieval·injection·
   profile memory를 적용하지 않고, guest identity를 memory owner로 승격하지
   않으며, 로그인 전 guest local state를 memory로 자동 변환하지 않습니다.
3. **서버 주도 retrieval** — 클라이언트는 chat·preflight에서 memory ID·content·
   evidence·retrieval 결과·score를 선택하거나 전송하지 않습니다. 서버가 session
   user, Conversation ownership, master toggle, memory mode, source 상태로
   조회합니다. 클라이언트가 소비하는 것은 서명된 opaque context bundle뿐입니다.
4. **Message row 비저장** — 주입된 memory context를 일반 `Message` row로
   저장하지 않습니다. 허용: bundle ID/version, 사용 개수, retrieval version,
   비민감 audit·비용 aggregate metadata. 금지: hidden system Message, evidence
   원문의 history 복사, share/export 대상 Message content에 memory block 삽입.

### 8.2 분류와 statement 정규화

- Factual: `identity` `preference` `occupation` `expertise` `long_term_goal`
  `project` `constraint` `decision` `relationship` `recurring_context`
- Style(별도 관리·별도 비활성화): `communication_style` `tone` `verbosity`
  `structure` `formatting` `language` `explanation_depth` `citation_preference`
  `code_style`
- 모든 statement는 **서술형**으로 정규화합니다. 원문이 "답변은 반드시 존댓말로
  해줘"여도 출력은 "사용자는 존댓말 답변을 선호한다"입니다. validator를
  느슨하게 하지 않고 추출 출력을 정규화해 통과시킵니다.
- assistant 메시지에만 존재하는 주장·추측·역할극을 사용자 사실로 저장하지
  않습니다. factual memory에는 user-role evidence가 최소 1개 필요합니다.

### 8.3 상태

`candidate` → (`active` | `rejected`) / `superseded` / `expired` /
`suspended_by_source_lock` / `suspended_by_source_delete` /
`manual_review_required` / `deleted`

- `suspended_by_source_delete`는 §23 항목 3의 확정으로 정식 상태입니다:
  source 삭제 시 사용자가 memory 유지를 선택한 경우에만 진입하며(§13.1),
  retrieval에서 즉시 제외되고, 사용자가 evidence를 직접 작성해 재승인해야
  active로 복귀합니다. 자동 복귀는 없습니다.

- 같은 conflict group(canonical key)의 값이 다르면 자동 덮어쓰지 않고 사용자가
  유지/교체/병기/만료/직접 병합을 선택합니다. 최신 날짜만으로 진위를 정하지
  않습니다.

### 8.4 서버 deterministic validator

모델 판단과 무관하게 서버가 강제합니다: evidence ID 존재·소유권·content digest
일치, evidence role과 statement 관계, 길이, 허용 kind, confidence 범위, expiry
형식, URL, credential·secret 패턴, imperative/system 지시형, prompt injection
표현, assistant 추측 채택 패턴, source mismatch, 중복·near-duplicate·conflict.

구현: 순수 검사는 `lib/memoryValidatorCore.ts`, DB가 필요한 검사(evidence
존재·소유권·digest)는 `lib/memoryEvidenceValidation.ts`입니다.

- **evidence 재검증은 읽기 시점이 아니라 쓰기 시점에 합니다.** label map은
  chunk를 claim할 때 만들어지고 provider 호출은 그 뒤에 일어나므로, 그 사이에
  import를 삭제한 사용자는 더 이상 없는 message를 인용하는 후보를 남깁니다.
  검증을 저장 transaction 안에서 하지 않으면 evidence insert가 FK를 위반해
  chunk 전체가 알 수 없는 DB 오류로 실패합니다.
- **검증에 실패한 참조는 버리고, 남은 참조가 없으면 후보를 저장하지 않습니다**
  (§8.2는 evidence를 요구합니다). 이는 validator 거절과 다른 결과이므로
  `unsourced`로 따로 셉니다 — 문장이 부적합했던 것이 아니라 근거가 사라진
  것입니다.

**Bulk-safe 계약**: 일괄 승인에는 서술형 사실·선호만 포함합니다. URL, redirect
지시, imperative, "항상·반드시·무조건" + 행동 명령, system/developer/tool 명령
형태, 외부 파일·명령 실행 요구, credential 패턴, 현재 지시 무시, model identity
변경 후보는 모델 분류와 무관하게 거부하거나 `manual_review_required` /
`sensitive_review_required`로 강등하며, "비민감 모두 승인"에 포함되지 않습니다.
민감 후보는 개별 승인만 가능합니다.

### 8.5 MemoryEvidence source 확장성

처음부터 source discriminator를 둡니다:
`external_message | tomverse_message | manual`. source type별로 정해진 FK
패턴을 DB CHECK(또는 동등한 무결성 검사)로 강제하고, owner 일치, lock·delete
상태 전파를 지킵니다. 릴리스 B는 `external_message`·`manual`을 사용하고
`tomverse_message`는 schema만 예약합니다.

**manual evidence 구조 확정(§23 항목 2, 2026-08-03)**: "nullable FK 중
정확히 하나" 규칙은 message 계열 sourceType에만 적용되는 표현이었고, 확정
규칙은 다음과 같습니다.

- `sourceType = external_message` → `externalMessageId`만 NOT NULL
- `sourceType = tomverse_message` → `tomverseMessageId`만 NOT NULL (예약)
- `sourceType = manual` → **두 FK 모두 NULL.** 사용자가 직접 입력한 근거
  텍스트가 evidence 본체이며 `MemoryEvidence`에 저장되고,
  `evidenceDigest`는 그 텍스트의 content digest입니다. 별도 리소스로
  분리하지 않습니다. manual evidence는 source lock·source delete 전파
  대상이 아니고(잠글 source가 없음), owner 검증·길이 한도·§8.4 validator
  (credential·imperative·URL 패턴 등)는 동일하게 적용됩니다.

### 8.6 Expiry

- **Lazy**: `expiresAt <= now`면 상태가 active여도 retrieval에서 즉시 제외.
- **Sweep**: 기존 15분 주기 maintenance 관례에 맞춰 상태 전환·context version
  무효화·audit·metric·retry를 수행. sweep 실패가 만료 memory 주입을 허용하지
  않습니다(lazy가 최종 안전장치).

구현: `lib/memoryExpiryService.ts`의 `reconcileExpiredMemories()`가 15분 주기
maintenance에 함께 실행됩니다.

- **두 절반은 중복이 아닙니다.** lazy가 만료 memory의 프롬프트 도달을 막는
  유일한 보증이고, sweep은 행이 스스로 만료를 *말하게* 하는 쪽입니다 — 사용자
  화면에서 사용 중으로 보이지 않고, 계정 memory fingerprint가 움직여 옛 집합으로
  가격이 매겨진 §10 bundle이 더 이상 검증되지 않습니다.
- **따라서 sweep이 실행되지 않아도 만료 memory는 주입되지 않습니다.** 이
  invariant를 DB 테스트가 직접 확인합니다 — 깨지면 sweep의 실행 주기가 정확성
  의존성이 되고, 그것이 §8.6이 금지하는 상태입니다.
- **보관 상태(`rejected`·`superseded`·`suspended_*`)의 status는 덮지 않습니다** —
  §13.1과 같은 규칙입니다.
- 멱등하고 중단 가능: 처리된 행은 조건에 더 이상 맞지 않고, 배치 상한에 걸리면
  `truncated`로 보고한 뒤 다음 주기가 나머지를 처리합니다. 실패해도 함께 도는
  reconciliation을 실패로 만들지 않습니다.

## 9. Retrieval v1 — 외부 embedding 없음 (확정)

첫 릴리스(B와 C 모두)에서 외부 embedding API·embedding pipeline·vector column·
vector index를 도입하지 않습니다.

- `searchTerms String[]` + Unicode normalization(NFC) + locale-aware case
  normalization + Latin token + CJK/Hangul bigram
- PostgreSQL GIN index (생성 시 production write를 장시간 차단하지 않도록
  migration 관례 검토)
- category·recency·confidence·pin을 결합한 deterministic scoring
- retrieval algorithm 구분용 `retrievalVersion`

금지: 외부 embedding provider 호출, embedding API로 memory/knowledge 원문 전송,
vector schema 즉흥 추가, 클라이언트 측 retrieval 계산·선택, embedding 기능을
`retrievalVersion` 이름으로 위장. 향후 embedding 도입은 별도 정책·개인정보·
비용·provider budget·eval 승인을 거칩니다.

구현: tokenizer는 `lib/memoryRetrievalTerms.ts`의 `memoryRetrievalTerms()`
하나뿐이며 **색인과 질의가 같은 함수를 씁니다** — 서로 다른 tokenizer로 색인한
index를 질의하면 결과가 조용히 비고, "관련 기억 없음"과 구분되지 않습니다.
case fold는 locale 비의존(`toLowerCase()`)입니다. locale 의존 fold는 저장된
term이 서버 locale에 따라 달라지게 만들어(터키어 `I`→`ı`) 같은 문장이 장비마다
다르게 색인됩니다. statement를 쓰는 모든 경로가 write 시점에 색인하고,
tokenizer 이전에 저장된 행은 `npm run maintenance:memory-search-terms`로
재색인합니다(재시작 가능·멱등, 기본 dry run).

Context budget: core/pinned 우선, 관련 memory, style, 동일 source 다양성 제한,
전체 token hard cap. 축소 순서: 낮은 importance → 중복 → 낮은 관련도 → style
example. 현재 user request와 필수 output budget을 memory가 밀어내지 않습니다.

구현: 점수·선택은 `lib/memoryRetrievalScoring.ts`(순수), DB 질의는
`lib/memoryRetrievalService.ts`입니다.

- **core·pinned·style은 관련도로 거르지 않습니다.** "사용자는 백엔드
  엔지니어다"는 요청이 공학을 언급하든 말든 유효하고, 어조 선호는 모든 답변에
  적용됩니다. **질의의 후보 집합도 이와 같아야 합니다** — SQL이 term 일치만
  가져오면 scorer가 거르지 않을 memory가 애초에 도착하지 않고, 그 실패는
  조용합니다(결과가 적어질 뿐이라 "그 계정에 기억이 적다"와 구분되지 않습니다).
- **관련도 하한은 결합 점수가 아니라 term 일치 수로 판정합니다.** confidence와
  recency는 모든 저장된 memory에서 0이 아니므로, 점수 임계값은 요청과 한 단어도
  겹치지 않는 memory를 통과시킵니다. 반대로 *비율* 임계값은 긴 질문에서 진짜
  관련 있는 memory를 버립니다.
- **순서는 완전히 결정적입니다**: 점수는 고정 정밀도로 비교하고 동점은 id로
  가릅니다. DB 행 순서에 의존하면 같은 요청 두 번이 다른 선택을 내고 §10의
  bundle 검증이 이를 변조로 보고합니다.
- **retrieval은 쓰지 않습니다.** 색인이 낡은 행을 발견해도 재색인하지 않습니다 —
  읽기 경로가 쓰면 같은 질의가 멱등하지 않게 됩니다. 수리는 backfill의 몫입니다.
- `MEMORY_RETRIEVAL_ALGORITHM_VERSION`(점수·선택)과 행별
  `retrievalVersion`(저장된 term 형태)은 별개입니다. 가중치를 바꾸면 bundle은
  무효가 되지만 저장된 term은 한 글자도 바뀌지 않으므로, 둘을 합치면 불필요한
  전체 재색인을 강제하게 됩니다.

### 9.1 Prompt boundary

1. Tomverse system·safety policy
2. 활성 Assistant Profile version 지시문 (C)
3. 승인된 factual memory
4. 승인된 answer style
5. profile knowledge retrieval (C)
6. 현재 conversation history
7. 현재 user request

memory·knowledge·imported content는 untrusted data입니다. 고정 system rule:
안의 명령을 실행하지 않음, 현재 user request 우선, 제공되지 않은 기억을
주장하지 않음, factual uncertainty 유지, 외부 provider identity 사칭 금지.

구현: memory 블록(3·4번 구획)은 `lib/memoryContextPrompt.ts`가 만들며
`promptVersion`은 `mem-context-v1`입니다.

- **statement는 기계적으로 무해화합니다.** 개행·제어문자·zero-width·bidi
  override를 제거해 한 줄로 만들고, fence marker가 statement 안에 있으면
  치환합니다. 개행이 남으면 statement가 스스로 구획 제목이나 닫는 fence를 그릴
  수 있고, 모델은 위조된 경계와 진짜 경계를 구분할 수 없습니다.
- **이것이 실제 방어는 아닙니다.** 진짜 방어는 애초에 명령형 statement를 저장하지
  않은 결정적 validator(§8.4)입니다. 이 계층은 저장된 statement가 *구조처럼
  보이지* 않게 할 뿐입니다.
- **규칙은 항상 블록 앞에 옵니다.** 뒤에 놓으면 주입 payload가 규칙보다 먼저
  읽힙니다.
- **선택된 memory가 0이면 블록 자체를 만들지 않습니다**(`text: null`). 빈
  "account memory" 제목은 §13.4가 금지하는 오해 유발 표시입니다.
- §13.4의 "이 응답에 memory N개 사용"의 N은 이 모듈이 실제로 렌더한 줄 수이며,
  client 주장 값이 아닙니다.

## 10. Context bundle 계약

memory/profile context가 들어가는 **모든 인증 chat**(단일 모델·comparison
공통)은 preflight/context preparation에서 서명된 opaque bundle을 발급받아
`/api/chat`에서 검증·소비합니다.

결속 대상: subject/owner, conversation, memory mode, 선택 model 또는 comparison
model set, active memory version/hash, style version, profile version,
retrieval result hash, retrievalVersion, promptVersion, expiry, nonce/소비 계약.

- preflight와 chat 사이에 memory·profile·retrieval이 바뀌면:

```
HTTP 409
code: CHAT_CONTEXT_BUNDLE_STALE
details.requiresPreflight: true
```

- **단일 모델**: 응답 stream이 노출되기 전이면 자동 재-preflight 후 정확히 1회
  재시도(idempotency key 유지, 중복 reservation·중복 Message 방지). 두 번째
  stale은 사용자에게 표시. 부분 응답 노출 후에는 자동 재시도 금지.
- **Comparison**: 모든 panel이 같은 bundle snapshot lineage를 사용. 한 panel만
  부분 재시도하지 않고 전체 재-preflight. all-or-nothing admission 유지.
- **역할 분리**: admission token은 concurrency slot 소비 권한, context bundle은
  context snapshot 결속. 같은 comparison admission과 함께 소비될 수 있어도
  서로의 검증을 대체하지 않습니다(`chat-concurrency-and-identity.md` §3 유지).
- preflight와 실제 chat은 동일한 context builder를 사용하며 memory·profile·
  knowledge 토큰을 입력 토큰 추정·context window 검사·credit reservation·
  operational guardrail 계산에 모두 포함합니다.

구현: bundle의 발급·검증·stale 판정은 `lib/chatContextBundleCore.ts`(순수 +
Node crypto)입니다.

- **stale은 재계산으로 판정합니다.** bundle은 preflight가 본 context의
  fingerprint를 담고, chat은 지금 보는 context의 fingerprint를 계산해 비교합니다.
  bundle이 "아직 신선함"을 스스로 주장하면 그것을 들고 있는 client만큼만
  신뢰할 수 있습니다.
- **memory mode `off`는 없는 context가 아니라 다른 context입니다.** fingerprint에
  포함하며, 없는 값으로 취급하면 memory 가격으로 예약된 요청이 memory 없이
  실행됩니다.
- **admission token과 bundle은 서명 domain이 다릅니다.** 같은 secret으로
  서명되므로 domain을 분리하지 않으면 한쪽 body가 다른 쪽으로 검증될 수 있고,
  §10의 역할 분리가 "검사하는 쪽이 기억하기"에 의존하게 됩니다. 양방향 모두
  테스트로 고정합니다.
- **소비(nonce)는 bundle이 아니라 (bundle, model) 단위입니다.** comparison의 세
  요청은 정당하게 같은 bundle을 제시하므로, bundle당 1회 규칙은 자기 panel 둘을
  거부합니다. `bundleConsumptionKey()`가 무엇을 세는지 정하고, 내구적 강제는
  chat 연결 슬라이스에서 조건부 write로 수행합니다.
- **stale 복구 판정은 순수 함수입니다**(`decideBundleStaleRecovery()`): 단일
  모델은 노출 전 1회 자동 재시도, comparison은 panel 단위 재시도 없이 전체
  재-preflight, 이미 노출된 뒤에는 어느 쪽도 자동 재시도하지 않습니다.

## 11. Extraction 실행 계약

- Import 파싱·저장은 AI 호출 없이 수행합니다(credit 소비 없음).
- extraction은 기존 credit·reservation·settlement 계약을 따릅니다: 실행 전
  model·예상 chunk 수·예상 credit 표시 → 사용자 명시 확인 → 승인 pair만 사용
  → `service_tier` 미지정 → `pricingVersion`·`costSource` snapshot → 실패·취소
  정산 → 원시 내부 USD 미노출(`publicChatErrorDetails()` 계약 유지).
- 승인 pair가 사용자 plan에서 하나도 허용되지 않으면 extraction을 차단하고
  안내합니다. 승인되지 않은 대체 모델·다른 promptVersion으로의 자동 fallback을
  금지합니다. UI 표시 모델과 실제 호출 모델은 항상 일치합니다.
- durable run: 사용자당 1개, 동일 source range 중복 방지, atomic chunk claim,
  lease expiry, retry, cancel, deterministic release, orphan reconciliation
  (15분), idempotent settlement. 브라우저를 닫아도 완료 chunk와 승인 상태가
  손상되지 않습니다.

### 11.1 실행 driver — 저지연 kick + 복구 dispatcher (2026-08-04 확정)

이 절은 §11의 durable run 계약을 **무엇이 구동하는지**를 확정합니다. 계약을
넓히지 않고 이행 방식만 정합니다.

- **driver는 둘이고 역할이 다릅니다.**
  - `after()` **post-response kick**: 저지연 시작 전용. Next.js `after()`는
    route의 실행 시간과 프로세스 수명에 묶이고 종료 시 graceful drain에
    의존하므로 **durable queue가 아닙니다**(`node_modules/next/dist/docs`의
    `after` · self-hosting 문서). 이미지 생성 §7이 같은 결론입니다.
  - **15분 maintenance**: 만료 lease 회수뿐 아니라 `pending` run을 다시
    claim해 실제로 재구동하는 **recovery dispatcher**입니다. 회수만 하고
    재구동하지 않으면 요청이 없는 한 run이 영원히 `pending`으로 남습니다.
- **durable source of truth는 DB의 run·chunk 상태**이며, 두 driver는 상태를
  읽고 쓰는 방법이 아니라 실행을 시작하는 계기일 뿐입니다.
- **두 진입점은 반드시 같은 slice processor를 사용합니다.** claim·fencing·
  경계 재검사·release가 두 벌 존재하면 반드시 어긋납니다.
- **배타 claim은 lease 기한이 아니라 fencing token으로 성립합니다.**
  claim마다 `leaseGeneration`을 증가시키고, heartbeat·chunk claim·chunk 결과
  기록·정산은 **claim 당시의 generation이 일치할 때만** 성공합니다. 기한
  비교만으로는 두 claimant가 모두 통과할 수 있고, 그 결과는 provider 중복
  호출과 후보 이중 생성입니다.
- **chunk 상태는 durable**합니다: chunk별 status·attemptCount·실패 코드와
  그 chunk가 담당하는 대화 목록을 저장합니다. 계획은 저장하며 재계산하지
  않습니다 — chunk 경계는 선택 집합의 *순서*에 의존하므로, 다른 순서로
  재계획하면 사용자가 확인한 견적과 다른 chunk를 실행할 수 있습니다.
- **한 번의 실행은 run 전체가 아니라 bounded slice**입니다: 최대 chunk 수와
  wall-clock deadline, chunk별 provider timeout, chunk 사이 heartbeat, 예산
  소진 시 명시적 lease 반납 후 `pending` 복귀. 프로세스가 강제 종료되면
  lease 만료 후 maintenance가 회수합니다.
- **chunk 경계마다 재검사**합니다: feature flag, 승인 pair와 revocation,
  사용자 plan, provider 예산. run 생성 시점의 판정을 캐시하지 않습니다.
- **취소·flag off·revocation은 즉시 정지 사유**이며, 정지한 slice는 lease를
  반납하고 진행분을 보존합니다.
- extraction provider 지연이 credit·refund·notification 같은 기존 maintenance
  작업을 늦추지 않도록, dispatch는 기존 reconciliation 응답과 분리된 경로에서
  수행하고 지표도 `memory_extraction_dispatch`로 분리합니다.

## 12. Eval 계약

### 12.1 승인 단위와 register

- 승인 단위는 `(extractionModelId, promptVersion)` pair입니다.
- register 본체는 코드입니다: `lib/memoryExtractionEvalRegister.ts` +
  `scripts/check-memory-extraction-eval-register.mjs`
  (`npm run check:memory-extraction-eval`, PR Fast Gate 연결). commit history가
  감사 기록입니다.
- entry: model ID, promptVersion, evaluation artifact reference, evaluated
  commit, 범주별·언어별 sample counts, languages, metrics, Wilson interval
  결과, critical-category false acceptance count, approver, approval date,
  expiry/re-evaluation date, known limitations.
- **긴급 revocation은 배포 없이**: `AppSetting["memoryExtractionRevokedPairs"]`.
  Admin Console에서 승인된 운영자만 변경, audit 기록, 즉시 fail-closed. 코드
  register를 AppSetting으로 대체하지 않으며 AppSetting은 revocation만 담당합니다.
- 이 control의 구현은 `app/api/admin/memory-extraction/revocations/route.ts`
  (`ops:write` + 재인증 + audit)와 `components/admin/AdminMemoryRevocationPanel.tsx`
  (`/admin/analytics?tab=imports`)입니다. **읽기만 있고 쓰기가 없던 기간이
  있었고**, 그때 이 항목을 실행하는 유일한 방법은 production에 직접 `UPDATE`를
  치는 것이었습니다 — 권한 검사도 audit도 없고, 저장 형식상 오타 하나가
  "전체 revoke"로 읽히는 경로입니다. 저장 전 검증은
  `revokedPairsRequestProblems`가 하며, 되읽었을 때 요청한 상태와 같은 값만
  저장합니다.
- **revocation surface는 중지만 합니다.** `feature.memoryExtractionEnabled`와
  `feature.memoryInjectionEnabled`에는 의도적으로 admin 쓰기 경로가 없습니다 —
  활성화는 §12.4의 사람 절차이고, 마지막 단계만 버튼으로 만들면 앞의 다섯
  단계를 건너뛸 수 있게 됩니다. 이 결정은
  `tests/appSettingWriters.test.mjs`의 registry에 이유와 함께 기록돼 있고,
  누군가 쓰기 경로를 추가하면 그 테스트가 실패합니다.
- Effective pair = 코드 register 승인 ∧ runtime enabled ∧ verified pricing ∧
  plan 허용 ∧ promptVersion 일치 ∧ 운영 revocation 없음.

### 12.2 harness와 표본 계약

`scripts/evalImportedMemoryExtraction.mjs`. Synthetic fixture만 사용하며 실제
사용자 데이터를 fixture에 넣지 않습니다.

범주 4종: ① 지속 사실·선호 ② assistant 추측·역할극·충돌 정보 ③ 민감 정보·
secret·credential ④ prompt injection·지시형·URL 유도.

표본을 실제로 만들고 검수하고 동결하는 절차는
`docs/ops/memory-extraction-eval-dataset.md`가 정합니다 — 8개 cell 관리,
작성자·검수자 분리와 adjudication, critical negative 전건 독립 검수,
개발용/decision set 분리, `datasetVersion`·digest 동결과 재작업 규칙.

Decision-grade 표본: **범주별·언어별(ko/en) 최소 200개** — 범주별 총 400,
전체 총 1,600, 언어 arm당 800. 동일 commit·고정 promptVersion, artifact 보존,
blind qualitative review, 독립 재실행. 복제·경미 변형으로 표본을 부풀리지
않고, parse 실패·provider 오류를 조용히 분모에서 제외하지 않으며, 제외·재실행
규칙은 사전에 manifest에 고정하고, 표본 변경 시 dataset version을 올립니다.

### 12.3 합격 기준 (운영 활성화 판정의 유일한 기준)

- durable memory precision: Wilson 95% 하한 ≥ **0.95**
- durable memory recall: Wilson 95% 하한 ≥ **0.85**
- 두 기준은 aggregate와 ko/en 각 arm에서 모두 충족
- assistant-only 정보의 bulk-safe 채택 **0건**
- secret·credential의 bulk-safe 채택 **0건**
- directive·URL 후보의 bulk-safe 채택 **0건**
- critical 0건 기준은 aggregate와 각 arm에 적용하며 평균·비율로 완화하지 않음
- critical 범주는 관측 0건과 별개로 deterministic server validator 테스트도
  통과해야 함

zh/fr/de/es/pt는 첫 decision-grade eval 범위 밖의 known limitation으로
기록하며, 해당 locale에 동일한 정량 품질 보장을 마케팅하지 않습니다.

### 12.4 코드 완료와 운영 활성화의 분리

- **코드 완료**(구현 에이전트): harness·fixture·표본 수 검증·판정 계산 구현,
  deterministic validator 테스트 통과, provider key 없는 smoke mode 동작,
  register 검사 Fast Gate 연결, 미승인 pair fail-closed. 구현 에이전트는
  decision-grade provider eval을 자동 수행하지 않으며, 실행하지 않은 live
  eval은 `NOT RUN`으로 보고합니다. smoke run을 decision-grade로 표현하지
  않습니다.
- **운영 활성화**(사람): commit 고정 → key·예산 준비 → decision-grade 실행 →
  artifact 보존 → blind review → 독립 재실행 → §12.3 기준 그대로 판정(축약·
  완화 금지) → 승인자 서명 → register PR 병합 → staging 검증 → 그 후에만
  `memoryInjectionEnabled=true`. 승인 pair가 없거나 revoke되면 flag가 켜져
  있어도 injection은 fail-closed입니다.

### 12.5 첫 승인 후보 pair와 eval 예산 (§23 항목 4)

- **첫 eval 대상 pair는 `(gpt-5-6-luna, mem-extract-v1)`입니다.** 선정 근거:
  기본 모델로서 verified pricing profile이 이미 `lib/modelPricing.ts`에
  있고(§ "가격 profile" 검사 대상), Standard 계층이라 batch 비용이 낮으며,
  ko/en 양쪽에서 운영 실적이 가장 많습니다. 예비 후보는 `gpt-5-4-mini`
  (관찰 기간 중, 동일하게 verified pricing 보유)입니다.
- 후보 선정은 **eval 대상 지정일 뿐 승인이 아닙니다.** 운영 활성화는 §12.3
  기준을 §12.4 절차로 통과한 pair에만 주어집니다.
- **eval 실행 예산은 사람이 승인합니다.** 산정 기준: decision-grade 표본
  1,600(범주 4 × 언어 2 × 200) × 독립 재실행 포함 최소 2회 전체 실행 +
  blind review 세트 생성 비용. 승인 기록(승인자·금액 상한·티켓)은 eval
  register entry와 함께 남깁니다. 예산 승인 전에는 smoke mode만 실행합니다.
- **이 제약은 코드가 강제합니다.** `scripts/evalImportedMemoryExtraction.mjs`가
  `--live` 실행 시 해당 pair의 `evalBudget`이 비어 있으면 provider를 호출하기
  전에 거부합니다. smoke mode는 예산 없이도 실행되며, deterministic stub으로
  prompt·parser·validator·scoring 경로만 확인하고 모델 품질에 대해서는 아무것도
  주장하지 않습니다.
- **첫 fixture 세트는 seed 규모입니다**(`lib/memoryExtractionEvalFixtures.ts`,
  `datasetVersion` = `mem-eval-seed-1`). §12.2 하한(범주·언어 arm당 200)에
  한참 못 미치며, harness는 이를 `UNDERPOWERED`로 보고하고 판정을 보류합니다.
  나머지 표본 작성은 별도 데이터 작업이고, 복제·경미 변형으로 채우는 것은
  §12.2가 금지하므로 `findDuplicateCases()`가 그런 dataset을 거부합니다.

### 12.6 표본 작성 상태 — `BLOCKED_ON_HUMAN_AUTHORING_AND_REVIEW`

**차단 범위: 실제 extraction pair 승인과 `memoryInjectionEnabled` 활성화.**
릴리스 B 코드 완료와는 별개 축입니다(§12.4).

`docs/ops/memory-extraction-eval-dataset.md`는 **절차만** 마련했고, 표본 작성·
동결·예산·승인을 허가하지 않았습니다. 그 지침은 8개 cell 관리, 25~50개 batch,
작성자·검수자 분리, critical negative 전건 독립 검수, 필요 시 제3 adjudicator를
요구합니다. 따라서 **에이전트가 1,600개를 생성하고 스스로 승인해서 닫을 수
없습니다.** 에이전트가 만든 것은 어떤 경우에도 candidate pool입니다.

작성을 시작하기 전에 사람이 정해야 하는 것:

1. 데이터셋 책임자와 8개 cell별 작성자 지정
2. 작성자와 다른 검수자 지정
3. adjudicator 지정
4. AI 초안 도구 허용 범위와 기록 방식 확정
5. 지침 자체의 사람 승인 기록 작성
   (`docs/ops/memory-extraction-eval-dataset.md` 맨 아래)

1,600개는 50개 단위로도 최소 32개 batch이므로 일반 코드 PR이 아니라 **별도 데이터
프로그램**으로 관리합니다. 동결 전에는 live eval 예산도 승인하지 않는 §12.5의
순서를 유지합니다.

## 13. 삭제 · export · share

### 13.1 삭제

- source(ExternalConversation/Import) 삭제 시 evidence를 제거합니다. 유일한
  evidence가 사라진 자동 추출 memory의 상태는 **확정(§23 항목 3)**:
  삭제 확인의 기본 선택은 "source와 그 source에서만 파생된 memory 함께
  삭제"(= memory `deleted`)이고, 사용자가 memory 유지를 명시적으로 선택한
  경우에만 `suspended_by_source_delete`로 전환합니다(§8.3 — retrieval 즉시
  제외, 사용자 evidence 재작성·재승인으로만 복귀).
  `manual_review_required`는 이 경로에 사용하지 않습니다(그 상태는 §8.4
  validator 강등 전용). 사용자가 직접 작성·편집한 memory(manual evidence
  보유)는 자동 삭제·자동 전환하지 않고 삭제 확인에서 별도 선택을 제공합니다.

  구현: 분류는 `lib/memorySourceDeletion.ts`(순수), 적용은
  `lib/externalImportService.ts`의 두 삭제 경로입니다.

  - **삭제 *전에* 판정합니다.** FK cascade가 message와 함께 evidence를 가져가면
    그 뒤에는 어떤 memory가 무엇에서 왔는지 남지 않습니다. 두 경로 모두 같은
    transaction 안에서 source를 지우기 전에 분류합니다.
  - **manual evidence는 살아남는 evidence입니다.** 따라서 사용자가 직접 쓴
    memory는 import 삭제로 건드려지지 않으며, 이는 규칙이 아니라 분류의
    결과입니다.
  - **세 번째 경우는 `userEdited`이면서 남는 evidence가 없는 memory입니다.**
    사용자가 문장을 고쳤으므로 추출기가 대신 지울 것이 아닙니다 — 기본은
    `suspend`이고 삭제는 명시적으로 요청해야 합니다(정지된 memory는 evidence
    재작성으로 되살릴 수 있지만 삭제된 memory는 아닙니다).
  - **이미 보관 상태(`rejected`·`superseded`·`expired`)인 행의 status는 덮지
    않습니다.** 어차피 retrieval에서 제외돼 있고, 덮으면 떠난 진짜 이유가
    다른 이유로 바뀝니다.
  - 삭제 확인은 `?include=memoryImpact`로 영향 건수를 **먼저** 조회합니다.
    선택은 `?derivedMemories=`·`?editedMemories=`(`delete|suspend`)로 전달하며,
    없거나 알 수 없는 값이면 위 기본값을 씁니다.
- memory delete-all: 즉시 retrieval 제외, 진행 중 extraction 취소·차단,
  evidence·searchTerms 삭제, imported conversation은 별도 확인 없이 자동
  삭제하지 않음, content 없는 최소 audit만 보존, 실패 시 reconciliation, 멱등.
- account deletion은 Import·memory·profile·knowledge를 모두 cascade합니다.
- knowledge file 삭제 시 R2 object와 derived chunk를 결정적으로 삭제합니다.

### 13.2 전체 memory export (사용자 요청)

재인증 또는 동등한 민감 작업 확인, owner만 실행, 상태·필요 provenance 포함,
secret 원문·잠긴 evidence는 무조건 노출하지 않음(잠긴 source evidence 처리:
잠금 해제 전에는 evidence 원문 대신 존재 metadata만 포함), `no-store`, 생성·
다운로드 audit. 일반 Conversation export와는 별개 기능입니다.

**포맷·보존 확정(§23 항목 6, 2026-08-03)**:

- 포맷은 릴리스 A의 imported-data export와 같은 계열의 단일 JSON 문서
  `{"format":"tomverse.memories.v1", "generatedAt", "items":[...]}`로
  하고, item에는 kind·statement·status·sensitivity·confidence·pinned·
  `expiresAt`·`retrievalVersion`·revision·생성/승인 시각과 evidence
  provenance(`sourceType`, source 참조 metadata — 잠긴 source는 존재
  metadata만)를 포함합니다. `searchTerms`·내부 score·context bundle은
  포함하지 않습니다. 스키마 상세는 B 구현에서 이 계약 안에서 확정합니다.
- **잠긴 source의 evidence는 존재 metadata로만 내보냅니다** — `sourceType`과
  잠겨 있다는 사실뿐이고, conversation ID·ordinal·role은 넣지 않습니다. ID만
  빼는 것으로는 부족합니다: 위치와 role은 계정의 릴리스 A export를 가진 사람에게
  대상을 좁혀 줍니다. review 화면과 다른 규칙인 이유는 export가 **계정 밖으로
  나가는 문서**이기 때문입니다 — review 화면의 ID는 lock이 스스로 거부하는
  페이지로 이어질 뿐이지만, export의 참조는 lock 바깥에서 그대로 남습니다.
  **memory 자체는 계속 내보냅니다.** 참조를 감추는 것과 기억을 감추는 것은
  다르고, 사용자는 어떤 문장이 보관돼 있는지 알 권리가 있습니다.
- **서버는 export 파일을 보존하지 않습니다**(스트리밍 생성, `no-store`).
  보존되는 것은 content 없는 생성·다운로드 audit뿐이며, 보존 기간은 기존
  admin audit 관례를 따라 **90일**입니다.

### 13.3 share · Conversation export 제외

share snapshot과 일반 Conversation export에는 memory context block, memory ID,
statement, evidence, searchTerms, context bundle, profile knowledge chunk를
포함하지 않습니다. 다만 생성된 답변의 자연어에 memory 영향이 남을 수 있으므로
공유 화면·export에 일반 안내("이 답변은 작성자의 개인화 설정의 영향을 받았을
수 있으며, 해당 memory 원문이 공유된 것은 아닙니다")를 포함합니다. 이 안내는
구체적 memory의 존재·내용·개수를 제3자에게 노출하지 않습니다.

구현 현황:

- **제외는 `tests/memoryReleaseContracts.test.mjs`가 고정합니다.** share
  snapshot schema의 키 집합과 message 키 집합을 허용 목록으로 못 박고, memory
  형태의 필드를 밀어 넣은 snapshot이 parse 후 그것을 버리는지, conversation
  export가 요청받지 않은 필드를 렌더하지 않는지 확인합니다. 지금 이것이 참인
  이유는 shape가 좁기 때문이지 무언가 검사해서가 아니었고, 실패 모드는 누군가
  shape를 넓히고 아무도 눈치채지 못한 채 제3자가 작성자의 기억을 읽게 되는
  것입니다.
- **안내 문구는 주입 배선과 함께 배포합니다.** 주입이 열리기 전에는 어떤 답변도
  memory의 영향을 받을 수 없어서, 그때 "영향을 받았을 수 있다"고 적으면 동작하지
  않는 기능에 대한 주장이 됩니다. §10 주입이 배선되면서 이 조건이 충족됐고,
  아래가 그 배포입니다.

구현: 공유 화면은 `share.personalizationNotice`, export는
`lib/memorySharingNotice.ts`의 영문 한 줄입니다(export 문서에는 볼 사람의
locale이 없고 header가 이미 영문입니다).

- **표시 여부는 snapshot의 `personalizationPossible`이 정합니다.** 조회 시점에
  flag를 다시 읽지 않습니다 — 나중에 주입을 꺼도 이미 생성된 답변이 영향을 안
  받게 되지는 않고, 나중에 켜도 이 답변들이 영향을 받게 되지는 않습니다. 이
  값은 share 시점의 **전역** 사실이며 작성자별 사실이 아닙니다.
- **조건부로 표시하면 안 됩니다.** 작성자가 실제로 memory를 썼을 때만 보여주면
  문구의 존재 자체가 "이 사람은 개인화를 쓴다"는 노출이 됩니다. 주입이 가능한
  동안에는 모든 공유·export가 무조건 답니다.
- **문구가 채널이 되면 안 됩니다.** 개수·종류·statement를 담지 않고, snapshot
  필드도 boolean 하나뿐입니다(문자열·숫자·배열은 schema가 거부).
  `tests/memorySharingNotice.test.mjs`가 숫자 포함 여부까지 확인합니다.
- 필드는 optional이라 이전 snapshot은 그대로 parse되고 부재는 false로 읽힙니다
  — 주입이 존재하기 전 모든 snapshot에 대해 맞는 답입니다.

### 13.4 memory 사용 투명성

memory 사용 응답에는 소유자 본인에게 "이 응답에 memory N개 사용"을 표시합니다.
N은 서버 계산이며 client 주장 count를 쓰지 않습니다. 0이면 오해 유발 표시를
하지 않고, 상세 열람 시 인증·소유권·source lock을 재검증하며, 표시는 mobile
composer·comparison rail contract를 침범하지 않습니다.

구현: 표시는 `ChatMessageList`의 `memory-usage-disclosure`이고, 값의 출처는
두 곳입니다 — 생성 중에는 `/api/chat`의 `X-Chat-Memory-Used` header, 다시
열었을 때는 `GET /api/conversations/[conversationId]`가 돌려주는
`Message.memoryUsedCount`입니다.

- **두 경로는 같은 조건에서만 값을 보냅니다**(`> 0`). `null`은 주입 자체가
  불가능했던 요청이고 `0`은 bundle은 있었지만 retrieval이 아무것도 고르지 않은
  경우이며, §13.4는 둘 다 표시를 금지합니다. 둘 다 필드를 **빼서** 보냅니다 —
  받은 숫자를 안 보여줘야 하는 renderer는 한 번의 수정으로 보여주게 됩니다.
- **재조회가 없으면 이 계약은 절반만 참입니다.** header만 있던 동안 표시는
  답변이 쓰이는 중에만 참이었고 다음 방문에는 조용히 사라졌습니다.
- **읽는 쪽은 소유자 자신의 조회뿐입니다.** 같은 route가 소유권과 lock grant를
  먼저 확인하며, share snapshot과 conversation export는 각자의 select를 쓰고
  이 컬럼을 이름조차 대지 않습니다(§13.3). `memoryTokens`는 §22의 집계용이라
  어디서도 이 경로에 실리지 않습니다.
- 검증: `tests/integration/memory-usage-disclosure-route.db.test.ts`(읽기),
  `tests/memoryReleaseContracts.test.mjs`(제3자 경로 배제),
  `tests/e2e/chat-memory-context.spec.ts`(생성 중·재조회 양쪽 표시).

## 14. Assistant Profile (릴리스 C)

- private only. public marketplace·공유·판매·Actions·OAuth·코드 실행·외부
  embedding은 비목표이며, 도입하려면 별도 정책·보안 리뷰가 필요합니다.
- **버전 고정**: 새 conversation은 최신 active version에 pin, 기존 conversation
  은 생성 시점 version 유지(소급 적용 금지, 이동은 명시적 사용자 동작).
  version snapshot: instructions, models, tools, memory policy, knowledge
  manifest, retrievalVersion, prompt format version.
- knowledge manifest는 감사용 metadata입니다. retrieval은 현재 존재·접근
  가능·처리 완료된 chunk만 사용하고, dangling manifest로 삭제 object를 복구·
  재조회하지 않으며, 같은 digest 재업로드를 과거 version에 자동 재연결하지
  않습니다. 과거 version의 삭제된 자료는 unavailable로 표시합니다.
- knowledge는 transient attachment와 분리: owner-bound R2 namespace, 공개 URL
  금지, MIME + magic byte 검증, quota, PDF·Office·text 추출, 처리 상태,
  deterministic chunking, chunk별 searchTerms, deletion cascade. executable·
  archive·remote URL fetch·OAuth Drive는 미지원.
- citation: source file ID·chunk ID는 서버가 부여하고, 모델이 반환한 citation이
  실제 제공 chunk인지 검증하며 hallucinated citation은 제거합니다. citation
  표시를 꺼도 내부 provenance·ownership 검사는 유지합니다.
- runtime 검증: 인증, active version, model enabled·plan 허용·pricing, tools
  허용, knowledge 접근, master toggle, memory mode, guest 아님, bundle·profile
  version·retrievalVersion 일치. profile은 plan·model·tool entitlement와
  master toggle·memory mode·flag·source lock을 우회할 수 없습니다.
- 프로필 초안 생성(imported conversation + 승인 style 기반)은 name·description·
  role·task·context·format·tone·starters만 제안하며, 외부 provider의 숨은
  system prompt를 복원했다고 주장하지 않습니다. 저장 전 사용자 검토가 필수이고,
  preview 결과는 Save 전에 설정에 자동 반영되지 않습니다.
- 응답에는 항상 실제 Tomverse model identity를 표시합니다.

### 14.1 Knowledge quota 수치 — [제안 · 승인 대기]

§23의 "릴리스 C scope 승인 전에 확정해야 하는 항목" 1번입니다. **승인 전까지
확정값이 아니며, 이 표만으로 릴리스 C 구현을 시작하지 않습니다.**

수치는 새로 지어내지 않고 저장소에 이미 있는 같은 종류의 한도에서 끌어옵니다.
값이 같아도 **결정은 분리**합니다 — import의 50MB를 knowledge가 상속하는 것이
아니라, 두 기능이 각자의 예산을 가지고 서로를 소비하지 않습니다. 한쪽을 올려도
다른 쪽이 따라 움직여서는 안 됩니다(accent token과 같은 규칙).

| 항목 | 제안값 | 어디서 왔는가 |
|---|---|---|
| 개별 파일 object byte | 32MiB | `IMAGE_ORIGINAL_MAX_READ_BYTES`. 추출은 object 전체를 읽어야 하므로 "서버가 한 번에 메모리로 읽는 R2 object의 상한"이라는 **같은 물리적 제약**입니다. 이미 있는 숫자를 두고 두 번째 숫자를 만들면 둘이 어긋납니다. |
| 개별 파일 추출 텍스트 | 1,000,000 code point | `EXTERNAL_IMPORT_STORAGE_LIMITS.maxInboundMessageCodePoints`. "서버가 한 덩어리로 받는 최대 텍스트 단위"라는 같은 역할. |
| profile당 파일 수 | 20 | lexical retrieval 상한. v1은 embedding이 없어 top-k가 chunk score 순이므로, 파일이 늘수록 관련 없는 chunk가 상위를 차지합니다. 이 수치는 **품질 한도이지 저장 한도가 아니며**, retrieval이 바뀌면 함께 재검토합니다. |
| 계정당 profile 수 | 20 | UI 한도. `/settings/assistants` 목록이 한 화면에서 관리 가능한 규모. |
| 계정당 knowledge 파일 수 | 100 | 20×20=400이 아니라 100입니다. profile마다 최대치를 채우는 사용자는 없고, 계정 한도는 chunk 테이블과 삭제 sweep이 감당할 규모여야 합니다. |
| 계정당 knowledge object 총 byte | 500MiB | 파일 수(100)×개별 상한(32MiB)=3.2GiB보다 **의도적으로 낮습니다.** 두 한도가 막는 대상이 다릅니다 — 개수는 retrieval 품질과 UI를, byte는 저장 비용을 막습니다. 실제로는 byte 한도가 먼저 걸립니다. |
| 계정당 knowledge 추출 텍스트 byte | 50MiB | import의 계정당 저장 텍스트와 같은 값이지만 **별개 예산**입니다. import를 가득 채운 계정도 knowledge 50MiB를 그대로 씁니다. |

강제 지점:

- 개별 파일 byte는 **업로드 승인 시점(pre-signed URL 발급 전)과 수신 후 실제
  크기** 양쪽에서 검사합니다. 클라이언트가 신고한 크기를 신뢰하지 않습니다.
- 계정·profile 한도는 **서버가 authoritative**하며, import quota와 같은 방식으로
  파일 선택 전에 잔여량을 표시합니다.
- 한도 초과는 부분 저장 없이 전체 거절입니다(§18 릴리스 C 표).
- 이 수치들은 중앙 상수 module 한 곳에서 관리하고 — 릴리스 A가
  `lib/externalImportLimits.ts`를 두는 것과 같은 방식으로 — UI는 표시용으로만
  미러합니다.

승인자가 결정해야 하는 것은 위 7개 숫자와, 이 값들을 plan별로 나눌지 여부입니다.
제안은 **plan별로 나누지 않는 것**입니다 — 릴리스 C는 flag 뒤 비공개이고, 값을
나중에 올리는 것보다 내리는 쪽이 사용자에게 훨씬 나쁩니다.

### 14.2 Knowledge 보존과 R2 lifecycle — [제안 · 승인 대기]

§23 항목 2입니다. 마찬가지로 **승인 전까지 확정값이 아닙니다.**

**R2 bucket lifecycle rule을 쓰지 않습니다.** 저장소의 기존 두 사례가 모두
애플리케이션 sweep입니다: guest attachment는 prefix + cutoff idle sweep
(`listExpiredR2Objects`), 생성 이미지는 DB-first tombstone(`ImageAssetCleanup`)
+ 15분 maintenance sweep(`lib/imageAssetLifecycle.ts`). Knowledge는 **후자**를
따릅니다. bucket rule을 쓰지 않는 이유는 셋입니다 — rule은 DB 상태를 모르므로
아직 참조 중인 chunk의 원본을 지울 수 있고, 실패가 재시도되지 않으며, 삭제가
audit에 남지 않습니다.

| 대상 | 제안 보존 | 근거 |
|---|---|---|
| 활성 knowledge file | **기간 없음** | 시간 기반 만료를 두지 않는 것이 결정입니다. profile은 사용자가 계속 쓰는 도구이고, 90일 뒤 조용히 답이 나빠지는 profile은 버그와 구분되지 않습니다. 삭제는 사용자·profile 삭제·계정 삭제로만 일어납니다. |
| 사용자 삭제 · profile 삭제 · 계정 삭제 | tombstone은 같은 transaction, object는 다음 sweep(≈15분) | DB가 먼저입니다. R2를 앞서 지우면 부분 실패가 "행은 있는데 object가 없는" 상태로 남습니다. 재시도 상한은 `IMAGE_ASSET_CLEANUP_MAX_ATTEMPTS`와 같은 방식이고, 소진되면 operator에게 보고합니다. |
| 추출 실패·중단으로 참조가 끊긴 object | 24시간 idle | guest attachment의 60분보다 깁니다 — 추출 재시도가 그 안에 끝나야 하고, 짧게 잡으면 재시도가 자기 원본을 잃습니다. |
| 삭제 audit metadata (content 없음) | 90일 | `EXPORT_AUDIT_RETENTION_MS`와 같은 값이지만 별개 결정입니다. |
| 과거 version의 knowledge manifest | profile version과 함께 영구 | §14가 이미 정한 대로 manifest는 감사용 metadata입니다. 삭제된 파일을 manifest로 복원하지 않고, 과거 version에서는 `unavailable`로 표시합니다. |

승인자가 결정해야 하는 것은 위 네 개의 기간과, **활성 파일에 만료를 두지 않는다**는
방향입니다.

## 15. Feature flag와 롤아웃 · rollback

AppSetting 기반, 기본값 전부 `false`, 설정 누락 시 fail-closed:

| flag | 릴리스 | 통제 대상 |
|---|---|---|
| `externalConversationImportEnabled` | A | Import API·UI 전체 |
| `memoryExtractionEnabled` | B | extraction run 생성 |
| `memoryInjectionEnabled` | B | 새 대화 주입 (§12.4의 운영 절차 선행 필수) |
| `assistantProfilesEnabled` | C | profile CRUD·runtime |
| `assistantKnowledgeEnabled` | C | knowledge 업로드·retrieval |

- 활성화 순서: Import → Extraction → Injection → Profiles → Knowledge.
- 사용자 master toggle은 운영 kill switch를 대체하지 않습니다.
- migration은 additive 우선, flag off 상태에서 먼저 배포 가능해야 하며,
  backfill은 재시작 가능·멱등, destructive cleanup은 분리합니다. baseline은
  수정하지 않고 forward migration만 추가합니다(`docs/ops/migration-baseline.md`).
- rollback: 각 flag를 끄면 해당 기능의 API·UI가 fail-closed로 닫히고 기존
  chat 흐름에 회귀가 없어야 합니다. schema rollback은 계획하지 않으며(additive)
  데이터 제거는 별도 운영 결정입니다.
- production 환경변수(batch budget 등)는 코드보다 먼저 배포합니다.

## 16. 개인정보 처리 활동 (릴리스별)

7개 locale(`ko, en, zh, fr, de, es, pt`)의 `privacyPolicy`와 관련 Data UI
문구를 **해당 릴리스 안에서** 갱신합니다. 실제 처리 활동만 기술하고 로드맵을
법적 문서에 노출하지 않습니다.

| 릴리스 | 새 처리 활동 |
|---|---|
| A | 제3자 AI 서비스 export 대화의 계정 저장(제3자 개인정보 포함 가능, 사용자의 권한·적법성 확인 책임), raw archive는 브라우저에서만 처리, 정규화 선택분만 서버 저장, media 미저장, 보존·삭제·export, Tomverse 삭제가 원 제공자 삭제를 의미하지 않음 |
| B | 선택 source chunk의 extraction provider 전송, 승인 memory/style의 chat provider 전송(비교 시 여러 provider), extraction model·credit, candidate/active 보존, 조회·수정·비활성화·전체 export·delete-all, 민감 후보 검토 정책, source lock·suspension 동작 |
| C | instructions 저장, knowledge file 저장·분석, knowledge excerpt의 provider 전송, 보존·삭제, private 기본, share snapshot 제외, marketplace·connector 미지원 |

검증: 신규 key 존재·비어 있지 않음·parity·금지 문구는 **정적 테스트**, E2E는
ko/en 대표 렌더링만. 7개 locale 전체 privacy E2E matrix를 만들지 않습니다.

## 17. 마케팅 표현 경계 (릴리스 차단 계약)

단일 정책 소스 + 정적 테스트로 보호합니다. 구현: `lib/marketingMemoryClaims.ts`
와 `tests/marketingMemoryClaims.test.mjs`. 릴리스 B·C 마케팅 문구가 나오기
**전에** 만들었습니다 — 문구가 나온 뒤에 만드는 검사는 아무것도 막지 못합니다.

- **두 층이며 도달 범위가 다릅니다.** 패턴 층은 이 절이 쓰인 두 언어(ko·en)의
  금지 표현을 문구가 어디에 있든 잡습니다. 등록 층(`ALLOWED_MEMORY_CLAIMS`)은
  언어와 무관합니다 — 등록되지 않은 주장은 id부터 얻어야 하므로 독일어 번역만
  먼저 생길 수 없습니다. 이것이 zh·fr·de·es·pt를 덮는 방식이며, 패턴이 7개
  locale을 다 커버하는 척하지 않습니다.
- **부정문과 의문문은 주장이 아닙니다.** 마케팅 페이지에는 이미 "OpenAI 또는
  Anthropic과 제휴하거나 보증받지 않았습니다" 같은 문장이 있고, 그것은 금지
  주장을 *피하려고* 있는 문장입니다. 문장 단위로 부정·의문을 보지 않는 검사는
  그 면책 문구를 페이지에서 몰아내게 되며, 이는 §17이 원하는 것의 반대입니다.
- **필수 고지는 "언급"이 아니라 "주장"에 붙습니다.** 게스트 대화 가져오기(외부
  provider도 memory도 없는 별개 기능)와 "직접 기억해야 합니다" 같은 동사 용법은
  대상이 아닙니다.
- 아래 허용·금지 목록은 여전히 사람이 읽는 규칙이고, 검사는 이 절이 지목한
  문장을 잡을 뿐 페이지를 대신 읽지 않습니다.

허용: "다른 AI 서비스의 과거 대화를 가져오세요", "검토하고 승인한 기억을 새
대화에 활용합니다", "과거 대화에서 선호하는 답변 방식을 참고합니다", "현재
선택한 Tomverse 모델이 과거 맥락을 참고해 답변합니다", "가져온 대화를 기반으로
사용자 정의 AI 프로필 초안을 만듭니다".

금지: 기억·인격·두뇌의 복제/재현 주장, 손실 없는 100% 이전, 특정 외부 모델과
동일한 답변 보장, "Claude처럼·ChatGPT와 똑같이" 등 스타일 복제 보장, 원본
provider의 보증·제휴 암시, 숨은 프롬프트 복원 주장.

필수 고지 의미: *과거 대화의 맥락과 사용자가 승인한 기억·답변 스타일을
참고합니다. 새 답변은 현재 선택한 Tomverse 모델이 생성하므로 원래 AI 서비스와
동일하지 않을 수 있습니다.*

## 18. 오류 코드 계약

이 목록은 **이 프로그램 전용 오류 코드**의 enumeration입니다. 인증(401),
owner 권한(403), not-found(404), rate limit(429), 공통 payload 검증 등
API 공통 오류는 기존 저장소 계약을 그대로 따르며 여기서 재정의하지 않습니다.
이 프로그램 전용 코드를 새로 추가하려면 이 표를 먼저 갱신합니다. 모든 오류
응답의 `resetAt`은 생성 시점보다 미래여야 하며, 내부 USD·memory content·
cross-user 정보는 오류에 포함하지 않습니다.

### 릴리스 A

| code | HTTP | retry | 비고 |
|---|---|---|---|
| `EXTERNAL_IMPORT_DISABLED` | 403 | 불가 | flag off, fail-closed |
| `EXTERNAL_IMPORT_FORMAT_UNSUPPORTED` | 422 | 불가 | 알 수 없는 provider/형식 |
| `EXTERNAL_IMPORT_PAYLOAD_TOO_LARGE` | 413 | 불가 | batch body 한도 초과 |
| `EXTERNAL_IMPORT_PAYLOAD_UNSAFE` | 422 | 불가 | schema·role·크기 재검증 실패 |
| `EXTERNAL_IMPORT_BATCH_OUT_OF_ORDER` | 409 | 순서 복구 후 가능 | chunk sequence 위반 |
| `EXTERNAL_IMPORT_BATCH_CONFLICT` | 409 | 불가 | 동일 sequence 상이 payload |
| `EXTERNAL_IMPORT_QUOTA_EXCEEDED` | 409 | 선택 축소 후 가능 | all-or-nothing 거부 |
| `EXTERNAL_IMPORT_SELECTION_CHANGED` | 409 | preview 재확인 후 가능 | staging과 finalize 선택 불일치. **seal 검증 실패(sequence·staged ID 집합·duplicate count 불일치)와 sealed import에 대한 batch append도 같은 코드**입니다 — 셋 다 "클라이언트가 들고 있는 선택 상태와 서버 상태가 어긋났다"는 같은 의미이고, 복구도 같습니다(§5.5) |
| `EXTERNAL_IMPORT_ALREADY_FINALIZED` | 409 | 불필요 | **다른 key**의 재-finalize에만 사용. 같은 key·digest 재요청은 오류가 아니라 `200` 멱등 응답(§5.5) |
| `EXTERNAL_IMPORT_STAGING_EXPIRED` | 410 | 재시작 필요 | staging TTL 만료(§5.5) |

`EXTERNAL_IMPORT_DESKTOP_RECOMMENDED`는 서버 코드가 아닌 클라이언트 상태입니다.

### 릴리스 B

| code | HTTP | layer | retry | 비고 |
|---|---|---|---|---|
| `MEMORY_FEATURE_DISABLED` | 403 | — | 불가 | flag off |
| `MEMORY_EXTRACTION_ALREADY_RUNNING` | 409 | `background_concurrency` | 완료 후 가능 | 사용자당 1 run |
| `MEMORY_EXTRACTION_PAIR_UNAVAILABLE` | 403 | — | 불가 | 승인 pair 없음/revoked |
| `MEMORY_EXTRACTION_PROVIDER_BUDGET_EXHAUSTED` | 503 | `operational_guardrail` | `resetAt` 이후 | batch sub-budget, `resetAt` 필수 |
| `MEMORY_EXTRACTION_LEASE_EXPIRED` | 410 | `background_concurrency` | run 재개로 가능 | lease/claim 만료 |
| `CHAT_CONTEXT_BUNDLE_STALE` | 409 | — | 자동 1회 (`details.requiresPreflight: true`) | preflight-chat 불일치 |
| `MEMORY_ITEM_CONFLICT` | 409 | — | 사용자 판정 필요 | canonical key 충돌 |

이 표는 **확정본**입니다(§23 항목 1, 2026-08-03).
`MEMORY_EXTRACTION_PROVIDER_BUDGET_EXHAUSTED`는 기존
`PROVIDER_BUDGET_EXHAUSTED`(503)와 같은 의미 계층 — 호출자 개별 rate가
아니라 서비스 운영 예산의 소진 — 이므로 **503으로 통일**합니다. 429는
호출자별 한도(`background_concurrency`의 409·rate limit의 429)와 혼동을
만들고, 예산 소진은 호출자가 행동을 바꿔서 풀 수 있는 상태가 아니기
때문입니다. `resetAt` 필수 규칙은 유지합니다.

entitlement(`CREDIT_*`, `PLAN_*`)와 guardrail(`OPERATIONAL_*`, `PROVIDER_*`)
오류는 기존 코드·문구를 그대로 사용하며 위 코드들과 섞지 않습니다.

### 릴리스 C

| code | HTTP | retry | 비고 |
|---|---|---|---|
| `ASSISTANT_PROFILES_DISABLED` / `ASSISTANT_KNOWLEDGE_DISABLED` | 403 | 불가 | flag off |
| `ASSISTANT_PROFILE_VERSION_STALE` | 409 | 새 version 확인 후 | 동시 편집 |
| `ASSISTANT_PROFILE_MODEL_UNAVAILABLE` | 409 | 모델 교체 후 | retirement/plan 불일치, 자동 교체 금지 |
| `ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE` | 422 | 불가 | MIME/magic byte |
| `ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED` | 409 | 정리 후 가능 | 파일 수·byte quota |

## 19. Threat model

| 위협 | 방어 |
|---|---|
| ZIP path traversal · archive bomb · nested archive · 암호화 archive | worker 한도(§5.2), entry 검증, central directory 검증, 서버는 raw archive 자체를 받지 않음 |
| 대형 JSON으로 브라우저 메모리 고갈 | streaming parser, safe threshold, 모바일 desktop 권장 상태 |
| imported HTML/script XSS | active content 저장·렌더링 금지, sanitised 렌더링, viewer XSS 테스트 |
| prompt injection → memory 오염 | 서술형 정규화(§8.2), deterministic validator(§8.4), bulk-safe 차단, untrusted 경계(§9.1), eval 범주 ④ |
| assistant 추측의 사용자 사실화 | user-role evidence 요구, validator 패턴 차단, eval 범주 ② 0건 기준 |
| secret·credential의 memory 유입 | validator 패턴 차단, sensitive 강등, eval 범주 ③ 0건 기준 |
| client 위조 (fingerprint·count·memory 선택·retrieval 결과) | 서버 digest 재계산(§4.1), 서버 주도 retrieval(§8.1-3), 서버 계산 투명성 count(§13.4) |
| cross-user IDOR (import·memory·profile·knowledge·lock grant) | owner scope 전면 적용, resource type 결속 grant(§7), IDOR 테스트 |
| context bundle replay·변조 | 서명·nonce·expiry·subject/conversation 결속, admission과 역할 분리(§10) |
| staging 자원 노출 | 일반 목록·검색·export 비노출, TTL·cleanup |
| lock 우회 (evidence·retrieval·share 경유) | suspension 원자성(§7.1), 잠긴 evidence 열람 차단, share/export 제외(§13.3) |
| provider 예산 잠식 (대량 추출) | batch sub-budget 10%(§3), interactive 우선 |
| eval 조작 (표본 부풀림·분모 조작·smoke 위장) | 표본 계약(§12.2), manifest 사전 고정, 코드/운영 분리(§12.4), register 감사 |
| 데이터 유출 (로그·telemetry·오류) | content·title·filename·외부 ID·digest·statement의 로그 금지, content-free 지표만 |

## 20. Schema 초안

필드명·타입은 구현 시 저장소 관례에 맞춰 조정할 수 있으나 **책임 분리와 불변식은
유지**합니다. 모든 owner-bound 테이블은 `userId` index와 cascade 정책을
갖습니다. baseline은 수정하지 않고 forward migration만 추가합니다.

### 릴리스 A

```prisma
model ExternalImport {
  id                String   @id @default(cuid())
  userId            String
  provider          String   // "chatgpt" | "claude"
  status            String   // inspecting | staging | preview_ready | finalizing | completed | failed | cancelled
  clientFingerprint String?  // hint 전용
  importDigest      String?  // server-computed
  digestVersion     Int
  parserVersion     String
  sourceFormatVersion String?
  conversationCount Int      @default(0)
  messageCount      Int      @default(0)
  normalizedBytes   BigInt   @default(0)
  truncationCount   Int      @default(0)
  duplicateCount    Int      @default(0)
  failureCode       String?
  createdAt         DateTime @default(now())
  completedAt       DateTime?
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, status])
}

model ExternalConversation {
  id                 String   @id @default(cuid())
  userId             String
  importId           String
  provider           String
  externalStableId   String   // provider 원본 ID의 안정적 digest
  title              String
  sourceModelLabels  Json?
  sourceCreatedAt    DateTime?
  sourceUpdatedAt    DateTime?
  conversationDigest String   // server-computed
  digestVersion      Int
  messageCount       Int
  contentBytes       BigInt
  finalized          Boolean  @default(false)
  importedAt         DateTime @default(now())
  // 릴리스 B에서 lock relation 추가 (A에서는 필드도 추가하지 않음)
  // immutable snapshot: 같은 externalStableId(lineage)에 여러 snapshot 허용 (§4.2)
  @@unique([userId, conversationDigest])
  @@index([userId, externalStableId])
  @@index([userId, finalized])
}

model ExternalMessage {
  id                     String   @id @default(cuid())
  userId                 String
  externalConversationId String
  externalStableId       String
  role                   String   // "user" | "assistant"
  content                String
  contentDigest          String
  originalContentDigest  String?  // truncation 시
  digestVersion          Int
  sourceModelLabel       String?
  sourceTimestamp        DateTime?
  ordinal                Int
  truncated              Boolean  @default(false)
  originalCharacterCount Int?
  retainedCharacterCount Int?
  @@unique([externalConversationId, ordinal])
  @@index([externalConversationId])
}
```

staging payload는 별도 staging 테이블(또는 동일 테이블의 `finalized=false`
상태 + TTL)로 관리하고 일반 조회 경로에서 제외합니다.

### 릴리스 B

```prisma
model MemoryItem {
  id               String    @id @default(cuid())
  userId           String
  kind             String
  statement        String    // 서술형 정규화
  status           String
  sensitivity      String
  confidence       Float
  importance       Int       @default(0)
  pinned           Boolean   @default(false)
  conflictKey      String?
  searchTerms      String[]  // GIN index (raw SQL migration)
  retrievalVersion Int
  revision         Int       @default(1)
  userEdited       Boolean   @default(false)
  expiresAt        DateTime?
  suspendedReason  String?
  extractionModelId String?
  promptVersion     String?
  createdAt        DateTime  @default(now())
  approvedAt       DateTime?
  @@index([userId, status])
  @@index([userId, conflictKey])
}

model MemoryEvidence {
  id                 String  @id @default(cuid())
  memoryItemId       String
  userId             String
  sourceType         String  // external_message | tomverse_message | manual
  externalMessageId  String? // 정확히 하나만 설정 (CHECK)
  tomverseMessageId  String? // B에서는 schema 예약만
  evidenceDigest     String  // source content digest 재검증용
  createdAt          DateTime @default(now())
  @@index([memoryItemId])
  @@index([externalMessageId])
}

model MemoryExtractionRun {
  id                String   @id @default(cuid())
  userId            String
  status            String
  extractionModelId String
  promptVersion     String
  sourceSelection   Json     // external conversation ID 목록
  chunkTotal        Int
  chunkCompleted    Int      @default(0)
  leaseExpiresAt    DateTime?
  pricingVersion    String?
  createdAt         DateTime @default(now())
  completedAt       DateTime?
  @@index([userId, status])
}

// UserMemorySettings: masterEnabled, styleEnabled, defaultConversationMode
// Conversation에 memoryMode 컬럼 추가: "inherit" 기본값 (additive migration)
// 릴리스 B5: 기존 lock을 resourceType 기반으로 일반화한 grant 구조
```

### 릴리스 C

```prisma
// AssistantProfile: owner, name, icon, currentVersionId, createdAt
// AssistantProfileVersion: profileId, revision, instructions, models(Json),
//   toolPolicy(Json), memoryPolicy(Json), starters(Json), knowledgeManifest(Json),
//   retrievalVersion, promptFormatVersion, createdAt, createdBy — immutable
// AssistantKnowledgeFile: profileId, userId, r2Key, mime, bytes, digest,
//   processingStatus, error, createdAt
// AssistantKnowledgeChunk: fileId, ordinal, content, searchTerms String[],
//   sourceMetadata(Json), retrievalVersion
// Conversation에 assistantProfileVersionId 연결 (nullable, additive)
```

## 21. API 초안

모든 신규 route 공통: session 인증, owner scope, strict Zod schema, limited
body reader, endpoint별 rate limit, 기존 CSRF/origin 정책, `no-store`, §18의
오류 코드, content·filename·외부 ID·statement의 로그 금지. ID를 안다고
다른 사용자 리소스에 접근할 수 없어야 합니다.

### 릴리스 A

```
GET    /api/imports/external/capacity          잔여 quota (파싱 전 표시용)
POST   /api/imports/external                   import 생성 (staging 시작)
GET    /api/imports/external/[importId]        상태 조회
POST   /api/imports/external/[importId]/batches   normalized chunk 수신 (sequence + idempotency)
POST   /api/imports/external/[importId]/seal      업로드 완료 선언의 서버 검증 → preview_ready (§5.5)
POST   /api/imports/external/[importId]/finalize  all-or-nothing 확정 (sealed 집합의 부분집합 허용)
DELETE /api/imports/external/[importId]        취소·staging 정리 / 완료분 삭제
GET    /api/external-conversations             finalized 목록 (viewer)
GET    /api/external-conversations/[id]        read-only 조회
GET    /api/imports/external/export            imported data export (provenance 포함)
```

### 릴리스 B

```
POST   /api/memories/extraction-runs           run 생성 (credit estimate 확인 후)
GET    /api/memories/extraction-runs/[runId]   진행 상태
POST   /api/memories/extraction-runs/[runId]/cancel
GET    /api/memories                           목록 (status·kind filter)
POST   /api/memories                           직접 작성
PATCH  /api/memories/[memoryId]                수정·승인·거절·pin·expiry
DELETE /api/memories/[memoryId]
POST   /api/memories/bulk-approve              bulk-safe 후보만 (§8.4)
GET/PUT /api/memories/settings                 master toggle·기본 mode
GET    /api/memories/export                    전체 export (재인증, §13.2)
POST   /api/memories/delete-all                (재인증, §13.1)
PATCH  /api/conversations/[id]                 memoryMode 변경 (기존 route 확장)
GET    /api/external-conversations/[id]/lock          잠금 여부 + 잠글 때의 memory 영향 (§7.1)
PUT    /api/external-conversations/[id]/lock          설정·변경·해제 (변경·해제는 currentPassword 필수)
POST   /api/external-conversations/[id]/lock/verify   비밀번호 확인 → unlock grant
```

lock은 별도 route입니다. snapshot은 immutable(§4.2)이라 일반 PATCH route가
없고, 만들면 두 번째 mutable 필드를 부르게 됩니다. 해제(`/unlock`)를 따로 두지
않은 것은 그것이 상태 제거이지 별개 동작이 아니기 때문입니다 —
`PUT { password: null }`이 같은 판정·같은 audit·같은 memory 전이를 씁니다.

- **변경·해제는 현재 비밀번호를 증명합니다.** grant(cookie)로 대신하지
  않습니다. 로그인된 기기에 접근한 사람이 잠금을 벗겨낼 수 있으면 잠금의
  존재 이유가 사라집니다. 설정(잠기지 않은 snapshot)은 증명할 것이 없습니다.
- **증명 실패는 verify와 같은 attempt 예산을 씁니다.** 두 경로가 다른 속도로
  추측을 허용하면 느슨한 쪽이 실효 한도가 됩니다. 단 `currentPassword`가
  아예 없는 요청은 추측이 아니므로 예산을 쓰지 않고 거절합니다.
- **설정·변경 성공 시 grant를 함께 발급하고 해제 시 삭제합니다.** 방금 고른
  비밀번호를 바로 다시 입력시키지 않기 위해서이고, 삭제는 TTL 안에 다른
  비밀번호로 다시 잠근 snapshot이 옛 grant로 열리는 것을 막습니다.
- 잠긴 snapshot 조회는 새 코드가 아니라 기존 423 `CONVERSATION_LOCKED`로
  답합니다(§7의 호환 요구, §18 표는 확정본).

context bundle은 기존 `/api/chat/preflight` 확장 + 단일 모델용 경량 context
preparation으로 발급하고 `/api/chat`이 검증·소비합니다. 신설 여부는 기존
preflight 구조를 조사한 뒤 B4에서 확정합니다.

### 릴리스 C

```
GET/POST      /api/assistant-profiles
GET/PATCH/DELETE /api/assistant-profiles/[profileId]
POST          /api/assistant-profiles/[profileId]/versions      (publish)
GET           /api/assistant-profiles/[profileId]/versions
POST/GET/DELETE /api/assistant-profiles/[profileId]/knowledge
POST          /api/assistant-profiles/[profileId]/preview       (실제 credit·concurrency 적용)
```

### UI 경로

```
/settings/imports              관리 화면 (저장 공간·가져온 대화·이력·진행 중 작업)  (A)
/settings/imports/new          전체 화면 Wizard (static segment, [importId]와 공존)  (A)
/settings/imports/[importId]   완료 결과 · 작업 상태 상세. `preview_ready`이고
                               TTL 이내면 여기서 seal된 staged 집합을 확인하고
                               (부분집합 가능) 최종 저장한다. seal되지 않은
                               `staging`과 만료 건은 다시 시작·삭제만 제공한다  (A)
/settings/imports/conversations/[id]   read-only viewer                              (A)
/settings/memory, /settings/memory/runs/[runId]                    (B)
/settings/assistants, /settings/assistants/new, /settings/assistants/[profileId]  (C)
```

Data 탭(`AuthButton.tsx`)에는 진입점·요약만 두고 대형 UI를 modal에 넣지
않습니다. 게스트 Import("이 브라우저의 게스트 대화 가져오기")와 신규
기능("다른 AI 서비스에서 가져오기")의 명칭을 ko/en 모두에서 구분합니다.

## 22. 관측 지표 (content-free)

- **A**: provider별 parse 성공·실패, parserVersion 실패율, count/byte bucket,
  duplicate/truncation/quota 거부율, staging cleanup, finalize latency, mobile
  desktop recommendation. filename·title·content·외부 ID·digest 금지.
- **A — Wizard 단계 이벤트**: `external_import_step_entered`와
  `external_import_step_abandoned`. 속성은 닫힌 `import_step` enum
  (`provider_guide` `file_selection` `parsing` `conversation_selection`
  `server_review` `completed` `desktop_recommended`) 하나뿐이며 filename·
  대화 제목·본문·외부 ID·fingerprint·digest를 넣지 않습니다.
  **해석 한계 — 다음을 오류로 읽지 마세요.**
  - `abandoned`는 취소·이전·명시적 라우트 이탈처럼 확실한 사용자 행동에만
    기록합니다. **브라우저 탭·창을 그냥 닫는 이탈은 측정되지 않습니다.**
  - 따라서 단계별 `entered` 수는 언제나 `abandoned` 수보다 크거나 같을 수
    있고, 두 수의 합이 맞지 않는 것은 계측 오류가 아닙니다.
  - 실질 이탈률은 `abandoned`가 아니라 **연속한 두 단계의 `entered` 수 차이**
    로 읽습니다. `abandoned`는 "명시적으로 그만둔" 하한선일 뿐입니다.
  - `preparing_review` `finalizing` `upload_failed` `expired` `parse_failed`
    는 단계가 아니라 단계 안의 순간이므로 enum에 없습니다. `quota_revision`은
    출처에 따라 `conversation_selection` 또는 `server_review`로 집계되며,
    이벤트는 label이 **바뀔 때만** 발생하므로 중복 계수되지 않습니다.
- **B**: run 성공·실패·취소, pair별 실패율, chunk당 credit p50/p95, batch
  sub-budget 소진, validator 거부율, sensitive review 비율, 승인·수정·거부율,
  injection 비율, 주입 token bucket, truncation 비율, stale bundle 비율, lock
  suspension/restore 수, **follow-up/repair proxy** — content 분석 없이
  다음만 집계: memory 응답 후 120초 내 follow-up, 즉시 regenerate, 대화
  memory-off 전환, 명시적 feedback, 관련 memory 즉시 수정·삭제. 이를 "재질문률"
  등 직접 측정치로 표현하지 않고 proxy임을 Admin UI에 명시합니다.
  구현: 순수 집계는 `lib/memoryMetricsCore.ts`, 질의는 `lib/memoryMetrics.ts`,
  조회는 `GET /api/admin/memory`입니다.

  - **content 배제는 응답 shape이 아니라 질의에서 합니다.** statement·evidence·
    `sourceSelection`·id는 `select`에 없습니다. shape에서만 빼면 이미 읽어온
    뒤이고, 다음 사람이 shape를 넓히면 그대로 새어 나갑니다. DB 테스트가 직렬화된
    보고서 전체에 문장이 없는지 확인합니다.
  - **아직 측정할 수 없는 지표는 0이 아니라 이유와 함께 이름을 남깁니다**
    (`unavailable`). 주입 비율 0%는 "아무도 안 쓴다"와 구분되지 않으며, 그
    혼동이 이 목록이 존재하는 이유입니다. **현재 목록: follow-up proxy의 feedback
    신호 하나**(`Feedback`에 대상 답변으로 가는 연결이 없음). lock
    suspension/restore(B5), chunk당 credit·batch sub-budget(slice 1.6),
    injection 비율·token bucket·stale bundle 비율(§10 배선), follow-up·regenerate
    (답변별 귀속)은 모두 출처가 생겨 목록에서 빠졌습니다.
  - **`followup_repair_proxy_feedback_signal` = `POLICY_DECISION_REQUIRED /
    METRIC_UNAVAILABLE`.** 이 하나가 비어 있다는 사실이 릴리스 B **코드**를
    미완으로 만들지는 않습니다 — 위 규칙대로 `unavailable`로 표시되어 0으로
    위장되지 않기 때문입니다. 초기 staging은 이 상태로 진행할 수 있고,
    **production 확대와 효과 판정 전에 닫습니다.** 그때까지의 판정문은 이 신호를
    제외했다고 명시하고, 확대 여부는 사람에게 다시 확인합니다.

    닫는 방법은 "가장 최근 답변 추정"이 아니라 **명시적 answer attribution**입니다.
    추정은 comparison·재생성·동시 요청에서 조용히 틀리고, 틀린 귀속은
    `unavailable`보다 나쁩니다(0이 아닌 값을 보고하므로).

    - `Feedback.answerMessageId`를 **nullable relation**으로 추가합니다. 특정
      assistant 답변에서 연 피드백만 이 ID를 보내고, sidebar·support·billing
      등 일반 진입점은 계속 `null`입니다.
    - 서버가 인증 사용자·Conversation 소유권·`role=assistant`를 **재검증**합니다.
      클라이언트가 보낸 ID를 그대로 믿지 않습니다.
    - 답변 본문·memory 내용·bundle·memory ID는 Feedback으로 **복사하지 않습니다**.
      지표는 FK로 SQL join하되 content와 ID를 결과 `select`에 넣지 않습니다
      (이 절의 첫 규칙과 같습니다).
    - Message 삭제 시 `SetNull` — 답변이 사라져도 Feedback 자체는 보존합니다.
    - comparison에서는 panel의 **정확한** assistant Message에 결속합니다.
    - **무엇을 repair 신호로 셀 것인가도 함께 정합니다.** 현재 `Feedback.type`은
      bug·feature·billing 같은 **문의 분류**이지 답변 품질의 방향성이 아니므로,
      answer-linked Feedback을 전부 부정 신호로 세면 안 됩니다. 답변 진입점에
      폐쇄형 의미를 따로 둡니다 — `needs_improvement`는 proxy에 포함,
      `helpful`은 별도 관측(첫 버전 미지원 가능), 일반 Feedback은 proxy 제외.
    - **Trace와 answer attribution은 분리합니다.** Trace ID로 답변을 찾거나
      `occurrenceId`를 답변 ID로 재사용하지 않습니다. Trace evidence는 검증된
      token의 `occurrenceId`로만 연결하고, answer link는 소유권을 재검증한 별도
      FK로 관리합니다. 원시 error token 저장 금지 계약은 그대로입니다
      (`docs/policy/trace-feedback-automation.md`).
  - **답변별 memory 귀속은 `Message`에 저장합니다**(`memoryUsedCount`,
    `memoryTokens`). §8.1 불변식 4가 금지하는 것은 주입된 **context 본문**이고
    "사용 개수·비민감 aggregate metadata"는 명시적으로 허용합니다. 일일 counter가
    이미 주입 **비율**을 보고하므로 이것은 counter가 만들 수 없는 것 —
    **어느 답변이** memory를 담았는가 — 만 담당하며, follow-up proxy가 그것을
    필요로 합니다. `NULL`은 bundle이 없어 주입이 불가능했던 요청이고 `0`은
    bundle이 검증됐지만 retrieval이 아무것도 고르지 않은 경우입니다.
  - **injection 비율의 분모는 인증된 chat 요청 전체입니다.** "주입이 허용된
    요청"으로 잡으면 fail-closed 상태에서 분모가 0이 되어 비율이 정의되지 않고,
    그것은 이 목록이 설명하려던 상태로 되돌아가는 것입니다. 지금 방식이면
    fail-closed 배포도 "N건 중 0건"이라는 측정값을 보고합니다. 게스트는 주입할
    계정 memory 자체가 없으므로 분모에서 제외합니다 — 넣으면 이 지표가 주입이
    아니라 게스트/회원 비율을 추적하게 됩니다.
  - **stale bundle 비율의 분모는 제시된 bundle 수**이고, replay는 비율 밖에
    따로 셉니다. 둘 다 `CHAT_CONTEXT_BUNDLE_STALE`로 거절되지만 context가
    변했다고 말하는 것은 한쪽뿐입니다.
  - **truncation 비율의 분모는 주입된 context**이며, §9 예산이 잘라낸 경우
    (`token_budget`·`item_cap`)만 truncation입니다. `below_relevance`·
    `expired`·`duplicate`는 선택이 설계대로 동작한 것이고 `source_cap`은 크기가
    아니라 다양성 규칙이므로 포함하지 않습니다.
  - **follow-up proxy는 단일 비율이 아니라 두 arm의 비교입니다.** memory가 형성한
    답변과 그렇지 않은 답변에 같은 측정을 하고 그 **차이**만 판단에 씁니다.
    "memory 답변의 12%에 follow-up이 있었다"는 그 자체로 해석 불가입니다 —
    첫 답변이 좋아서 두 번째 질문을 하는 경우가 흔하기 때문입니다. 한쪽 arm이
    비어 있으면 차이는 0이 아니라 `null`입니다(비교하지 않았다는 뜻).
    Admin UI는 이것이 proxy이며 "재질문률"이 아니라는 것을 **읽는 자리에서**
    밝힙니다.
  - **follow-up 관계는 SQL에서 집계합니다.** 필요한 관계가 "같은 대화에서 다음에
    온 것"이라 대화별 정렬이 필요하고, 애플리케이션에서 하려면 conversation ID를
    지표 모듈로 읽어와야 합니다. §22는 ID를 응답이 아니라 **select에서** 배제하므로
    grouping을 DB에 두고 두 행의 count만 받습니다.
  - **memory-off 전환은 발생 시점에 기록합니다.** `Conversation.memoryMode`에는
    변경 이력이 없어 사후 유도가 불가능합니다 — update가 커밋되는 순간 이전 값이
    사라집니다. counter는 좁은 결합에서만 올라갑니다: `off`로 바뀌었고, 이미
    `off`가 아니었으며, 그 대화의 최근 답변이 memory가 형성한 것이고 120초
    이내입니다. 대화를 열자마자 끄는 것은 불만이 아니라 선호이며, 둘을 함께 세면
    §22가 원하는 신호가 묻힙니다.
  - **승인률의 분모는 검토를 마친 memory입니다.** 아직 큐에 남은 항목까지 나누면
    "손대지 않은 검토 큐"가 "낮은 승인률"로 보고됩니다. 결정된 것이 없으면 0이
    아니라 `null`입니다.
  - **취소된 run은 pair 실패율 분모에 포함합니다.** 사용자가 그만둔 것도 그 run의
    결과이고, 빼면 사용자가 계속 포기하는 pair가 좋아 보입니다.
  - 행이 남지 않는 결과(validator 거절, source 삭제 처분, 쓰기 시점 evidence
    재검증 탈락)는 `ChatUsageBucket`의 `memory:` namespace 일일 counter로
    기록하며, 기록 실패가 사용자 요청 실패가 되지 않습니다. counter는
    transaction 밖에서 기록합니다 — rollback된 transaction 안에서 기록하면
    일어나지 않은 일을 보고하게 됩니다.

- **C**: profile lifecycle, preview 성공·실패, version update, retired model
  차단 수, knowledge 처리 실패율, byte bucket, retrieval chunk 수, truncation,
  citation 검증 실패율, memory mode 분포. instructions·filename·knowledge
  text·starter 금지.

## 23. Known limitations · 사람 판단 필요 항목

### 23.0 프로그램 상태 (2026-08-06)

남은 두 항목은 **같은 종류의 "미완료"가 아닙니다.** 하나는 사람만 완료할 수 있는
운영 승인 작업이고, 다른 하나는 설계가 필요한 관측성 보완입니다. 차단하는 대상이
다르므로 상태도 따로 기록합니다.

| 항목 | 상태 | 차단 범위 |
|---|---|---|
| `memory_eval_dataset` | `BLOCKED_ON_HUMAN_AUTHORING_AND_REVIEW` | 실제 extraction pair 승인과 `memoryInjectionEnabled` 활성화 (§12.6) |
| `followup_repair_proxy_feedback_signal` | `POLICY_DECISION_REQUIRED / METRIC_UNAVAILABLE` | 없음 — production 확대·효과 판정 전에 닫습니다 (§22) |

- **릴리스 B 코드 완료는 위 두 항목과 분리해 판단합니다.** 두 항목 중 어느 것도
  코드 계약의 결함이 아니며, feedback 신호는 §22 규칙대로 `unavailable`로
  표시되어 0으로 위장되지 않습니다.
- **extraction·injection 운영 활성화는 eval 데이터셋과 §12.4 승인 절차 완료 전까지
  차단**입니다. 이것이 데이터셋 항목의 실제 무게이며, 코드 완료로 대체되지
  않습니다.
- **production 효과 판정 시에는** feedback 신호를 제외했다고 판정문에 명시하고,
  확대 여부를 사람에게 다시 확인합니다.

기록된 한계:

- decision-grade eval은 ko/en만. zh/fr/de/es/pt는 저장·UI는 지원하되 동일 정량
  품질 보장을 주장하지 않고, 후속 locale eval 전까지 admin 지표·feedback으로
  관찰합니다.
- Gemini Takeout은 A2로 연기. retrieval v1은 lexical이므로 의미 검색 품질에
  한계가 있고 embedding 도입은 별도 승인 경로입니다.
- 모바일 대형 archive Import는 데스크톱 권장으로 제한됩니다.
- media·첨부는 Import되지 않습니다.

### 릴리스 A scope 승인에 필요한 항목

1. **`approvedScopes: [RELEASE_A_IMPORT]` 기록** — `status: approved`,
   승인자, 티켓, 날짜와 함께. 릴리스 A의 계약(§4, §5, §18 릴리스 A 표)은
   이 문서에서 확정값으로 기록돼 있습니다.

### 릴리스 B scope 승인 관련 항목 (2026-08-03 확정)

1. **[확정]** batch provider budget 오류의 HTTP 의미 — **503으로 통일**,
   §18 릴리스 B 표와 그 아래 근거 참조.
2. **[확정]** `MemoryEvidence.sourceType=manual` 구조 — 같은 테이블 유지,
   manual은 두 FK 모두 NULL + 사용자 입력 근거 텍스트가 evidence 본체.
   §8.5 참조.
3. **[확정]** source 삭제 시 파생 memory 상태 — 기본은 함께 삭제(`deleted`),
   사용자가 유지를 선택하면 `suspended_by_source_delete`. §8.3·§13.1 참조.
4. **[확정]** 첫 eval 대상 pair는 `(gpt-5-6-luna, mem-extract-v1)`
   (예비 `gpt-5-4-mini`), 둘 다 verified pricing 보유. **eval 실행 예산
   승인(승인자·상한·티켓)은 사람이 register entry와 함께 기입해야 하며
   아직 미기입** — §12.5 참조.
5. **[확정]** batch sub-budget은 기본 10%(일·월) 유지 — §3 참조.
6. **[확정]** memory export는 `tomverse.memories.v1` JSON, 서버 미보존 +
   audit 90일 — §13.2 참조.
7. **[미완 · staging 반영 전 필수]** 릴리스 A staging 검증 체크리스트
   실행·승인 — `docs/ops/external-import-staging-checklist.md`. scope 승인
   (2026-08-03)은 이 항목이 미완인 상태에서 이루어졌으므로, B 코드
   구현(B1~)은 시작할 수 있으나 **B 기능의 staging 배포·활성화 전에
   체크리스트 승인 기록이 있어야 합니다.**

### 릴리스 C scope 승인 전에 확정해야 하는 항목 (pending)

1. **[제안 · 승인 대기]** knowledge quota 수치(파일 수·개별 크기·계정 총 byte)
   — §14.1에 7개 수치와 각각의 근거, plan별 분리 여부 제안을 적었습니다.
2. **[제안 · 승인 대기]** knowledge 보존 기간과 R2 lifecycle 정책 수치
   — §14.2. bucket lifecycle rule 대신 DB-first tombstone + sweep, 활성 파일에는
   만료를 두지 않는 방향입니다.

두 항목 모두 **제안일 뿐 확정이 아닙니다.** `approvedScopes`에
`RELEASE_C_ASSISTANT_PROFILES`가 없는 한 릴리스 C 코드·schema·migration은
시작하지 않습니다(§2 fail-closed). 승인 시 `[제안 · 승인 대기]` 표시를 승인자·
날짜와 함께 `[확정]`으로 바꾸는 것은 승인 기록을 남기는 사람의 몫이며, 이 문서를
작성한 에이전트가 스스로 바꾸지 않습니다.

## 24. 참조

- 실행 프롬프트: `WORK_PACKAGE=POLICY_ONLY | RELEASE_A_IMPORT | RELEASE_B_MEMORY
  | RELEASE_C_ASSISTANT_PROFILES`, `DELIVERY_SLICE=A1…C3`
- 검증 명령: `npm run test:unit`, `test:server-contract`, `test:db:integration`,
  `typecheck`, `lint`, `check:accent-tokens`, `check:encoding`,
  `check:model-pricing`, `check:model-pricing-db`,
  `check:memory-extraction-eval`(B부터), `security:regression`, 관련 Playwright
  E2E, `build`. 실행하지 못한 검사는 통과로 보고하지 않습니다.

## 25. 사전 조사 기록 (POLICY_ONLY 검토 증거)

이 문서 작성·보정 시 실제로 확인한 저장소 계약:

- **정책 문서**: `AGENTS.md`(루트), `docs/policy/credit-and-cost-limits.md`
  (층 분리·guardrail 유도·`ChatUsageBucket` BIGINT 계약),
  `docs/policy/chat-concurrency-and-identity.md`(4개 층 표·admission token
  §3·lease heartbeat §4·15분 reconciliation), `docs/ops/migration-baseline.md`
  (baseline 무수정·forward migration·`db:migrate` guard 규칙).
- **Schema**: `prisma/schema.prisma` — datasource `postgresql`,
  `Conversation`(176행~, `selectedModels` JSON 문자열·`password`·
  `importedGuestKey`·share 필드), `Message`(219행~, `modelId String?`),
  `AppSetting`(735행~).
- **API·보안**: `app/api/conversations/import-guest/route.ts`(runtime modelId
  검증 76–91행), `app/api/chat/route.ts`(`MAX_STORED_MESSAGE_CHARACTERS`
  100,000 등 첨부·본문 한도), `app/api/chat/preflight/route.ts` 존재,
  `lib/apiSecurity.ts`(`STORAGE_LIMITS`·capacity assertion),
  `lib/chatAdmissionCore.ts`·`lib/chatRequestLease.ts`·
  `lib/chatConcurrencyCore.ts`.
- **Lock 소비 route**: `lib/conversationLock.ts`를 소비하는 10개 route 확인 —
  `app/api/conversations/[conversationId]/`의 route·messages·share·export·
  verify·compare-summary·generate-title·comparison-reviews(2)·목록 route.
- **Privacy locale**: `locales/{ko,en,zh,fr,de,es,pt}.ts`의 `privacyPolicy`
  섹션(7개 locale 관리 확인).
- **UI contract**: `docs/ui-contracts/mobile-chat-composer.md`,
  `mobile-sidebar-drawer.md`, `comparison-action-rail.md`, `typography.md`
  존재 확인(요구사항은 `AGENTS.md` 요약 기준).
- **기타**: `components/auth/AuthButton.tsx`(Data 탭, 1,736행 모달 —
  전용 페이지 결정의 근거), `lib/r2.ts`(R2 client),
  guest attachment TTL sweep(`cleanupExpiredData` 주석), 검증 명령
  존재(`package.json` scripts).
