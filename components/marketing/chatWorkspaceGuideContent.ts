import type { Language } from "@/components/LanguageProvider";

export type WorkspaceGuideItem = {
  term: string;
  detail: string;
};

export type WorkspaceGuideSection = {
  id: string;
  title: string;
  description: string;
  items: WorkspaceGuideItem[];
  note?: string;
};

export type ChatWorkspaceGuideCopy = {
  eyebrow: string;
  title: string;
  description: string;
  updated: string;
  contents: string;
  tourTitle: string;
  tourDescription: string;
  tourItems: WorkspaceGuideItem[];
  sections: WorkspaceGuideSection[];
  reviewVideoTitle: string;
  openChat: string;
  allHelp: string;
  chatIntro: { title: string; description: string; items: WorkspaceGuideItem[] };
};

// Existing section anchors are retained for saved links.
export const chatWorkspaceGuideContent: Record<Language, ChatWorkspaceGuideCopy> = {
  "en": {
    "eyebrow": "Help Centre · Review workspace",
    "title": "Tomverse Review workspace guide",
    "description": "Tomverse Chat is for an ongoing conversation with one model, supported by Smart Adaptive, manual model selection and question-refinement suggestions. This guide covers the Tomverse Review workspace with up to three answer panels and AI Review.",
    "updated": "Guide updated 12 October 2026",
    "contents": "On this page",
    "tourTitle": "1. Tour the chat screen",
    "tourDescription": "Select a number in the workspace map to jump to its explanation. The map mirrors the current sidebar without showing private conversation content.",
    "tourItems": [
      {
        "term": "New chat",
        "detail": "Starts a separate conversation with the currently selected default models."
      },
      {
        "term": "Search conversations",
        "detail": "Searches conversation titles and, for signed-in accounts, matching saved message text."
      },
      {
        "term": "Status filters",
        "detail": "Shows conversations that are Locked or currently have a Shared link."
      },
      {
        "term": "Projects",
        "detail": "Groups account conversations into folders for organization."
      },
      {
        "term": "Conversation menu",
        "detail": "Renames, pins, moves, shares, downloads, locks, or deletes a conversation."
      }
    ],
    "sections": [
      {
        "id": "states-and-labels",
        "title": "2. Conversation states and projects",
        "description": "These controls can appear together, but they describe different things.",
        "items": [
          {
            "term": "Locked",
            "detail": "A protected conversation that requires password verification for protected reads and actions."
          },
          {
            "term": "Shared",
            "detail": "A read-only public snapshot link is currently active."
          },
          {
            "term": "Pinned",
            "detail": "Keeps a conversation at the top of the sidebar. Signed in, it belongs to the account and holds on every device; signed out, it stays in this browser."
          },
          {
            "term": "Project",
            "detail": "An account-backed folder that groups related conversations."
          }
        ],
        "note": "Projects do not make their conversations automatically share content, files, or AI memory."
      },
      {
        "id": "projects",
        "title": "3. Use projects",
        "description": "Create a project, then move conversations into it from each conversation menu.",
        "items": [
          {
            "term": "Create",
            "detail": "Choose New beside Projects, enter a name, and confirm."
          },
          {
            "term": "Rename",
            "detail": "Use the pencil button beside the project name."
          },
          {
            "term": "Move a conversation",
            "detail": "Open the conversation menu, find Move to project, and select a project."
          },
          {
            "term": "Remove from a project",
            "detail": "Open the same menu and choose Remove from project."
          },
          {
            "term": "Delete a project",
            "detail": "Confirm the project delete action. Its conversations remain in the account and become uncategorized."
          },
          {
            "term": "Context boundary",
            "detail": "A project is a folder, not a shared prompt, file library, or cross-chat memory."
          }
        ]
      },
      {
        "id": "lock-and-share",
        "title": "4. Locking and sharing",
        "description": "Locking protects saved-chat actions; sharing publishes a bounded read-only snapshot.",
        "items": [
          {
            "term": "Lock",
            "detail": "Set a conversation password from its menu. Opening, sharing, downloading, editing, and other protected actions require verification."
          },
          {
            "term": "Unlock",
            "detail": "Choose Unlock and enter the conversation password. Repeated incorrect attempts may be rate-limited."
          },
          {
            "term": "Forgotten password",
            "detail": "Tomverse cannot display or recover the original password. Keep it safely and contact support for available account-data options."
          },
          {
            "term": "Not encryption",
            "detail": "A lock is an access control. It does not stop the selected AI provider from receiving prompts and necessary context during generation."
          },
          {
            "term": "Share",
            "detail": "Anyone with the active link can read the snapshot until it expires or is revoked. Do not share sensitive content."
          },
          {
            "term": "Refresh or revoke",
            "detail": "Refresh Share to create a new snapshot and link. Revoke Share disables the current public link."
          }
        ],
        "note": "Messages added after sharing are not automatically added to the existing snapshot."
      },
      {
        "id": "models-and-panels",
        "title": "5. AI models and answer panels",
        "description": "Choose one model for a focused answer or up to three for side-by-side comparison.",
        "items": [
          {
            "term": "Select models",
            "detail": "Open the model picker before sending and review each model's usage class and estimated base credits."
          },
          {
            "term": "Active model",
            "detail": "Only enabled panels receive the next shared prompt."
          },
          {
            "term": "Model-only follow-up",
            "detail": "Use a response panel's follow-up control when the next question should go only to that model."
          },
          {
            "term": "Pause a panel",
            "detail": "Switch a panel off temporarily without removing it from the conversation."
          },
          {
            "term": "Close a panel",
            "detail": "Remove that model panel from the current comparison after confirmation."
          },
          {
            "term": "Limited or unavailable",
            "detail": "Open the model status reason and use a recommended fallback if a provider is temporarily limited."
          },
          {
            "term": "Credit estimate",
            "detail": "The amount before sending estimates the selected models’ base credits. Final usage can differ after processing files and long conversation history."
          }
        ]
      },
      {
        "id": "ai-review",
        "title": "6. Use AI Review",
        "description": "After two or three model answers complete, open AI Review, choose a review mode, check the estimated credits, and run the review.",
        "items": [
          {
            "term": "Balanced",
            "detail": "Organizes agreements, important differences, omissions, contradictions, and practical usefulness."
          },
          {
            "term": "Evidence-focused",
            "detail": "Emphasizes weak support, conflicts, and claims that require outside verification."
          },
          {
            "term": "Action-focused",
            "detail": "Emphasizes options, trade-offs, risks, and next actions."
          },
          {
            "term": "Output",
            "detail": "Review the consensus, differences, contradictions, missing points, and verification-needed sections."
          }
        ],
        "note": "AI Review compares only the supplied answers. It does not browse the web, independently fact-check claims, or guarantee a correct answer."
      },
      {
        "id": "files-and-drive",
        "title": "7. Files and Google Drive",
        "description": "Where guest attachments are offered, you can send one supported image or readable document up to 5 MiB. Signed-in accounts with attachment access can send up to five files per message, 10 MiB each and 25 MiB combined. Google Drive requires sign-in. The selected AI providers process the required file content; upload only material you are allowed to use.",
        "items": [
          {
            "term": "Supported",
            "detail": "PNG, JPEG, WebP, PDF, text, Word, Excel, PowerPoint, OpenDocument files, and supported Google Drive exports."
          },
          {
            "term": "Unsupported or failed",
            "detail": "Remove passwords, re-export corrupted documents, reduce size, or paste the key text directly."
          },
          {
            "term": "Model differences",
            "detail": "Some models handle images or long documents differently; try a file-capable fallback when needed."
          },
          {
            "term": "Sensitive files",
            "detail": "Attach only content you are permitted to process with Tomverse and the selected external AI provider."
          }
        ]
      },
      {
        "id": "credits-and-plans",
        "title": "8. Credits and plans",
        "description": "Credits provide a simple usage unit while model cost and reasoning depth vary.",
        "items": [
          {
            "term": "Base classes",
            "detail": "Check each model’s base credits in the model catalogue and picker. Class examples describe short requests; actual usage depends on the model and input."
          },
          {
            "term": "Long input",
            "detail": "Long questions, conversation history and extracted file content count toward input size. See the pricing credit guide for the current bands and multipliers."
          },
          {
            "term": "Files",
            "detail": "Extracted file content contributes to input size and can change the estimate."
          },
          {
            "term": "AI Review",
            "detail": "The setup screen shows its separate estimated charge before execution."
          },
          {
            "term": "Two balances",
            "detail": "Plan credits reset on the plan schedule; purchased add-on credits are separate and remain until used or expired under their terms."
          },
          {
            "term": "Failed usage",
            "detail": "Provider failures and empty responses are refunded; cancelled requests settle completed usage and return the unused reservation."
          }
        ]
      },
      {
        "id": "troubleshooting",
        "title": "9. Troubleshooting",
        "description": "Start with the smallest retry, then keep the trace evidence if the problem continues.",
        "items": [
          {
            "term": "No answer",
            "detail": "Check the status page, retry once, and try a recommended fallback model."
          },
          {
            "term": "One model fails",
            "detail": "Continue with successful panels and inspect the failed provider's status reason."
          },
          {
            "term": "Upload fails",
            "detail": "Check format, file size, password protection, and network stability; then retry with one file."
          },
          {
            "term": "Credit looks wrong",
            "detail": "Refresh usage after settlement and check the effects of files and long context. Contact support with the time, model and trace ID if an unexplained charge or duplicate entry remains."
          },
          {
            "term": "Trace ID",
            "detail": "Copy the trace ID shown with an error and include it with the approximate time, model, browser, and attachment status."
          },
          {
            "term": "Provider status",
            "detail": "Open tomverse.app/status to see model availability and current incidents."
          }
        ]
      }
    ],
    "reviewVideoTitle": "AI Review workflow example",
    "openChat": "Open Tomverse Review",
    "allHelp": "View all Help Centre guides",
    "chatIntro": {
      "title": "If you want to use Tomverse Chat",
      "description": "Choose Chat for an ongoing conversation with one model. Where these selection features are available to your account, follow the steps below.",
      "items": [
        {
          "term": "Smart Adaptive / Auto",
          "detail": "When Auto is offered in the model picker, enable it and enter a question. Check which model is shown on the answer."
        },
        {
          "term": "Manual model selection",
          "detail": "Turn Auto off to choose an available model yourself. Check its base credits and supported capabilities first."
        },
        {
          "term": "Question refinement",
          "detail": "If a suggestion appears, check your original intent and conditions and choose whether to apply it. Add any missing requirements to the question."
        },
        {
          "term": "Files and follow-up questions",
          "detail": "When an attachment control is offered, add a supported file and ask about a specific part. See the file section below for limits and retention."
        }
      ]
    }
  },
  "ko": {
    "eyebrow": "도움말 센터 · Review 워크스페이스",
    "title": "Tomverse Review 작업공간 가이드",
    "description": "Tomverse Chat은 한 모델과 대화를 이어가며 Smart Adaptive·직접 모델 선택·질문 다듬기 제안을 활용하는 제품입니다. 이 가이드는 최대 세 모델의 답변 패널과 AI Review를 사용하는 Tomverse Review 작업공간을 설명합니다.",
    "updated": "2026년 10월 12일 안내 업데이트",
    "contents": "이 페이지의 내용",
    "tourTitle": "1. Review 화면 둘러보기",
    "tourDescription": "워크스페이스 지도에서 번호를 누르면 해당 설명으로 이동합니다. 개인 대화 내용 없이 현재 사이드바 구조를 재현했습니다.",
    "tourItems": [
      {
        "term": "새 대화",
        "detail": "현재 기본 모델 선택으로 서로 독립된 새 대화를 시작합니다."
      },
      {
        "term": "대화 검색",
        "detail": "대화 제목을 검색하고 로그인 계정에서는 저장된 메시지의 일치 내용도 찾습니다."
      },
      {
        "term": "상태 필터",
        "detail": "잠겼거나 현재 공유 링크가 활성화된 대화를 표시합니다."
      },
      {
        "term": "프로젝트",
        "detail": "계정의 관련 대화를 폴더처럼 묶어 정리합니다."
      },
      {
        "term": "대화 메뉴",
        "detail": "이름 변경, 고정, 이동, 공유, 다운로드, 잠금, 삭제를 실행합니다."
      }
    ],
    "sections": [
      {
        "id": "states-and-labels",
        "title": "2. 대화 상태와 프로젝트의 차이",
        "description": "한 대화에 함께 표시될 수 있지만 각각 의미가 다릅니다.",
        "items": [
          {
            "term": "잠김",
            "detail": "보호된 읽기와 작업 전에 비밀번호 확인이 필요한 대화입니다."
          },
          {
            "term": "공유됨",
            "detail": "읽기 전용 공개 스냅샷 링크가 활성화된 상태입니다."
          },
          {
            "term": "고정됨",
            "detail": "사이드바 맨 위에 대화를 고정합니다. 로그인하면 계정 상태라 다른 기기에서도 같고, 로그인하지 않으면 이 브라우저에만 남습니다."
          },
          {
            "term": "프로젝트",
            "detail": "관련 대화를 묶는 계정 기반 폴더입니다."
          }
        ],
        "note": "프로젝트에 포함된 대화들이 서로의 내용, 파일 또는 AI 메모리를 자동 공유하지 않습니다."
      },
      {
        "id": "projects",
        "title": "3. 프로젝트 사용 방법",
        "description": "프로젝트를 만든 뒤 각 대화 메뉴에서 이동합니다.",
        "items": [
          {
            "term": "생성",
            "detail": "프로젝트 옆 새 프로젝트를 누르고 이름을 입력해 확인합니다."
          },
          {
            "term": "이름 변경",
            "detail": "프로젝트 이름 옆 연필 버튼을 사용합니다."
          },
          {
            "term": "대화 이동",
            "detail": "대화의 ⋮ 메뉴에서 프로젝트로 이동을 열고 대상을 선택합니다."
          },
          {
            "term": "프로젝트에서 제거",
            "detail": "같은 메뉴에서 프로젝트에서 제거를 선택합니다."
          },
          {
            "term": "프로젝트 삭제",
            "detail": "삭제를 확인해도 대화는 계정에 남고 미분류 상태가 됩니다."
          },
          {
            "term": "컨텍스트 제한",
            "detail": "프로젝트는 폴더이며 공용 프롬프트, 파일 보관함 또는 대화 간 메모리가 아닙니다."
          }
        ]
      },
      {
        "id": "lock-and-share",
        "title": "4. 잠금과 공유",
        "description": "잠금은 저장된 대화 작업을 보호하고, 공유는 범위가 제한된 읽기 전용 스냅샷을 공개합니다.",
        "items": [
          {
            "term": "잠금",
            "detail": "대화 메뉴에서 비밀번호를 설정합니다. 열기, 공유, 다운로드, 수정 등 보호 작업 전에 확인이 필요합니다."
          },
          {
            "term": "잠금 해제",
            "detail": "잠금 해제를 선택하고 대화 비밀번호를 입력합니다. 반복 오류는 일시 제한될 수 있습니다."
          },
          {
            "term": "비밀번호 분실",
            "detail": "Tomverse는 원래 비밀번호를 표시하거나 복구할 수 없습니다. 안전하게 보관하고 가능한 계정 데이터 조치는 지원팀에 문의하세요."
          },
          {
            "term": "암호화 아님",
            "detail": "잠금은 접근 제어입니다. 답변 생성 중 선택한 AI 공급자에게 질문과 필요한 맥락이 전달되는 것을 막지 않습니다."
          },
          {
            "term": "공유",
            "detail": "링크를 가진 사람은 만료 또는 취소 전까지 스냅샷을 읽을 수 있으므로 민감한 내용은 공유하지 마세요."
          },
          {
            "term": "갱신·취소",
            "detail": "공유 갱신은 새 스냅샷과 링크를 만들고, 공유 취소는 현재 공개 링크를 비활성화합니다."
          }
        ],
        "note": "공유 후 추가된 메시지는 기존 스냅샷에 자동 반영되지 않습니다."
      },
      {
        "id": "models-and-panels",
        "title": "5. AI 모델과 답변 패널",
        "description": "집중 답변은 한 모델, 나란히 비교하려면 최대 세 모델을 선택합니다.",
        "items": [
          {
            "term": "모델 선택",
            "detail": "보내기 전에 모델 선택창에서 사용량 클래스와 예상 기본 크레딧을 확인합니다."
          },
          {
            "term": "활성 모델",
            "detail": "켜진 패널만 다음 공통 질문을 받습니다."
          },
          {
            "term": "특정 모델 후속 질문",
            "detail": "해당 응답 패널의 후속 질문 기능을 사용합니다."
          },
          {
            "term": "패널 일시 중지",
            "detail": "대화에서 제거하지 않고 해당 모델만 잠시 끕니다."
          },
          {
            "term": "패널 닫기",
            "detail": "확인 후 현재 비교에서 해당 모델 패널을 제거합니다."
          },
          {
            "term": "제한·장애",
            "detail": "상태 이유를 열고 공급자가 제한된 경우 추천 대체 모델을 사용합니다."
          },
          {
            "term": "크레딧 예상",
            "detail": "전송 전 값은 선택한 모델의 기본 크레딧 예상량입니다. 파일과 긴 대화 기록을 처리한 뒤 적용되는 사용량은 달라질 수 있습니다."
          }
        ]
      },
      {
        "id": "ai-review",
        "title": "6. AI Review 사용법",
        "description": "2~3개 모델 답변이 완료되면 AI Review를 열고 검토 방식과 예상 크레딧을 확인한 뒤 실행합니다.",
        "items": [
          {
            "term": "균형 검토",
            "detail": "공통점, 중요한 차이, 누락, 모순과 실용성을 정리합니다."
          },
          {
            "term": "근거 중심",
            "detail": "근거가 약한 주장, 충돌과 외부 검증이 필요한 항목을 강조합니다."
          },
          {
            "term": "실행 중심",
            "detail": "선택지, 장단점, 위험과 다음 행동을 강조합니다."
          },
          {
            "term": "결과",
            "detail": "합의점·차이·모순·누락·검증 필요 영역을 확인합니다."
          }
        ],
        "note": "AI Review는 제공된 답변만 비교합니다. 웹 검색, 독립적인 사실검증 또는 정답 보증을 수행하지 않습니다."
      },
      {
        "id": "files-and-drive",
        "title": "7. 파일과 Google Drive",
        "description": "첨부가 제공되는 게스트 체험에서는 지원 이미지·읽을 수 있는 문서 1개를 최대 5MiB까지 보낼 수 있습니다. 첨부 권한이 있는 로그인 계정은 메시지당 최대 5개, 각 10MiB, 합계 25MiB까지 사용할 수 있습니다. Google Drive 연결에는 로그인이 필요합니다. 필요한 파일 내용은 선택한 AI 제공자가 처리하므로 업로드 권한이 있는 자료만 사용하세요.",
        "items": [
          {
            "term": "지원 형식",
            "detail": "PNG, JPEG, WebP, PDF, 텍스트, Word, Excel, PowerPoint, OpenDocument와 지원되는 Google Drive 내보내기입니다."
          },
          {
            "term": "실패 시",
            "detail": "암호를 제거하고 손상 문서를 다시 내보내거나 크기를 줄이고 핵심 텍스트를 직접 붙여넣으세요."
          },
          {
            "term": "모델별 차이",
            "detail": "이미지·긴 문서 처리가 다를 수 있으므로 파일 지원 대체 모델을 시도하세요."
          },
          {
            "term": "민감 파일",
            "detail": "Tomverse와 선택한 외부 AI 공급자에서 처리할 권한이 있는 내용만 첨부하세요."
          }
        ]
      },
      {
        "id": "credits-and-plans",
        "title": "8. 크레딧과 플랜",
        "description": "모델 비용과 추론 깊이가 달라도 이해하기 쉽도록 크레딧이라는 공통 사용 단위를 제공합니다.",
        "items": [
          {
            "term": "기본 클래스",
            "detail": "모델 목록과 모델 선택창에서 해당 모델의 기본 크레딧을 확인하세요. 등급별 예시는 짧은 요청의 안내이며 실제 사용량은 모델과 입력에 따라 달라집니다."
          },
          {
            "term": "긴 입력",
            "detail": "긴 질문·대화 기록·추출된 파일 내용은 입력 크기에 포함됩니다. 요금제의 크레딧 안내에서 현재 구간과 배율을 확인하세요."
          },
          {
            "term": "파일",
            "detail": "추출된 파일 내용도 입력 크기에 포함되어 예상량이 달라질 수 있습니다."
          },
          {
            "term": "AI Review",
            "detail": "실행 전 설정 화면에서 별도 예상 차감량을 표시합니다."
          },
          {
            "term": "두 잔액",
            "detail": "플랜 크레딧은 일정에 따라 초기화되고 추가 구매 크레딧은 별도로 유지되어 약관에 따라 소진·만료됩니다."
          },
          {
            "term": "실패 처리",
            "detail": "공급자 오류·빈 응답은 환불하고 취소 요청은 완료 사용량만 확정한 뒤 미사용 예약분을 돌려줍니다."
          }
        ]
      },
      {
        "id": "troubleshooting",
        "title": "9. 문제 해결",
        "description": "가장 작은 범위로 한 번 재시도하고 문제가 계속되면 추적 정보를 보관하세요.",
        "items": [
          {
            "term": "답변 없음",
            "detail": "상태 페이지를 확인하고 한 번 재시도한 뒤 추천 대체 모델을 사용합니다."
          },
          {
            "term": "특정 모델 실패",
            "detail": "성공한 패널은 계속 사용하고 실패한 공급자의 상태 이유를 확인합니다."
          },
          {
            "term": "업로드 실패",
            "detail": "형식, 크기, 암호 보호와 네트워크를 확인하고 파일 하나로 재시도합니다."
          },
          {
            "term": "크레딧 이상",
            "detail": "정산 후 사용량 내역을 새로고침하고 파일·긴 문맥에 따른 적용 내용을 확인하세요. 설명되지 않는 차감이나 중복 표시가 남으면 시간·모델·Trace ID와 함께 지원팀에 문의하세요."
          },
          {
            "term": "Trace ID",
            "detail": "오류의 Trace ID와 대략적 시간, 모델, 브라우저, 첨부 여부를 함께 전달합니다."
          },
          {
            "term": "공급자 상태",
            "detail": "tomverse.app/status에서 모델 가용성과 진행 중인 사고를 확인합니다."
          }
        ]
      }
    ],
    "reviewVideoTitle": "AI Review 동작 예시",
    "openChat": "Tomverse Review 열기",
    "allHelp": "전체 도움말 보기",
    "chatIntro": {
      "title": "Tomverse Chat을 사용하려면",
      "description": "한 모델과 질문을 이어갈 때는 Chat을 선택하세요. 아래 선택 기능이 계정에 제공되는 경우 이 순서로 확인할 수 있습니다.",
      "items": [
        {
          "term": "Smart Adaptive / Auto",
          "detail": "모델 선택창에서 Auto가 제공되면 켜고 질문을 입력합니다. 답변에 표시되는 실제 모델을 확인하세요."
        },
        {
          "term": "직접 모델 선택",
          "detail": "Auto를 끄고 사용 가능한 모델을 직접 선택할 수 있습니다. 선택 전 모델의 기본 크레딧과 지원 기능을 확인하세요."
        },
        {
          "term": "질문 다듬기 제안",
          "detail": "제안이 표시되면 원래 의도와 조건을 확인하고 적용 여부를 직접 선택합니다. 필요한 조건이 빠졌다면 질문에 보완하세요."
        },
        {
          "term": "파일과 후속 질문",
          "detail": "첨부 버튼이 제공되면 지원 파일을 추가하고, 자료의 어떤 부분을 찾을지 구체적으로 질문하세요. 실제 한도와 보관 범위는 아래 파일 안내를 확인하세요."
        }
      ]
    }
  },
  "zh": {
    "eyebrow": "帮助中心 · Review 工作区",
    "title": "Tomverse Review 工作区指南",
    "description": "Tomverse Chat 用于与一个模型持续对话，并提供 Smart Adaptive、手动选模型和提问优化建议。本指南介绍最多三个回答面板与 AI Review 的 Tomverse Review 工作区。",
    "updated": "指南更新于2026年10月12日",
    "contents": "本页内容",
    "tourTitle": "1. Review 界面导览",
    "tourDescription": "选择工作区地图中的编号即可跳到说明。地图不显示任何私人对话内容。",
    "tourItems": [
      {
        "term": "新对话",
        "detail": "使用当前默认模型开始一个独立对话。"
      },
      {
        "term": "搜索对话",
        "detail": "搜索标题；登录后也可搜索已保存消息中的匹配内容。"
      },
      {
        "term": "状态筛选",
        "detail": "显示已锁定或已启用分享链接的对话。"
      },
      {
        "term": "项目",
        "detail": "像文件夹一样整理账户对话。"
      },
      {
        "term": "对话菜单",
        "detail": "重命名、置顶、移动、分享、下载、锁定或删除。"
      }
    ],
    "sections": [
      {
        "id": "states-and-labels",
        "title": "2. 状态和项目",
        "description": "它们可以同时出现，但含义不同。",
        "items": [
          {
            "term": "已锁定",
            "detail": "受保护的读取和操作前需要密码验证。"
          },
          {
            "term": "已分享",
            "detail": "只读公开快照链接当前有效。"
          },
          {
            "term": "已置顶",
            "detail": "将对话固定在侧边栏顶部。登录后该状态属于账户，在其他设备上也一样；未登录时仅保存在此浏览器。"
          },
          {
            "term": "项目",
            "detail": "账户中用于归组相关对话的文件夹。"
          }
        ],
        "note": "项目不会自动共享对话内容、文件或 AI 记忆。"
      },
      {
        "id": "projects",
        "title": "3. 使用项目",
        "description": "先创建项目，再从每个对话的菜单移动。",
        "items": [
          {
            "term": "创建",
            "detail": "选择项目旁的新建，输入名称并确认。"
          },
          {
            "term": "重命名",
            "detail": "使用项目名称旁的铅笔按钮。"
          },
          {
            "term": "移动对话",
            "detail": "打开 ⋮ 菜单，在移动到项目中选择目标。"
          },
          {
            "term": "移出",
            "detail": "在同一菜单选择从项目移除。"
          },
          {
            "term": "删除项目",
            "detail": "对话不会被删除，而会回到未分类。"
          },
          {
            "term": "上下文边界",
            "detail": "项目只是文件夹，不是共享提示词、文件库或跨对话记忆。"
          }
        ]
      },
      {
        "id": "lock-and-share",
        "title": "4. 锁定与分享",
        "description": "锁定保护已保存对话的操作；分享发布有范围限制的只读快照。",
        "items": [
          {
            "term": "锁定",
            "detail": "从菜单设置密码；打开、分享、下载、编辑等受保护操作需验证。"
          },
          {
            "term": "解锁",
            "detail": "选择解锁并输入密码；连续错误可能被限速。"
          },
          {
            "term": "忘记密码",
            "detail": "Tomverse 无法显示或恢复原密码，请安全保存并向支持咨询可用的数据选项。"
          },
          {
            "term": "不是加密",
            "detail": "锁定是访问控制，不会阻止生成回答时把必要内容发送给 AI 提供商。"
          },
          {
            "term": "分享",
            "detail": "持有链接的人可在到期或撤销前读取快照，请勿分享敏感内容。"
          },
          {
            "term": "刷新或撤销",
            "detail": "刷新会生成新快照和链接；撤销会停用当前链接。"
          }
        ],
        "note": "分享后新增的消息不会自动进入现有快照。"
      },
      {
        "id": "models-and-panels",
        "title": "5. AI 模型和回答面板",
        "description": "一个模型适合专注回答，最多三个模型可并排比较。",
        "items": [
          {
            "term": "选择模型",
            "detail": "发送前查看用量类别和预计基础积分。"
          },
          {
            "term": "启用模型",
            "detail": "只有开启的面板接收下一条共同问题。"
          },
          {
            "term": "仅向一个模型追问",
            "detail": "使用该回答面板的追问控件。"
          },
          {
            "term": "暂停面板",
            "detail": "暂时关闭而不从对话移除。"
          },
          {
            "term": "关闭面板",
            "detail": "确认后从当前比较移除。"
          },
          {
            "term": "受限或不可用",
            "detail": "查看状态原因并使用推荐替代模型。"
          },
          {
            "term": "积分预估",
            "detail": "发送前显示所选模型的基础积分预估；处理文件和较长对话记录后，最终用量可能不同。"
          }
        ]
      },
      {
        "id": "ai-review",
        "title": "6. 使用 AI Review",
        "description": "两到三个回答完成后，打开 AI Review，选择模式、确认预计积分并运行。",
        "items": [
          {
            "term": "均衡",
            "detail": "整理共识、差异、遗漏、矛盾和实用性。"
          },
          {
            "term": "证据优先",
            "detail": "突出薄弱依据、冲突和需外部验证的说法。"
          },
          {
            "term": "行动优先",
            "detail": "突出选项、权衡、风险和下一步。"
          },
          {
            "term": "结果",
            "detail": "查看共识、差异、矛盾、遗漏和待验证部分。"
          }
        ],
        "note": "AI Review 只比较提供的回答，不浏览网页、不独立核验事实，也不保证正确答案。"
      },
      {
        "id": "files-and-drive",
        "title": "7. 文件和 Google Drive",
        "description": "在提供访客附件的体验中，可发送一个不超过 5 MiB 的支持图片或可读文档。拥有附件权限的登录账户每条消息最多五个文件，每个 10 MiB，总计 25 MiB。连接 Google Drive 需要登录。所选 AI 提供商会处理必要文件内容，请只上传有权使用的资料。",
        "items": [
          {
            "term": "支持",
            "detail": "PNG、JPEG、WebP、PDF、文本、Word、Excel、PowerPoint、OpenDocument 和支持的 Drive 导出。"
          },
          {
            "term": "失败时",
            "detail": "移除密码、重新导出损坏文件、减小大小或粘贴关键文本。"
          },
          {
            "term": "模型差异",
            "detail": "图像和长文档能力不同，可改用支持文件的模型。"
          },
          {
            "term": "敏感文件",
            "detail": "只上传你有权交由 Tomverse 和外部 AI 提供商处理的内容。"
          }
        ]
      },
      {
        "id": "credits-and-plans",
        "title": "8. 积分和方案",
        "description": "积分把不同模型成本和推理深度统一为易懂的用量单位。",
        "items": [
          {
            "term": "基础类别",
            "detail": "请在模型目录和选择器查看各模型的基础积分。等级示例针对短请求，实际用量取决于模型与输入。"
          },
          {
            "term": "长输入",
            "detail": "长问题、对话记录和提取的文件内容都计入输入大小。当前区间与倍数请查看套餐的积分说明。"
          },
          {
            "term": "文件",
            "detail": "提取内容计入输入大小。"
          },
          {
            "term": "AI Review",
            "detail": "运行前单独显示预计用量。"
          },
          {
            "term": "两种余额",
            "detail": "方案积分按周期重置；附加积分单独保留并按条款使用或到期。"
          },
          {
            "term": "失败处理",
            "detail": "提供商错误和空回答会退款；取消时仅结算已完成用量并退回未用预留。"
          }
        ]
      },
      {
        "id": "troubleshooting",
        "title": "9. 故障排除",
        "description": "先做一次最小范围重试；若持续发生，请保留追踪证据。",
        "items": [
          {
            "term": "没有回答",
            "detail": "查看状态页、重试一次并尝试推荐替代模型。"
          },
          {
            "term": "单个模型失败",
            "detail": "继续使用成功面板并查看失败提供商原因。"
          },
          {
            "term": "上传失败",
            "detail": "检查格式、大小、密码和网络，再用一个文件重试。"
          },
          {
            "term": "积分异常",
            "detail": "结算后刷新用量记录，检查文件与长上下文的影响。仍有无法解释的扣除或重复记录时，请附上时间、模型与 Trace ID 联系支持。"
          },
          {
            "term": "Trace ID",
            "detail": "提交 Trace ID、时间、模型、浏览器和附件情况。"
          },
          {
            "term": "提供商状态",
            "detail": "在 tomverse.app/status 查看可用性和事故。"
          }
        ]
      }
    ],
    "reviewVideoTitle": "AI Review 流程示例",
    "openChat": "打开 Tomverse Review",
    "allHelp": "查看全部帮助指南",
    "chatIntro": {
      "title": "如果要使用 Tomverse Chat",
      "description": "与一个模型持续对话时请选择 Chat。账户提供这些选择功能时，可按以下步骤查看。",
      "items": [
        {
          "term": "Smart Adaptive / Auto",
          "detail": "选择器提供 Auto 时开启并提问，在回答上查看实际使用模型。"
        },
        {
          "term": "手动选模型",
          "detail": "关闭 Auto 后可自行选择可用模型，先查看基础积分与功能。"
        },
        {
          "term": "提问优化建议",
          "detail": "显示建议时检查原意与条件，自行决定是否采用；缺少条件时补充问题。"
        },
        {
          "term": "文件与追问",
          "detail": "提供附件按钮时添加支持文件，并明确想找的内容。下方文件说明列出限制与保管范围。"
        }
      ]
    }
  },
  "fr": {
    "eyebrow": "Centre d’aide · Espace Review",
    "title": "Guide de l’espace Tomverse Review",
    "description": "Tomverse Chat permet de poursuivre une conversation avec un modèle, avec Smart Adaptive, le choix manuel et les suggestions de reformulation. Ce guide présente l’espace Tomverse Review, ses trois panneaux maximum et AI Review.",
    "updated": "Guide mis à jour le 12 octobre 2026",
    "contents": "Dans cette page",
    "tourTitle": "1. Découvrir l’écran Review",
    "tourDescription": "Sélectionnez un numéro dans la carte pour rejoindre son explication, sans afficher de conversation privée.",
    "tourItems": [
      {
        "term": "Nouveau chat",
        "detail": "Démarre une conversation indépendante avec les modèles par défaut."
      },
      {
        "term": "Rechercher",
        "detail": "Recherche les titres et, une fois connecté, le texte correspondant dans les messages enregistrés."
      },
      {
        "term": "États",
        "detail": "Filtre les conversations verrouillées ou avec un lien partagé actif."
      },
      {
        "term": "Projets",
        "detail": "Regroupe les conversations du compte comme des dossiers."
      },
      {
        "term": "Menu de conversation",
        "detail": "Renommer, épingler, déplacer, partager, télécharger, verrouiller ou supprimer."
      }
    ],
    "sections": [
      {
        "id": "states-and-labels",
        "title": "2. États et projets",
        "description": "Ils peuvent coexister mais n’ont pas le même rôle.",
        "items": [
          {
            "term": "Verrouillé",
            "detail": "Mot de passe requis pour les lectures et actions protégées."
          },
          {
            "term": "Partagé",
            "detail": "Un lien public vers un instantané en lecture seule est actif."
          },
          {
            "term": "Épinglé",
            "detail": "Garde la conversation en haut de la barre latérale. Connecté, c’est un état du compte, identique sur tous les appareils ; déconnecté, cela reste dans ce navigateur."
          },
          {
            "term": "Projet",
            "detail": "Dossier lié au compte pour regrouper des conversations."
          }
        ],
        "note": "Un projet ne partage pas automatiquement contenu, fichiers ou mémoire IA entre conversations."
      },
      {
        "id": "projects",
        "title": "3. Utiliser les projets",
        "description": "Créez un projet puis déplacez-y les conversations depuis leur menu.",
        "items": [
          {
            "term": "Créer",
            "detail": "Choisissez Nouveau près de Projets, saisissez un nom et confirmez."
          },
          {
            "term": "Renommer",
            "detail": "Utilisez le crayon près du nom."
          },
          {
            "term": "Déplacer",
            "detail": "Dans le menu ⋮, choisissez Déplacer vers le projet."
          },
          {
            "term": "Retirer",
            "detail": "Choisissez Retirer du projet dans le même menu."
          },
          {
            "term": "Supprimer",
            "detail": "Les conversations restent dans le compte et redeviennent non classées."
          },
          {
            "term": "Limite de contexte",
            "detail": "Un projet est un dossier, pas une invite, bibliothèque de fichiers ou mémoire partagée."
          }
        ]
      },
      {
        "id": "lock-and-share",
        "title": "4. Verrouillage et partage",
        "description": "Le verrou protège les actions; le partage publie un instantané limité en lecture seule.",
        "items": [
          {
            "term": "Verrouiller",
            "detail": "Définissez un mot de passe; ouverture, partage, téléchargement et modification exigent une vérification."
          },
          {
            "term": "Déverrouiller",
            "detail": "Saisissez le mot de passe; les erreurs répétées peuvent être limitées."
          },
          {
            "term": "Mot de passe oublié",
            "detail": "Tomverse ne peut ni afficher ni récupérer l’original; contactez le support pour les options disponibles."
          },
          {
            "term": "Pas un chiffrement",
            "detail": "Le fournisseur IA reçoit toujours les données nécessaires à la génération."
          },
          {
            "term": "Partager",
            "detail": "Toute personne avec le lien peut lire l’instantané jusqu’à expiration ou révocation."
          },
          {
            "term": "Actualiser ou révoquer",
            "detail": "Actualiser crée un nouvel instantané et lien; révoquer désactive le lien courant."
          }
        ],
        "note": "Les messages ajoutés après le partage ne rejoignent pas automatiquement l’instantané existant."
      },
      {
        "id": "models-and-panels",
        "title": "5. Modèles IA et panneaux",
        "description": "Un modèle pour une réponse ciblée, jusqu’à trois pour comparer.",
        "items": [
          {
            "term": "Choisir",
            "detail": "Vérifiez classe d’usage et crédits de base avant l’envoi."
          },
          {
            "term": "Actif",
            "detail": "Seuls les panneaux activés reçoivent la prochaine question commune."
          },
          {
            "term": "Suivi ciblé",
            "detail": "Utilisez le contrôle de suivi du panneau concerné."
          },
          {
            "term": "Pause",
            "detail": "Désactive temporairement sans retirer."
          },
          {
            "term": "Fermer",
            "detail": "Retire le panneau après confirmation."
          },
          {
            "term": "Limité",
            "detail": "Consultez la raison et utilisez un modèle de secours."
          },
          {
            "term": "Estimation",
            "detail": "Avant l’envoi, le montant estime les crédits de base des modèles choisis. L’usage final peut varier après traitement de fichiers et d’un long historique."
          }
        ]
      },
      {
        "id": "ai-review",
        "title": "6. Utiliser AI Review",
        "description": "Après deux ou trois réponses, ouvrez AI Review, choisissez le mode, vérifiez les crédits et lancez.",
        "items": [
          {
            "term": "Équilibré",
            "detail": "Accords, différences, omissions, contradictions et utilité."
          },
          {
            "term": "Preuves",
            "detail": "Appuis faibles, conflits et vérifications externes."
          },
          {
            "term": "Action",
            "detail": "Options, compromis, risques et prochaines étapes."
          },
          {
            "term": "Résultat",
            "detail": "Consensus, différences, contradictions, omissions et points à vérifier."
          }
        ],
        "note": "AI Review compare uniquement les réponses fournies; il ne navigue pas, ne vérifie pas indépendamment les faits et ne garantit pas la bonne réponse."
      },
      {
        "id": "files-and-drive",
        "title": "7. Fichiers et Google Drive",
        "description": "Lorsque les pièces jointes sont proposées aux visiteurs, vous pouvez envoyer une image prise en charge ou un document lisible de 5 Mio maximum. Les comptes connectés autorisés peuvent envoyer cinq fichiers par message, 10 Mio chacun et 25 Mio au total. Google Drive nécessite une connexion. Les fournisseurs d’IA choisis traitent le contenu nécessaire ; utilisez uniquement des documents que vous êtes autorisé à transmettre.",
        "items": [
          {
            "term": "Pris en charge",
            "detail": "PNG, JPEG, WebP, PDF, texte, Word, Excel, PowerPoint, OpenDocument et exports Drive compatibles."
          },
          {
            "term": "Échec",
            "detail": "Retirez le mot de passe, réexportez, réduisez ou collez le texte essentiel."
          },
          {
            "term": "Selon le modèle",
            "detail": "Images et longs documents peuvent être traités différemment."
          },
          {
            "term": "Données sensibles",
            "detail": "N’envoyez que ce que vous êtes autorisé à faire traiter."
          }
        ]
      },
      {
        "id": "credits-and-plans",
        "title": "8. Crédits et offres",
        "description": "Une unité commune malgré les différences de coût et de raisonnement.",
        "items": [
          {
            "term": "Bases",
            "detail": "Consultez les crédits de base de chaque modèle dans le catalogue et le sélecteur. Les exemples par catégorie concernent les requêtes courtes ; l’usage dépend du modèle et de l’entrée."
          },
          {
            "term": "Longue entrée",
            "detail": "Questions longues, historique et contenu extrait des fichiers comptent dans la taille de l’entrée. Consultez les paliers et coefficients actuels dans le guide des crédits des tarifs."
          },
          {
            "term": "Fichiers",
            "detail": "Le contenu extrait compte dans l’entrée."
          },
          {
            "term": "AI Review",
            "detail": "Affiche sa propre estimation avant exécution."
          },
          {
            "term": "Deux soldes",
            "detail": "Les crédits du plan se réinitialisent; les crédits achetés restent séparés selon leurs conditions."
          },
          {
            "term": "Échecs",
            "detail": "Erreurs fournisseur et réponses vides sont remboursées; l’annulation rend la réservation inutilisée."
          }
        ]
      },
      {
        "id": "troubleshooting",
        "title": "9. Dépannage",
        "description": "Réessayez une fois au plus petit périmètre puis conservez les preuves.",
        "items": [
          {
            "term": "Aucune réponse",
            "detail": "Vérifiez le statut, réessayez et utilisez un secours recommandé."
          },
          {
            "term": "Un modèle échoue",
            "detail": "Continuez avec les panneaux réussis et consultez la raison."
          },
          {
            "term": "Échec d’envoi",
            "detail": "Vérifiez format, taille, mot de passe et réseau puis un seul fichier."
          },
          {
            "term": "Crédits",
            "detail": "Actualisez l’usage après calcul final et vérifiez les effets des fichiers et du contexte long. Si un débit inexpliqué ou un doublon subsiste, contactez l’assistance avec l’heure, le modèle et le Trace ID."
          },
          {
            "term": "Trace ID",
            "detail": "Joignez identifiant, heure, modèle, navigateur et état des pièces jointes."
          },
          {
            "term": "Statut",
            "detail": "Consultez tomverse.app/status."
          }
        ]
      }
    ],
    "reviewVideoTitle": "Exemple du flux AI Review",
    "openChat": "Ouvrir Tomverse Review",
    "allHelp": "Voir tout le Centre d’aide",
    "chatIntro": {
      "title": "Pour utiliser Tomverse Chat",
      "description": "Choisissez Chat pour poursuivre une conversation avec un modèle. Lorsque ces fonctions sont proposées à votre compte, suivez ces étapes.",
      "items": [
        {
          "term": "Smart Adaptive / Auto",
          "detail": "Activez Auto lorsqu’il est proposé dans le sélecteur, puis posez votre question. Vérifiez le modèle indiqué sur la réponse."
        },
        {
          "term": "Choix manuel du modèle",
          "detail": "Désactivez Auto pour choisir un modèle disponible. Consultez d’abord crédits de base et fonctions."
        },
        {
          "term": "Reformulation de la question",
          "detail": "Si une suggestion apparaît, vérifiez intention et conditions puis décidez de l’appliquer. Complétez les exigences manquantes."
        },
        {
          "term": "Fichiers et questions de suivi",
          "detail": "Si le bouton est proposé, ajoutez un fichier pris en charge et posez une question précise. Les limites et la conservation sont expliquées plus bas."
        }
      ]
    }
  },
  "de": {
    "eyebrow": "Hilfe · Review-Workspace",
    "title": "Tomverse Review: Arbeitsbereich",
    "description": "Tomverse Chat unterstützt fortlaufende Gespräche mit einem Modell, Smart Adaptive, manuelle Modellwahl und Vorschläge zur Präzisierung. Dieser Leitfaden erklärt Tomverse Review mit bis zu drei Antwortfeldern und AI Review.",
    "updated": "Anleitung aktualisiert am 12. Oktober 2026",
    "contents": "Auf dieser Seite",
    "tourTitle": "1. Review-Oberfläche kennenlernen",
    "tourDescription": "Wählen Sie eine Nummer in der Workspace-Karte, ohne private Chatinhalte anzuzeigen.",
    "tourItems": [
      {
        "term": "Neuer Chat",
        "detail": "Startet eine unabhängige Unterhaltung mit den Standardmodellen."
      },
      {
        "term": "Chats suchen",
        "detail": "Sucht Titel und angemeldet auch passende gespeicherte Nachrichtentexte."
      },
      {
        "term": "Statusfilter",
        "detail": "Zeigt gesperrte oder aktuell geteilte Chats."
      },
      {
        "term": "Projekte",
        "detail": "Ordnet Konto-Chats wie Ordner."
      },
      {
        "term": "Chat-Menü",
        "detail": "Umbenennen, anheften, verschieben, teilen, laden, sperren oder löschen."
      }
    ],
    "sections": [
      {
        "id": "states-and-labels",
        "title": "2. Status und Projekte",
        "description": "Sie können gleichzeitig erscheinen, bedeuten aber Unterschiedliches.",
        "items": [
          {
            "term": "Gesperrt",
            "detail": "Passwortprüfung für geschützte Lese- und Änderungsaktionen."
          },
          {
            "term": "Geteilt",
            "detail": "Ein öffentlicher Nur-Lese-Snapshot-Link ist aktiv."
          },
          {
            "term": "Angeheftet",
            "detail": "Hält den Chat oben in der Seitenleiste. Angemeldet gehört der Status zum Konto und gilt auf jedem Gerät; abgemeldet bleibt er in diesem Browser."
          },
          {
            "term": "Projekt",
            "detail": "Kontobasierter Ordner für zusammengehörige Chats."
          }
        ],
        "note": "Projekte teilen Inhalte, Dateien oder KI-Gedächtnis nicht automatisch."
      },
      {
        "id": "projects",
        "title": "3. Projekte verwenden",
        "description": "Projekt erstellen und Chats über ihr Menü verschieben.",
        "items": [
          {
            "term": "Erstellen",
            "detail": "Neu neben Projekte wählen, Namen eingeben, bestätigen."
          },
          {
            "term": "Umbenennen",
            "detail": "Stift neben dem Projektnamen verwenden."
          },
          {
            "term": "Verschieben",
            "detail": "Im ⋮-Menü Zu Projekt verschieben wählen."
          },
          {
            "term": "Entfernen",
            "detail": "Im selben Menü Aus Projekt entfernen."
          },
          {
            "term": "Projekt löschen",
            "detail": "Chats bleiben im Konto und werden unkategorisiert."
          },
          {
            "term": "Kontextgrenze",
            "detail": "Ein Projekt ist kein gemeinsamer Prompt, Dateispeicher oder Cross-Chat-Gedächtnis."
          }
        ]
      },
      {
        "id": "lock-and-share",
        "title": "4. Sperren und Teilen",
        "description": "Sperren schützt Aktionen; Teilen veröffentlicht einen begrenzten Nur-Lese-Snapshot.",
        "items": [
          {
            "term": "Sperren",
            "detail": "Passwort festlegen; Öffnen, Teilen, Download und Bearbeitung erfordern Prüfung."
          },
          {
            "term": "Entsperren",
            "detail": "Passwort eingeben; wiederholte Fehler können begrenzt werden."
          },
          {
            "term": "Passwort vergessen",
            "detail": "Tomverse kann das Original nicht anzeigen oder wiederherstellen; Support zu verfügbaren Datenoptionen fragen."
          },
          {
            "term": "Keine Verschlüsselung",
            "detail": "Der KI-Anbieter erhält weiterhin für die Generierung nötige Daten."
          },
          {
            "term": "Teilen",
            "detail": "Jeder mit aktivem Link kann den Snapshot bis Ablauf oder Widerruf lesen."
          },
          {
            "term": "Aktualisieren/Widerrufen",
            "detail": "Aktualisieren erstellt Snapshot und Link neu; Widerrufen deaktiviert den Link."
          }
        ],
        "note": "Spätere Nachrichten werden nicht automatisch in den bestehenden Snapshot übernommen."
      },
      {
        "id": "models-and-panels",
        "title": "5. KI-Modelle und Panels",
        "description": "Ein Modell für Fokus, bis zu drei für Vergleich.",
        "items": [
          {
            "term": "Auswählen",
            "detail": "Nutzungsklasse und Basis-Credits vor dem Senden prüfen."
          },
          {
            "term": "Aktiv",
            "detail": "Nur aktive Panels erhalten die nächste gemeinsame Frage."
          },
          {
            "term": "Gezielte Nachfrage",
            "detail": "Nachfrage-Steuerung im Antwortpanel verwenden."
          },
          {
            "term": "Pause",
            "detail": "Vorübergehend ausschalten, ohne zu entfernen."
          },
          {
            "term": "Schließen",
            "detail": "Panel nach Bestätigung entfernen."
          },
          {
            "term": "Eingeschränkt",
            "detail": "Grund öffnen und empfohlenes Ersatzmodell nutzen."
          },
          {
            "term": "Schätzung",
            "detail": "Vor dem Senden werden die Basis-Credits der gewählten Modelle geschätzt. Nach Dateien und langem Gesprächsverlauf kann der endgültige Verbrauch abweichen."
          }
        ]
      },
      {
        "id": "ai-review",
        "title": "6. AI Review verwenden",
        "description": "Nach zwei oder drei Antworten AI Review öffnen, Modus und Credits prüfen und starten.",
        "items": [
          {
            "term": "Ausgewogen",
            "detail": "Übereinstimmungen, Unterschiede, Lücken, Widersprüche und Nutzen."
          },
          {
            "term": "Evidenz",
            "detail": "Schwache Belege, Konflikte und externe Prüfung."
          },
          {
            "term": "Aktion",
            "detail": "Optionen, Abwägungen, Risiken und nächste Schritte."
          },
          {
            "term": "Ergebnis",
            "detail": "Konsens, Unterschiede, Widersprüche, Lücken und Prüfbedarf."
          }
        ],
        "note": "AI Review vergleicht nur bereitgestellte Antworten, durchsucht nicht das Web, prüft Fakten nicht unabhängig und garantiert keine richtige Antwort."
      },
      {
        "id": "files-and-drive",
        "title": "7. Dateien und Google Drive",
        "description": "Wenn Gastanhänge angeboten werden, ist ein unterstütztes Bild oder lesbares Dokument bis 5 MiB möglich. Angemeldete Konten mit Anhangzugriff können fünf Dateien pro Nachricht senden, je 10 MiB und insgesamt 25 MiB. Google Drive erfordert eine Anmeldung. Die gewählten KI-Anbieter verarbeiten nötige Dateiinhalte; laden Sie nur erlaubte Materialien hoch.",
        "items": [
          {
            "term": "Unterstützt",
            "detail": "PNG, JPEG, WebP, PDF, Text, Word, Excel, PowerPoint, OpenDocument und unterstützte Drive-Exporte."
          },
          {
            "term": "Fehler",
            "detail": "Passwort entfernen, neu exportieren, verkleinern oder Kerntext einfügen."
          },
          {
            "term": "Modellunterschiede",
            "detail": "Bilder und lange Dokumente können anders verarbeitet werden."
          },
          {
            "term": "Sensible Dateien",
            "detail": "Nur Inhalte mit entsprechender Verarbeitungsberechtigung anhängen."
          }
        ]
      },
      {
        "id": "credits-and-plans",
        "title": "8. Credits und Pläne",
        "description": "Gemeinsame Nutzungseinheit trotz unterschiedlicher Modellkosten.",
        "items": [
          {
            "term": "Basis",
            "detail": "Basis-Credits finden Sie im Modellkatalog und der Auswahl. Kategoriebeispiele gelten für kurze Anfragen; der Verbrauch hängt von Modell und Eingabe ab."
          },
          {
            "term": "Lange Eingabe",
            "detail": "Lange Fragen, Gesprächsverlauf und extrahierte Dateiinhalte zählen zur Eingabegröße. Aktuelle Stufen und Faktoren finden Sie in der Credit-Erklärung der Tarife."
          },
          {
            "term": "Dateien",
            "detail": "Extrahierter Inhalt zählt zur Eingabe."
          },
          {
            "term": "AI Review",
            "detail": "Separate Schätzung vor Ausführung."
          },
          {
            "term": "Zwei Guthaben",
            "detail": "Plan-Credits setzen zurück; gekaufte bleiben gemäß Bedingungen separat."
          },
          {
            "term": "Fehler",
            "detail": "Anbieterfehler und leere Antworten werden erstattet; ungenutzte Reservierung bei Abbruch zurückgegeben."
          }
        ]
      },
      {
        "id": "troubleshooting",
        "title": "9. Fehlerbehebung",
        "description": "Einmal klein neu versuchen und bei Fortbestehen Nachweise sichern.",
        "items": [
          {
            "term": "Keine Antwort",
            "detail": "Status prüfen, einmal neu versuchen, Ersatzmodell nutzen."
          },
          {
            "term": "Ein Modell",
            "detail": "Erfolgreiche Panels weiterverwenden und Grund prüfen."
          },
          {
            "term": "Upload",
            "detail": "Format, Größe, Passwort, Netzwerk prüfen und eine Datei testen."
          },
          {
            "term": "Credits",
            "detail": "Aktualisieren Sie den Verbrauch nach Abrechnung und prüfen Sie Dateien sowie langen Kontext. Bleiben unerklärte Abbuchungen oder doppelte Einträge, senden Sie Zeit, Modell und Trace ID an den Support."
          },
          {
            "term": "Trace ID",
            "detail": "ID, Zeit, Modell, Browser und Anhänge mitsenden."
          },
          {
            "term": "Status",
            "detail": "tomverse.app/status öffnen."
          }
        ]
      }
    ],
    "reviewVideoTitle": "Beispiel für AI Review",
    "openChat": "Tomverse Review öffnen",
    "allHelp": "Alle Hilfeartikel ansehen",
    "chatIntro": {
      "title": "Tomverse Chat verwenden",
      "description": "Wählen Sie Chat für fortlaufende Gespräche mit einem Modell. Sind diese Auswahlfunktionen für Ihr Konto verfügbar, helfen die folgenden Schritte.",
      "items": [
        {
          "term": "Smart Adaptive / Auto",
          "detail": "Aktivieren Sie Auto, wenn es in der Modellauswahl angeboten wird, und stellen Sie die Frage. Prüfen Sie das Modell an der Antwort."
        },
        {
          "term": "Manuelle Modellwahl",
          "detail": "Schalten Sie Auto aus, um ein verfügbares Modell zu wählen. Prüfen Sie zuerst Basis-Credits und Funktionen."
        },
        {
          "term": "Frage präzisieren",
          "detail": "Prüfen Sie bei einem Vorschlag Ihre Absicht und Bedingungen und entscheiden Sie über die Übernahme. Ergänzen Sie fehlende Anforderungen."
        },
        {
          "term": "Dateien und Folgefragen",
          "detail": "Wenn eine Anhangschaltfläche angeboten wird, fügen Sie eine unterstützte Datei hinzu und fragen Sie gezielt. Grenzen und Aufbewahrung stehen unten."
        }
      ]
    }
  },
  "es": {
    "eyebrow": "Centro de ayuda · Espacio Review",
    "title": "Guía del espacio Tomverse Review",
    "description": "Tomverse Chat permite conversar con un modelo usando Smart Adaptive, selección manual y sugerencias para precisar preguntas. Esta guía explica Tomverse Review, con hasta tres paneles de respuestas y AI Review.",
    "updated": "Guía actualizada el 12 de octubre de 2026",
    "contents": "En esta página",
    "tourTitle": "1. Recorrido por Review",
    "tourDescription": "Selecciona un número del mapa para ir a su explicación sin mostrar conversaciones privadas.",
    "tourItems": [
      {
        "term": "Nuevo chat",
        "detail": "Inicia una conversación independiente con los modelos predeterminados."
      },
      {
        "term": "Buscar",
        "detail": "Busca títulos y, con sesión iniciada, texto coincidente en mensajes guardados."
      },
      {
        "term": "Estados",
        "detail": "Filtra chats bloqueados o con enlace compartido activo."
      },
      {
        "term": "Proyectos",
        "detail": "Agrupa chats de la cuenta como carpetas."
      },
      {
        "term": "Menú",
        "detail": "Renombrar, fijar, mover, compartir, descargar, bloquear o eliminar."
      }
    ],
    "sections": [
      {
        "id": "states-and-labels",
        "title": "2. Estados y proyectos",
        "description": "Pueden coexistir, pero significan cosas distintas.",
        "items": [
          {
            "term": "Bloqueado",
            "detail": "Requiere contraseña para lecturas y acciones protegidas."
          },
          {
            "term": "Compartido",
            "detail": "Hay un enlace público de instantánea de solo lectura activo."
          },
          {
            "term": "Fijado",
            "detail": "Mantiene el chat arriba en la barra lateral. Con sesión iniciada es un estado de la cuenta, igual en todos los dispositivos; sin sesión permanece en este navegador."
          },
          {
            "term": "Proyecto",
            "detail": "Carpeta vinculada a la cuenta."
          }
        ],
        "note": "Los proyectos no comparten automáticamente contenido, archivos ni memoria de IA."
      },
      {
        "id": "projects",
        "title": "3. Usar proyectos",
        "description": "Crea un proyecto y mueve chats desde su menú.",
        "items": [
          {
            "term": "Crear",
            "detail": "Elige Nuevo junto a Proyectos, escribe un nombre y confirma."
          },
          {
            "term": "Renombrar",
            "detail": "Usa el lápiz junto al nombre."
          },
          {
            "term": "Mover",
            "detail": "En ⋮, abre Mover al proyecto y elige destino."
          },
          {
            "term": "Quitar",
            "detail": "Elige Quitar del proyecto en el mismo menú."
          },
          {
            "term": "Eliminar",
            "detail": "Los chats permanecen en la cuenta y quedan sin categoría."
          },
          {
            "term": "Límite de contexto",
            "detail": "Es una carpeta, no un prompt, biblioteca o memoria compartida."
          }
        ]
      },
      {
        "id": "lock-and-share",
        "title": "4. Bloquear y compartir",
        "description": "El bloqueo protege acciones; compartir publica una instantánea limitada de solo lectura.",
        "items": [
          {
            "term": "Bloquear",
            "detail": "Define contraseña; abrir, compartir, descargar y editar requieren verificación."
          },
          {
            "term": "Desbloquear",
            "detail": "Introduce la contraseña; errores repetidos pueden limitarse."
          },
          {
            "term": "Contraseña olvidada",
            "detail": "Tomverse no puede mostrar ni recuperar la original; consulta soporte sobre opciones de datos."
          },
          {
            "term": "No es cifrado",
            "detail": "El proveedor de IA sigue recibiendo lo necesario para generar."
          },
          {
            "term": "Compartir",
            "detail": "Cualquiera con el enlace puede leer hasta que caduque o se revoque."
          },
          {
            "term": "Actualizar/revocar",
            "detail": "Actualizar crea nueva instantánea y enlace; revocar desactiva el actual."
          }
        ],
        "note": "Los mensajes posteriores no se añaden automáticamente a la instantánea existente."
      },
      {
        "id": "models-and-panels",
        "title": "5. Modelos y paneles",
        "description": "Un modelo para foco; hasta tres para comparar.",
        "items": [
          {
            "term": "Seleccionar",
            "detail": "Revisa clase de uso y créditos base antes de enviar."
          },
          {
            "term": "Activo",
            "detail": "Solo paneles activos reciben la pregunta común."
          },
          {
            "term": "Seguimiento individual",
            "detail": "Usa el control del panel de respuesta."
          },
          {
            "term": "Pausar",
            "detail": "Desactiva temporalmente sin quitar."
          },
          {
            "term": "Cerrar",
            "detail": "Quita el panel tras confirmar."
          },
          {
            "term": "Limitado",
            "detail": "Consulta el motivo y usa un sustituto recomendado."
          },
          {
            "term": "Estimación",
            "detail": "Antes de enviar se estiman los créditos base de los modelos elegidos. El uso final puede variar al procesar archivos e historiales largos."
          }
        ]
      },
      {
        "id": "ai-review",
        "title": "6. Usar AI Review",
        "description": "Tras dos o tres respuestas, abre AI Review, elige modo, revisa créditos y ejecuta.",
        "items": [
          {
            "term": "Equilibrado",
            "detail": "Acuerdos, diferencias, omisiones, contradicciones y utilidad."
          },
          {
            "term": "Evidencia",
            "detail": "Soporte débil, conflictos y verificación externa."
          },
          {
            "term": "Acción",
            "detail": "Opciones, compensaciones, riesgos y próximos pasos."
          },
          {
            "term": "Resultado",
            "detail": "Consenso, diferencias, contradicciones, omisiones y verificación."
          }
        ],
        "note": "AI Review solo compara las respuestas aportadas; no navega, no verifica hechos de forma independiente ni garantiza la respuesta correcta."
      },
      {
        "id": "files-and-drive",
        "title": "7. Archivos y Google Drive",
        "description": "Cuando se ofrecen adjuntos a visitantes, puedes enviar una imagen compatible o un documento legible de hasta 5 MiB. Las cuentas con sesión y permiso para adjuntar pueden enviar cinco archivos por mensaje, de 10 MiB cada uno y 25 MiB en total. Google Drive requiere iniciar sesión. Los proveedores elegidos procesan el contenido necesario; sube solo material que tengas permiso para usar.",
        "items": [
          {
            "term": "Compatibles",
            "detail": "PNG, JPEG, WebP, PDF, texto, Word, Excel, PowerPoint, OpenDocument y exportaciones Drive."
          },
          {
            "term": "Fallo",
            "detail": "Quita contraseña, reexporta, reduce o pega el texto clave."
          },
          {
            "term": "Por modelo",
            "detail": "Imágenes y documentos largos pueden procesarse distinto."
          },
          {
            "term": "Sensible",
            "detail": "Adjunta solo contenido que puedas autorizar para procesamiento."
          }
        ]
      },
      {
        "id": "credits-and-plans",
        "title": "8. Créditos y planes",
        "description": "Unidad común pese a costes y razonamiento diferentes.",
        "items": [
          {
            "term": "Bases",
            "detail": "Consulta los créditos base de cada modelo en el catálogo y el selector. Los ejemplos por categoría corresponden a consultas cortas; el uso depende del modelo y la entrada."
          },
          {
            "term": "Entrada larga",
            "detail": "Las preguntas largas, el historial y el contenido extraído cuentan en el tamaño de entrada. Consulta los tramos y multiplicadores actuales en la guía de créditos de precios."
          },
          {
            "term": "Archivos",
            "detail": "El contenido extraído cuenta como entrada."
          },
          {
            "term": "AI Review",
            "detail": "Muestra estimación separada antes de ejecutar."
          },
          {
            "term": "Dos saldos",
            "detail": "Créditos del plan se reinician; comprados permanecen separados según condiciones."
          },
          {
            "term": "Fallos",
            "detail": "Errores y respuestas vacías se reembolsan; la cancelación devuelve reserva no usada."
          }
        ]
      },
      {
        "id": "troubleshooting",
        "title": "9. Solución de problemas",
        "description": "Reintenta una vez con el menor alcance y conserva evidencias.",
        "items": [
          {
            "term": "Sin respuesta",
            "detail": "Consulta estado, reintenta y usa un modelo alternativo."
          },
          {
            "term": "Un modelo",
            "detail": "Continúa con paneles correctos y revisa el motivo."
          },
          {
            "term": "Carga",
            "detail": "Comprueba formato, tamaño, contraseña y red con un archivo."
          },
          {
            "term": "Créditos",
            "detail": "Actualiza el uso tras el cálculo final y revisa el efecto de archivos e historiales largos. Si quedan cargos sin explicación o duplicados, contacta con soporte indicando hora, modelo y Trace ID."
          },
          {
            "term": "Trace ID",
            "detail": "Incluye ID, hora, modelo, navegador y adjuntos."
          },
          {
            "term": "Estado",
            "detail": "Abre tomverse.app/status."
          }
        ]
      }
    ],
    "reviewVideoTitle": "Ejemplo del flujo AI Review",
    "openChat": "Abrir Tomverse Review",
    "allHelp": "Ver todo el Centro de ayuda",
    "chatIntro": {
      "title": "Para usar Tomverse Chat",
      "description": "Elige Chat para conversar con un modelo. Si tu cuenta dispone de estas funciones de selección, sigue estos pasos.",
      "items": [
        {
          "term": "Smart Adaptive / Auto",
          "detail": "Activa Auto cuando esté disponible en el selector y pregunta. Comprueba qué modelo aparece en la respuesta."
        },
        {
          "term": "Selección manual",
          "detail": "Desactiva Auto para elegir un modelo disponible. Revisa antes créditos base y funciones."
        },
        {
          "term": "Precisar la pregunta",
          "detail": "Si aparece una sugerencia, comprueba intención y condiciones y decide si la aplicas. Completa los requisitos que falten."
        },
        {
          "term": "Archivos y preguntas de seguimiento",
          "detail": "Si aparece el botón de adjuntar, añade un archivo compatible y pregunta por una parte concreta. Consulta los límites y conservación abajo."
        }
      ]
    }
  },
  "pt": {
    "eyebrow": "Centro de ajuda · Workspace Review",
    "title": "Guia do espaço Tomverse Review",
    "description": "O Tomverse Chat permite conversar com um modelo usando Smart Adaptive, seleção manual e sugestões para aprimorar perguntas. Este guia explica o Tomverse Review, com até três painéis de respostas e AI Review.",
    "updated": "Guia atualizado em 12 de outubro de 2026",
    "contents": "Nesta página",
    "tourTitle": "1. Conhecer a tela Review",
    "tourDescription": "Selecione um número no mapa para ir à explicação, sem mostrar conversas privadas.",
    "tourItems": [
      {
        "term": "Novo chat",
        "detail": "Inicia uma conversa independente com os modelos padrão."
      },
      {
        "term": "Pesquisar",
        "detail": "Pesquisa títulos e, com sessão iniciada, texto correspondente nas mensagens salvas."
      },
      {
        "term": "Estados",
        "detail": "Filtra conversas bloqueadas ou com link de compartilhamento ativo."
      },
      {
        "term": "Projetos",
        "detail": "Agrupa chats da conta como pastas."
      },
      {
        "term": "Menu",
        "detail": "Renomear, fixar, mover, compartilhar, baixar, bloquear ou excluir."
      }
    ],
    "sections": [
      {
        "id": "states-and-labels",
        "title": "2. Estados e projetos",
        "description": "Podem coexistir, mas têm significados diferentes.",
        "items": [
          {
            "term": "Bloqueado",
            "detail": "Exige senha para leituras e ações protegidas."
          },
          {
            "term": "Compartilhado",
            "detail": "Está ativa uma link pública para um snapshot só de leitura."
          },
          {
            "term": "Fixado",
            "detail": "Mantém o chat no topo da barra lateral. Com sessão iniciada é um estado da conta, igual em qualquer dispositivo; sem sessão fica neste navegador."
          },
          {
            "term": "Projeto",
            "detail": "Pasta associada à conta."
          }
        ],
        "note": "Projetos não compartilham automaticamente conteúdo, arquivos ou memória de IA."
      },
      {
        "id": "projects",
        "title": "3. Usar projetos",
        "description": "Crie um projeto e mova chats pelo respectivo menu.",
        "items": [
          {
            "term": "Criar",
            "detail": "Escolha Novo junto de Projetos, digite o nome e confirme."
          },
          {
            "term": "Renomear",
            "detail": "Use o lápis junto do nome."
          },
          {
            "term": "Mover",
            "detail": "No menu ⋮, escolha Mover para projeto."
          },
          {
            "term": "Remover",
            "detail": "Escolha Remover do projeto no mesmo menu."
          },
          {
            "term": "Excluir",
            "detail": "Os chats permanecem na conta e ficam sem categoria."
          },
          {
            "term": "Limite de contexto",
            "detail": "É uma pasta, não um prompt, biblioteca ou memória compartilhada."
          }
        ]
      },
      {
        "id": "lock-and-share",
        "title": "4. Bloqueio e compartilhamento",
        "description": "O bloqueio protege ações; o compartilhamento publica um snapshot limitado só de leitura.",
        "items": [
          {
            "term": "Bloquear",
            "detail": "Defina senha; abrir, compartilhar, baixar e editar exigem verificação."
          },
          {
            "term": "Desbloquear",
            "detail": "Digite a senha; erros repetidos podem ser limitados."
          },
          {
            "term": "Esquecida",
            "detail": "O Tomverse não mostra nem recupera a original; consulte o suporte sobre opções de dados."
          },
          {
            "term": "Não é criptografia",
            "detail": "O provedor de IA continua a receber o necessário para gerar."
          },
          {
            "term": "Compartilhar",
            "detail": "Quem tem a link pode ler até expirar ou ser revogada."
          },
          {
            "term": "Atualizar/revogar",
            "detail": "Atualizar cria novo snapshot e link; revogar desativa a atual."
          }
        ],
        "note": "Mensagens posteriores não entram automaticamente no snapshot existente."
      },
      {
        "id": "models-and-panels",
        "title": "5. Modelos e painéis",
        "description": "Um modelo para foco; até três para comparação.",
        "items": [
          {
            "term": "Selecionar",
            "detail": "Veja classe de uso e créditos base antes de enviar."
          },
          {
            "term": "Ativo",
            "detail": "Só painéis ativos recebem a pergunta comum."
          },
          {
            "term": "Seguimento individual",
            "detail": "Use o controle do painel de resposta."
          },
          {
            "term": "Pausar",
            "detail": "Desativa temporariamente sem remover."
          },
          {
            "term": "Fechar",
            "detail": "Remove o painel após confirmação."
          },
          {
            "term": "Limitado",
            "detail": "Consulte o motivo e use uma alternativa recomendada."
          },
          {
            "term": "Estimativa",
            "detail": "Antes do envio, o valor estima os créditos-base dos modelos escolhidos. O uso final pode mudar após processar arquivos e históricos longos."
          }
        ]
      },
      {
        "id": "ai-review",
        "title": "6. Usar AI Review",
        "description": "Após duas ou três respostas, abra AI Review, escolha modo, veja créditos e execute.",
        "items": [
          {
            "term": "Equilibrado",
            "detail": "Acordos, diferenças, omissões, contradições e utilidade."
          },
          {
            "term": "Evidência",
            "detail": "Suporte fraco, conflitos e verificação externa."
          },
          {
            "term": "Ação",
            "detail": "Opções, compromissos, riscos e próximos passos."
          },
          {
            "term": "Resultado",
            "detail": "Consenso, diferenças, contradições, omissões e verificação."
          }
        ],
        "note": "AI Review só compara as respostas fornecidas; não navega, não verifica fatos de forma independente nem garante a resposta correta."
      },
      {
        "id": "files-and-drive",
        "title": "7. Arquivos e Google Drive",
        "description": "Quando anexos são oferecidos a visitantes, você pode enviar uma imagem compatível ou um documento legível de até 5 MiB. Contas conectadas com acesso a anexos podem enviar cinco arquivos por mensagem, 10 MiB por arquivo e 25 MiB no total. O Google Drive exige login. Os provedores de IA escolhidos processam o conteúdo necessário; envie apenas materiais que você tem permissão para usar.",
        "items": [
          {
            "term": "Suportados",
            "detail": "PNG, JPEG, WebP, PDF, texto, Word, Excel, PowerPoint, OpenDocument e exportações Drive."
          },
          {
            "term": "Falha",
            "detail": "Retire senha, reexporte, reduza ou cole o texto essencial."
          },
          {
            "term": "Por modelo",
            "detail": "Imagens e documentos longos podem ser tratados de modo diferente."
          },
          {
            "term": "Sensível",
            "detail": "Anexe apenas conteúdo autorizado para processamento."
          }
        ]
      },
      {
        "id": "credits-and-plans",
        "title": "8. Créditos e planos",
        "description": "Unidade comum apesar de custos e raciocínio diferentes.",
        "items": [
          {
            "term": "Bases",
            "detail": "Confira os créditos-base de cada modelo no catálogo e no seletor. Os exemplos por categoria são de solicitações curtas; o uso depende do modelo e da entrada."
          },
          {
            "term": "Entrada longa",
            "detail": "Perguntas longas, histórico e conteúdo extraído contam no tamanho da entrada. Confira as faixas e os multiplicadores atuais no guia de créditos dos preços."
          },
          {
            "term": "Arquivos",
            "detail": "O conteúdo extraído conta como entrada."
          },
          {
            "term": "AI Review",
            "detail": "Mostra estimativa separada antes de executar."
          },
          {
            "term": "Dois saldos",
            "detail": "Créditos do plano reiniciam; comprados ficam separados segundo os termos."
          },
          {
            "term": "Falhas",
            "detail": "Erros e respostas vazias são reembolsados; cancelamento devolve reserva não usada."
          }
        ]
      },
      {
        "id": "troubleshooting",
        "title": "9. Resolução de problemas",
        "description": "Tente uma vez no menor escopo e salve evidências.",
        "items": [
          {
            "term": "Sem resposta",
            "detail": "Veja o estado, tente novamente e use um modelo alternativo."
          },
          {
            "term": "Um modelo",
            "detail": "Continue com painéis bem-sucedidos e veja o motivo."
          },
          {
            "term": "Upload",
            "detail": "Verifique formato, tamanho, senha e rede com um arquivo."
          },
          {
            "term": "Créditos",
            "detail": "Atualize o uso após o cálculo final e confira o efeito dos arquivos e do contexto longo. Se restarem cobranças sem explicação ou duplicadas, contate o suporte com horário, modelo e Trace ID."
          },
          {
            "term": "Trace ID",
            "detail": "Inclua ID, hora, modelo, navegador e anexos."
          },
          {
            "term": "Estado",
            "detail": "Abra tomverse.app/status."
          }
        ]
      }
    ],
    "reviewVideoTitle": "Exemplo do fluxo AI Review",
    "openChat": "Abrir Tomverse Review",
    "allHelp": "Ver todo o Centro de ajuda",
    "chatIntro": {
      "title": "Para usar o Tomverse Chat",
      "description": "Escolha o Chat para conversar com um modelo. Se sua conta tiver estes recursos de seleção, siga as etapas abaixo.",
      "items": [
        {
          "term": "Smart Adaptive / Auto",
          "detail": "Ative Auto quando estiver disponível no seletor e faça a pergunta. Confira o modelo mostrado na resposta."
        },
        {
          "term": "Seleção manual",
          "detail": "Desative Auto para escolher um modelo disponível. Confira antes os créditos-base e os recursos."
        },
        {
          "term": "Aprimorar a pergunta",
          "detail": "Se aparecer uma sugestão, confira intenção e condições e decida se aplica. Acrescente os requisitos ausentes."
        },
        {
          "term": "Arquivos e perguntas seguintes",
          "detail": "Se houver botão de anexo, adicione um arquivo compatível e pergunte sobre uma parte específica. Veja os limites e a retenção abaixo."
        }
      ]
    }
  }
};
