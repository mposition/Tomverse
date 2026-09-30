# 채팅 공급자 수신지 공개문서 초안 (2026-09-28)

이 문서는 초안이다. 2026-09-28에 소유자가 등록된 열여섯 공급자를 모두 Ready로 확정했다. MiniMax Account에는 학습 스위치가 없었고, 소유자는 개인정보 처리방침의 문장을 학습 아니오와 판매·광고 금지로 함께 확정했다. 계약이 장소를 묶지 않는 칸은 `NOT_SPECIFIED`로 둔다. 개인정보 처리방침 페이지는 열여섯 행이 모두 공개 가능할 때만 공급자 표를 그린다.

읽은 날: 2026-09-28. 근거는 그 공급자가 공개한 문서만이다. 다른 서비스의 정책, 블로그, 요약 사이트는 근거로 쓰지 않았다. OpenRouter의 문서는 OpenRouter 행에만 쓴다. 읽지 못한 칸은 미확인이다. 미확인은 아니오가 아니다. 계정 콘솔에만 있는 값(리전, ZDR 승인, 유료 결제 연결)은 비워 두었다.

보관 다섯 칸은 `content`, `safetyLogs`, `inMemoryCache`, `persistentFeatureState`, `systemMetadata`이다. 문서가 그 칸을 말하지 않으면 미확인이다.

## 코드에서 확인한 전송

채팅 응답의 공급자 호출은 `app/api/chat/route.ts`의 `streamText`이다. 넘기는 것은 메시지, 시스템 지시, 출력 상한, 생성 설정, 그 턴의 도구이다. 계정 식별자, 이메일, 클라이언트 IP를 이 호출에 붙이지 않는다. `userId`는 기억과 프로필을 우리 데이터베이스에서 읽는 데 쓰이고, 클라이언트 IP는 속도 제한과 보안 기록에 쓰인다. 사용자가 쓴 문장, 켠 기억, 첨부 파일 안에는 개인정보가 들어 있을 수 있다. 그것은 우리가 계정 레코드를 붙인 것과 다르다.

Perplexity에만 내부 추적 헤더를 붙였다가, 실제 전송 전에 `lib/perplexityUsageCapture.ts`가 그 헤더를 지운다.

호출 주소는 `lib/modelRegistryShared.ts`의 `PROVIDER_API_CONFIGURATION`이고, 모두 `https://`이다. OpenAI 리전 호스트(`us.api.openai.com`, `eu.api.openai.com`)와 xAI 미국 호스트(`us.api.x.ai`)는 이 표에 없다.

| provider | 코드가 호출하는 주소 |
|---|---|
| openai | `https://api.openai.com/v1` |
| anthropic | `https://api.anthropic.com` |
| google | `https://generativelanguage.googleapis.com/v1beta` |
| groq | `https://api.groq.com/openai/v1` |
| xai | `https://api.x.ai/v1` |
| deepseek | `https://api.deepseek.com` |
| mistral | `https://api.mistral.ai/v1` |
| moonshot | `https://api.moonshot.ai/v1` |
| minimax | `https://api.minimax.io/anthropic/v1` |
| qwen | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| zhipu | `https://api.z.ai/api/paas/v4` |
| perplexity | `https://api.perplexity.ai` |
| deepinfra | `https://api.deepinfra.com/v1/openai` |
| together | `https://api.together.ai/v1` |
| openrouter | `https://openrouter.ai/api/v1` |
| sail | `https://api.sailresearch.com/v1` |

앱이 직접 웹 검색을 수행하는 경로는 `https://api.search.brave.com/res/v1/web/search`이다. 그 요청에도 계정 식별자, 이메일, 클라이언트 IP를 넣지 않는다. Brave의 법인, 국가, 보관은 이번 초안에 없다.

## 공급자별 초안

### openai

- 수신 법인·국가: 미확인. 음성 고지의 OpenAI OpCo, LLC를 이 행으로 옮기지 않는다. DPA 본문에서 당사자 정의를 이번 읽기에서 확정하지 못했다.
- 저장 지리: 미확인. 문서상 data residency는 계정 프로젝트 설정이다. 코드는 글로벌 호스트를 부른다. 콘솔에서 프로젝트 리전을 확인해야 한다.
- 처리 지리: 미확인. 같은 문서가, 선택 리전이 지역 처리를 지원하지 않으면 고객 콘텐츠를 그 리전 밖에서 처리하고 잠시 저장할 수 있다고 한다. 우리 계정이 어느 모드인지는 콘솔.
- 학습: 기본은 아니오, 명시적 opt-in이면 예. 계정 opt-in 여부는 콘솔.
- 보관 content: 기본 abuse monitoring 로그에 프롬프트와 응답이 들어갈 수 있고 최대 30일. 법령 또는 서비스·제3자 보호에 합리적으로 필요하면 더 길 수 있다. ZDR과 Modified Abuse Monitoring은 사전 승인이 필요하다. 승인 여부는 콘솔.
- safetyLogs: 위 abuse monitoring이 문서가 말한 안전 로그이다. 별도 칸의 일수는 미확인.
- inMemoryCache: 프롬프트 캐시가 GPU 로컬에 암호화된 상태를 둘 수 있고, 그 문서는 24시간 만료를 말한다. 채팅이 그 경로를 쓰는지는 이 초안이 단정하지 않는다.
- persistentFeatureState: Assistants 등 일부 엔드포인트는 저장한다. 일반 채팅 호출의 적용 여부는 미확인.
- systemMetadata: data residency 문서는 계정·사용량 같은 system data가 선택 리전 밖에서 처리·저장될 수 있다고 한다. 보관 일수는 미확인.
- 제3자 상업 이용 제한: DPA 발췌는 CCPA상 판매·공유 금지와, 고객과의 직접 사업 관계 밖 사용 금지를 말한다. 전문 대조는 미완.
- 근거: https://platform.openai.com/docs/guides/your-data , https://openai.com/policies/data-processing-addendum/ (발췌). 하위처리자 목록은 이번 읽기에 없다.

### anthropic

- 수신 법인·국가: 미확인. Commercial Terms에서 당사자 이름을 이번 읽기에서 확정하지 못했다.
- 저장·처리 지리: 미확인. 하위처리자 목록 원문은 이번 읽기에 없다.
- 학습: 그 페이지는 보관된 데이터를 명시적 허가 없이 모델 학습에 쓰지 않는다고 한다.
- 보관 content: 대화 내용은 기본으로 보관하지 않는다. 예외는 Covered Models(Fable, Mythos 계열)의 30일. 그 모델은 이 카탈로그의 채팅 경로가 아니다. ZDR은 조직마다 영업을 통해 켜며, 기본값이 아니다. 우리 조직의 ZDR 여부는 콘솔.
- safetyLogs: 미확인. ZDR 페이지가 플래그된 콘텐츠와 법적 보류를 별도로 가리키지만 일수는 그 절에 없다.
- inMemoryCache, persistentFeatureState, systemMetadata: 미확인. Activity Feed 6년, Compliance API는 그 페이지가 API 고객 콘텐츠의 기본 보관과 다른 제품으로 설명한다.
- 제3자 상업 이용 제한: 미확인.
- 근거: https://platform.claude.com/docs/en/manage-claude/api-and-data-retention

### google

Ready. 2026-09-28 소유자 확정.

- 수신 법인·국가: Google Asia Pacific Pte. Ltd.와 Google Australia Pty Ltd. 국가 SG, AU. 근거는 Google 계약 당사자 페이지.
- 저장·처리 지리: 유료 약관은 시설이 있는 나라에서 일시 저장·캐시될 수 있다고만 하고 나라를 묶지 않는다. `NOT_PINNED`.
- 학습: 아니오. AI Studio 결제 화면에서 Tomverse 프로젝트가 Gemini API 유료 1이고 결제 계정이 연결되어 있었다. 유료 약관은 그 프롬프트를 제품 개선에 쓰지 않는다고 한다.
- 보관 content·inMemoryCache: `TRANSIENT`. persistentFeatureState·systemMetadata: `NOT_SPECIFIED`.
- safetyLogs: `BOUNDED` 55일. 근거는 시트에 적힌 usage-policies 페이지.
- 제3자 상업 이용 제한: 금지. Cloud Data Processing Addendum은 고객 지시를 따라 서비스를 제공할 때만 처리하고, CCPA 절에서 판매와 광고 목적 공유를 금지한다. 소유자가 이 문장으로 Ready를 확정했다.
- 근거: https://ai.google.dev/gemini-api/terms , https://cloud.google.com/terms/google-entity , https://cloud.google.com/terms/data-processing-addendum , https://ai.google.dev/gemini-api/docs/usage-policies

트래픽을 끊거나 옮기는 결정은 이 초안이 하지 않는다. 개인정보 처리방침 표는 MiniMax가 Ready가 된 뒤에 넣는다.

### groq

- 수신 법인: Groq LLC 또는 Groq Public Sector, LLC. 미주·아시아·오세아니아 청구 주소는 Groq LLC, P.O. Box 1778, Mountain View, California, 94042, USA. 우리 청구 주소가 그 구간인지는 콘솔.
- 수신 국가 후보: 미국. 이것은 계약 당사자의 주소이지 저장 지리가 아니다.
- 저장·처리 지리: 미확인.
- 학습: 서비스 계약 4.2는 고객이 명시적으로 허락하거나 지시하지 않는 한 입력·출력을 모델 학습이나 미세조정에 쓰지 않는다고 한다.
- 보관 content: 데이터 안내 페이지는 추론 요청을 기본으로 보관하지 않고, 안정성 문제나 남용 조사 때는 최대 30일 로그할 수 있다고 한다. ZDR을 켜면 그 보관을 하지 않는다. 우리 계정의 ZDR은 콘솔.
- safetyLogs: 위 30일 로그가 문서가 말한 남용 조사이다. 별도 칸은 미확인.
- inMemoryCache: 미확인.
- persistentFeatureState: 배치와 미세조정은 고객이 지우기 전까지 또는 30일. 일반 채팅 추론과는 문서가 구분한다.
- systemMetadata: 미확인.
- 제3자 상업 이용 제한: 미확인. DPA는 하위처리를 허용하고 삭제 요청 시 최대 180일을 말한다. 판매 금지 문장은 이번 읽기에서 확정하지 못했다.
- 근거: https://console.groq.com/docs/legal/services-agreement , https://console.groq.com/docs/your-data , https://console.groq.com/docs/legal/customer-data-processing-addendum . 하위처리자 목록 URL은 DPA가 가리키나 목록 본문은 이번 읽기에 없다.

### xai

- 수신 법인·국가: 미확인. 보안 FAQ는 xAI라고 하고, 읽은 엔터프라이즈 약관 페이지는 SpaceXAI라고 한다. 법인 등기명은 이번 읽기에서 확정하지 못했다.
- 저장 지리: 미확인.
- 처리 지리: 기본 엔드포인트 `https://api.x.ai`는 처리 지역을 보장하지 않는다고 한다. 미국 보장은 `https://us.api.x.ai/v1`이고, 코드는 그 호스트를 쓰지 않는다.
- 학습: 명시적 허가 없이 API 입력·출력으로 학습하지 않는다고 한다.
- 보관 content: 기본은 서버에 암호화 저장, 남용 감사를 위해 30일 뒤 삭제. ZDR은 팀 단위 콘솔 설정이고 기본이 아니다. 우리 팀의 ZDR은 콘솔. 응답 헤더 `x-zero-data-retention`으로 확인할 수 있다고 한다.
- safetyLogs: 기본 30일 보관의 목적이 남용 감사라고 한다.
- inMemoryCache, persistentFeatureState: ZDR을 끄면 Files, Collections, Batch가 저장된다. 일반 채팅이 그 기능을 쓰지 않을 때의 칸은 미확인.
- systemMetadata: 미확인. 감사 로그는 팀 관리자 화면에 남는다. 내용 포함 여부는 ZDR과 별개로 적혀 있다.
- 제3자 상업 이용 제한: 미확인. DPA URL은 https://x.ai/legal/data-processing-addendum 이고 본문은 이번 읽기에 없다.
- 근거: https://docs.x.ai/developers/faq/security , https://x.ai/legal/terms-of-service-enterprise

### deepseek

Ready. 2026-09-28 소유자 확정.

- 수신 법인: Hangzhou DeepSeek Artificial Intelligence Co., Ltd. Open Platform 약관이 그 회사를 운영자로 적는다.
- 수신 국가: CN. 약관의 준거법은 중국 본토법이고, 관할은 그 회사 등록 사무소다. 저장 지리와는 별개다.
- 호출 주소: 카탈로그는 `https://api.deepseek.com`이다. 공식 문서의 Anthropic 호환 주소 `https://api.deepseek.com/anthropic`은 이 앱이 부르지 않는다. `api.deepseek.cn`, `api.sg.deepseek.com` 같은 별도 호스트는 공식 문서에서 확인되지 않아 적지 않는다.
- 저장·처리 지리: `NOT_SPECIFIED`. 국가 목록은 비어 있다. 일반 개인정보 처리방침의 중국 저장 문장은 API 고객 콘텐츠의 저장 위치로 쓰지 않는다.
- 학습: 아니오. 채팅 Settings의 Data에서 "Improve the model for everyone"은 회색이었다. 오른쪽으로 밀면 파란색이 되고, 그때가 켜진 상태다.
- 보관 다섯 칸: `NOT_SPECIFIED`.
- 제3자 상업 이용 제한: 금지. 개인정보 처리방침은 타깃 광고를 하지 않고, 개인정보를 판매하지 않으며, 프로파일링에 쓰지 않는다고 적는다. 소유자가 이 문장으로 금지라고 확정했다. Open Platform 약관 5.5는 그 방침이 개발자 본인의 개인정보에 적용되고 하위 앱 최종 사용자의 처리 규칙은 방침 밖이라고 한다. 그 범위 차이를 안 상태에서 소유자가 금지를 적으라고 했다.
- 근거: https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html , https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html , https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html

트래픽을 끊거나 다른 호스트로 옮기지 않는다. 개인정보 처리방침 표는 MiniMax가 Ready가 된 뒤에 넣는다.

### mistral

Ready. 2026-09-28 소유자 확정.

- 수신 법인·국가: Mistral AI, FR.
- 저장 지리: `COMMITTED_LOCATIONS`, 매크로 리전 EU. 처리 지리: `NOT_PINNED`. 임시로 EU 밖으로 옮길 수 있어 처리를 EU에 묶지 않는다.
- 학습: 아니오. Admin Privacy에서 "Allow the use of your API calls to train Mistral's AI models"가 꺼져 있었다. Labs 모델도 꺼져 있어, opt-out과 무관하게 학습에 쓴다는 Labs 문장은 지금 켜져 있지 않다.
- 보관 다섯 칸: `NOT_SPECIFIED`. ZDR 승인 여부는 이 화면의 질문이 아니어서 `UNKNOWN`으로 둔다.
- 제3자 상업 이용 제한: 금지. 근거는 데이터 처리 부속계약.
- 근거: https://legal.mistral.ai/terms/commercial-terms-of-service/ , https://legal.mistral.ai/terms/data-processing-addendum/ , https://help.mistral.ai/en/articles/347629-where-do-you-store-my-data-or-my-organization-s-data , https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training

### moonshot

- 수신 법인: MOONSHOT AI PTE. LTD.
- 수신 국가: SG. 저장 지리와 같은 문서에서 읽었고, 둘은 다른 칸이다.
- 호출 주소: 카탈로그는 `https://api.moonshot.ai/v1`이다. 공식 Chat Completions 예제도 그 주소다. 중국 본토 주소 `https://api.moonshot.cn/v1`은 쓰지 않는다. 문서의 Anthropic 호환 주소 `https://api.moonshot.ai/anthropic`은 이 앱이 부르지 않는다.
- 저장 지리: `COMMITTED_LOCATIONS`, SG. 처리방침은 수집한 정보를 싱가포르의 secure servers에 저장한다고 적는다.
- 처리 지리: `DISCLOSED_POSSIBLE_LOCATIONS`, SG. 같은 문서는 필요하면 국외 이전이 있을 수 있다고 적지만 다른 국가를 이름 대지 않는다. 이름 없는 이전을 국가 코드로 만들지 않는다.
- 학습: 참. 같은 처리방침은 User Content로 기반 기술(기계학습 모델과 알고리즘)을 학습·개선할 수 있다고 적는다. 싱가포르 저장과 별개의 칸이다. 도움말 페이지는 API 입력·출력을 학습에 쓰지 않는다고 하므로 두 문서가 어긋난다. 레지스트리의 학습 답은 처리방침을 따른다.
- 보관 다섯 칸: `NOT_SPECIFIED`. "필요한 동안"은 일수가 아니다.
- 제3자 상업 이용 제한: 금지되지 않음. 처리방침이 판매·광고 금지를 말하지 않는다.
- 근거: https://platform.kimi.ai/docs/agreement/userprivacy (Last Update: April 30, 2025). 행 상태는 `proven`이고 고지 표에 오른다. 학습이 참인 것도 그 표의 칸이다.

학습이 참이라는 것과 싱가포르 저장은 표에서 서로 다른 칸이다. 트래픽을 끊거나 다른 호스트로 옮기지 않는다.

### minimax

Ready이다. Account에 학습 스위치는 없었다. 소유자가 처리방침 문장을 학습 아니오와 판매·광고 금지로 함께 확정했다.

- 수신 법인·국가: Nanonoble Pte. Ltd., SG. 근거는 유료 서비스 약관.
- 저장·처리 지리: `NOT_SPECIFIED`. 미국 데이터센터 문장과 싱가포르 밖 이전 제한 문장을 한 나라로 합치지 않는다.
- 학습: 아니오. 처리방침은 입력 개인정보로 개인의 특성을 추론하지 않고, 소비자를 프로파일하거나 타깃하는 학습에 쓰지 않는다고 적는다. 소유자가 이 문장으로 학습도 아니오라고 확정했다.
- 보관 다섯 칸: `NOT_SPECIFIED`.
- 제3자 상업 이용 제한: 금지. 같은 문장이다.
- 근거: https://platform.minimax.io/protocol/privacy-policy , https://platform.minimax.io/protocol/paid-agreement . 행 상태는 `proven`이고, 나머지 행과 함께 고지 표에 오른다.

### qwen

- 수신 법인·국가: 미확인. FAQ는 Alibaba Cloud Model Studio라고만 한다.
- 저장 지리: 미확인. 국제 사이트는 싱가포르, 미국 버지니아, 중국 베이징 콘솔을 지역마다 활성화한다고 한다. 코드 호스트는 `dashscope-intl.aliyuncs.com`이다. 그 호스트가 어느 콘솔 지역인지는 문서가 이 FAQ에서 대응하지 않는다. 콘솔에서 활성화한 지역을 확인해야 한다.
- 처리 지리: 미확인.
- 학습: FAQ는 모델 학습에 고객 데이터를 쓰지 않는다고 한다. 저장은 한다고 하고, 자세한 처리는 국제 사이트 제품 약관으로 보낸다. 그 약관 본문은 이번 읽기에 없다.
- 보관 content: 모델·애플리케이션 호출로 생긴 데이터를 저장한다고 한다. 일수 없음. Experience Center의 대화 100개는 콘솔 화면의 역사이며 API 보관과 같다고 적지 않는다.
- safetyLogs, inMemoryCache, persistentFeatureState, systemMetadata: 미확인.
- 제3자 상업 이용 제한: 미확인.
- 근거: https://www.alibabacloud.com/help/en/model-studio/faq-about-alibaba-cloud-model-studio (Last Updated: Sep 23, 2026). 하위처리자 목록은 이번 읽기에 없다.

### zhipu

- 수신 법인: JINGSHENG HENGXING TECHNOLOGY PTE.LTD. API는 이 회사와 계열사가 처리자이고 고객이 컨트롤러라고 DPA가 말한다.
- 수신 국가: 등록 주소는 10 Anson Road, #26-03, International Plaza, Singapore. 개인 이용자용 방침의 컨트롤러 주소이다. API DPA도 같은 회사를 당사자로 둔다.
- 저장 지리: 미확인.
- 처리 지리: API DPA는 서비스를 일반적으로 싱가포르에서 제공하고 고객 데이터도 일반적으로 싱가포르에서 처리한다고 한다. "일반적으로"이므로 배타적 목록이 아니다.
- 학습: API DPA에서 모델 학습 문장을 찾지 못했다. 개인 이용자용 방침의 학습 문장은 그 방침이 API 고객에게 적용되지 않는다고 하므로 API 행에 쓰지 않는다. 학습 칸은 미확인.
- 보관 content: API DPA 4(b)는 고객 또는 최종 사용자가 제공하거나 생성한 콘텐츠를 서버에 저장하지 않고 실시간 처리한다고 한다.
- safetyLogs, inMemoryCache, persistentFeatureState: 미확인.
- systemMetadata: DPA 4(c)는 4(b) 밖의 고객 데이터를 서비스 제공이나 법령 준수를 위해 임시 저장하고, 약관 종료 뒤 삭제한다고 한다. 일수 없음.
- 제3자 상업 이용 제한: 미확인.
- 근거: https://docs.z.ai/legal-agreement/privacy-policy (Last Update: September 29, 2025, 개인 방침과 API DPA가 한 문서에 있다). 하위처리자 목록은 이번 읽기에 없다.

### perplexity

- 수신 법인: Perplexity AI, Inc. API 약관이 계약 당사자로 적는다. 등기 주(州)는 그 문장에 없다.
- 수신 국가: 미확인.
- 저장 지리: 미확인.
- 처리 지리: FAQ는 컴퓨팅이 북미의 Amazon Web Services에 있다고 한다. 저장 지리로 옮기지 않는다.
- 학습: API 약관 2.3.3은 고객 콘텐츠를 생성 모델의 학습, 재학습, 미세조정, 그 밖의 개선에 쓰거나 제3자에게 허락하지 않는다고 한다. 개인정보 안내는 Chat Completions API 데이터를 모델 학습에 쓰지 않는다고 한다.
- 보관 content: 개인정보 안내는 Chat Completions API에 대해 Zero Data Retention이고, 그 즉시 요청을 처리하는 것 외의 목적으로 고객 데이터를 쓰지 않는다고 한다. FAQ는 사용자 프롬프트를 0일 보관하고 학습에 쓰지 않는다고 한다. DPA 10은 서비스 종료 후 30일 내 개인정보 삭제를 말한다. 두 문서의 관계가 즉시 삭제인지 계정 개인정보의 30일인지 이 초안이 합치지 않는다.
- safetyLogs: 미확인.
- inMemoryCache: 미확인.
- persistentFeatureState: 미확인.
- systemMetadata: 개인정보 안내는 토큰 수, 모델, 시각, API 키 식별만 청구 메타데이터로 모으고 프롬프트 내용은 넣지 않는다고 한다. 보관 일수는 미확인.
- 제3자 상업 이용 제한: DPA 5는 개인정보 법령이 요구하는 범위에서 판매·공유 금지, 직접 사업 관계 밖 사용 금지, 다른 출처의 개인정보와 결합 금지를 말한다.
- 근거: https://docs.perplexity.ai/docs/resources/privacy-security , https://docs.perplexity.ai/docs/resources/faq , https://www.perplexity.ai/hub/legal/perplexity-api-terms-of-service , https://www.perplexity.ai/hub/legal/dpa . 하위처리자 목록은 이번 읽기에 없다.

### deepinfra

- 수신 법인·국가: 미확인. 데이터 안내 페이지는 법인을 적지 않는다. `stage.deepinfra.com`의 약관은 근거로 쓰지 않는다.
- 저장 지리: 미확인. 안내 페이지는 추론 중 메모리에만 있고 디스크에 쓰지 않는다고 한다. 나라 이름은 없다.
- 처리 지리: 미확인.
- 학습: API에 제출한 데이터로 모델을 학습하지 않는다고 한다. 예외는 Google 또는 Anthropic 모델을 고른 경우이고, 그때는 그 회사의 정책이 적용된다고 한다. 코드의 deepinfra 행이 그 예외 모델을 부르는지 이 초안이 단정하지 않는다.
- 보관 content: 추론이 끝나면 메모리에서 지운다고 한다. 이미지 생성 출력은 잠시 저장한다. 벌크 추론은 디스크에 암호화해 잠시 둘 수 있고, 그 뒤 지운다고 한다. 일수 없음.
- safetyLogs: 요청 내용은 로그하지 않고 요청 ID, 비용, 샘플링 파라미터만 로그한다고 한다.
- inMemoryCache: 추론 동안의 메모리가 이 칸에 해당한다고 읽힐 수 있으나, 문서가 그 이름으로 부르지는 않는다. 칸 이름은 미확인으로 둔다.
- persistentFeatureState, systemMetadata: 미확인.
- 제3자 상업 이용 제한: Google·Anthropic 모델을 제외하면 제3자와 공유하지 않는다고 한다. 판매 금지의 계약 문장은 프로덕션 약관에서 아직 읽지 못했다.
- 근거: https://docs.deepinfra.com/account/data-privacy . 프로덕션 약관과 하위처리자 목록은 이번 읽기에 없다.

### together

Ready. 2026-09-28 소유자 화면.

- 수신 법인·국가: Together Computer, Inc., US.
- 저장·처리 지리: `NOT_SPECIFIED`.
- 학습: 아니오. 조직 Privacy의 "Allow my organization's data to be used for training models"가 No였다.
- 프롬프트 저장과 제3자 passthrough도 No였다. 저장을 끄면 passthrough도 꺼진다고 그 화면이 적는다.
- 보관 content·persistentFeatureState: `CUSTOMER_CONTROLLED`. 나머지는 `NOT_SPECIFIED`.
- ZDR: 개인정보 처리방침은 프롬프트 저장과 학습을 No로 두면 Zero Data Retention이고, 그 내용은 서비스 제공에 필요한 범위를 넘는 2차 목적에 쓰지 않는다고 한다.
- 제3자 상업 이용 제한: 금지. 같은 문장이다. 화면에도 제3자와 공유하지 않는다고 적혀 있고, passthrough는 No이다.
- 근거: https://www.together.ai/privacy , https://www.together.ai/terms-of-service

### openrouter

이 행만 OpenRouter 자신의 문서를 근거로 한다. 다른 공급자 행의 근거가 아니다.

- 수신 법인: OpenRouter, Inc.
- 수신 국가: 미확인. 분쟁 준거법은 뉴욕주법이다. 그것은 저장 국가가 아니다.
- 저장·처리 지리: 미확인. 입력은 선택한 모델 공급자에게 전달된다. 그 공급자의 지리는 그 공급자 행의 문제이고, 이 행이 대신 확정하지 않는다.
- 학습: OpenRouter 자신은 입력·출력을 모델 학습에 쓰지 않는다고 한다. 선택한 모델 공급자는 쓸 수 있다고 같은 문장이 말한다. 학습하지 않는다고 표시된 모델을 고르라고 안내한다.
- 보관 content: 이미지·음성·영상 입력은 요청을 라우팅하는 데 필요한 시간을 넘어 유지하지 않는다고 한다. 예외는 남용 탐지, 보안, 청구, 법령이다. 일수 없음. Files API로 올린 파일은 이용자가 지우거나 계정을 닫을 때까지 보관한다.
- safetyLogs: 남용 탐지 예외가 있으나 일수는 없다.
- inMemoryCache, persistentFeatureState: 미확인.
- systemMetadata: 개인정보는 사업·법적 의무에 합리적으로 필요한 동안. 일수 없음.
- 제3자 상업 이용 제한: 자신의 개인정보를 법령상 "sell"하지 않는다고 한다. 모델 공급자의 독립적 이용은 그 공급자 약관이 정하고, OpenRouter는 학습을 허용하는 공급자에게 보낸 뒤 그 학습을 통제하지 못한다고 한다.
- 근거: https://openrouter.ai/privacy . DPA와 하위처리자 목록 본문은 이번 읽기에 없다.

### sail

- 수신 법인: Sail Research Co., Delaware corporation. 약관이 그렇게 적는다.
- 수신 국가: 미국(델라웨어 법인). 저장 국가로 옮기지 않는다.
- 저장 지리: DPA는 고객 데이터를 Amazon S3에 임시 저장한다고 한다. 버킷의 리전은 적지 않는다. 고객 소유 버킷을 고를 수 있다고 한다. 우리 계정이 그 옵션인지는 콘솔.
- 처리 지리: 그 밖의 처리는 작업 동안 메모리에서만 한다고 한다. 나라 이름은 없다.
- 학습: 약관과 DPA 모두, 고객의 명시적 서면 동의 또는 고객이 지시한 자기 모델 미세조정을 제외하면 고객 데이터로 모델을 학습·미세조정·개선하지 않는다고 한다. DPA는 그 금지를 모델 공급자 하위처리자에게도 계약으로 확장한다고 한다.
- 보관 content: DPA는 48시간을 넘기지 않는다고 한다. 예외는 법령, 분쟁 해결, 그리고 Sail 또는 하위처리자의 표준 정책에 따른 보유이다. 세 번째 예외의 일수는 없다. 약관은 응답 저장을 끌 수 없다고 한다. `store: false`는 호환 필드일 뿐 그 임시 저장을 바꾸지 않는다고 지원 문서가 말한다.
- safetyLogs: 미확인.
- inMemoryCache: 작업 동안의 메모리 처리가 DPA 8.2에 있다. 만료 시간은 작업 종료이다.
- persistentFeatureState: 미확인.
- systemMetadata: 미확인. 집계·비식별 사용 데이터는 모델을 학습하지 않는 한 서비스 개선에 쓸 수 있다고 약관이 말한다.
- 제3자 상업 이용 제한: DPA는 CCPA상 판매·공유 금지, 문서화된 지시 밖 보유·이용·공개 금지, 직접 사업 관계 밖 사용 금지, 다른 출처와의 결합 금지를 말한다.
- 하위처리자 목록: https://trust.sailresearch.com/?tab=subprocessors 를 DPA가 가리킨다. 목록 본문은 이번 읽기에 없다.
- 근거: https://sailresearch.com/terms , https://docs.sailresearch.com/dpa

## 소유자가 콘솔에서 확인할 것

이 칸은 공개 문서가 계정 설정에 답을 맡겨 둔 것이다. 이 초안은 값을 지어 넣지 않는다.

1. OpenAI: 프로젝트의 data residency 리전, ZDR 또는 Modified Abuse Monitoring 승인 여부, 학습 opt-in이 꺼져 있는지.
2. Anthropic: 그 API 조직의 ZDR이 켜져 있는지.
3. Google: API 키가 속한 Cloud 프로젝트에 활성 결제가 연결되어 있는지. 연결되어 있지 않으면 읽은 약관은 무상 서비스로 내용을 제품과 머신러닝 개발에 쓴다.
4. Groq: Data Controls의 ZDR.
5. xAI: 팀의 Zero Data Retention. 코드는 미국 리전 호스트를 쓰지 않는다.
6. Mistral: API Privacy의 학습 opt-out과 ZDR 승인.
7. Together: 조직의 프롬프트 저장, 학습 허용, passthrough 허용.
8. DeepSeek: API 계정에 "Improve the model for everyone"이 있는지, 있다면 꺼져 있는지.
9. Qwen: `dashscope-intl` 키가 활성화된 Model Studio 지역.

## 고지에 아직 넣지 않는 이유

열여섯 행이 모두 검토된 것은 아니다. 일부를 고지에 적으면 빠진 공급자가 고지에서 빠진다. 페이지에 올린 것은 Tomverse가 통제하는 사실뿐이다. 법인, 국가, 보관 기간은 사람이 각 행을 `proven`으로 승인하기 전에는 페이지에 없다.

Moonshot의 학습 답은 참이고, 싱가포르 저장과 별개다. 그 답만으로 트래픽을 끊거나 호스트를 옮기지 않는다. Google의 무상 모드와 DeepSeek 약관 4.3도 콘솔 확인이 끝나기 전의 표시이며, 트래픽을 끊거나 호스트를 옮기라는 결정이 아니다.
