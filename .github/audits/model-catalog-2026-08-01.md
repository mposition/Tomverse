# Tomverse Insight 모델 카탈로그 정비 (2026-08-01)

이 문서는 2026-08-01에 공식 공급자 문서와 인증된 live model catalog를 대조해
Tomverse Insight의 정적 카탈로그, 운영 registry bootstrap, 가격 및 요청 호환성을
정비한 근거를 기록합니다. API 키, Authorization header, `/models` 응답 원문은
저장하지 않았습니다.

## 1. 결정 요약

| 구분 | Tomverse id | apiModel | replacementModelId | 결정 |
|---|---|---|---|---|
| 추가 | `gpt-5-6-sol` | `gpt-5.6-sol` | – | Pro / premium, GPT-5.6 canonical reasoning model |
| 추가 | `gpt-5-6-terra` | `gpt-5.6-terra` | – | Free / advanced |
| 추가 | `gpt-5-6-luna` | `gpt-5.6-luna` | – | Guest / standard |
| 추가 | `gemini-3-6-flash` | `gemini-3.6-flash` | – | Free / advanced |
| 추가 | `groq-gpt-oss-120b` | `openai/gpt-oss-120b` | – | Free / advanced; Groq의 오픈 모델 추론 경로 |
| 추가 | `grok-4-3` | `grok-4.3` | – | Free / advanced; `reasoningEffort:none` |
| in-place 갱신 | `gemini-2-5-flash` | `gemini-3.5-flash-lite` | – | 안정 Tomverse id를 유지하고 표시명·metadata 갱신 |
| in-place 갱신 | `mistral-medium-3-1` | `mistral-medium-3-5` | – | `latest` 대신 검증된 고정 ID 사용 |
| 유지 | `gpt-5-5` | `gpt-5.5` | – | 공식 지원 중; 기본 모델 변경 없음 |
| 유지 | `gpt-5-4-mini` | `gpt-5.4-mini` | – | 공식 지원 중; 기본 모델로 유지 |
| 유지 | `grok-4-5` | `grok-4.5` | – | live catalog와 공식 모델 문서에서 확인 |
| 유지 | `llama-3-1` | `llama-3.1-8b-instant` | – | 2026-08-16 종료 전이므로 2026-08-01에는 유지 |
| 유지 | `llama-3-3` | `llama-3.3-70b-versatile` | – | 2026-08-16 종료 전이므로 2026-08-01에는 유지 |
| 유지 | `claude-fable-5` | `claude-fable-5` | – | Anthropic 공식 상태 Active |
| 유지 | `claude-opus-4-8` | `claude-opus-4-8` | – | Anthropic 공식 상태 Active |
| 유지 | `claude-sonnet-5` | `claude-sonnet-5` | – | Anthropic 공식 상태 Active |
| 유지 | `claude-haiku-4-5` | `claude-haiku-4-5-20251001` | – | Anthropic 공식 상태 Active |
| 유지 | `perplexity/sonar` | `sonar` | – | 공식 Sonar model page 유지 |
| 유지 | `perplexity/sonar-pro` | `sonar-pro` | – | 공식 Sonar Pro model page 유지 |
| 유지 | `perplexity/sonar-reasoning-pro` | `sonar-reasoning-pro` | – | 공식 Sonar Reasoning Pro model page 유지 |
| 유지 | `perplexity/sonar-deep-research` | `sonar-deep-research` | – | 공식 Sonar Deep Research model page 유지 |
| 은퇴 | `deepseek-r1` | `deepseek-reasoner` | `deepseek-v4-flash` | historical row 유지, disabled·delisted |
| 은퇴 | `grok-3` | `grok-3` | `grok-4-3` | historical row 유지, disabled·delisted |
| 은퇴 유지/교체 변경 | `llama-4-scout` | `meta-llama/llama-4-scout-17b-16e-instruct` | `groq-gpt-oss-120b` | 종료 임박 Llama 3.3 replacement를 제거 |

`gpt-5-5-thinking`은 Tomverse id를 유지합니다. `apiModel`은 기존처럼 `gpt-5.5`지만,
모든 생성 경로가 이제 `reasoningEffort: high`를 실제 provider request에 전달합니다.
GPT-5.6에는 별도의 Thinking 복제 항목을 만들지 않았습니다.

## 2. 공식 근거와 live 확인

확인 날짜는 모두 **2026-08-01**입니다.

| 공급자 | 공식 근거 | live 확인 |
|---|---|---|
| OpenAI | [Latest model guide](https://developers.openai.com/api/docs/guides/latest-model), [Models](https://developers.openai.com/api/docs/models), [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) | 인증된 `GET https://api.openai.com/v1/models`에서 세 exact slug 확인; 세 모델 모두 최소 live generation 성공 |
| Google | [Latest models](https://ai.google.dev/gemini-api/docs/latest-model), [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations), [Pricing](https://ai.google.dev/gemini-api/docs/pricing) | 인증된 `GET https://generativelanguage.googleapis.com/v1beta/models`에서 `gemini-3.6-flash`, `gemini-3.5-flash-lite` 확인; 두 Tomverse 경로 live generation 성공 |
| Groq | [Deprecations](https://console.groq.com/docs/deprecations), [Models](https://console.groq.com/docs/models) | 인증된 `GET https://api.groq.com/openai/v1/models`에서 `openai/gpt-oss-120b` 확인, Scout 부재 확인; GPT-OSS live generation 성공 |
| xAI | [May 15 retirement](https://docs.x.ai/developers/migration/may-15-retirement), [Models](https://docs.x.ai/developers/models) | 인증된 `GET https://api.x.ai/v1/models`에서 `grok-4.3`, `grok-4.5` 확인, `grok-3` 부재 확인; Grok 4.3 live generation 성공 |
| DeepSeek | [Pricing and model contract](https://api-docs.deepseek.com/quick_start/pricing) | 인증된 `GET https://api.deepseek.com/models`에서 `deepseek-v4-flash`, `deepseek-v4-pro` 확인, `deepseek-reasoner` 부재 확인; V4 Flash live generation 성공 |
| Mistral | [Models](https://docs.mistral.ai/models) | 인증된 `GET https://api.mistral.ai/v1/models`에서 `mistral-medium-3-5`와 `mistral-medium-latest` 확인; 고정 ID 경로 live generation 성공 |
| Anthropic | [Model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations) | 기존 네 API ID가 모두 공식 상태표에서 Active임을 확인; 이번 reconciliation 대상 아님 |
| Perplexity | [Sonar models](https://docs.perplexity.ai/docs/sonar/models) | 기존 네 exact model page가 공식 문서에 유지됨을 확인; 이번 reconciliation 대상 아님 |

Mistral의 `latest` alias는 확인 시점에 Medium 3.5를 가리켰지만 운영 재현성을 위해
고정 `mistral-medium-3-5`를 선택했습니다. Groq GPT-OSS는 OpenAI 정식 모델의 중복이
아니라 Groq endpoint의 별도 가용성·지연·가격 경로이므로 Scout replacement로 추가했습니다.

## 3. 가격, credit, 검색 및 첨부 계약

가격은 USD / 1M tokens이며 cache는 일반 input 가격에 대한 배수입니다.

| Tomverse id | input / cache / output | context / max output | credit | 첨부 | native search |
|---|---:|---:|---:|---|---|
| `gpt-5-6-sol` | 5 / 0.5 / 30 | 1.05M / 128K | 8 | image, PDF | 지원 |
| `gpt-5-6-terra` | 2 / 0.2 / 12 | 1.05M / 128K | 4 | image, PDF | 지원 |
| `gpt-5-6-luna` | 0.2 / 0.02 / 1.2 | 1.05M / 128K | 1 | image, PDF | 지원 |
| `gemini-3-6-flash` | 1.5 / 0.15 / 7.5 | 1,048,576 / 65,536 | 4 | image, PDF | 지원 |
| `gemini-2-5-flash` | 0.3 / 0.03 / 2.5 | 1,048,576 / 65,536 | 1 | image, PDF | 지원 |
| `groq-gpt-oss-120b` | 0.15 / 0.075 / 0.6 | 131,072 / 65,536 | 4 | text only | 미지원 |
| `grok-4-3` | 1.25 / 0.2 / 2.5 | 1M / 16,384 운영 cap | 4 | image | 미지원 |
| `grok-4-5` | 2 / 0.3 / 6 | 500K / 16,384 운영 cap | 16 | image | 미지원 |
| `deepseek-v4-flash` | 0.14 / 0.0028 / 0.28 | 1M / 384K | 1 | text only | 미지원 |
| `deepseek-v4-pro` | 0.435 / 0.003625 / 0.87 | 1M / 384K | 1 | text only | 미지원 |
| `mistral-medium-3-1` | 1.5 / 1.5(할인 미적용) / 7.5 | 262,144 / 16,384 운영 cap | 4 | image | 미지원 |

- GPT-5.6은 272K를 초과하는 prompt tier에서 input 2배, output 1.5배를 적용합니다.
- Grok 4.3/4.5는 200K 이상 tier에서 input/output 2배를 적용합니다.
- Gemini 3.6 Flash와 3.5 Flash-Lite에서는 `temperature`, `top_p`, `top_k`를 보내지
  않으며, 마지막 non-empty turn이 assistant인 prefill 요청을 지출 전에 400으로 차단합니다.
- Groq/xAI 모델은 현재 앱의 plain Chat Completions 경로에 검색 tool integration이
  없으므로 provider가 별도 검색 상품을 제공하더라도 native search로 표시하지 않습니다.
- Mistral은 별도 공식 max-output 수치를 확인하지 못해 16,384를 명시적 운영 request
  cap으로 유지했습니다. 모델별 cache 가격도 확인되지 않아 검증됨으로 표시하지 않고
  할인 없는 1.0배 input 단가로 보수적으로 계산합니다.

## 4. 운영 DB 반영 방식

`ensureModelRegistrySeeded()`가 다음 순서로 idempotent하게 실행합니다.

1. `createMany(skipDuplicates)`로 신규 exact ID만 생성합니다.
2. 모든 정적 historical retirement에 `enabled:false`, `publiclyListed:false`,
   `status:"disabled"`, `replacementModelId`를 다시 적용합니다. 이미 disabled인 행의
   replacement가 오래된 경우도 갱신합니다.
3. `STATIC_CATALOG_RECONCILIATION_MODEL_IDS`의 이번 변경 대상 ID에만 name,
   `apiModel`, 표시 metadata, capability, 가격을 reconciliation합니다.

`catalogDeleted`, provider URL/key 설정, sort order, actor metadata는 건드리지 않습니다.
활성 모델의 운영 lifecycle도 seed로 다시 켜지 않습니다. 은퇴 모델에 한해서만
공식 lifecycle이 우선합니다. 따라서 범용 seed overwrite가 아니라 검토된 exact-ID
patch입니다.

기존 Message와 결제 ledger의 model id는 수정하지 않습니다. 대화 선택값, default,
favorites, recents, recommendations만 최대 8-hop의 cycle-safe replacement chain을 통해
복구하며, 유효 replacement가 없을 때만 기본 모델로 fallback합니다.

## 5. 검증 결과

| 검사 | 결과 |
|---|---|
| `npm run test:unit` | 1,011 / 1,011 통과 |
| `npm run typecheck` | 통과 |
| `npm run lint` | 통과 |
| `npm run check:encoding` | 통과 |
| `npm run check:model-pricing` | 통과; enabled premium unpriced 0 |
| `npm run build` | 통과; 78개 route/page 생성 |
| model lifecycle, registry, finder, recommendations, fallback, catalog monitor, usage credit 단위 테스트 | 전체 unit 묶음에서 통과 |
| `model-picker.spec.ts`, `provider-status.spec.ts`, `native-web-search.spec.ts` 전체 Playwright 프로젝트 | 224개 매트릭스, 최종 exit 0; 플랫폼 조건부 skip 포함 |
| font system + mobile composer 기능 계약 | visual record 제외 46 / 46 통과 |
| 신규·교체 계열 live generation | OpenAI 3, Google 2, Groq 1, xAI 1, DeepSeek 1, Mistral 1 모두 성공 |

E2E는 DB 비활성 fixture 때문에 `127.0.0.1:1` P1001 진단 로그를 남기지만 실패로
이어지지 않았습니다. Windows용 승인 golden이 없는 visual record 2건은 기준을 새로
승인하지 않고 제외했으며, 자동 생성된 이미지는 작업 트리에서 제거했습니다.

## 6. 배포 후 확인과 잔여 위험

- 이 작업 환경에는 staging DB/배포 URL이 제공되지 않아 실제 staging
  `ModelRegistryEntry`, `/api/models/catalog`, `/api/models/status`의 배포 후 일치를
  직접 확인하지 못했습니다. 배포 직후 exact-ID reconciliation 로그와 세 endpoint를
  확인해야 합니다.
- Mistral Medium 3.5의 공식 별도 max-output 및 cached-input 단가는 확인되지 않아
  운영 cap과 cache 미검증 상태를 사용합니다.
- Grok의 200K+ 장문 tier, GPT-5.6의 272K+ tier는 단위 테스트로 계산을 검증했지만
  비용이 큰 실제 장문 요청은 live로 실행하지 않았습니다.
- `llama-3-1`, `llama-3-3`은 2026-08-16 종료 예정이므로 그 전에 별도 historical
  retirement와 `groq-gpt-oss-120b` replacement migration을 배포해야 합니다.
- Perplexity의 네 Sonar 모델은 정확한 공식 model page가 남아 있어 유지했지만 문서
  탐색 구조상 Sonar API가 `Legacy API` 아래에 있습니다. 명시된 종료일은 없으므로
  자동 은퇴하지 않았으며 Agent API 전환 공지를 catalog monitor와 함께 추적해야 합니다.
