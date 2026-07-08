import { streamText } from "ai";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { APP_DEFAULTS } from "@/lib/appDefaults";

const groq = createOpenAI({
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY,
});

const deepseek = createOpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
});

const xai = createOpenAI({
    baseURL: "https://api.x.ai/v1",
    apiKey: process.env.XAI_API_KEY,
});

const moonshot = createOpenAI({
    baseURL: "https://api.moonshot.ai/v1",
    apiKey: process.env.MOONSHOT_API_KEY,
});

const qwen = createOpenAI({
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKey: process.env.DASHSCOPE_API_KEY,
});

const perplexity = createOpenAI({
    baseURL: "https://api.perplexity.ai",
    apiKey: process.env.PERPLEXITY_API_KEY,
});

const getActiveModel = (modelId: string) => {
    switch (modelId) {
        case "gpt-4o-mini":
            return openai("gpt-4o-mini");
        case "gpt-4.1":
            return openai("gpt-4.1");
        case "gpt-4o":
            return openai("gpt-4o");

        case "claude-sonnet-4-5":
            return anthropic("claude-sonnet-4-5-20250929");
        case "claude-haiku-4-5":
            return anthropic("claude-haiku-4-5-20251001");

        case "gemini-1-5-pro":
            return google("gemini-1.5-pro");
        case "gemini-1-5-flash":
        case "gemini-1-5":
            return google("gemini-1.5-flash");

        case "llama-3-1":
            return groq.chat("llama-3.1-8b-instant");

        case "llama-3-3":
            return groq.chat("llama-3.3-70b-versatile");

        case "deepseek-v4-flash":
            return deepseek.chat("deepseek-v4-flash");

        case "deepseek-v4-pro":
            return deepseek.chat("deepseek-v4-pro");

        case "grok-4":
            return xai.chat("grok-4");

        case "grok-3":
            return xai.chat("grok-3");

        case "grok-3-mini":
            return xai.chat("grok-3");

        case "kimi-k2.7-code":
            return moonshot.chat("kimi-k2.7-code");

        case "qwen3.7-max":
            return qwen.chat("qwen3.7-max");

        case "qwen3.7-plus":
            return qwen.chat("qwen3.7-plus");

        case "qwen3.6-flash":
            return qwen.chat("qwen3.6-flash");

        case "glm-5.2":
            return qwen.chat("glm-5.2");

        case "perplexity/sonar":
            return perplexity.chat("sonar");

        default:
            return openai("gpt-4o");
    }
};

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { messages, modelId } = body;

        if (modelId === "llama-3-3-70b" && !process.env.GROQ_API_KEY) {
            return new Response(
                JSON.stringify({ error: "GROQ_API_KEY가 설정되어 있지 않습니다." }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
        }

        const activeModel = getActiveModel(modelId || APP_DEFAULTS.defaultModelId);

        const formattedMessages = messages.map((msg: any) => ({
            role: msg.role === "assistant" ? "assistant" : "user",
            content: msg.content,
        }));

        const result = await streamText({
            model: activeModel,
            messages: formattedMessages,
        });

        return new Response(result.textStream, {
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Connection": "keep-alive",
                "Cache-Control": "no-cache, no-transform",
            },
        });
    } catch (error: any) {
        console.error("AI SDK API request failed:");
        console.error(error?.message || error);

        return new Response(
            JSON.stringify({ error: "AI 응답 생성 실패", details: error?.message }),
            { status: 500, headers: { "Content-Type": "application/json" } }
        );
    }
}