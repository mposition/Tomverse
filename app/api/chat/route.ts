import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';

// 💡 프론트엔드의 modelId를 각 제조사의 "공식 API 모델명"으로 맵핑하는 딕셔너리
const getActiveModel = (modelId: string) => {
  const id = modelId.toLowerCase();

  // GPT 계열
  if (id.includes('gpt-4o')) return openai('gpt-4o');
  if (id.includes('gpt-4-turbo')) return openai('gpt-4-turbo');
  if (id.includes('gpt-3.5') || id.includes('gpt-35')) return openai('gpt-3.5-turbo');

	// Claude 계열
  if (id.includes('claude')) {
    // claude-3.5, claude-3-5 등 다양한 프론트엔드 ID 포맷을 모두 방어합니다.
    if (id.includes('3.5') || id.includes('3-5')) {
      return anthropic('claude-3-5-sonnet-20240620');
    }
    // 기본 클로드 폴백
    return anthropic('claude-haiku-4-5-20251001'); 
  }

	// 💡 Gemini 계열: 은퇴한 구형 모델을 빼고, 최신 1.5 시리즈(Flash / Pro)로 업데이트!
  if (id.includes('gemini')) {
    if (id.includes('pro')) return google('gemini-1.5-pro');
    // 기본 제미나이는 응답이 매우 빠르고 안정적인 최신 1.5 Flash 모델로 연결합니다.
    return google('gemini-3-flash-preview'); 
  }

  // 기본값 (매칭 안 될 경우)
  return openai('gpt-4o');
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
	const { messages, modelId } = body;

	const activeModel = getActiveModel(modelId || 'gpt-4o');

    const formattedMessages = messages.map((msg: any) => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    }));

    // 선택된 AI 엔진으로 메시지를 보내고 스트리밍(실시간 타자 치는 효과) 응답을 받습니다.
	const result = await streamText({
      model: activeModel,
      messages: formattedMessages,
    });

	// 프론트엔드의 TextDecoder가 100% 완벽하게 읽을 수 있는 순수 텍스트 스트림(textStream)으로 쏴줍니다!
    return new Response(result.textStream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  } catch (error) {
    console.error("❌ [AI SDK] API 요청 에러:");
    console.error(error?.message || error);

	return new Response(JSON.stringify({ error: "AI 응답 생성 실패", details: error?.message }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
}
