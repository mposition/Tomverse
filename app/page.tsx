"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { ChatApp } from "@/components/chat/ChatApp";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ChatInput } from "@/components/chat/ChatInput";
import { Conversation, AVAILABLE_MODELS, ENABLED_MODELS, MAX_SELECTED_MODELS, type ChatAttachment } from "@/components/chat/types";
import { useSession } from "next-auth/react";
import {
  useLanguage,
  type Language,
} from "@/components/LanguageProvider";
import {
  APP_DEFAULTS,
  clampGuestSelectedModels,
  clampSelectedModels,
} from "@/lib/appDefaults";
import { isEnabledModelId } from "@/lib/models";
import {
  USER_SETTINGS_UPDATED_EVENT,
  type UserSettingsUpdatedDetail,
} from "@/lib/userSettingsEvents";

const normalizeStringArray = (value: unknown, fallback: string[]) => {
  let parsed = value;
  for (let i = 0; i < 2 && typeof parsed === "string"; i++) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return fallback;
    }
  }
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : fallback;
};

const uniqueStrings = (values: string[]) => Array.from(new Set(values));
const isLanguage = (value: unknown): value is Language =>
  value === "en" || value === "ko" || value === "zh";

const cloneAttachmentPreviews = async (
  items: ChatAttachment[]
): Promise<ChatAttachment[]> =>
  Promise.all(
    items.map(async (attachment) => {
      if (!attachment.data) return attachment;

      try {
        const blob = await fetch(attachment.data).then((response) =>
          response.blob()
        );
        return {
          ...attachment,
          data: URL.createObjectURL(blob),
        };
      } catch {
        return attachment;
      }
    })
  );

export default function Home() {
    const { t, setLang } = useLanguage(); // 💡 t 함수 꺼내기
  const [isConversationsLoaded, setIsConversationsLoaded] = useState(false);  
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const { data: session, status } = useSession();

  const isSending = false;
  const [focusToken, setFocusToken] = useState(0);

    const [userDefaultEngine, setUserDefaultEngine] = useState<string>(APP_DEFAULTS.defaultModelId);
  const [isUserSettingsLoaded, setIsUserSettingsLoaded] = useState(false);

  const [inputValue, setInputValue] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [promptPayload, setPromptPayload] = useState<{ id: string; text: string; chatId: string; userMessageId: string; attachments: ChatAttachment[] } | null>(null);
  
  // 💡 핵심: 어떤 모델들이 선택되었는지 추적하는 상태 (기본값: GPT)
    const [selectedModels, setSelectedModels] = useState<string[]>([APP_DEFAULTS.defaultModelId]);
  
  // 💡 현재 '일시정지(OFF)' 상태인 모델들을 추적하는 배열
  const [disabledPanels, setDisabledPanels] = useState<string[]>([]);
  const modelSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelSyncAbortRef = useRef<AbortController | null>(null);

  // 💡 프라이빗 모드 전역 상태 관리
  const [isPrivateMode, setIsPrivateMode] = useState(false);

  // 💡 게스트 모드 판별 및 사용량 상태 추가
  const isGuestMode = status !== "loading" && !session?.user;
  const [guestMessageCount, setGuestMessageCount] = useState(0);
  const MAX_GUEST_MESSAGES = 20;

  const isInitialSelectedRef = useRef(false);

    const applyConversationSettings = useCallback((data: {
        selectedModels?: unknown;
        disabledPanels?: unknown;
        messages?: Array<{ role?: string; modelId?: string | null }>;
    }) => {
        const savedModels = normalizeStringArray(data.selectedModels, [userDefaultEngine]);
        const messageModels = Array.isArray(data.messages)
            ? data.messages
                .map((message) => (message.role === "assistant" ? message.modelId : null))
                .filter((modelId): modelId is string => !!modelId)
            : [];

        const nextModels = clampSelectedModels(
            uniqueStrings([...savedModels, ...messageModels])
        );
        const recoveredModels = messageModels.filter((modelId) => !savedModels.includes(modelId));

        setSelectedModels(nextModels.length > 0 ? nextModels : [userDefaultEngine]);
        setDisabledPanels(
            normalizeStringArray(data.disabledPanels, []).filter(
                (modelId) =>
                    nextModels.includes(modelId) &&
                    !recoveredModels.includes(modelId)
            )
        );
    }, [userDefaultEngine]);

// 💡 컴포넌트 마운트 시 오늘 날짜 기준으로 게스트 카운트 초기화 및 로드
  useEffect(() => {
    if (isGuestMode) {
      let cancelled = false;
      queueMicrotask(() => {
      if (cancelled) return;
      setUserDefaultEngine(APP_DEFAULTS.guestDefaultModelId);
      setSelectedModels([APP_DEFAULTS.guestDefaultModelId]);
      const today = new Date().toDateString();
      const storedDate = localStorage.getItem("guest_date");
      
      // 날짜가 바뀌었으면 카운트 초기화
      if (storedDate !== today) {
        localStorage.setItem("guest_date", today);
        localStorage.setItem("guest_count", "0");
        setGuestMessageCount(0);
      } else {
        // 오늘 날짜면 기존 카운트 불러오기
        const count = parseInt(localStorage.getItem("guest_count") || "0", 10);
        setGuestMessageCount(count);
      }

      const savedConversations = localStorage.getItem("guest_conversations");
      if (savedConversations) {
        try {
          const parsed = JSON.parse(savedConversations);
          setConversations(parsed);
          // 저장된 방이 있다면 가장 최근 방을 기본 활성화
          if (parsed.length > 0) {
            setCurrentChatId((currentId) => currentId || parsed[0].id);
          }
        } catch (e) {
          console.error("게스트 대화방 파싱 에러:", e);
        }
      } else {
        // 최초 진입 시 환영 인사를 띄울 기본 게스트 방 하나를 생성해 줍니다.
        const initialChatId = `guest_${Date.now()}`;
        const initialChat = {
          id: initialChatId,
          title: "새 대화 (게스트)",
            selectedModels: [APP_DEFAULTS.guestDefaultModelId],
          disabledPanels: []
        };
        setConversations([initialChat]);
        setCurrentChatId(initialChatId);
        localStorage.setItem("guest_conversations", JSON.stringify([initialChat]));        
      }

      // 로컬 스토리지 조회가 완벽히 끝난 시점에 true로 변경합니다.
      setIsConversationsLoaded(true);      
      });
      return () => {
        cancelled = true;
      };
    }
  }, [isGuestMode]);  

  // 💡 게스트 대화방 목록 상태가 변경될 때마다 로컬 스토리지에 자동 저장
  useEffect(() => {
    if (isGuestMode && isConversationsLoaded && conversations.length > 0) {
      localStorage.setItem("guest_conversations", JSON.stringify(conversations));
    }
  }, [conversations, isGuestMode, isConversationsLoaded]);  

    useEffect(() => {
        if (
            isGuestMode ||
            !isUserSettingsLoaded ||
            conversations.length === 0 ||
            currentChatId ||
            isInitialSelectedRef.current
        ) return;

        const firstConversation = conversations[0];
        isInitialSelectedRef.current = true;

        if (firstConversation.isLocked) {
            queueMicrotask(() => {
                setCurrentChatId(null);
                setSelectedModels([userDefaultEngine]);
                setDisabledPanels([]);
                setPromptPayload(null);
            });
            return;
        }

        let cancelled = false;

        const openInitialConversation = async () => {
            try {
                const res = await fetch(`/api/conversations/${firstConversation.id}`, {
                    cache: "no-store",
                });

                if (!res.ok || cancelled) return;

                const data = await res.json();
                applyConversationSettings(data);
                setCurrentChatId(firstConversation.id);
            } catch (error) {
                if (!cancelled) {
                    console.error("Failed to open initial conversation:", error);
                    applyConversationSettings(firstConversation);
                    setCurrentChatId(firstConversation.id);
                }
            }
        };

        openInitialConversation();

        return () => {
            cancelled = true;
        };
    }, [
        applyConversationSettings,
        conversations,
        currentChatId,
        isGuestMode,
        isUserSettingsLoaded,
        userDefaultEngine,
    ]);

    useEffect(() => {
        const handleSettingsUpdated = (event: Event) => {
            const detail = (event as CustomEvent<UserSettingsUpdatedDetail>).detail;
            if (!detail || !isEnabledModelId(detail.defaultModel)) return;

            setUserDefaultEngine(detail.defaultModel);
            if (!currentChatId) {
                setSelectedModels([detail.defaultModel]);
                setDisabledPanels([]);
            }
        };

        window.addEventListener(
            USER_SETTINGS_UPDATED_EVENT,
            handleSettingsUpdated
        );
        return () => {
            window.removeEventListener(
                USER_SETTINGS_UPDATED_EVENT,
                handleSettingsUpdated
            );
        };
    }, [currentChatId]);

  // 💡 대화방 목록을 서버에서 불러오는 함수 (부모가 관리)
  const fetchConversations = useCallback(async () => {
    // 세션이 없으면(로그인 안 했으면) 굳이 안 불러옵니다.
    if (!session?.user) return;

    try {
	  // 💡 캐시 무효화 옵션 추가
	  const res = await fetch(`/api/conversations`, { cache: "no-store" });
      if (res.ok) setConversations(await res.json());
    } catch (error) {
      console.error("대화 목록을 불러오는 중 오류 발생:", error);
    }
    }, [session?.user]);

    // 최초 페이지 로드 시 목록 가져오기
    useEffect(() => {
        if (session?.user) {
            queueMicrotask(() => setIsUserSettingsLoaded(false));
            queueMicrotask(() => {
                void fetchConversations();
            });

            // 💡 사용자 데이터베이스 설정 로드 파이프라인
            fetch("/api/user/settings")
                .then((res) => {
                    if (!res.ok) throw new Error(`Settings load failed: ${res.status}`);
                    return res.json();
                })
                .then((data) => {
                    if (data && isEnabledModelId(data.defaultModel)) {
                        setUserDefaultEngine(data.defaultModel);
                        // 현재 활성화된 채팅방이 전혀 없을 때만 기본 엔진으로 패널 초기 스위칭
                        if (!currentChatId) {
                            setSelectedModels([data.defaultModel]);
                        }
                    }

                    if (data && data.theme) {
                        if (data.theme === "light") {
                            // 라이트 테마일 때는 dark 클래스 제거
                            document.documentElement.classList.remove("dark");
                        } else {
                            // 다크 테마일 때는 dark 클래스 추가
                            document.documentElement.classList.add("dark");
                        }
                    }

                    if (data && isLanguage(data.language)) {
                        setLang(data.language);
                    }
                })
                .catch((err) => {
                    console.error("사용자 선호 엔진 조회 실패:", err);
                    setUserDefaultEngine(APP_DEFAULTS.defaultModelId);
                    if (!currentChatId) {
                        setSelectedModels([APP_DEFAULTS.defaultModelId]);
                    }
                })
                .finally(() => setIsUserSettingsLoaded(true));
        } else if (status !== "loading") {
            queueMicrotask(() => setIsUserSettingsLoaded(true));
        }
    }, [currentChatId, fetchConversations, session?.user, setLang, status]);

  // + 새 채팅 버튼 클릭 시 호출
    const handleNewChat = () => {
        setIsPrivateMode(false);
  	// 💡 새 채팅을 누르면 패널 상태를 기본 1개 창으로 완벽하게 리셋합니다.
    // 게스트용 독립 방 생성 (handleNewChat)
    if (isGuestMode) {
      const newGuestChat = {
        id: `guest_${Date.now()}`, // 👈 고유 타임스탬프 ID 부여로 다중 방 지원
          title: t("sidebar.autoGeneratedNewRoom"),
          selectedModels: [APP_DEFAULTS.guestDefaultModelId],
        disabledPanels: []
      };
      // 최신 방이 위로 오도록 사이드바 목록 앞에 추가
        setConversations((prev) => [newGuestChat, ...prev]);
      setCurrentChatId(newGuestChat.id);
    } else {
      // 로그인 사용자 기존 로직
        setCurrentChatId(null); // 대화방 ID 초기화
        setSelectedModels([userDefaultEngine]);   // 기본 엔진 하나만 남기기
    }

    setDisabledPanels([]);           // OFF 상태였던 패널 기록 초기화
    setInputValue("");               // 혹시 쓰다 남은 입력창 텍스트 초기화	
      setPromptPayload(null); 		 // 새 채팅 시 과거 질문 완벽 초기화

      setFocusToken((prev) => prev + 1);
  };

  // 사이드바에서 특정 대화방 클릭 시 호출
    const handleSelectConversation = async (id: string) => {
        if (isSending) return;

        // 💡 [검증 안전 가드] 게스트 모드가 아닐 때, 잠겨있는 대화방이면 패스워드 일치성 선행 확인
        if (!isGuestMode) {
            const targetConv = conversations.find((c) => c.id === id);

            if (targetConv && targetConv.isLocked) {
                const inputPwd = prompt(t("sidebar.askPassword"));

                if (inputPwd === null) return; // 취소 시 패널 진입 안 함

                // 백엔드에 패스워드 검증 요청
                try {
                    const verifyRes = await fetch(`/api/conversations/${id}/verify`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ password: inputPwd }),
                    });
                    const verifyData = await verifyRes.json();

                    if (!verifyData.success) {
                        alert(
                            verifyData.code === "LOCK_RATE_LIMITED"
                                ? t("sidebar.lockRateLimited")
                                : t("sidebar.wrongPassword")
                        );
                        return; // 패널 로딩 절차 전면 무력화 및 차단
                    }
                } catch (e) {
                    console.error("검증 에러:", e);
                    return;
                }
            }
        }

      setCurrentChatId(id);
	  setPromptPayload(null); // 방 이동 시 과거 질문 잔재 삭제

	// 💡 사이드바에서 프라이빗 룸을 선택한 경우 브라우저 렌더링만 처리하고 종료
    if (id === "private-chat") {
      setIsPrivateMode(true);
      return;
    }

    setIsPrivateMode(false);

    // 게스트 모드일 때는 서버 통신 없이 로컬 상태에서 패널 설정을 복구합니다.
    if (isGuestMode) {
      const targetConv = conversations.find((c) => c.id === id);
      if (targetConv) {
        // types.tsx에 없는 속성이므로 as any로 캐스팅하여 안전하게 가져옵니다.
          const restoredModels = clampGuestSelectedModels(
            normalizeStringArray(
              targetConv.selectedModels,
              [APP_DEFAULTS.guestDefaultModelId]
            )
          );
          setSelectedModels(
            restoredModels.length
              ? restoredModels
              : [APP_DEFAULTS.guestDefaultModelId]
          );
          setDisabledPanels(
            normalizeStringArray(targetConv.disabledPanels, []).filter(
              (modelId) => restoredModels.includes(modelId)
            )
          );
        }
      return; // 서버 API 호출을 막고 즉시 종료
    }

    if (!session || !session.user) return;

	try {
	  const res = await fetch(`/api/conversations/${id}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
		console.log("✅ [DB Load] 불러온 설정:", data.selectedModels);

		// 데이터가 유효하면 덮어씌우고, 혹시라도 깨져있으면 안전하게 빈 배열로 처리합니다.
          applyConversationSettings(data);
	  }
    } catch (error) {
      console.error("대화방 정보 로드 실패:", error);
    }	

        setFocusToken((prev) => prev + 1);

    };

    // 대화방 잠금 등록 핸들러
    const handleLock = async (id: string, password: string) => {
        try {
            const response = await fetch(`/api/conversations/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password }),
            });
            if (!response.ok) {
                const data = await response.json().catch(() => null);
                alert(
                    data?.code === "INVALID_LOCK_PASSWORD"
                        ? t("sidebar.passwordLength")
                        : t("sidebar.wrongPassword")
                );
                return;
            }
            setConversations((prev) =>
                prev.map((c) => (c.id === id ? { ...c, isLocked: true } : c))
            );
        } catch (e) {
            console.error("잠금 설정 에러:", e);
        }
    };

    // 대화방 잠금 해제 핸들러
    const handleUnlock = async (id: string) => {
        const targetConv = conversations.find((c) => c.id === id);
        if (!targetConv?.isLocked) return;

        const currentPassword = prompt(t("sidebar.askPassword"));
        if (currentPassword === null) return;

        try {
            const response = await fetch(`/api/conversations/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password: null, currentPassword }),
            });
            if (!response.ok) {
                const data = await response.json().catch(() => null);
                alert(
                    data?.code === "LOCK_RATE_LIMITED"
                        ? t("sidebar.lockRateLimited")
                        : t("sidebar.wrongPassword")
                );
                return;
            }
            setConversations((prev) =>
                prev.map((c) => (c.id === id ? { ...c, isLocked: false } : c))
            );
        } catch (e) {
            console.error("잠금 해제 에러:", e);
        }
    };

  // 💡 대화방 이름 변경 요청
  const handleRename = async (id: string, newTitle: string) => {
    if (isGuestMode) {
        setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title: newTitle } : c))
      );
    } else {      
      try {
        await fetch(`/api/conversations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: newTitle }),
        });
        fetchConversations(); // 목록 새로고침
      } catch (error) {
        console.error("이름 변경 중 오류:", error);
      }
    }
  };

  // 💡 대화방 삭제 요청
  const handleDelete = async (id: string) => {
      const confirmDelete = confirm(t("sidebar.deleteConfirm"));
    if (!confirmDelete) return;

    if (isGuestMode) {
      const updated = conversations.filter((c) => c.id !== id);
      setConversations(updated);
      localStorage.removeItem(`guest_messages_${id}`); // 💡 삭제된 방의 메시지 스토리지도 깔끔히 청소
      
      // 현재 열려있는 방을 지웠다면 다른 방으로 포커스 이동
      if (currentChatId === id) {
        setCurrentChatId(updated.length > 0 ? updated[0].id : null);
      }
      if (updated.length === 0) {
        localStorage.removeItem("guest_conversations");
      }
    } else {    
      try {
        await fetch(`/api/conversations/${id}`, {
          method: "DELETE",
        });
        
        // 만약 현재 보고 있던 방을 지웠다면, '새 채팅' 화면으로 초기화
        if (currentChatId === id) {
          handleNewChat();
        }
        fetchConversations(); // 목록 새로고침
      } catch (error) {
        console.error("대화방 삭제 에러:", error);
      }
    }
  };
  
  // 💡 모델 세팅 상태가 변경되면 서버 DB에 실시간 동기화 요청 (PATCH)
  const syncModelSettingsToServer = (targetChatId: string, updatedModels: string[], updatedDisabled: string[]) => {
    if (!targetChatId || targetChatId === "private-chat") return; // 새 채팅 상태일 때는 생성 전이므로 패스, 프라이빗 저장 금지
    if (!session || !session.user) return;

    if (modelSyncTimerRef.current) {
      clearTimeout(modelSyncTimerRef.current);
    }
    modelSyncAbortRef.current?.abort();

    modelSyncTimerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      modelSyncAbortRef.current = controller;
      try {
        const models = clampSelectedModels(updatedModels);
        const disabled = uniqueStrings(updatedDisabled).filter((modelId) =>
          models.includes(modelId)
        );
        const response = await fetch(`/api/conversations/${targetChatId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            selectedModels: models,
            disabledPanels: disabled,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Model settings sync failed: ${response.status}`);
        }
      } catch (error: unknown) {
        if (!(error instanceof Error) || error.name !== "AbortError") {
          console.error("모델 세팅 동기화 실패:", error);
        }
      }
    }, 250);
  };  
  
  // 💡 메시지 전송 함수
  const handleGlobalSubmit = async () => {
    const trimmed = inputValue.trim();
    if ((!trimmed && attachments.length === 0) || selectedModels.length === 0) return;
    const promptAttachments = await cloneAttachmentPreviews(attachments);
	
    if (isGuestMode) {
      if (guestMessageCount >= MAX_GUEST_MESSAGES) {
          alert(t("sidebar.exceedDailyLimit"));
        return; // 전송 차단
      }
      
      // 전송 로직이 실행될 때 카운트 증가
      const newCount = guestMessageCount + 1;
      setGuestMessageCount(newCount);
      localStorage.setItem("guest_count", newCount.toString());
    }

	// 💡 [프라이빗 분기]: 프라이빗 모드일 경우 서버 통신을 완전히 생략하고 페이로드만 전송
    if (isPrivateMode) {
      setPromptPayload({ 
        id: Date.now().toString(), 
        text: trimmed, 
        chatId: "private-chat",
        userMessageId: crypto.randomUUID(),
        attachments: promptAttachments,
      });
      setInputValue("");
      setAttachments([]);
      return;
    }	
	
	let activeChatId = currentChatId;

	// 현재 선택된 방이 없다면(새 채팅이라면), 부모가 대표로 딱 한 번만 방을 생성합니다!
    if (!activeChatId) {
      if (isGuestMode) {
        // 1. 게스트 모드인 경우 DB에 방을 만들지 않고 임시 가상 ID를 부여합니다.
        activeChatId = "guest-chat";
        setCurrentChatId(activeChatId);
      } else {      
      try {
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            title: (trimmed || attachments[0]?.name || t("chat.newChat")).slice(0, 30),
            selectedModels,
            disabledPanels
          }),
        });
        
        if (res.ok) {
          const data = await res.json();
          activeChatId = data.id; // 💡 새로 만들어진 1개의 방 ID 확보
          setCurrentChatId(activeChatId);
          fetchConversations(); // 사이드바 목록 갱신
        }
      } catch (error) {
        console.error("대화방 생성 중 오류:", error);
        return; // 생성 실패 시 진행 중단
      }
    }
    }
    
    // 생성되거나 기존에 있던 딱 1개의 방 ID(activeChatId)를 자식들에게 신호로 내려줍니다.
    if (activeChatId) {
	  const userMsgId = crypto.randomUUID(); // 고유 유저 메시지 ID 생성

    // 게스트 모드가 아닐 때만 유저 메시지를 DB에 선저장합니다!
      if (!isGuestMode) {
      try {
        // 💡 부모가 대표로 메시지 저장 요청을 먼저 수행
        await fetch(`/api/conversations/${activeChatId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            messages: [{
              id: userMsgId,
              role: "user",
              content: trimmed || attachments.map((item) => item.name).join(", "),
            }]
          }),
        });
      } catch (e) {
        console.error("유저 메시지 선저장 에러:", e);
      }
    }

      // 자식들에게 생성된 방 ID와 유저 메시지 ID 신호를 공유합니다.
      setPromptPayload({ 
        id: Date.now().toString(), 
        text: trimmed, 
        chatId: activeChatId,
        userMessageId: userMsgId,
        attachments: promptAttachments,
      });
      setInputValue("");
      setAttachments([]);
    }
  };

  // 💡 프라이빗 모드 온오프 스위치 함수
  const togglePrivateModeGlobal = () => {
    if (isPrivateMode) {
      handleNewChat();
    } else {
      setIsPrivateMode(true);
      setCurrentChatId("private-chat");
    }
  };

  // 💡 입력창에서 모델을 켜고 끄는 함수
  const toggleModel = (modelId: string) => {
    if (
      isGuestMode &&
      !clampGuestSelectedModels([modelId]).includes(modelId)
    ) {
      return;
    }
	let nextModels = [...selectedModels];
    let nextDisabled = [...disabledPanels];

	if (nextModels.includes(modelId)) {
      if (nextModels.length === 1) return; 
      nextModels = nextModels.filter((id) => id !== modelId);
      nextDisabled = nextDisabled.filter((id) => id !== modelId); // 삭제된 모델은 OFF 목록에서도 깔끔히 치워줍니다
    } else {
        if (nextModels.length >= MAX_SELECTED_MODELS) {
            alert(t("chat.maxModelCompare"));
            return;
        }

        nextModels.push(modelId);
      }
    
    nextModels = clampSelectedModels(nextModels);
	setSelectedModels(nextModels);
    setDisabledPanels(nextDisabled);
    // 💡 현재 열려있는 방(currentChatId)이 있을 때만 서버에 동기화하도록 안전하게 묶어줍니다!
    if (currentChatId && currentChatId !== "private-chat") {
      syncModelSettingsToServer(currentChatId, nextModels, nextDisabled);
    }
  };

  // 💡 완전히 창을 닫고 데이터베이스 기록을 날려버리는 기능 추가
  const handleRemoveModel = async (modelId: string) => {
    const modelName = AVAILABLE_MODELS.find(m => m.id === modelId)?.name || modelId;
      if (!confirm(`[${modelName}] ${t("sidebar.closePanel")}`)) return;

    const nextModels = selectedModels.filter((id) => id !== modelId);
    const nextDisabled = disabledPanels.filter((id) => id !== modelId);
    
    setSelectedModels(nextModels);
    setDisabledPanels(nextDisabled);
    
    if (currentChatId) {
      syncModelSettingsToServer(currentChatId, nextModels, nextDisabled);
      try {
        // 백엔드 삭제 API 호출
        await fetch(`/api/conversations/${currentChatId}/messages?modelId=${modelId}`, {
          method: "DELETE"
        });
      } catch (error) {
        console.error("기록 삭제 실패:", error);
      }
    }
  };

  // 💡 패널의 상태(ON/OFF)를 전환하는 함수
  const togglePanelDisable = (modelId: string) => {
    setDisabledPanels((currentDisabled) => {
      const nextDisabled = currentDisabled.includes(modelId)
        ? currentDisabled.filter((id) => id !== modelId)
        : [...currentDisabled, modelId];

      if (currentChatId) {
        syncModelSettingsToServer(currentChatId, selectedModels, nextDisabled);
      }
      return nextDisabled;
    });
  };
  
  // 💡 특정 패널의 모델을 다른 모델로 스위칭하는 함수
  const changePanelModel = (oldModelId: string, newModelId: string) => {
    if (newModelId !== oldModelId && selectedModels.includes(newModelId)) {
      return;
    }
    // 1. 선택된 모델 배열에서 옛날 ID를 새 ID로 교체합니다.
	const nextModels = clampSelectedModels(
      selectedModels.map((id) => (id === oldModelId ? newModelId : id))
    );
    let nextDisabled = [...disabledPanels];
    
    // 2. 만약 해당 패널이 일시정지(OFF) 상태였다면, 바뀐 모델도 일시정지 상태를 유지해줍니다.
    if (nextDisabled.includes(oldModelId)) {
      nextDisabled = [...nextDisabled.filter((id) => id !== oldModelId), newModelId];
    }

    setSelectedModels(nextModels);
    setDisabledPanels(nextDisabled);
	if (currentChatId) syncModelSettingsToServer(currentChatId, nextModels, nextDisabled);
  };  
  
  // 💡 사이드바 리스트 믹싱: 프라이빗 모드가 활성화되어 있다면 임시 룸을 최상단에 강제 주입합니다.
    const blendedConversations = conversations; 
  
    const handleDownloadConversation = (convId: string) => {
        if (isGuestMode) return;
        window.location.href = `/api/conversations/${convId}/export`;
    };

  // 💡 공유하기 링크 생성 로직
    const handleShareConversation = async (convId: string) => {
        if (isGuestMode) return;

        try {
            const res = await fetch(`/api/conversations/${convId}/share`, {
                method: "POST",
            });
            const data = await res.json().catch(() => null);

            if (!res.ok) {
                alert(
                    res.status === 423 ||
                        data?.code === "CONVERSATION_LOCKED"
                        ? t("sidebar.shareLocked")
                        : t("sidebar.shareFailed")
                );
                return;
            }

            setConversations((prev) =>
                prev.map((conversation) =>
                    conversation.id === convId
                        ? {
                            ...conversation,
                            shareEnabled: true,
                            shareExpiresAt: data.expiresAt || null,
                        }
                        : conversation
                )
            );
            await navigator.clipboard.writeText(data.url);
            alert(t("sidebar.shareCopied"));
        } catch {
            alert(t("sidebar.shareFailed"));
        }
    };

    const handleRevokeShare = async (convId: string) => {
        if (
            isGuestMode ||
            !confirm(t("sidebar.revokeShareConfirm"))
        ) {
            return;
        }

        const response = await fetch(
            `/api/conversations/${convId}/share`,
            { method: "DELETE" }
        );
        if (!response.ok) {
            alert(t("sidebar.shareRevokeFailed"));
            return;
        }

        setConversations((prev) =>
            prev.map((conversation) =>
                conversation.id === convId
                    ? {
                        ...conversation,
                        shareEnabled: false,
                        shareExpiresAt: null,
                    }
                    : conversation
            )
        );
        alert(t("sidebar.shareRevoked"));
    };

  return (
      <main className="flex h-screen overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <ChatSidebar 
        conversations={blendedConversations} // 동기화된 리스트 전달
        currentChatId={currentChatId}  // 현재 활성화된 방 ID 전달 (UI 하이라이트용)
        onNewChat={handleNewChat}
        onSelectConversation={handleSelectConversation}
		    onRename={handleRename}
        onDelete={handleDelete}		
        isGuestMode={isGuestMode} 
        guestMessageCount={guestMessageCount} 
              maxGuestMessages={MAX_GUEST_MESSAGES}        
              onLock={handleLock}     
              onUnlock={handleUnlock} 
onShare={handleShareConversation}
              onRevokeShare={handleRevokeShare}
              onDownload={handleDownloadConversation}              
              isPrivateMode={isPrivateMode}
              onTogglePrivateMode={togglePrivateModeGlobal}
      />

      <section className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">        
        {/* 💡 동적 화면 분할 영역 */}
              <div className="flex flex-1 min-h-0 overflow-hidden gap-4 bg-zinc-100/80 px-4 pb-4 pt-4 dark:bg-zinc-950">

		{/* 켜진 패널이 하나도 없을 때 보여줄 예쁜 안내 문구 */}
          {selectedModels.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center text-zinc-500 select-none">
              <div className="text-4xl mb-4 opacity-50">🤖</div>
                          <p className="text-sm font-medium">{t("chat.inactivePanel")}</p>
                          <p className="text-xs mt-1 opacity-70">{t("chat.chooseModel")}</p>
            </div>
          )}
		  
		{selectedModels.map((modelId) => {
            const modelInfo = AVAILABLE_MODELS.find(m => m.id === modelId);
			const isPanelDisabled = disabledPanels.includes(modelId);
            
			return (
                <React.Fragment key={modelId}>               
                    {/* 💡 패널이 OFF일 때 너비를 w-44(약 176px)으로 축소시킵니다 */}
                <div className={`flex flex-col bg-white border border-zinc-200 dark:bg-zinc-950 dark:border-zinc-800 rounded-2xl overflow-hidden relative transition-all duration-300 ease-in-out shadow-sm shadow-zinc-200/60 dark:shadow-black/20 ${isPanelDisabled ? "w-44 shrink-0" : "flex-1 min-w-0"
                }`}>
				  {/* 💡 모델 이름과 ON/OFF 토글 버튼이 있는 헤더 */}
                  {(
                      <div className="flex min-h-12 items-center justify-between shrink-0 border-b border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-400">
                      <div className={`flex flex-1 min-w-0 items-center gap-2 transition-opacity ${isPanelDisabled ? 'opacity-50' : ''}`}>
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-xs font-semibold text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-zinc-700">
                          {modelInfo?.icon}
                        </span>
                        
						{/* 💡 2. OFF 상태일 때는 일반 텍스트로 렌더링하고, 넘치는 글자는 말줄임표 처리 */}
                        {isPanelDisabled ? (
                          <span className="min-w-0 flex flex-col truncate select-none">
                            <span className="truncate text-sm font-semibold text-zinc-600 dark:text-zinc-300">{modelInfo?.name}</span>
                            <span className="truncate text-[10px] font-medium text-zinc-400">{modelInfo?.provider}</span>
                          </span>
                        ) : (
                        // ON 상태일 때는 기존처럼 드롭다운 렌더링
                        <span className="min-w-0 flex flex-col">
                          <select
                            value={modelId}
                            onChange={(e) => changePanelModel(modelId, e.target.value)}
                            disabled={isPanelDisabled} // 패널이 OFF일 때는 모델 변경 막기
                            className="min-w-0 cursor-pointer truncate bg-transparent text-sm font-semibold text-zinc-800 outline-none hover:text-zinc-950 dark:text-zinc-100 dark:hover:text-white"
                          >
                            {ENABLED_MODELS.map((m) => {
                              // 이미 다른 패널에 켜져 있는 모델인지 확인
                              const isAlreadyUsed = selectedModels.includes(m.id) && m.id !== modelId;
                              return (
                                <option 
                                  key={m.id} 
                                  value={m.id}
                                  disabled={isAlreadyUsed}
                                  className="bg-zinc-900 text-zinc-100"
                                >
                                      {m.name} {isAlreadyUsed ? t("chat.inUsed") : ""}
                                </option>
                              );
                            })}
                          </select>
                          <span className="truncate text-[10px] font-medium text-zinc-400">
                            {modelInfo?.provider} · {modelInfo?.tier}
                          </span>
                        </span>
						)}
                      </div>

					  <div className="flex items-center gap-2 shrink-0">

					{/* 💡 [패널 제어 버튼 조건부 렌더링]: 패널이 2개 이상일 때만 ON/OFF 및 X 버튼 노출 */}
                    {selectedModels.length > 1 && (
                      <>                      
					  {/* ON/OFF 버튼과 닫기(X) 버튼 그룹화 */}
                      <button
                        onClick={() => togglePanelDisable(modelId)}
                        className="cursor-pointer flex items-center gap-2 rounded-full px-2 py-1 hover:bg-zinc-100 transition-colors dark:hover:bg-zinc-800"
                        title={isPanelDisabled ? "대화 다시 켜기" : "대화 일시정지"}
                      >
                        <span className="text-[10px] font-bold text-zinc-500">
                          {isPanelDisabled ? "OFF" : "ON"}
                        </span>
                        <div className={`h-4 w-8 rounded-full p-0.5 transition-colors ${!isPanelDisabled ? "bg-blue-500" : "bg-zinc-700"}`}>
                          <div className={`h-3 w-3 rounded-full bg-white transition-transform ${!isPanelDisabled ? "translate-x-4" : "translate-x-0"}`} />
                        </div>
                      </button>
					  
					  <div className="w-[1px] h-4 bg-zinc-200 dark:bg-zinc-700/50"></div>
                      
                      <button
                        onClick={() => handleRemoveModel(modelId)}
                        className="cursor-pointer flex items-center justify-center p-1.5 rounded-full text-zinc-500 hover:bg-red-500/10 hover:text-red-500 transition-colors"
                        title="창 닫기 (기록 삭제)"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18"></line>
                          <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                      </button>	
					  </>
                    )}					  
                    </div>
					</div>
                  )}
                  
                  <ChatApp 
                    key={`${modelId}:${currentChatId || "new"}`}
				            modelId={modelId}
                    initialConversationId={currentChatId} 
                    promptPayload={promptPayload}
					          isPanelDisabled={isPanelDisabled}
                    isGuestMode={isGuestMode}
                  />
                </div>
              </React.Fragment>
            );
          })}
        </div>

        {/* 💡 하단에 통합된 글로벌 입력창 */}
        <ChatInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleGlobalSubmit}
          onCancel={() => {}} 
          isSending={isSending}
		      focusToken={focusToken}		  
          selectedModels={selectedModels}
          onToggleModel={toggleModel}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          canAttach={!isGuestMode}
          isGuestMode={isGuestMode}
          isGuestLimitReached={isGuestMode && guestMessageCount >= MAX_GUEST_MESSAGES}          
        />
      </section>
    </main>
  );
}
