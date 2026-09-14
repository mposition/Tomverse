# 제품 업데이트 이메일 캠페인 운영

## 목적과 현재 상태

Tomverse의 제품 업데이트 뉴스레터는 Admin Console의 `Email > Campaigns`에서
작성·미리보기·승인·테스트·발송합니다. 운영자가 매번 HTML을 디자인하지 않습니다.
`product_announcement` 템플릿이 레이아웃과 텍스트 대체본을 만들고, 운영자는
한국어·영어 구조화 콘텐츠만 편집합니다. 포스터, 포스터 대체 텍스트와 라벨도
같은 콘텐츠에 포함되며, 주소는 HTTPS Tomverse 도메인만 허용됩니다.

이 기능을 배포하는 것과 고객에게 발송할 수 있게 하는 것은 별개입니다. 다음 두
AppSetting이 기본적으로 꺼져 있으며, production 발송 identity·법적 사업자 정보·
관할권 정책·unsubscribe key·도메인 준비 상태도 기존 이메일 gate를 모두
통과해야 합니다.

- `feature.emailCampaignsEnabled`: 캠페인 생성·승인·wave 실행
- `feature.emailMarketingEnabled`: 마케팅 enqueue·fan-out·실제 전송

flag가 꺼져 있어도 작성 화면과 서버 미리보기는 사용할 수 있습니다. 캠페인 생성과
테스트 발송은 거절됩니다. 이 문서는 flag 활성화를 승인하지 않습니다.

## 첫 뉴스레터 기본 문안

작성 화면은 `나의 AI 어시스턴트 + Knowledge` 한국어·영어 문안으로 시작합니다.
다음 제품 경계만 설명합니다.

- 이름·지시문·기본 모델로 개인 AI 어시스턴트를 설정한다.
- Knowledge 파일의 관련 발췌가 답변의 참고 자료로 사용될 수 있다.
- AI 어시스턴트와 Knowledge는 계정 전용이며 공개 목록이나 다른 사용자에게
  공유되지 않는다.

첫 문안의 기능 카드는 소개 문구가 아니라 실제 사용 순서입니다.

1. 이름과 지시문으로 어시스턴트를 만든다.
2. Knowledge 파일을 추가·선택하고 변경사항을 저장한다.
3. 대화 도구의 AI 어시스턴트 메뉴에서 선택한다.

메일은 클라이언트 호환성을 위해 영상을 직접 삽입하지 않습니다. 정적 포스터와
3단계 텍스트를 보여주고, 단일 CTA로 Tomverse의
`/guides/assistant-knowledge` 인터랙티브 안내에 연결합니다. 이 안내는 로그인 전에도
볼 수 있고, 로그인 후에는 실제 생성 화면으로 이어집니다. 생성 성공, Knowledge가
포함된 버전 저장, 대화 이동을 실제 저장 결과로 판정하므로 URL만 다시 열어도 완료된
단계 다음부터 이어집니다.

CTA와 포스터는 HTTPS `tomverse.app` 또는 그 하위 도메인만 허용합니다. 외부
URL이나 `javascript:` URL은 초안 생성 전에 거절됩니다.

## 권장 운영 순서

1. `Email > Campaigns`에서 한국어와 영어의 제목, preheader, headline, 본문,
   포스터 정보, 사용 단계 카드, CTA를 편집합니다.
2. `미리보기 갱신`으로 서버의 실제 템플릿 렌더링 결과와 텍스트 대체본을 모두
   읽습니다. 화면의 copy digest는 이 렌더링 결과에 대한 값입니다.
3. 캠페인 기능 flag가 켜진 환경에서 `초안 만들기`를 누릅니다. 초안과 수동
   `launch` wave 하나가 같은 DB 작업으로 만들어집니다.
4. 캠페인 상세에서 대상 규모를 측정합니다. 대상은
   `product_updates`에 현재 `enabled=true`이고 `grantedAt`이 기록된 활성 계정뿐이며,
   주소가 없는 계정은 원장에 `no_email`로 남습니다.
5. `나에게 테스트 발송`을 실행합니다. 테스트도 우회 전송이 아니라 실제 마케팅
   큐를 사용하므로 현재 관리자 계정의 동의, suppression, 관할권, unsubscribe,
   sending identity gate를 모두 통과해야 합니다.
6. 모든 언어의 HTML·텍스트와 copy digest를 다시 읽고 승인 사유를 작성합니다.
   2인 승인 또는 저장소가 허용한 1인 조직 예외를 거쳐 승인합니다. 요청이 본
   digest와 서버의 현재 digest가 다르면 승인은 거절됩니다.
7. 승인 뒤 `launch` wave를 수동 시작합니다. wave는 승인된 locale payload를
   이벤트에 담고, 각 수신자의 언어에 맞는 payload 하나만 암호화된 delivery
   snapshot에 저장합니다. 지원하지 않는 언어는 승인된 영어, 그다음 승인 목록의
   첫 언어로만 fallback합니다.
8. wave 원장과 delivery 상태로 포함·제외·발송 결과를 확인합니다. 발송 시점에
   동의, suppression, marketing kill switch, 관할권, unsubscribe 구성과 발송
   identity가 다시 검사됩니다.

## 실패 안전 경계

- 대상 spec이 정확히 `marketing_consent/product_updates`가 아니면 consent cohort로
  읽지 않으며, 빈 segment를 전체 사용자로 넓히지 않습니다.
- 선택한 locale의 콘텐츠가 없거나 실제 템플릿으로 렌더링되지 않으면 초안·승인·
  발송이 거절됩니다.
- 승인은 locale별 실제 렌더링 hash를 고정합니다. 승인 후 copy 또는 locale이
  달라지면 wave 실행이 `content_changed` 또는 `locale_not_pinned`으로 거절됩니다.
- 이 필드가 생기기 전에 만든 legacy 캠페인은 `contentByLocale=NULL`입니다. 임의
  문안을 만들어 승인된 것으로 간주하지 않고, 새 캠페인으로 다시 작성해야 합니다.
- 테스트 발송은 현재 관리자 본인 주소에만 만들 수 있고 감사 로그와 rate limit을
  거칩니다.

## 별도 production 준비

코드 병합만으로 production 마케팅 발송은 활성화되지 않습니다. 실제 활성화는 기존
운영 문서의 순서를 따릅니다.

- `docs/ops/email-business-identity.md`: 법적 사업자 identity
- `docs/ops/email-sending-domains.md`: marketing 발송 도메인, DNS와 warm-up
- `docs/policy/email-notifications.md`: 동의·suppression·관할권·승인 정책

위 준비와 staging 검증이 끝난 뒤에만 운영자가 두 feature flag를 결정합니다.
