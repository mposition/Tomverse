"use client";

import React, { useState, useEffect } from "react";
import { ChatApp } from "@/components/chat/ChatApp";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ChatInput } from "@/components/chat/ChatInput";
import { Conversation, AVAILABLE_MODELS } from "@/components/chat/types";

export default function Home() {
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  
  const [isSending, setIsSending] = useState(false);
  const [focusToken, setFocusToken] = useState(0);

  const [inputValue, setInputValue] = useState("");
  const [promptPayload, setPromptPayload] = useState<{ id: string; text: string; chatId: string; userMessageId: string } | null>(null);
  
  // 💡 핵심: 어떤 모델들이 선택되었는지 추적하는 상태 (기본값: GPT)
  const [selectedModels, setSelectedModels] = useState<string[]>(["gpt-4o"]);
  
  // 💡 현재 '일시정지(OFF)' 상태인 모델들을 추적하는 배열
  const [disabledPanels, setDisabledPanels] = useState<string[]>([]);
  
  // 💡 대화방 목록을 서버에서 불러오는 함수 (부모가 관리)
  const fetchConversations = async () => {
    try {
      const res = await fetch("/api/conversations");
      if (res.ok) {
        const data = await res.json();
        setConversations(data);
      }
    } catch (error) {
      console.error("대화 목록을 불러오는 중 오류 발생:", error);
    }
  };

  // 최초 페이지 로드 시 목록 가져오기
  useEffect(() => {
    fetchConversations();
  }, []);

  // + 새 채팅 버튼 클릭 시 호출
  const handleNewChat = () => {
    setCurrentChatId(null);	// 대화방 ID 초기화

	// 💡 새 채팅을 누르면 패널 상태를 기본 1개 창으로 완벽하게 리셋합니다.
    setSelectedModels(["gpt-4o"]);   // 기본 엔진 하나만 남기기
    setDisabledPanels([]);           // OFF 상태였던 패널 기록 초기화
    setInputValue("");               // 혹시 쓰다 남은 입력창 텍스트 초기화	
	setPromptPayload(null); 		 // 새 채팅 시 과거 질문 완벽 초기화
  };

  // 사이드바에서 특정 대화방 클릭 시 호출
  const handleSelectConversation = async (id: string) => {
    setCurrentChatId(id);
	setPromptPayload(null); // 방 이동 시 과거 질문 잔재 삭제

	try {
      const res = await fetch(`/api/conversations/${id}`);
      if (res.ok) {
        const data = await res.json();
        // 대화방에 귀속되어 있던 모델 종류와 ON/OFF 상태 복원!
        if (data.selectedModels) setSelectedModels(data.selectedModels);
        if (data.disabledPanels) setDisabledPanels(data.disabledPanels);
      }
    } catch (error) {
      console.error("대화방 정보 로드 실패:", error);
    }	
  };

  // 💡 대화방이 생성되면 부모 상태를 동기화하고 리스트를 새로고침합니다.
  const handleConversationCreated = (id: string) => {
    setCurrentChatId(id);
    fetchConversations(); 
  };

  // 💡 대화방 이름 변경 요청
  const handleRename = async (id: string, newTitle: string) => {
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
  };

  // 💡 대화방 삭제 요청
  const handleDelete = async (id: string) => {
    const confirmDelete = confirm("이 대화방을 삭제하시겠습니까?");
    if (!confirmDelete) return;

    try {
      await fetch(`/api/conversations/${id}`, {
        method: "DELETE",
      });
      
      // 만약 현재 보고 있던 방을 지웠다면, '새 채팅' 화면으로 초기화
      if (currentChatId === id) {
        setCurrentChatId(null);
      }
      fetchConversations(); // 목록 새로고침
    } catch (error) {
      console.error("삭제 중 오류:", error);
    }
  };
  
  // 💡 모델 세팅 상태가 변경되면 서버 DB에 실시간 동기화 요청 (PATCH)
  const syncModelSettingsToServer = async (updatedModels: string[], updatedDisabled: string[]) => {
    if (!currentChatId) return; // 새 채팅 상태일 때는 생성 전이므로 패스
    try {
      await fetch(`/api/conversations/${currentChatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedModels: updatedModels,
          disabledPanels: updatedDisabled
        }),
      });
    } catch (error) {
      console.error("모델 세팅 동기화 실패:", error);
    }
  };  
  
  const handleGlobalSubmit = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || selectedModels.length === 0) return;
	
	let activeChatId = currentChatId;

	// 현재 선택된 방이 없다면(새 채팅이라면), 부모가 대표로 딱 한 번만 방을 생성합니다!
    if (!activeChatId) {
      try {
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            title: trimmed.slice(0, 30),
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
    
    // 생성되거나 기존에 있던 딱 1개의 방 ID(activeChatId)를 자식들에게 신호로 내려줍니다.
    if (activeChatId) {
	  const userMsgId = crypto.randomUUID(); // 고유 유저 메시지 ID 생성
      
      try {
        // 💡 부모가 대표로 메시지 저장 요청을 먼저 수행
        await fetch(`/api/conversations/${activeChatId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            messages: [{ id: userMsgId, role: "user", content: trimmed }] 
          }),
        });
      } catch (e) {
        console.error("유저 메시지 선저장 에러:", e);
      }

      // 자식들에게 생성된 방 ID와 유저 메시지 ID 신호를 공유합니다.
      setPromptPayload({ 
        id: Date.now().toString(), 
        text: trimmed, 
        chatId: activeChatId,
        userMessageId: userMsgId 
      });
      setInputValue("");
    }
  };

  // 💡 입력창에서 모델을 켜고 끄는 함수
  const toggleModel = (modelId: string) => {
	let nextModels = [...selectedModels];
    let nextDisabled = [...disabledPanels];

	if (nextModels.includes(modelId)) {
      if (nextModels.length === 1) return; 
      nextModels = nextModels.filter((id) => id !== modelId);
      nextDisabled = nextDisabled.filter((id) => id !== modelId); // 삭제된 모델은 OFF 목록에서도 깔끔히 치워줍니다
    } else {
      nextModels.push(modelId);
    }
	
	setSelectedModels(nextModels);
    setDisabledPanels(nextDisabled);
    syncModelSettingsToServer(nextModels, nextDisabled);
  };

  // 💡 패널의 상태(ON/OFF)를 전환하는 함수
  const togglePanelDisable = (modelId: string) => {
	const nextDisabled = disabledPanels.includes(modelId)
      ? disabledPanels.filter((id) => id !== modelId) // 이미 꺼져있으면 켬
      : [...disabledPanels, modelId]; // 안 꺼져있으면 배열에 넣어 끔
      
    setDisabledPanels(nextDisabled);
    syncModelSettingsToServer(selectedModels, nextDisabled);
  };
  
  // 💡 특정 패널의 모델을 다른 모델로 스위칭하는 함수
  const changePanelModel = (oldModelId: string, newModelId: string) => {
    // 1. 선택된 모델 배열에서 옛날 ID를 새 ID로 교체합니다.
	const nextModels = selectedModels.map((id) => (id === oldModelId ? newModelId : id));
    let nextDisabled = [...disabledPanels];
    
    // 2. 만약 해당 패널이 일시정지(OFF) 상태였다면, 바뀐 모델도 일시정지 상태를 유지해줍니다.
    if (disabledPanels.includes(oldModelId)) {
      nextDisabled = [...disabledPanels.filter((id) => id !== oldModelId), newModelId];
    }

    setSelectedModels(nextModels);
    setDisabledPanels(nextDisabled);
    syncModelSettingsToServer(nextModels, nextDisabled);
  };  
  
  return (
    <main className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <ChatSidebar 
        userEmail="guest@example.com" 
        conversations={conversations} // 동기화된 리스트 전달
        currentChatId={currentChatId}  // 현재 활성화된 방 ID 전달 (UI 하이라이트용)
        onNewChat={handleNewChat}
        onSelectConversation={handleSelectConversation}
		onRename={handleRename}
        onDelete={handleDelete}		
      />

      <section className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">        
        {/* 💡 동적 화면 분할 영역 */}
        <div className="flex flex-1 min-h-0 overflow-hidden px-4 pb-4 pt-4 gap-4 bg-zinc-950">
		{selectedModels.map((modelId, index) => {
            const modelInfo = AVAILABLE_MODELS.find(m => m.id === modelId);
			const isPanelDisabled = disabledPanels.includes(modelId);
            
			return (
              <React.Fragment key={modelId}>               
				{/* 💡 패널이 OFF일 때 너비를 w-44(약 176px)으로 축소시킵니다 */}
                <div className={`flex flex-col bg-zinc-900/40 border border-zinc-800 rounded-2xl overflow-hidden relative transition-all duration-300 ease-in-out shadow-sm ${
                  isPanelDisabled ? "w-36 shrink-0" : "flex-1 min-w-0"
                }`}>
				  {/* 💡 모델 이름과 ON/OFF 토글 버튼이 있는 헤더 */}
                  {selectedModels.length > 1 && (
                    <div className="flex items-center justify-between shrink-0 border-b border-zinc-800 bg-zinc-900/50 px-3 py-1.5 text-xs font-semibold text-zinc-400">
                      <div className={`flex flex-1 min-w-0 items-center gap-2 transition-opacity ${isPanelDisabled ? 'opacity-50' : ''}`}>
                        <span className="text-sm">{modelInfo?.icon}</span>
                        
						{/* 💡 2. OFF 상태일 때는 일반 텍스트로 렌더링하고, 넘치는 글자는 말줄임표 처리 */}
                        {isPanelDisabled ? (
                          <span className="text-sm font-medium text-zinc-200 truncate select-none">
                            {modelInfo?.name}
                          </span>
                        ) : (
                        // ON 상태일 때는 기존처럼 드롭다운 렌더링
                        <select
                          value={modelId}
                          onChange={(e) => changePanelModel(modelId, e.target.value)}
                          disabled={isPanelDisabled} // 패널이 OFF일 때는 모델 변경 막기
                          className="cursor-pointer bg-transparent text-sm font-medium text-zinc-200 outline-none hover:text-white truncate min-w-0"
                        >
                          {AVAILABLE_MODELS.map((m) => {
                            // 이미 다른 패널에 켜져 있는 모델인지 확인
                            const isAlreadyUsed = selectedModels.includes(m.id) && m.id !== modelId;
                            return (
                              <option 
                                key={m.id} 
                                value={m.id}
                                disabled={isAlreadyUsed}
                                className="bg-zinc-800 text-zinc-100"
                              >
                                {m.name} {isAlreadyUsed ? "(사용 중)" : ""}
                              </option>
                            );
                          })}
                        </select>
						)}
                      </div>
                      
					{/* 💡 ON/OFF 토글 스위치 적용 */}
                      <button
                        onClick={() => togglePanelDisable(modelId)}
                        className="cursor-pointer flex items-center gap-2 rounded px-2 py-0.5 hover:bg-zinc-800 transition-colors"
                        title={isPanelDisabled ? "대화 다시 켜기" : "대화 일시정지"}
                      >
                        <span className="text-[10px] font-bold text-zinc-500">
                          {isPanelDisabled ? "OFF" : "ON"}
                        </span>
                        <div className={`h-4 w-8 rounded-full p-0.5 transition-colors ${!isPanelDisabled ? "bg-blue-500" : "bg-zinc-700"}`}>
                          <div className={`h-3 w-3 rounded-full bg-white transition-transform ${!isPanelDisabled ? "translate-x-4" : "translate-x-0"}`} />
                        </div>
                      </button>
                    </div>
                  )}
                  
                  <ChatApp 
				    modelId={modelId}
                    initialConversationId={currentChatId} 
                    onConversationCreated={handleConversationCreated}
                    promptPayload={promptPayload}
					isPanelDisabled={isPanelDisabled}
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
        />
      </section>
    </main>
  );
}