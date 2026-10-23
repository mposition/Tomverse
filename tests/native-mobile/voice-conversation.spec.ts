import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("https://tomverse.app/**", route => route.abort("blockedbyclient"));
  await page.addInitScript(() => {
    localStorage.setItem("tomverse-language", "ko"); localStorage.setItem("tomverse-theme", "dark");
    const scope = window as unknown as { __voiceQa: { emit: (event: unknown) => void; stopped: number; results: unknown[] } };
    scope.__voiceQa = { emit() {}, stopped: 0, results: [] };
    const track = { enabled: true, stop() { scope.__voiceQa.stopped++; } };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) });
    class Peer {
      iceGatheringState = "complete"; localDescription: unknown = null;
      createOffer = async () => ({ type: "offer", sdp: "fixture-offer" });
      setLocalDescription = async (value: unknown) => { this.localDescription = value; };
      setRemoteDescription = async () => {}; addTrack() {} createDataChannel() {} close() {}
    }
    Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: Peer });
  });
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(); const source = await response.text();
    const fixture = `
      transport.voiceConfiguration = async () => ({enabled:true,maxSeconds:300});
      transport.sendVoice = async (conversation,text,signal,progress) => {
        await transport.send(conversation,text,[],signal,progress);
        const stored=await transport.load(conversation.id);
        return {conversationId:stored.id,sourceUserMessageId:stored.messages.filter(m=>m.role==='user').at(-1).id};
      };
      transport.voiceRequest = async body => {
        const qa=window.__voiceQa;
        if(body.action==='start') return new Response(new ReadableStream({start(controller){
          qa.emit=event=>controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(event)+'\\n\\n'));
          qa.finish=()=>controller.close();
          qa.emit({type:'ready',reservationId:'qa-session',sdp:'fixture-answer',maxSeconds:300});qa.emit({type:'started'});
        }}));
        if(body.action==='result'){qa.results.push(body);localStorage.setItem('qa-voice-chat',body.conversationId);return Response.json({ok:true});}
        if(body.action==='stop'){localStorage.setItem('qa-voice-closed','true');qa.emit({type:'closed',confirmed:true,settled:true,seconds:10,credits:6});qa.finish();return Response.json({ok:true});}
        if(body.action==='history') return Response.json({sessions:localStorage.getItem('qa-voice-closed')==='true'&&localStorage.getItem('qa-voice-chat')===body.conversationId?[{id:'qa-session',seconds:10,credits:6,confirmed:true,settled:true}]:[]});
        return Response.json({settled:true,confirmed:true,credits:6,seconds:10});
      };
    `;
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", fixture + "createRoot(container).render(") });
  });
});

test("native voice delegates to the existing Chat and restores answers and session usage after reload", async ({ page }, info) => {
  await page.goto("/"); await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await page.getByTestId("native-voice-open").click();
  await expect(page.getByText("Smart Adaptive", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("voice-ready.png") });
  await expect(page.getByTestId("voice-conversation-panel")).not.toContainText(/36.*분|분.*36/);
  await page.getByRole("button", { name: "음성 대화 시작", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("듣고 있어요");
  await page.evaluate(() => {
    const qa = (window as unknown as { __voiceQa: { emit: (event: unknown) => void } }).__voiceQa;
    qa.emit({ type: "transcript", event: { type: "session.input_transcript.delta", event_id: "input-1", delta: "기존 모델로 이 질문에 답해주세요", start_ms: 0, end_ms: 1000 } });
    qa.emit({ type: "delegation", delegationId: "question-1", text: "기존 모델로 이 질문에 답해주세요" });
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __voiceQa: { results: unknown[] } }).__voiceQa.results.length)).toBe(1);
  await page.screenshot({ path: info.outputPath("voice-listening.png") });
  const receipt = await page.evaluate(() => (window as unknown as { __voiceQa: { results: Record<string, unknown>[] } }).__voiceQa.results[0]);
  expect(receipt).not.toHaveProperty("content"); expect(receipt.sourceUserMessageId).toBeTruthy();
  await page.getByRole("button", { name: "마이크 끄기", exact: true }).click();
  await expect(page.getByRole("button", { name: "마이크 켜기", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "대화 종료", exact: true }).click();
  await expect(page.getByTestId("voice-conversation-panel").getByText("대화가 종료됐어요", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "채팅으로 돌아가기", exact: true }).click();
  await expect(page.getByTestId("voice-session-summary")).toContainText("6");
  await expect(page.locator("article.user")).toContainText("기존 모델로 이 질문에 답해주세요");
  await page.reload(); await expect(page.locator("article.user")).toContainText("기존 모델로 이 질문에 답해주세요");
  await expect(page.getByTestId("voice-session-summary")).toContainText("00:10");
});

test("native voice preserves a typed draft and fits 320px with enlarged text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); await page.goto("/");
  await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  const input = page.getByRole("textbox"); await input.fill("작성 중인 질문");
  await expect(page.getByTestId("native-voice-open")).toBeDisabled(); await expect(input).toHaveValue("작성 중인 질문");
  await input.fill(""); await page.getByTestId("native-voice-open").click();
  await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
  const panel = page.getByTestId("voice-conversation-panel");
  expect(await panel.evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false);
  await expect(page.getByRole("button", { name: "음성 대화 시작", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "닫기", exact: true }).click(); await expect(input).toBeVisible();
});
