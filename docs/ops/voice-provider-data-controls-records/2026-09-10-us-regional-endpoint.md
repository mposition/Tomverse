# B-5 결정·구현 기록 — Voice 전사를 미국 지역 endpoint로 고정 (2026-09-10)

`docs/policy/voice-input.md` §11.3.0의 근거 기록입니다. 같은 날의 처리 지역
결정(`2026-09-10-processing-region-decision.md`)이 **"지역 제한을 적용하지
않는다"**였고, 이 기록은 그것을 뒤집는 것이 아니라 **이전 국가를 고지에 적을 수
있게 특정**합니다.

**이 초안은 에이전트가 썼습니다.** 절마다 출처를 밝혔고, **판정과 서명은 사람이
채웁니다.**

- **기록일(UTC)**: 2026-09-10
- **상태**: **코드 병합·고지 문구 승인 완료 — staging 미관측**
- **갱신(UTC)**: 2026-09-10 — §8이 법인명 대조와 문구 승인을, §9가 staging deploy SHA 관측을 기록합니다

---

## 1. 공식 문서에서 확인된 사실

출처: `https://developers.openai.com/api/docs/guides/your-data`, **2026-09-10
읽음.** 이 저장소에서 직접 열렸습니다(`openai.com/policies/*`와 달리 403이
아닙니다).

| 확인 항목 | 문서가 말한 것 |
|---|---|
| `/v1/audio/transcriptions` regional storage | "All listed regions" |
| 같은 endpoint regional **processing** | "United States, Europe (EEA + Switzerland)" |
| 미국의 MAM·ZDR 필수 여부 | **"No"** |
| Global 프로젝트 key로 지역 host 사용 | *"As an alternative to creating a region-specific project, you can select regional processing for an individual request by using the prefixed domain with an API key from a project having Global geography."* |
| 지원 모델 | `tts-1, whisper-1, gpt-4o-tts, gpt-4o-transcribe, gpt-4o-mini-transcribe, gpt-transcribe` — **이 제품의 두 모델 모두 포함** |
| 적용 범위 | *"Data residency does not apply to system data, which may be processed and stored outside the selected region."* |
| 가격 | *"Data residency endpoints are charged a 10% uplift for models released on or after March 5, 2026, that are eligible for data residency."* |

**마지막 줄은 이 작업의 브리프가 예상하지 않은 사실입니다.** 지역 endpoint에는
가격 할증이 **조건부로** 있습니다. §5에서 다룹니다.

## 2. 제품 소유자의 결정

- **ZDR은 Production Voice의 필수조건이 아닙니다** — 2026-09-10 서명
  (`2026-09-10-zdr-precondition-decision.md`). **이 기록은 그 결정을 유지합니다.**
  미국 지역이 MAM·ZDR을 요구하지 않으므로 둘은 충돌하지 않습니다.
- **처리 지역은 미국으로 특정합니다.** 목적은 개인정보보호법 제28조의8이 요구하는
  **이전 국가**를 고지에 적을 수 있게 하는 것입니다.

## 3. 코드가 보장하는 것

| 보장 | 어디서 |
|---|---|
| 모든 Voice 전사가 `https://us.api.openai.com/v1/audio/transcriptions`로 나감 | `VOICE_TRANSCRIPTION_OPENAI_BASE_URL` 상수 + production binding이 명시 전달 |
| global endpoint로 돌아가는 **런타임 경로 없음** | 옛 `?? "https://api.openai.com"` 기본값 제거. Voice runtime source에 그 문자열이 없음(주석 제외) |
| **환경변수로 바꿀 수 없음** | `_URL`·`_HOST`·`REGION`·`GEOGRAPHY`·`ENDPOINT` 꼴 env 접근을 Voice runtime에서 금지하는 검사 |
| test injection은 명시 주입에서만 | `baseUrl`은 optional이고 생략 시 상수 |
| `//v1` 결합 사고 없음 | `voiceTranscriptionEndpoint()`가 후행 slash 제거 |
| multipart 표면 불변 | `file`·`model`·`response_format`(+선택 `language`), header는 `Authorization` 하나 |
| Chat·Image 등 미변경 | 다른 adapter에 `us.api.openai.com`이 없음을 단언 |

**되돌리면 실제로 실패합니다.** 옛 global 기본값을 복원하고 돌리니 9건 중 **3건이
red**였고(요청 URL, runtime source 스캔, binding 명시), 복원하니 다시 9건 green
입니다. 이름만 늘린 테스트가 아닙니다.

**key 계약은 바꾸지 않았습니다.** `VOICE_TRANSCRIPTION_API_KEY` → 공용 key
fallback 그대로입니다. §1이 인용한 대로 Global 프로젝트 key로 지역 host를 부를 수
있으므로, 새 프로젝트·key를 이 코드 변경의 전제로 만들지 않았습니다.

## 4. staging에서 아직 관측하지 않은 것

- **실제 요청이 미국 endpoint에 닿는다는 wire 증거.** 코드와 테스트가 보장하는
  것은 **요청이 그 URL로 만들어진다**는 것입니다. 그 host가 응답하고 이 key가
  거기서 유효하다는 것은 **실제 호출로만** 확인됩니다.
- **지역 식별자를 로그에 넣지 않은 이유가 여기 있습니다.** host가 상수이므로
  그 상수에서 유도한 로그 필드는 언제나 `"us"`만 내고, 요청이 어디에 닿았는지는
  말하지 못합니다. 장식이 아니라 증거가 되려면 응답 쪽 사실이어야 하는데 그런
  필드가 없습니다. **대체 증거는 B-6의 실제 호출 성공**이며, 실패하면
  `provider_rejected_credentials`나 `provider_unreachable`로 드러납니다.

## 5. 가격 — 다시 관측해야 하는가

**기존 `costObservation` 둘은 global endpoint에서 얻은 값이며 덮어쓰지
않았습니다.** 지역 endpoint의 요율이 같다고 추정하지도 않았습니다.

문서의 할증 규칙은 **2026-03-05 이후 출시 모델**에만 적용됩니다. 이 제품의 두
모델은 `GET /v1/models`의 `created`가 **2025-03-15**로, 컷오프 이전입니다.
2026-09-02 청구의 line item 이름도 `gpt-4o-mini-transcribe-2025-12-15`로 컷오프
이전 snapshot입니다.

**그러나 이것은 확정이 아닙니다.** `AGENTS.md`가 `GET /v1/models`를 가격 출처로
쓰지 말라고 못 박고 있고, 모델 객체의 `created`가 문서가 말하는 "released"와
같은 날짜라는 보장도 없습니다. **정황은 할증 없음을 가리키지만, 문서만으로
확정할 수 없습니다.**

**제안**: B-6의 첫 승인된 실제 전사 호출을 **지역 확인과 비용 관측에 함께**
씁니다. 그 호출은 이미 승인·예산 안에 있고, 다음 날 Costs를 읽으면 지역
endpoint의 실제 요율이 나옵니다 — 별도 유료 호출이 필요하지 않습니다. 요율이
기존 관측과 다르면 **3회차 `costObservation`**으로 추가하고 기존 둘은 그대로
둡니다(global 시점의 사실이므로).

**이 작업에서 유료 호출은 하지 않았습니다.**

## 6. 개인정보처리방침 — 사람의 승인이 필요한 문구

제28조의8 제2항 항목을 현재 `privacyPolicy.voiceInput`과 대조했습니다.

| # | 항목 | 현재 | 이번에 확정 가능 |
|---|---|---|---|
| 1 | 이전되는 개인정보 | 있음(녹음) | — |
| 2 | **이전 국가** | 없음 | **미국** |
| 3 | **이전 시점·방법** | 없음 | 사용자가 녹음을 끝내고 전사를 요청할 때, 암호화된 HTTPS API 전송 |
| 4 | **이전받는 법인의 정확한 명칭·연락처** | 없음 | **불가 — blocker** |
| 5 | 이용 목적 | 있음 | 음성을 텍스트로 변환 |
| 6 | **보유·이용 기간** | 없음(위탁자 것만) | **보수적 문구만 제안** |
| 7 | **거부 방법·절차** | 없음 | 마이크 권한을 허용하지 않거나 Voice를 쓰지 않고 텍스트 입력 사용 |
| 8 | **거부 효과** | 없음 | Voice 전사 불가, 텍스트 대화는 계속 가능 |

**두 blocker는 2026-09-10에 운영자가 해소했고, 여덟 항목을 7개 locale 전부에
넣었습니다.** `privacyPolicy.voiceInputTransfer1`–`8`과 제목 key이며,
`PrivacyPolicy.tsx`가 Voice 섹션 아래에 목록으로 렌더링합니다 — 한 문단에 여덟
답을 밀어 넣으면 어느 것도 찾을 수 없어 감사되지 않기 때문입니다.

**4번 — 법인명과 연락처: `OpenAI OpCo, LLC` / `privacy@openai.com`.** 이 초안이
쓰였을 때 이 줄은 운영자가 제시했고 **이 저장소가 대조하지 않은** 값이었습니다 —
계약 원문이 egress 프록시에서 403이기 때문입니다(`2026-09-10-dpa-incorporation.md`
§1). 이 값은 사용자에게 보이는 법정 고지이므로 계약서 표기와 다르면 고지가
틀립니다. 그래서 "문구 승인 시 계약 원문과 대조해야 하는 첫 번째 줄"로 적어
두었습니다.

**2026-09-10에 운영자가 계약 원문과 대조해 확인했습니다(§8-1).** 저장소의
접근 제약은 그대로이며, 대조한 주체는 저장소가 아니라 사람입니다.

**6번 — 보유·이용 기간: 원칙적으로 최대 30일(악용 모니터링), 법령상 의무나
OpenAI의 서비스·제3자 보호에 합리적으로 필요한 경우 연장.** 이것이 §11.3.2-1의
`None` 대 30일 긴장을 **보수적으로 정리한 것**임을 적어 둡니다 — endpoint 표가
틀렸다고 선언한 것이 아니라, **고지에서는 더 긴 쪽을 적기로 한 선택**입니다.
사용자에게 실제보다 짧게 말하는 위험을 피하는 방향이고, 공급자 답변이 오면
줄이는 것은 안전하지만 늘리는 것은 그렇지 않습니다.

**"미국에서만 모든 데이터가 처리된다"고 쓰지 않았습니다.** 고지는 **녹음과 그
전사 결과**가 미국으로 이전된다고 적으며, §1이 인용한 system data 예외를 이
문장이 넘어서지 않습니다.

## 7. B-5를 해결로 표시하지 않았습니다

코드가 병합돼도 B-5는 열려 있습니다. 완료 조건은 최소한 이 여섯입니다.

1. 미국 endpoint 고정 코드 병합 — **완료** (PR #1331, develop `6019e07a`, 2026-09-10)
2. 개인정보처리방침 국외이전 필수 항목 승인 — **완료 (2026-09-10, §8-2)**
3. 그 코드가 포함된 staging 전체 deploy SHA — **완료 (2026-09-10, §9-1: `6019e07afd598a1431862ec925189a04544e9c94`)**
4. 그 deploy에서 실제 Voice 요청 성공 — **미관측**
5. 요청이 미국 endpoint를 썼다는 코드·테스트·운영 증거 — **코드·테스트는 있음,
   운영 증거 미관측(§4)**
6. 사람의 B-5 판정과 서명 — **미완**

**B-6 체크리스트의 template revision은 올리지 않았습니다.** 참조할 B-5 결정
기록이 아직 서명되지 않았고, 존재하지 않는 기록을 미리 가리키지 않습니다.

### B-5 최종 서명 기록이 담아야 하는 것

**빈 서식 파일을 미리 만들지 않았습니다.** 관측이 없는 서식은 나중에 지어낸
관측으로 채워질 자리이고, 이 저장소는 그것을 금지합니다. 대신 요구 항목만 여기
적어 둡니다 — 관측이 생기는 시점에 이 목록으로 기록을 씁니다.

1. 결정·위험 수용 기록 참조 (이 디렉터리의 2026-09-10 기록 넷)
2. 승인된 개인정보처리방침 revision — **`6019e07afd598a1431862ec925189a04544e9c94`** (§8-2)
3. staging **전체 40자리** deploy SHA — **`6019e07afd598a1431862ec925189a04544e9c94`** (§9-1)
4. 관측 시각(UTC)
5. 실제 사용된 endpoint·region 증거
6. Voice 요청 결과
7. 잔여 위험
8. **통과 / 조건부 / 실패** 판정
9. 서명자와 날짜

**3번과 5번이 이 기록이 채울 수 없는 둘입니다.** deploy SHA는 merge SHA가
아니라 **staging이 실제로 서비스 중인 SHA**이고(B-6 체크리스트 사전 조건과 같은
값), endpoint 증거는 §4가 적은 대로 실제 호출로만 생깁니다.

**5번을 무엇으로 채울 수 있는지 미리 정해 둡니다** — 성공한 요청 자체(실패하면
`provider_rejected_credentials`나 `provider_unreachable`로 드러납니다), 그 요청의
정제된 `x-request-id`, 그리고 다음 날 Costs에서 해당 프로젝트 line item.
**로그의 지역 필드는 증거가 아닙니다**(§4).

## 8. 2026-09-10 운영자 확인 둘

§6이 열어 둔 두 항목입니다. **아래 두 문장은 운영자가 이 세션에서 말한 것을 옮긴
것이고, 에이전트가 대조하거나 판단한 것이 아닙니다.**

### 8-1. 계약 원문상 정식 상대방

> "OpenAI OpCo, LLC가 계약 원문상 정식 상대방이 맞습니다."

- **확인 대상**: 국외이전 고지 4번 항목의 이전받는 자 명칭
- **값**: `OpenAI OpCo, LLC`
- **대조한 주체**: 운영자 (계약 원문)
- **일자(UTC)**: 2026-09-10

**저장소의 제약은 바뀌지 않았습니다.** `openai.com/policies/…`는 이 컨테이너에서
여전히 403이고(`2026-09-10-dpa-incorporation.md` §1), 이 확인은 사람이 원문을 열어
대조한 결과입니다. 등기 접미사(`Pty Ltd` 등)나 등록번호가 계약서에 함께 적혀
있다면 그것까지 고지에 넣을지는 별개 판단이며, 지금 고지에 적힌 것은 위 명칭
하나입니다.

**연락처 `privacy@openai.com`은 이 확인에 포함되지 않습니다.** 운영자가 확인한
것은 명칭이고, 연락처는 §6에서 함께 제시된 값입니다. 둘을 하나의 확인으로
합치면 확인되지 않은 쪽이 확인된 것처럼 보입니다.

### 8-2. 국외이전 고지 문구 승인

> "승인합니다"

- **승인 대상**: 개인정보보호법 제28조의8 제2항 여덟 항목의 고지 문구
- **승인자**: 운영자 (Privacy Owner)
- **일자(UTC)**: 2026-09-10

**승인된 revision을 SHA로 고정합니다.** "승인된 문구"가 나중에 어느 문장이었는지
말할 수 없으면, 문구가 바뀌어도 승인이 따라 움직인 것처럼 보입니다.

| 대상 | 값 |
|---|---|
| develop merge commit | `6019e07afd598a1431862ec925189a04544e9c94` |
| PR | #1331 |
| `locales/en.ts` blob | `9795307b54321c9bec88c7020f34476c42d6f531` |
| `locales/ko.ts` blob | `bc61bba4b50066c29e5d941fd5a31627368d7de0` |
| `components/legal/PrivacyPolicy.tsx` blob | `386e77e2c8f14ad6cab214fe0583845480826da6` |

7개 locale 전부가 같은 commit에 있고, 위 표는 그중 셋을 대표로 적습니다 —
`voiceInputTransferTitle`과 `voiceInputTransfer1`–`8`이 locale마다 존재한다는 것은
`check:locale-translation`이 강제합니다.

**이 문구가 바뀌면 승인은 따라오지 않습니다.** 위 blob 중 하나라도 달라지는 변경은
다시 승인 대상입니다. 특히 §6이 적은 두 값 — 이전 국가(미국)와 보유 기간(최대
30일, 연장 가능) — 은 각각 §11.3.0의 코드 고정과 공급자 문서에 매여 있으므로,
그쪽이 움직이면 문구가 먼저 틀립니다.

### 8-3. 이 둘이 B-5를 닫지 않습니다

여섯 조건 중 1·2가 충족됐고 **3·4·5·6이 남았습니다**(§7). 남은 넷은 전부 같은
것을 기다립니다 — **이 코드가 실제로 도는 환경에서의 관측**. 코드가 보장하는
것은 "요청이 미국 endpoint로 간다"이고, "실제로 갔다"는 아직 **미관측**입니다.

## 9. staging deploy SHA 관측 (2026-09-10)

§7의 3번 조건입니다. **merge SHA가 아니라 staging이 실제로 서비스 중인 SHA**를
요구하므로, 병합 사실만으로는 채울 수 없는 칸이었습니다.

### 9-1. 관측값

| 항목 | 값 |
|---|---|
| environment | `staging` |
| **deploy SHA (40자)** | `6019e07afd598a1431862ec925189a04544e9c94` |
| deploymentId | `f5f3547a-1c97-4aaa-baa7-1dcf1ad828ca` |
| deploymentStartedAt | 2026-09-10T09:19:45.967Z |
| builtAt | 2026-09-10T09:32:33.603Z |
| deployedAt | 2026-09-10T09:35:31.215Z |
| deploymentStatus | `success` |

**staging의 여섯 서비스가 모두 같은 commit, 같은 배포 배치입니다** — `Tomverse`,
`Provider Probe`, `Provider Usage Sync`, `Provider Model Catalog`,
`Maintenance Cron`, `Credit Reconciliation`. 전부 `createdAt`
2026-09-10T09:19:45.967Z이고 control plane이 여섯 다 `live`로 보고합니다. 조건이
"**전체** deploy SHA"를 말하므로 한 서비스만 보고 채우지 않았습니다.

### 9-2. 무엇을 근거로 말하는가 — 그리고 무엇을 말하지 않는가

두 곳에서 읽었습니다.

1. **Railway control plane** — 환경 조회에서 `Tomverse` 서비스가 `live`이고 그
   `latestDeployment`가 `f5f3547a…`, 그 배포의 `meta.commitHash`가 위 SHA.
2. **실행 중인 앱 자신** — `GET /api/build-info`(공개 endpoint, STG-F010)가 같은
   SHA와 같은 deploymentId를 반환.

**둘은 완전히 독립적이지 않습니다.** `/api/build-info`의 `commitSha`는 Railway가
프로세스에 주입한 `RAILWAY_GIT_COMMIT_SHA`(없으면 빌드 시점에 구워진 fallback)이지
**실행 중인 번들의 해시가 아닙니다.** 그래서 이 관측이 증명하는 것은 "Railway가
이 SHA로 배포했다고 말하고, 그 배포로 뜬 프로세스도 같은 SHA를 말한다"까지입니다.

다만 그 둘이 **어긋나면 드러납니다.** `lib/buildInfo.ts`의 timeline 조회는
Railway가 보고한 commit과 프로세스의 commit이 다르면 타임스탬프를 전부 `null`로
돌려보냅니다("a wrong timestamp is worse than none"). 위 응답이 실제 타임스탬프를
담고 있으므로 **그 대조를 통과했습니다.**

`builtAt` 09:32:33.603Z는 #1331 병합(09:19:44Z) **이후**입니다. 배포가 병합 전
번들을 재사용한 것이 아니라는 뜻입니다.

**배포된 번들이 §11.3.0의 코드를 담고 있음을 런타임 동작으로 확인하지는
못했습니다.** staging의 두 도메인이 이 컨테이너의 egress에서 막혀
있습니다(`staging.tomverse.app`은 Cloudflare Access 로그인으로 302 후 CONNECT
403, `tomverse-staging.up.railway.app`은 CONNECT 403). `/api/build-info`만
Access 우회 대상이라 읽혔습니다. 개인정보처리방침 페이지의 국외이전 8항목이
렌더링되는지 확인했다면 번들 내용에 대한 독립 증거가 됐겠지만, **하지 못했으므로
미관측으로 남깁니다.**

### 9-3. 조건 4·5가 가능한 상태인지

**환경 자체는 준비돼 있습니다.** staging `Tomverse` 서비스의 변수 이름만 조회한
결과(값은 읽지 않았고 출력하지 않습니다):

- `VOICE_TRANSCRIPTION_API_KEY` — **있음**
- `VOICE_PROVIDER_SECONDS_PER_DAY`·`_PER_MONTH` — **있음** (B-4, 2026-09-08 서명)
- `VOICE_INPUT_KILL_SWITCH` — **없음**. kill switch가 걸려 있지 않으므로 저장된
  flag가 그대로 효력을 가집니다.
- `VOICE_INPUT_REQUESTS_PER_DAY`·`_PER_MINUTE`·`VOICE_INPUT_SECONDS_PER_DAY` —
  없음. **차단 요인이 아닙니다** — `lib/voiceInputGuardrails.ts`의
  `VOICE_GUARDRAIL_DEFAULTS`가 적용됩니다.
- `VOICE_TRANSCRIPTION_MODEL` — 없음. `gpt-4o-mini-transcribe`가 적용됩니다.

**변수가 있다는 것은 설정됐다는 뜻이지 그 경로로 트래픽이 갔다는 뜻이 아닙니다.**
값은 `valuesRedacted`로 가려져 있어 이 관측은 이름의 존재까지입니다. 조건 4·5는
여전히 실제 요청으로만 생깁니다.

### 9-4. 조건 현황

| # | 조건 | 상태 |
|---|---|---|
| 1 | 미국 endpoint 고정 코드 병합 | **완료** — PR #1331, `6019e07a` |
| 2 | 국외이전 고지 항목 승인 | **완료** — §8-2 |
| 3 | staging 전체 deploy SHA | **완료** — §9-1 |
| 4 | 그 deploy에서 Voice 요청 성공 | 미관측 |
| 5 | 미국 endpoint를 썼다는 운영 증거 | 미관측 |
| 6 | 사람의 B-5 판정·서명 | 미완 |

---

## 판정과 서명 (사람이 채웁니다)

- **판정**:
- **서명**:
- **일자(UTC)**:
