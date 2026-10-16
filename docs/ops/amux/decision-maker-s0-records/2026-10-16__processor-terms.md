# Decision Maker S0 처리위탁 조건 검토 기록 — 2026-10-16

> **운영자 `mposition`이 2026-10-17에 남은 항목을 결정하고 닫았다**("판정과 서명"). 에이전트(Claude)가 2026-10-16에 두
> 공급사의 공개 약관·문서를 읽고 정리했다. 이 문서는 법률 자문이 아니다. 유료 turn은 없다.

정책 근거는 `docs/policy/amux-decision-maker.md` 정책 버전 1의 §11("비용, 데이터, 법규")과 §12 S0("두 공급사의 처리위탁
조건")이다. §11은 S0의 처리위탁·국외 이전(APP 포함) 검토가 **카드와 스냅샷의 전체 payload**를 범위로 한다고 적는다.
카드는 worker가 쓴 공개되지 않은 자유 텍스트이고, 그 안에 개인정보가 섞일 수 있다(§10 "데이터 등록부").

## 요약

| 항목 | 결과 |
|---|---|
| DM 계정의 플랜 | **두 계정 모두 개인용**(운영자 보고, 2026-10-17). 그래서 두 공급사 모두 아래 "개인용일 때"가 적용된다 |
| 개인용 플랜일 때 | 처리위탁 계약(DPA)이 없다. 학습 사용은 설정으로 끈다. 자동 실행에 대한 문구가 있어 해석이 필요하다 |
| 기업용 플랜·API일 때 | DPA가 약관에 포함된다. 고객 콘텐츠로 학습하지 않는다 |
| 처리 지역 | 보장되지 않는다. S0에서 claude 출력은 `inference_geo:"global"`이었다 |

## 출처

모두 2026-10-16에 읽었다. 공급사가 문서를 바꿀 수 있으므로 S2 착수 전에 다시 읽는다.

| 출처 | 읽은 방법 | 문서가 밝힌 날짜 |
|---|---|---|
| Anthropic Consumer Terms of Service, `https://www.anthropic.com/legal/consumer-terms` | WebFetch | 효력일 2025-10-08 |
| Anthropic Commercial Terms of Service, `https://www.anthropic.com/legal/commercial-terms` | WebFetch | 효력일 2025-06-17 |
| Claude Code "Legal and compliance", `https://code.claude.com/docs/en/legal-and-compliance` | WebFetch | 없음 |
| Anthropic Privacy Center "Is my data used for model training?", `https://privacy.claude.com/en/articles/10023580-is-my-data-used-for-model-training` | WebFetch | 2026-03-16 |
| OpenAI Services Agreement, `https://openai.com/policies/business-terms/`(`/policies/services-agreement/`로 이동) | 브라우저 | 갱신 2025-12-01 |
| OpenAI Help "Data controls in ChatGPT", `https://help.openai.com/en/articles/7730893-data-controls-in-chatgpt` | 브라우저 | "18 days ago"로 표시 |
| Codex 문서 "Authentication", `https://learn.chatgpt.com/docs/auth` | WebFetch | 없음 |

WebFetch는 페이지를 요약 모델로 읽으므로, 아래에서 인용 부호 안의 짧은 문구만 원문 그대로다. 나머지는 에이전트의 요약이다.

## Anthropic (`decision-maker-anthropic`, Claude Code)

**어느 약관이 적용되는가.** Claude Code 문서는 Free·Pro·Max 사용자에게 Consumer Terms를, Team·Enterprise·Claude API 사용자에게
Commercial Terms를 적용한다고 적는다.

**개인용(Free·Pro·Max)일 때**

- 학습: Consumer Terms는 입력·출력을 모델 학습을 포함한 개선에 쓰되 계정 설정에서 끌 수 있다고 적는다. 끈 경우에도
  사용자가 보낸 피드백과 안전 검토 대상 자료는 예외다. Privacy Center(2026-03-16)는 개인용 플랜과 그 계정의 Claude
  Code에 대해, 사용자가 허용한 경우에 대화·코딩 세션을 개선에 쓴다고 적는다.
- DPA: Consumer Terms에는 처리위탁 계약이나 Anthropic이 처리자라는 문구가 없다.
- 자동 실행: Consumer Terms는 Anthropic API 키로 접근하거나 Anthropic이 명시적으로 허용한 경우를 빼고 "automated or
  non-human means"로 서비스에 접근하는 것을 금지한다. Claude Code 문서는 OAuth 인증이 구독 플랜 구매자를 위한 것이고
  Claude Code와 Anthropic 앱의 통상적인 사용을 위해 설계됐다고 적는다. Pro·Max의 사용량 한도는 통상적인 개인 사용을
  전제로 한다고 적고, Anthropic이 사전 통지 없이 조치할 수 있다고 적는다. 같은 문서는 사용자가 수정하지 않은 Claude
  Code 실행 파일에 자기 구독으로 로그인하는 것은 막지 않는다고 적는다.
- 에이전트의 정리: DM은 수정하지 않은 Claude Code를 Tomverse 자신의 구독으로 실행하므로 제3자 중개는 아니다. 그러나
  사람이 아닌 broker가 질문마다 무인으로 실행하는 것이 "통상적인 사용"에 들어가는지는 문서가 답하지 않는다.

**기업용(Team·Enterprise)·API일 때**

- Commercial Terms는 Anthropic DPA를 약관에 포함하고, 서비스의 고객 콘텐츠로 모델을 학습하지 않는다고 적는다.
- Claude Code 문서는 개발자가 만든 제품·서비스는 Console의 API 키 인증을 쓰라고 적는다.

## OpenAI (`decision-maker-openai`, Codex CLI)

**어느 약관이 적용되는가.** OpenAI Services Agreement는 API, ChatGPT Enterprise, ChatGPT Business 같은 기업·개발자 고객
서비스에만 적용되고, 개인이 쓰는 서비스에는 적용되지 않는다고 적는다. Codex 인증 문서는 ChatGPT로 로그인하면 Codex 사용이
그 ChatGPT workspace의 설정을 따르고, API 키로 로그인하면 API organization의 보존·공유 설정을 따른다고 적는다.

**개인용 ChatGPT 플랜일 때**

- 학습: 개인 플랜에서 Codex를 쓰면 ChatGPT의 "Improve the model for everyone" 설정이 Codex 작업에도 적용된다. 그 설정을
  끄거나 Privacy Portal에서 학습 제외를 고르면 된다. Codex의 "Include environments" 설정은 별개다(Codex 환경의 추가
  맥락에 대한 것).
- 보존: 안내문의 안전 목적 "up to 30 days" 보존 문구는 임시 대화(Temporary chat) 절에 있다. 학습을 끈 일반 대화와
  Codex CLI 작업의 보존 기간은 이 안내문에서 찾지 못했고 이 검토가 확인하지 않았다.
- DPA: 개인 플랜에는 Services Agreement가 적용되지 않는다. 처리위탁 계약은 확인되지 않았다.
- 자동 실행: Codex 인증 문서는 CI·CD 같은 프로그램 방식의 Codex CLI 작업에 API 키 인증을 쓰라고 적는다. ChatGPT
  workspace 접근이 필요한 자동화에는 access token을 쓰며, 그것은 신뢰된 비대화형 로컬 작업을 위한 것이라고 적는다.
  Enterprise에서는 관리자가 그 권한을 준다.
- 에이전트의 정리: DM의 `codex exec`는 공급사가 문서로 안내하는 비대화형 모드다. 다만 문서가 무인 자동화에 권하는 것은
  API 키이고, 개인 플랜의 ChatGPT 로그인으로 무인 실행하는 것을 명시적으로 허용하는 문구는 찾지 못했다.

**기업용(Business·Enterprise)·API일 때**

- Services Agreement는 고객이 개인정보를 처리하면 DPA를 따른다고 적고 DPA를 약관에 포함한다. 고객이 명시적으로 동의하지
  않으면 고객 콘텐츠로 서비스를 개선하지 않는다고 적는다.
- Data controls 안내문은 Business·Enterprise·Edu workspace의 콘텐츠를 기본적으로 학습에 쓰지 않는다고 적는다.

## 처리 지역과 국외 이전

- 두 공급사 모두 미국 회사다. 처리 지역을 보장하는 문구는 위 출처에서 찾지 않았다. 정책 §11은 이미 "처리 region을
  보장한다고 쓰지 않는다"고 적는다.
- S0 유료 turn에서 claude의 결과 객체는 `inference_geo:"global"`이었다(`2026-10-16__paid-turns.md`). 그 값이 어느 지역을
  뜻하는지는 문서로 확인하지 않았다.
- 중국 본토 접속·처리 region·그 지역 공급자는 쓰지 않는다(정책 §11). 두 공급사의 기본 경로가 여기에 걸리는지는 확인하지
  않았다.
- 카드에 개인정보가 섞이면 그 전송은 국외 수령자에게 개인정보를 공개하는 일이 될 수 있다(Australian Privacy Principle 8).
  그것을 어떻게 다룰지는 운영자의 결정이다. 이 기록은 판단하지 않는다.

## 운영자가 정할 것

1. **DM 두 계정의 플랜.** 각 계정이 개인용(Claude Pro·Max, ChatGPT Plus·Pro)인지 기업용(Claude Team·Enterprise, ChatGPT
   Business·Enterprise)인지, 또는 API 키로 바꿀지. 이것이 위 두 갈래 중 어느 쪽인지를 정한다.
   **2026-10-17 운영자 보고: 두 계정 모두 개인용이다.** 정확한 플랜 이름(Pro·Max, Plus·Pro)은 보고되지 않았다. 그래서 아래
   2와 4가 남은 결정이고, 3은 플랜을 바꾸기로 할 때만 해당한다.
2. **개인용을 유지한다면**
   - 두 계정의 학습 설정이 꺼져 있는지 확인한다(Claude의 모델 개선 설정, ChatGPT의 "Improve the model for everyone").
     설정 화면은 공급사 계정에 로그인해야 보이므로 에이전트는 확인하지 않았다.
   - DPA 없이 카드(개인정보가 섞일 수 있는 자유 텍스트)를 보내는 것을 받아들일지.
   - 무인 실행이 "통상적인 사용"·자동화 문구에 들어가는지에 대한 위험을 받아들일지. 계정이 조치되면 DM은 "DM 불가"가
     되고 질문은 운영자에게 간다(정책 §9). 데이터가 되돌아오지는 않는다.
3. **기업용이나 API 키로 바꾼다면** 다음이 함께 바뀐다.
   - 정책 §11의 "DM은 구독형 CLI 계정을 쓴다"와 비용 문장. API 키면 호출마다 과금이며 공통 기반 원칙 5(Agent 비용은
     별도 namespace, 전용 키)의 대상이다.
   - 인증 방식이 바뀌므로 S0의 인증·상태 관측(`2026-10-16__paid-turns.md`)과 정책 버전 2 후보의 §5a(고정 환경, 남김
     목록)를 다시 잰다.
4. **국외 이전.** 카드의 개인정보에 대해 APP 8을 어떻게 다룰지(예: 카드에 개인정보를 쓰지 말라는 worker 지시, secret
   검사에 개인정보 패턴 추가, 개인정보 고지 문구). 기술 조치는 정책 버전 변경이 필요하다.

**에이전트의 권고(판정 아님).** 실제 카드를 처음 보내는 S2 전에 1을 정한다. 개인정보가 섞일 수 있는 무인 전송이라는
점에서, DPA가 있고 학습이 기본으로 꺼진 기업용 약관이나 API 키 쪽이 문서상 근거가 더 분명하다. 비용과 S0 재측정이
드는 결정이므로 운영자가 정한다.

## 이 검토가 하지 않은 것

- 공급사 계정 화면의 실제 설정 확인(로그인이 필요하다).
- DPA 본문, 하위 처리자 목록, 데이터 전송 조항(표준 계약 조항 등) 읽기.
- 공급사 개인정보 처리방침 전체 읽기.
- 법률 자문.

## 판정과 서명

2026-10-17 운영자 `mposition`이 대화로 남은 항목에 답했고("학습설정 꺼져있으며 위험 수용 합니다. 공급 위치 어디지인지
개인정보 정책에 다 언급되어져 있습니다"), 에이전트가 그 내용을 옮겨 적었다.

| 항목 | 값 |
|---|---|
| DM 계정 플랜 | 두 계정 모두 개인용(운영자 보고, 2026-10-17) |
| 학습 설정 꺼짐 확인 | 꺼져 있다(운영자 확인, 2026-10-17. 에이전트는 계정 화면을 보지 않았다) |
| DPA 없음·자동 실행 문구 위험의 수용 | 수용한다(운영자, 2026-10-17) |
| APP 8 처리 | 공급자별 이전 장소는 Tomverse 개인정보 처리방침의 "공급자별 채팅 내용의 이전" 표에 이미 공개돼 있다(운영자, 2026-10-17). 표의 데이터는 `lib/providerDataDestinations.ts`, 렌더링은 `components/legal/PrivacyPolicy.tsx`다 |
| 결과 | 남은 항목이 모두 결정됐다. S0-6을 닫는다 |
| 서명 | mposition (2026-10-17, 대화) |

에이전트의 메모(결정이 아니다): 위 표는 채팅 API 경로의 계약을 기준으로 쓰였고, DM은 개인용 CLI 계정이라 적용 약관이
다르다(위 "Anthropic"·"OpenAI" 절). 처리방침을 고칠 때 DM 경로도 함께 보면 된다.
