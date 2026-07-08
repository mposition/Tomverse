"use client";

import { useEffect, useRef, useState } from "react";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import { Message } from "@/components/chat/types";
import { useSession } from "next-auth/react";
import { useLanguage } from "@/components/LanguageProvider";

type ChatAppProps = {
  modelId: string; // 💡 부모가 내려준 정체성(modelId)을 받습니다.
  initialConversationId?: string | null;
  onConversationCreated?: (id: string) => void; // 💡 새 방이 파졌을 때 부모에게 일러바칠 함수
  promptPayload?: { id: string; text: string; chatId: string; userMessageId: string } | null; // 💡 부모로부터 전달받을 공통 프롬프트 페이로드 (중복 방지를 위해 id 포함)
  isPanelDisabled?: boolean; // 💡 현재 패널이 비활성화(OFF) 상태인지 여부
  isGuestMode?: boolean; // 💡 게스트 모드 여부 추가  
};

export function ChatApp({ modelId, initialConversationId = null, onConversationCreated, promptPayload, isPanelDisabled = false, isGuestMode = false }: ChatAppProps) {
  const [isMessagesLoaded, setIsMessagesLoaded] = useState(false);
  const { data: session } = useSession();
    const { t, lang, setLang } = useLanguage(); // 💡 t 함수 꺼내기

  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
          content: t("chat.welcome"),
	  status: "normal",
    },
  ]);
  
  const [isSending, setIsSending] = useState(false);
  // 💡 컴포넌트가 태어날 때 들고 온 기존 payload.id를 이미 '처리 완료'된 것으로 간주합니다!
  const [lastProcessedPromptId, setLastProcessedPromptId] = useState<string>(promptPayload?.id || "");
  
  // 💡 화면 덮어씌움(리셋) 방지를 위한 똑똑한 Ref 추가
  const isSendingRef = useRef(false);
  const streamingChatIdRef = useRef<string | null>(null);
  const lastFetchedChatIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
    const loadedChatIdRef = useRef<string | null>(null); // 현재 성공적으로 불러온 방 ID를 기억합니다.

// 💡 현재 인스턴스가 프라이빗 모드방에 속해있는지 확인
  const isPrivate = initialConversationId === "private-chat";

  // 💡 부모로부터 새로운 질문 신호가 들어오면 감지해서 전송 로직을 실행합니다.
  useEffect(() => {
    if (!isGuestMode && !session?.user) return;

    if (promptPayload && promptPayload.id !== lastProcessedPromptId) {
      setLastProcessedPromptId(promptPayload.id);
      
	  if (!isPanelDisabled) {
		// 💡 부모가 이미 저장해 둔 고유 유저 메시지 ID를 바인딩해서 넘깁니다.
        handleSendPrompt(promptPayload.text, promptPayload.chatId, promptPayload.userMessageId);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptPayload, lastProcessedPromptId, isPanelDisabled]);

  const setAssistantMessage = (id: string, content: string, status?: Message["status"]) => {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === id ? { ...message, content, status } : message
      )
    );
  };

  // 💡 DB에서 대화 내역을 불러오는 로직, 부모의 ID가 변경(새채팅 클릭 혹은 사이드바 클릭)될 때 호출되는 동기화 로직
    useEffect(() => {
        if (!isPrivate && !isGuestMode && (!session || !session.user)) {
        return;
    }

	  let isMounted = true;

    // 💡 프라이빗 모드방일 경우: 서버 API 호출을 차단하고 웰컴 메시지만 상시 유지
    if (isPrivate) {
      lastFetchedChatIdRef.current = "private-chat";
        setMessages([{ id: "welcome", role: "assistant", content: t("chat.welcome"), status: "normal" }]);
      return;
    }

    if (isGuestMode) {
      // 💡 방이 바뀌거나 새로고침될 때 우선 저장 락을 걸기 위해 false로 초기화
      setIsMessagesLoaded(false);

        if (initialConversationId) {
            loadedChatIdRef.current = initialConversationId; // 로드 성공한 방 ID 도장 찍기!

        // 방 ID와 모델 ID를 조합하여 멀티 패널 및 다중 대화방 완벽 격리
        const storageKey = `guest_messages_${initialConversationId}_${modelId}`;
        const savedMessages = localStorage.getItem(storageKey);
        if (savedMessages) {
          try {
            setMessages(JSON.parse(savedMessages));
          } catch (e) {
            console.error("메시지 로드 실패:", e);
            setMessages([]);
          }
        } else {
          // 최초 대화방 진입 시 시스템 환영 인사 주입
          setMessages([
            { id: "welcome", role: "assistant", content: t("chat.guestWelcome"), status: "normal" }
          ]);
        }
      } else {
        setMessages([]);
      }

      // 불러오기 바인딩이 끝난 시점에만 락을 해제합니다.
      setIsMessagesLoaded(true);
      return; // 백엔드 API 통신 원천 차단
    }

    // 2. 일반 로그인 사용자용 기존 백엔드 API 로드 로직 실행
    // 사이드바에서 다른 대화방을 클릭하여 넘어온 경우
  	if (initialConversationId && initialConversationId !== lastFetchedChatIdRef.current && initialConversationId !== "guest-chat") {
      lastFetchedChatIdRef.current = initialConversationId;
	  
      const fetchPastMessages = async () => {
        try {
		      const response = await fetch(`/api/conversations/${initialConversationId}`, { 
            cache: "no-store",
            headers: { 'Cache-Control': 'no-cache' }
          });			
          if (response.ok) {
            const data = await response.json();
			    if (isMounted) {              
              // 방금 새로 만든 방이어서 현재 답변을 전송(스트리밍) 중이라면, 
              // 아직 DB 저장이 안 된 빈 데이터를 가져와서 화면을 덮어씌우지 않고 무시합니다!
              if (isSendingRef.current && streamingChatIdRef.current === initialConversationId) {
                return; 
              }
          }

          if (data.messages && data.messages.length > 0) {
				    // 자기 모델의 답변만 걸러냅니다!
            const filteredMessages: Message[] = [];
            const seenUserIds = new Set(); // 유저 질문 중복 렌더링 방지용
				    let hasMyAssistantMsg = false;

            // 💡 현재 모델이 작성한 답변이 DB에 하나라도 있는지 검사합니다.
            for (const msg of data.messages) {
              if (msg.role === "assistant" && (!msg.modelId || msg.modelId === modelId)) {
                hasMyAssistantMsg = true;
                break;
              }
            }

				    // 💡 내 답변이 단 하나도 없다면? (기록을 지우고 다시 켠 상태) -> 완벽한 Blank 화면!
            if (!hasMyAssistantMsg) {
              setMessages([{ id: "welcome", role: "assistant", content: t("chat.welcome"), status: "normal" }]);
            } else {				
              for (const msg of data.messages) {
                if (msg.role === "user") {
                  if (!seenUserIds.has(msg.id)) {
                    seenUserIds.add(msg.id);
                    filteredMessages.push(msg);
                  }
                } 
                // 💡 AI 답변일 경우, 내 modelId와 일치하는 것만 통과시킵니다.
                else if (msg.role === "assistant" && msg.modelId === modelId) {
                  filteredMessages.push(msg);
					      }
					    }
				    }
				
              setMessages(filteredMessages.length > 0 ? filteredMessages : [{ id: "welcome", role: "assistant", content: t("chat.welcome"), status: "normal" }]);
          } else {
              setMessages([{ id: "welcome", role: "assistant", content: t("chat.welcome"), status: "normal" }]);
          }
        }
      } catch (error) {
        console.error("메시지를 불러오는 중 오류 발생:", error);
      }
    };

      fetchPastMessages();
  } 
    // 부모가 '새 채팅' 상태(null)로 명령을 내린 경우 내부 상태 완전 초기화
    else {
	    lastFetchedChatIdRef.current = null;
	  
	    // 새로운 채팅일 경우에만 화면 리셋 (단, 전송 중이 아닐 때만)
        setMessages([
        {
          id: "welcome",
          role: "assistant",
                content: t("chat.welcome"),
          status: "normal",
        },
        ]);
    }
	
	  return () => {
      isMounted = false;
    };	
  }, [initialConversationId, isPrivate, isGuestMode, session?.user?.email]);
  
  // 💡 [여기에 새로 추가해 주세요!] 게스트 모드 메시지 자동 저장 로직
  useEffect(() => {
      if (isGuestMode && initialConversationId && isMessagesLoaded && messages.length > 0) {
          if (loadedChatIdRef.current === initialConversationId) {
              const storageKey = `guest_messages_${initialConversationId}_${modelId}`;
              localStorage.setItem(storageKey, JSON.stringify(messages));
          }
    }
  }, [messages, isGuestMode, initialConversationId, modelId, isMessagesLoaded]);

  // 메시지를 DB에 저장하는 함수
  const saveMessages = async (convId: string, assistantMsg: Message) => {
    // 💡 프라이빗 모드일 시 서버 DB 저장을 원천 차단합니다!
    if (convId === "private-chat"|| isGuestMode) return;
	
    await fetch(`/api/conversations/${convId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [assistantMsg] }),
    });
  };
  
  const handleSendPrompt = async (text: string, targetChatId: string, userMsgId: string) => {
  	if (!text || isSendingRef.current) return; // 💡 isSending 대신 즉각적인 Ref 사용

    // 💡 전송 시작 상태를 즉시 기록합니다.
    setIsSending(true);
	isSendingRef.current = true;
    streamingChatIdRef.current = targetChatId;
	
    const userMessage: Message = {
      id: userMsgId,
      role: "user",
      content: text,
	  status: "normal",
    };

    const assistantMessageId = crypto.randomUUID();
	// 💡 생성하는 답변에 내 꼬리표(modelId)를 달아줍니다!
    const assistantMessage: Message = { 
		id: assistantMessageId, 
		role: "assistant", 
		content: "", 
		status: "normal", 
		modelId: modelId 
	};
	
    setMessages((prev) => [
      ...prev,
      userMessage,
      assistantMessage,
    ]);

    setIsSending(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const timeoutId = window.setTimeout(() => {
      controller.abort();
    }, 30000);
	
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [...messages, userMessage],
		  modelId: modelId
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`서버 오류: ${response.status}`);
      }

      if (!response.body) {
        throw new Error("응답 본문이 없습니다.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        assistantText += decoder.decode(value, { stream: true });
		setAssistantMessage(assistantMessageId, assistantText, "normal");
      }

	  if (!assistantText.trim()) {
        setAssistantMessage(
          assistantMessageId,
          "응답은 왔지만 내용이 비어 있습니다.",
          "error"
        );
      }	else {
        // 응답이 정상적으로 끝난 후 DB에 저장
        await saveMessages(targetChatId, {
		  ...assistantMessage,
          content: assistantText,
          modelId: modelId
        });
      }  
    } catch (error: any) {
      if (error?.name === "AbortError") {
        setAssistantMessage(
          assistantMessageId,
          "답변 생성이 중단되었습니다.",
          "cancelled"
        );
      } else {
        console.error(error);
        setAssistantMessage(
          assistantMessageId,
          "오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
          "error"
        );
      }	
    } finally {
	  window.clearTimeout(timeoutId);

	  // 💡 전송 완료 시 상태 해제
      setIsSending(false);
      isSendingRef.current = false;
      streamingChatIdRef.current = null;
      abortControllerRef.current = null;
    }
  };

  const handleCancel = () => {
    abortControllerRef.current?.abort();
  };

  return (
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* 💡 패널이 켜져있을 때만 채팅 내역을 보여주고, 꺼지면 최소화 UI를 보여줍니다 */}
      {!isPanelDisabled ? (
        <div className="flex-1 min-h-0 overflow-hidden">
		  {/* 💡 isPrivate 플래그를 전달하여 상단 경고 문구 활성화 */}
          <ChatMessageList messages={messages} isPrivate={isPrivate} isGuestMode={isGuestMode}/>
	    </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center p-4 select-none">
          <div className="text-4xl mb-3 opacity-20 text-zinc-500">💤</div>
          <div className="text-xs text-zinc-600 font-medium text-center break-keep">
            일시정지됨
          </div>
        </div>
      )}
    </div>
  );
}
