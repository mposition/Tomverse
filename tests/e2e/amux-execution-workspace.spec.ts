
import { expect, test, type Page } from "@playwright/test";

const a = { id:"qa-task-104", title:"Open details without losing the board", sourceKey:"AMUX-104",
  status:"backlog", priority:"p2", kind:"code", cardType:"task", storyKind:null,
  parentFeatureNodeId:null, parentStoryCardId:null, taskRole:"impl", executionGrade:"standard",
  worker:null, lane:null, sev1:false, score:74, scoreFresh:true, dependencyCount:0,
  progress:null, briefPresent:true, updatedAt:"2026-10-12T05:00:00Z" };
const b = { ...a, id:"qa-task-105", sourceKey:"AMUX-105", title:"Preserve the second card", priority:"p1" };
const lanes = ["tomverse_backlog","amux_backlog","todo","in_progress","in_review","attention"];
const detail = (card=a) => ({ ...card, revision:3, body:JSON.stringify({
  problem:"Keep the board context",scopeIn:["Same-page dialog"],scopeOut:[],completionCriteria:["Keyboard focus returns"] }),
  brief:"Approved fixture brief", feedback:null, outcomeWriteEnabled:false, result:null,
  dependencies:[],dependents:[],attempts:[],escalations:[],score:null,usage:[],reviews:[],publications:[] });

async function setup(page:Page, opts:{ delayed?:boolean; reauth?:boolean; moveUnknown?:boolean;
  moveRefused?:boolean; moveHalted?:boolean; readOnly?:boolean }={}) {
  let promoted=false; let posts=0; let reads=0;
  await page.route("**/api/admin/amux/execution-view?**", async route => {
    const p=new URL(route.request().url()).searchParams;
    if(p.get("view")==="activation") return route.fulfill({json:{asOf:"2026-10-12T05:00:00Z",activationAuthorized:false,stages:[]}});
    if(p.get("view")==="detail") {
      if(opts.delayed) await new Promise(resolve=>setTimeout(resolve,350));
      if(opts.reauth) return route.fulfill({status:428,json:{error:"ADMIN_REAUTHENTICATION_REQUIRED"}});
      return route.fulfill({json:detail(p.get("taskId")===b.id?b:a)});
    }
    if(p.get("view")==="board_snapshot") return route.fulfill({json:{
      pageSize:8,counts:{tomverse_backlog:promoted?1:2,amux_backlog:promoted?1:0,todo:0,in_progress:0,in_review:0,attention:0,archive:0},
      lanes:lanes.map(lane=>({lane,cards:lane==="tomverse_backlog"?(promoted?[b]:[a,b]):
        lane==="amux_backlog"&&promoted?[{...a,status:"todo"}]:[]})),
    }});
    return route.fulfill({json:{cards:[],counts:{}}});
  });
  await page.route("**/api/admin/amux/execution-move**", async route => {
    if(route.request().method()==="POST") {
      posts++;const body=route.request().postDataJSON();
      expect(body.taskId).toBe(a.id);expect(body.expectedRevision).toBe(3);
      if(opts.moveRefused) return route.fulfill({status:409,json:{error:"stale_revision"}});
      if(opts.moveHalted) return route.fulfill({json:{promoted:false,reason:"auto_halted"}});
      if(opts.moveUnknown) return route.fulfill({status:409,json:{error:"outcome_unknown",retry:false}});
      promoted=true;
      return route.fulfill({json:{state:"promoted",taskId:a.id,requestId:body.requestId,receiptId:body.requestId}});
    }
    reads++;return route.fulfill({json:{state:"outcome_unknown",taskId:a.id}});
  });
  await page.goto("/e2e/admin-console-fixture?view=amux" + (opts.readOnly ? "&readOnly=true" : ""));
  await expect(page.getByTestId("amux-board-card-"+a.id)).toBeVisible();
  return {posts:()=>posts,reads:()=>reads};
}

test("number opens modal; tabs, Escape, focus and loaded filter survive",async({page})=>{
  await setup(page);
  const search=page.getByRole("textbox",{name:"Search loaded cards"});
  await search.fill("AMUX-104");
  const number=page.getByTestId("amux-board-card-"+a.id).getByRole("button",{name:"AMUX-104",exact:true});
  await number.click();const dialog=page.getByRole("dialog");
  await expect(dialog).toBeVisible();await expect(page).toHaveURL(/taskId=qa-task-104/);
  await expect(dialog.getByRole("heading",{name:a.title})).toBeVisible();
  await expect(dialog.getByRole("button",{name:"Close detail",exact:true}).first()).toBeFocused();
  await expect(page.getByTestId("amux-execution-workspace")).toHaveJSProperty("inert",false);
  expect(await page.locator("body > div").evaluateAll(nodes=>nodes.some(n=>(n as HTMLElement).inert))).toBe(true);
  await dialog.getByRole("tab",{name:"Execution",exact:true}).click();
  await expect(dialog.getByRole("heading",{name:"Worker result"})).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);await expect(search).toHaveValue("AMUX-104");await expect(number).toBeFocused();
  await expect(page).not.toHaveURL(/taskId=/);
});

test("closing loading detail prevents a late response reopening it",async({page})=>{
  await setup(page,{delayed:true});
  await page.getByRole("button",{name:"AMUX-104",exact:true}).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.waitForTimeout(450);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("reauth failure stays in the modal and retains the card callback",async({page})=>{
  await setup(page,{reauth:true});
  await page.getByRole("button",{name:"AMUX-104",exact:true}).click();
  const link=page.getByRole("dialog").getByRole("link",{name:/Sign in again/});
  await expect(link).toBeVisible();await expect(link).toHaveAttribute("href",/taskId%3Dqa-task-104/);
  await expect(page.getByRole("dialog").getByRole("status")).toHaveCount(0);
});

test("move button calls one guarded write then refreshes the actual lane",async({page})=>{
  const state=await setup(page);
  await page.getByTestId("amux-board-card-"+a.id).getByRole("button",{name:"Move to AMUX queue"}).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("unassigned Todo");
  expect(state.posts()).toBe(1);
  await expect(page.getByRole("region",{name:"AMUX Backlog"}).getByTestId("amux-board-card-"+a.id)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/taskId=|moveRequest=/);
  await page.reload();await expect(page.getByTestId("amux-board-card-"+a.id)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("dragging to the queue runs the same guarded card command",async({page})=>{
  const state=await setup(page);
  await page.getByTestId("amux-board-card-"+a.id).dragTo(page.getByRole("region",{name:"AMUX Backlog"}));
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("unassigned Todo");
  expect(state.posts()).toBe(1);
});

test("known refusal releases the receipt so corrected conditions can be tried",async({page})=>{
  const state=await setup(page,{moveRefused:true});
  const move=page.getByTestId("amux-board-card-"+a.id).getByRole("button",{name:"Move to AMUX queue"});
  await move.click();await expect(page.getByRole("dialog").getByRole("alert")).toContainText("card changed");
  await expect(page).not.toHaveURL(/moveRequest=/);
  await page.keyboard.press("Escape");await move.click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  expect(state.posts()).toBe(2);expect(state.reads()).toBe(0);
});

test("a halted admission response shows the actual reason without claiming success",async({page})=>{
  const state=await setup(page,{moveHalted:true});
  await page.getByTestId("amux-board-card-"+a.id).getByRole("button",{name:"Move to AMUX queue"}).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Admission is halted");
  expect(state.posts()).toBe(1);expect(state.reads()).toBe(0);
  await expect(page.getByRole("region",{name:"Tomverse Backlog"}).getByTestId("amux-board-card-"+a.id)).toBeVisible();
});

test("a read-only viewer has no move button or drag affordance",async({page})=>{
  const state=await setup(page,{readOnly:true});
  await expect(page.getByRole("button",{name:"Move to AMUX queue"})).toHaveCount(0);
  await expect(page.getByTestId("amux-board-card-"+a.id)).toHaveAttribute("draggable","false");
  expect(state.posts()).toBe(0);
});

test("unknown move uses readback and reopening never replays the write",async({page})=>{
  const state=await setup(page,{moveUnknown:true});
  await page.getByTestId("amux-board-card-"+a.id).getByRole("button",{name:"Move to AMUX queue"}).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("unconfirmed");
  expect(state.posts()).toBe(1);
  await page.getByRole("dialog").getByRole("button",{name:"Check this request"}).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("unconfirmed");
  expect(state.posts()).toBe(1);
  await page.keyboard.press("Escape");
  await page.getByTestId("amux-board-card-"+a.id).getByRole("button",{name:"Move to AMUX queue"}).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("unconfirmed");
  expect(state.posts()).toBe(1);expect(state.reads()).toBeGreaterThan(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button",{name:"AMUX-105",exact:true}).click();
  await page.keyboard.press("Escape");
  await page.getByTestId("amux-board-card-"+a.id).getByRole("button",{name:"Move to AMUX queue"}).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("unconfirmed");
  expect(state.posts()).toBe(1);
});

test("narrow Korean dialog keeps actions within viewport",async({page})=>{
  await setup(page);
  await page.setViewportSize({width:390,height:844});
  await page.goto("/e2e/admin-console-fixture?view=amux&locale=ko");
  await page.getByRole("button",{name:"AMUX-104",exact:true}).click();
  const dialog=page.getByRole("dialog");await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab",{name:"개요",exact:true})).toBeVisible();
  const box=await dialog.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x+box!.width).toBeLessThanOrEqual(390);
  await expect(dialog.getByRole("button",{name:"상세 닫기",exact:true}).last()).toBeInViewport();
  await page.screenshot({path:test.info().outputPath("ko-card-modal-mobile.png")});
});

test("Korean board and detail render with the console theme",async({page})=>{
  await setup(page);
  await page.goto("/e2e/admin-console-fixture?view=amux&locale=ko");
  await page.evaluate(()=>document.documentElement.classList.add("dark"));
  await expect(page.getByRole("region",{name:"AMUX 대기열"})).toBeVisible();
  await page.screenshot({path:test.info().outputPath("ko-board-desktop.png")});
  await page.getByRole("button",{name:"AMUX-104",exact:true}).click();
  await expect(page.getByRole("dialog").getByRole("tab",{name:"개요",exact:true})).toBeVisible();
  await page.getByRole("tab",{name:"개요",exact:true}).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab",{name:"실행 이력",exact:true})).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.getByRole("tab",{name:"개요",exact:true})).toBeFocused();
  await page.screenshot({path:test.info().outputPath("ko-card-modal-desktop.png")});
});

