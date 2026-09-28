# 채팅 공급자 수신지 공개문서 초안 (2026-09-28)

이 문서는 초안이다. 어느 행도 `proven`이 아니고, `approvedBy`와 `approvedAt`은 비어 있다. 판정과 서명은 소유자와 법무가 한다. 이 파일을 근거로 `lib/providerDataDestinations.ts`의 상태를 바꾸지 않았고, 개인정보 처리방침에도 공급자 표를 올리지 않았다.

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

- 수신 법인·국가: 미확인. 추가 약관은 유료 서비스의 "Google"을 다른 페이지의 정의로 보낸다. 그 정의를 이번 읽기에서 열지 않았다.
- 저장·처리 지리: 유료 서비스 조항은 프롬프트와 응답이 Google 또는 그 대리인이 시설을 둔 어느 나라에서든 일시 저장되거나 캐시될 수 있다고 한다. 나라 목록은 없다. 모드(유료/무료)는 콘솔.
- 학습: 모드에 따라 갈린다. 무료 서비스(AI Studio, Gemini API 무상 할당량)는 제출한 내용과 생성 응답을 제품과 머신러닝 기술을 제공·개선·개발하는 데 쓴다. 유료 서비스(활성 Cloud Billing이 연결된 프로젝트로 API를 부르는 경우)는 프롬프트와 응답을 제품 개선에 쓰지 않는다고 한다. 우리 키의 프로젝트가 어느 쪽인지는 콘솔에서만 알 수 있다. 확인 전에는 학습 여부를 예도 아니오도 적지 않는다.
- 보관 content: 유료는 금지 사용 정책 위반 탐지를 위해 제한된 기간 로그한다고만 하고, 이 페이지에는 일수가 없다. Grounding with Google Search는 별도 보관이 있다. 로그 정책 페이지는 결제 프로젝트가 소유한 로그의 기본 최대 55일을 말한다. 그것이 abuse 로그와 같은 것인지는 이 초안이 합치지 않는다.
- safetyLogs, inMemoryCache, persistentFeatureState, systemMetadata: 유료 조항은 계정, 결제, 사용량, IP 주소 등이 컨트롤러 간 약관과 Google 개인정보 처리방침의 대상이라고 한다. 다섯 칸으로 나누어 일수를 확정하지 못했다.
- 제3자 상업 이용 제한: 미확인. DPA 원문은 이번 읽기에 없다.
- 근거: https://ai.google.dev/gemini-api/terms (Effective March 23, 2026), https://ai.google.dev/gemini-api/docs/logs-policy (로그 55일은 이 페이지). 코드 호스트는 Gemini Developer API이다.

교체 전에 볼 것: 키가 무상 할당량이면, 읽은 약관은 그 내용을 제품과 머신러닝 개발에 쓴다고 한다. 그 확인이 나오기 전에는 공급자 표를 고지에 넣지 않는다. 트래픽을 끊거나 옮기는 결정은 이 초안이 하지 않는다.

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

- 수신 법인: 개인정보 처리방침의 컨트롤러는 Hangzhou DeepSeek Artificial Intelligence Co., Ltd.이고 등록 주소는 중국이다. 같은 방침은 오픈 플랫폼으로 만든 하위 앱의 최종 사용자 개인정보 처리를 이 방침의 범위 밖으로 둔다. API로 받는 우리 이용자의 수신자가 그 법인인지는 그래서 확정이 아니다.
- 수신 국가: 약관의 준거법은 중국 본토법이고, 관할은 그 회사 등록 사무소 소재지 법원이다. 저장 지리와는 별개다.
- 저장·처리 지리: 미확인.
- 학습: 확정하지 않는다. 이용약관 4.3은 암호화와 비식별을 전제로 입력과 출력을 서비스 또는 기반 기술을 제공·유지·운영·개발·개선하는 데 최소한으로 쓸 수 있고, "Improve the model for everyone"을 끄면 거부할 수 있다고 한다. 그 스위치가 API 계정에 있는지는 콘솔에서 봐야 한다. 개인정보 처리방침의 학습 문장을 API 고객 콘텐츠에 그대로 적용하지 않는다.
- 보관 다섯 칸: 미확인.
- 제3자 상업 이용 제한: 미확인.
- 근거: https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html , https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html (Last Update: Feb 10, 2026). 하위처리자 목록은 이번 읽기에 없다.

이 초안은 DeepSeek를 "학습에 사용"으로 확인하지 않는다. 트래픽을 끊거나 다른 호스트로 옮기지 않는다.

### mistral

- 수신 법인·국가: 미확인. DPA 원문은 이번 읽기에 없다.
- 저장·처리 지리: 미확인.
- 학습: ZDR 문서가 학습 opt-out을 ZDR과 다른 컨트롤로 둔다. 기본이 opt-out인지 opt-in인지는 그 페이지가 말하지 않는다. 도움말 센터 요약은 API용 토글이 따로 있다고 하나, 그 페이지 전문을 이번 읽기의 근거로 확정하지 않는다. 콘솔의 Privacy 설정이 답이다.
- 보관 content: ZDR이 켜지면 지원되는 무상태 호출의 입력·출력을 응답 생성에 필요한 시간보다 오래 저장하거나 로그하지 않는다고 한다. ZDR은 유료 플랜에서 신청하고 승인을 받는다. 우리 조직의 승인 여부는 콘솔. 기본 보관 일수는 이 페이지에 없다.
- safetyLogs, inMemoryCache, persistentFeatureState, systemMetadata: 미확인. Files, batch, agents는 ZDR 밖이다.
- 제3자 상업 이용 제한: 미확인.
- 근거: https://docs.mistral.ai/admin/monitor-comply/zero-data-retention

### moonshot

- 수신 법인·국가: 미확인. 도움말 페이지는 법인을 적지 않는다.
- 저장·처리 지리: 미확인.
- 학습: 도움말 페이지는 API로 제출한 입력과 출력을 Kimi 모델 학습이나 개선에 쓰지 않는다고 한다. 처리가 끝나면 학습을 위해 영구 저장하지 않는다고 한다. 이용약관 전문을 같은 날에 대조하지 못했다. 그래서 이 칸은 초안이지 확정이 아니다.
- 보관 content: 그 문장은 학습 목적의 영구 저장을 부인한다. 안전 검토, 파일, 그 밖의 보관 일수는 그 페이지에 없다. 파일은 콘솔에서 지울 수 있다고 한다.
- safetyLogs: 콘텐츠 안전 검토는 원문을 저장하거나 공개하지 않는다고 한다. 로그 메타데이터의 보관은 미확인.
- inMemoryCache, persistentFeatureState, systemMetadata: 미확인.
- 제3자 상업 이용 제한: 미확인. DPA와 하위처리자 목록은 이번 읽기에 없다.
- 근거: https://www.kimi.com/en/help/kimi-api/api-data-security

도움말 페이지는 "학습에 사용"이 아니다. 약관과 어긋나는지는 아직 모른다. 확인되기 전에는 트래픽을 끊거나 DeepInfra로 옮기지 않는다.

### minimax

- 수신 법인: API 개인정보 처리방침은 Nanonoble Pte. Ltd.를 컨트롤러로 적고, 주소는 152 Beach Road, #14-02 Gateway East, Singapore (189721)이다.
- 수신 국가: 싱가포르(등록 주소). 저장 지리와는 별개다.
- 저장·처리 지리: EEA 등 보충 조항은 데이터를 Cloud의 미국 데이터센터에 국외 저장하고 EU-US Privacy Framework 인증을 언급한다. 싱가포르 조항은 일반적으로 싱가포르 밖으로 옮기지 않는다고도 한다. 두 문장이 같은 처리 모드를 말하는지 이 초안이 합치지 않는다. 모드 미확인.
- 학습: "개인 데이터를 개인에 대한 특성을 추론하는 데 쓰지 않고, 소비자를 프로파일하거나 타깃하는 학습에 쓰지 않는다"고 한다. 모델 학습 전반의 금지는 그 문장보다 좁다. 모델 학습 여부는 미확인.
- 보관 다섯 칸: 목적에 필요하거나 법이 허용하는 동안. 일수 없음.
- 제3자 상업 이용 제한: 미확인. 서비스 제공자는 계약으로 제공 목적 밖 보유·이용·공개가 금지된다고 한다. 그것이 독립적 상업 이용 금지의 전부인지 미확인.
- 근거: https://platform.minimax.io/protocol/privacy-policy . API 개요의 "stateless" 문장은 기술 설명이라 이 행의 보관 근거로 쓰지 않는다. 하위처리자 목록은 이번 읽기에 없다.

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

- 수신 법인: Together Computer, Inc.
- 수신 국가: 미확인. 캘리포니아 고지 문장이 있으나 본점 주소로 읽지 않는다.
- 저장·처리 지리: 미확인. 문서의 프라이버시 페이지는 기업 고객의 리전과 VPC를 별도 계약으로 둔다. 우리 계정이 그 계약인지는 콘솔.
- 학습: 명시적 opt-in 없이는 수집한 데이터로 모델을 학습하지 않는다고 개인정보 처리방침이 말한다. 조직 설정의 "Allow organization's data for training"은 opt-in이고 기본이 아니라고 개발자 문서가 말한다. 우리 조직 토글은 콘솔.
- 보관 content: 개발자 문서는 입력·출력을 기본으로 저장하지 않는다고 한다. 개인정보 처리방침의 ZDR은 설정에서 프롬프트 저장과 학습을 "No"로 두는 것이고, 그 전 데이터에는 소급하지 않는다고 약관이 말한다. 기본이 이미 ZDR인지, 토글을 켜야 ZDR인지는 두 문서의 문장이 같다. 우리 조직 설정은 콘솔.
- safetyLogs, inMemoryCache, persistentFeatureState, systemMetadata: 미확인. Usage Data는 콘텐츠를 제외한 운영 데이터로 서비스를 개선할 수 있다고 약관이 말한다.
- 제3자 상업 이용 제한: 미확인. Passthrough 모델을 허용하면 프롬프트가 제3 공급자에게 가고 그 공급자 정책이 적용된다고 한다. 그 토글은 콘솔.
- 근거: https://www.together.ai/privacy , https://www.together.ai/terms-of-service , https://docs.together.ai/docs/privacy-and-security . 하위처리자 목록은 이번 읽기에 없다.

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

받아들일 수 없는 답이 확정된 공급자는 없다. Google의 무상 모드와 DeepSeek 약관 4.3은 콘솔 확인이 끝나기 전에 표를 올리지 말라는 표시이지, 트래픽을 끊거나 호스트를 옮기라는 결정이 아니다.
