# B-5 기록 — DPA 편입 근거 (2026-09-10)

`docs/policy/voice-input.md` §11.3.2-3이 **확인되지 않은 것**으로 적어 둔 "DPA
체결 여부와 체결 방법"에 대한 기록입니다.

**이 초안은 에이전트가 썼습니다.** 아래 원문 인용은 **Claude Code가 읽은 것이
아닙니다** — 출처를 §2에 밝힙니다. **판정과 서명은 사람이 채웁니다.**

- **기록일(UTC)**: 2026-09-10
- **상태**: **검증됨 — 운영자 확인·서명 대기**

---

## 1. 이 저장소는 원문을 읽지 못합니다

`openai.com/policies/data-processing-addendum/`와
`openai.com/policies/services-agreement/`는 이 컨테이너의 egress 프록시에서
**HTTP 403**입니다. 2026-09-10에 `WebFetch`로 두 URL을 다시 시도해 같은 결과를
확인했습니다. §11.3.2-3이 기록한 차단이 그대로입니다.

**그래서 §11.3.2-3은 "검색 요약을 근거로 확정하지 않는다"고 적었고, 이 기록도
그 규칙을 지킵니다** — 아래는 요약이 아니라 원문을 연 다른 주체의 보고입니다.

## 2. 출처 — 누가 무엇을 읽었는가

**Codex가 두 공식 페이지의 본문을 직접 열어 검증했습니다**(2026-09-10). 검색
결과 요약이 아니라 게시된 계약 본문입니다. 게시본은 2025-12-01 갱신,
**2026-01-01 시행**입니다.

- https://openai.com/policies/services-agreement/
- https://openai.com/policies/data-processing-addendum/

**Claude Code는 이 인용을 대조하지 못했습니다.** 사람이나 다른 도구가 원문을
읽은 것은 에이전트의 fetch보다 나은 출처이지만, **기록에는 누가 읽었는지가 적혀
있어야** 나중에 그 출처를 다시 물을 수 있습니다.

## 3. 원문에서 확인된 것

1. Services Agreement는 **OpenAI API를 사용하는 기업·개발자에게 적용**된다고
   명시합니다.
2. **§5.3 Privacy**: *"OpenAI and Customer will comply with the DPA, which is
   incorporated by this reference into the Agreement."*
3. DPA 서문도 해당 DPA가 Services Agreement를 **보충하며 그 계약에 편입**된다고
   명시합니다.
4. DPA 서문이 밝히는 동의 방식: 온라인 "I agree" 동의, Order Form 수락,
   **Services 이용**.
5. **DPA §1.1**: OpenAI가 Customer Data를 고객을 대신해 처리하는 경우 OpenAI가
   **Data Processor** 역할을 하며 그 처리를 DPA가 규율합니다.
6. 공개된 표준 계약에는 DPA 적용의 선행 조건으로 **별도 project 생성, 신규 API
   key 발급, ZDR 자격 심사·승인, 별도 DPA 신청 절차** 중 어느 것도 없습니다.

## 4. 판정 (전제 포함)

Tomverse 운영 주체가 **별도 협상 계약·reseller 계약·상충하는 Order Form 없이**
표준 온라인 Services Agreement에 따라 OpenAI API를 직접 이용하며, 그 계정의 계약
당사자로서 동의할 권한이 있다는 전제에서:

- 개인정보 처리에 관한 **DPA는 §5.3의 참조를 통해 Agreement에 편입**됩니다.
- **신규 project·API key 생성은 DPA 편입 요건이 아닙니다.**
- **ZDR은 DPA와 별개**의 선택적·승인형 데이터 보존 제어입니다.
- 따라서 **ZDR 미승인이나 전용 project/key 미생성만으로 "DPA가 적용되지
  않는다"고 판정해서는 안 됩니다.**

## 5. 이 검증이 증명하지 않는 것

공개된 표준 계약 문구의 **존재와 의미**를 확인한 것이며, 다음은 외부에서 증명되지
않습니다.

- Tomverse 계정의 실제 계약 당사자 명칭
- 별도 Order Form 또는 협상 계약의 존재 여부
- reseller를 통한 구매 여부
- 운영 주체가 특정 관할 법률에 따라 추가 문서를 체결해야 하는지 여부

**§4의 판정은 그 전제 위에서만 성립합니다.** 전제가 틀리면 판정도 틀립니다.

## 6. 이 기록이 다루지 않는 것

**처리 지역**(§11.3.2-3의 나머지 절반). DPA 편입과 별개 질문이며 여기서 답하지
않습니다. 개인정보처리방침의 제3자 전송·국외 처리 고지도 함께 남습니다.

---

## 운영자 확인 (사람이 채웁니다)

아래 문장을 확인하고 서명하면 B-5의 DPA 항목은 **"표준 Services Agreement에 참조
편입됨 — 별도 DPA 신청 불필요"**로 기록됩니다.

> Tomverse의 OpenAI API 계정은 별도의 상충 계약이나 reseller 계약 없이 표준
> 온라인 Services Agreement에 따라 직접 사용되며, 운영자는 해당 계약 당사자를
> 구속할 권한을 갖는다.

- **확인**:
- **서명**:
- **일자(UTC)**:
