import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  gradeDevelopmentAnswer,
  modelInputForCase,
  parseDevelopmentCorpus,
} from "../lib/routerDevelopmentBenchmark.ts";

const corpus = parseDevelopmentCorpus(readFileSync(
  new URL("../docs/ops/router-development-benchmark/development-v1.json", import.meta.url),
  "utf8",
));

// Separately encoded source facts and derivations, authored by the same agent
// as the corpus; this is not an independent human review. These functions do not
// read expected. Anchors fail if relevant prompt facts change without updating
// the explanation. See the README inventory.
const derivations = {
  "dev-en-extract-01": {
    why: "Select dispatched AND North Dock; preserve label order and convert yes to true.",
    anchors: ["shipment S-41, destination North Dock, status dispatched, fragile yes, labels [glass, blue]", "shipment S-42, destination South Dock", "shipment S-43, destination North Dock, status queued"],
    derive: () => {
      const rows = [
        { shipmentId: "S-41", destination: "North Dock", status: "dispatched", fragile: "yes", labels: ["glass", "blue"] },
        { shipmentId: "S-42", destination: "South Dock", status: "dispatched" },
        { shipmentId: "S-43", destination: "North Dock", status: "queued" },
      ];
      const row = rows.find((value) => value.destination === "North Dock" && value.status === "dispatched");
      return { shipmentId: row.shipmentId, destination: row.destination, fragile: row.fragile === "yes", labels: row.labels };
    },
  },
  "dev-en-extract-02": {
    why: "The current asset record has Annex/B2 and no custodian; do not inherit the historical custodian.",
    anchors: ["asset LAMP-7; current yes; location building Annex, room B2; rechargeable no; accessories [stand, shade]; custodian is not recorded", "current no, room A1 and custodian Team Gray"],
    derive: () => {
      const current = { asset: "LAMP-7", building: "Annex", room: "B2", rechargeable: "no", accessories: ["stand", "shade"] };
      return { assetId: current.asset, location: { building: current.building, room: current.room }, rechargeable: current.rechargeable === "yes", accessories: current.accessories, custodian: current.custodian ?? null };
    },
  },
  "dev-en-extract-03": {
    why: "Elm is the only room with both required flags; seat count is copied, not inferred.",
    anchors: ["Cedar, available no, stepFree yes", "Elm, available yes, stepFree yes, seats 8, equipment [whiteboard, speaker]", "Ash, available yes, stepFree no"],
    derive: () => {
      const rooms = [
        { room: "Cedar", available: false, stepFree: true },
        { room: "Elm", available: true, stepFree: true, seats: 8, equipment: ["whiteboard", "speaker"] },
        { room: "Ash", available: true, stepFree: false },
      ];
      const row = rooms.find((value) => value.available && value.stepFree);
      return { room: row.room, access: { available: row.available, stepFree: row.stepFree }, seats: row.seats, equipment: row.equipment };
    },
  },
  "dev-en-extract-04": {
    why: "Take T-18's final event; the resolution belongs to T-19 and must not fill T-18's null.",
    anchors: ["Ticket T-18", "oldest-to-newest order", "status paused, queue Parts, awaitingExternal yes; it has no resolution text", "Separate ticket T-19 is resolved"],
    derive: () => {
      const events = [{ status: "opened", queue: "Intake" }, { status: "assigned", queue: "Repairs" }, { status: "paused", queue: "Parts", awaitingExternal: "yes" }];
      const last = events.at(-1);
      return { ticketId: "T-18", status: last.status, queue: last.queue, awaitingExternal: last.awaitingExternal === "yes", resolution: last.resolution ?? null };
    },
  },
  "dev-en-extract-05": {
    why: "Filter explicit vegan and available flags in source order; preserve two spaces inside the note.",
    anchors: ["Zest bowl, vegan yes, available yes", "Almond tart, vegan yes, available no", "Bean soup, vegan yes, available yes", "Garden pie, vegan no, available yes", "Menu title is Noon List", "Collect  at hatch"],
    derive: () => {
      const items = [["Zest bowl", true, true], ["Almond tart", true, false], ["Bean soup", true, true], ["Garden pie", false, true]];
      return { menu: "Noon List", eligibleItems: items.filter(([, vegan, available]) => vegan && available).map(([name]) => name), serviceNote: "Collect  at hatch" };
    },
  },
  "dev-en-extract-06": {
    why: "Current v2 explicitly has an empty tag list and no reviewer; old version metadata is irrelevant.",
    anchors: ["Document MAP-3", "version v1 marked current no", "version v2 is marked current yes, draft no, tags explicitly empty, title River Paths, and no reviewer is recorded"],
    derive: () => {
      const versions = [{ version: "v1", current: false, reviewer: "Unit Amber" }, { version: "v2", current: true, draft: false, tags: [], title: "River Paths" }];
      const row = versions.find((value) => value.current);
      return { documentId: "MAP-3", version: row.version, title: row.title, draft: row.draft, tags: row.tags, reviewer: row.reviewer ?? null };
    },
  },
  "dev-ko-extract-01": {
    why: "Match title and loan category, not the reference copy with the same title.",
    anchors: ["자료 D-8, 제목 빛의 지도, 구분 대출용, 대출가능 예, 서가 동관/3번, 주제 [관측, 기록]", "자료 D-9, 제목 빛의 지도, 구분 참고용"],
    derive: () => {
      const records = [{ id: "D-8", title: "빛의 지도", category: "대출용", loanable: "예", wing: "동관", slot: "3번", topics: ["관측", "기록"] }, { id: "D-9", title: "빛의 지도", category: "참고용" }];
      const row = records.find((value) => value.title === "빛의 지도" && value.category === "대출용");
      return { id: row.id, title: row.title, loanable: row.loanable === "예", shelf: { wing: row.wing, slot: row.slot }, topics: row.topics };
    },
  },
  "dev-ko-extract-02": {
    why: "Use declared weekend/open labels and copy materials flags into ordered nested objects.",
    anchors: ["시간표 이름은 작은 공방", "유리 새, 요일구분 주말, 신청상태 열림, 재료제공 예", "종이 집, 요일구분 평일, 신청상태 열림", "실 매듭, 요일구분 주말, 신청상태 닫힘", "나무 배, 요일구분 주말, 신청상태 열림, 재료제공 아니오"],
    derive: () => {
      const rows = [["유리 새", "주말", "열림", "예"], ["종이 집", "평일", "열림", "예"], ["실 매듭", "주말", "닫힘", "아니오"], ["나무 배", "주말", "열림", "아니오"]];
      return { timetable: "작은 공방", classes: rows.filter(([, day, state]) => day === "주말" && state === "열림").map(([name, , , supplied]) => ({ name, materialsIncluded: supplied === "예" })) };
    },
  },
  "dev-ko-extract-03": {
    why: "Copy received G-4's nested body and components; G-5's locker is not G-4's locker.",
    anchors: ["기기 G-4의 기록은 상태 인수완료, 본체 색상 은색, 전원 충전식, 봉인 아니오, 구성품 [본체, 받침대, 안내지]이며 보관함 번호는 기록되지 않았습니다", "기기 G-5는 상태 인수예정"],
    derive: () => {
      const row = { id: "G-4", color: "은색", power: "충전식", sealed: "아니오", components: ["본체", "받침대", "안내지"] };
      return { deviceId: row.id, body: { color: row.color, power: row.power }, sealed: row.sealed === "예", components: row.components, locker: row.locker ?? null };
    },
  },
  "dev-ko-extract-04": {
    why: "Select confirmed first broadcasts and keep source order, even though time order is different.",
    anchors: ["채널 이름은 파도", "저녁 창, 편성종류 본방송, 확정 예, 시각 18:40", "새벽 길, 편성종류 재방송, 확정 예", "낮은 숲, 편성종류 본방송, 확정 아니오", "아침 돌, 편성종류 본방송, 확정 예, 시각 07:30"],
    derive: () => {
      const rows = [["저녁 창", "본방송", true, "18:40"], ["새벽 길", "재방송", true, "05:10"], ["낮은 숲", "본방송", false, "12:20"], ["아침 돌", "본방송", true, "07:30"]];
      return { channel: "파도", programmes: rows.filter(([, kind, confirmed]) => kind === "본방송" && confirmed).map(([title, , , time]) => ({ title, time })) };
    },
  },
  "dev-ko-extract-05": {
    why: "R-2 is sealed with a two-space label; an unrecorded inspection date remains null.",
    anchors: ["함 R-2, 내용물 모형 조각, 봉인 예", "위  아래", "점검일 미기록", "다른 표찰: 함 R-3"],
    derive: () => {
      const label = { id: "R-2", contents: "모형 조각", sealed: "예", text: "위  아래" };
      return { binId: label.id, contents: label.contents, sealed: label.sealed === "예", label: label.text, inspectionDate: label.inspectionDate ?? null };
    },
  },
  "dev-ko-extract-06": {
    why: "The issued notice supersedes the draft; empty supplies and a missing end date are different values.",
    anchors: ["공지 N-6 초안: 발행 아니오", "공지 N-6 확정본: 발행 예, 행사명 작은 전시, 장소 북쪽 홀, 신청필수 아니오, 준비물은 명시적으로 빈 목록, 종료일은 미기록"],
    derive: () => {
      const records = [{ published: false, venue: "남쪽 홀" }, { published: true, event: "작은 전시", venue: "북쪽 홀", registration: "아니오", bring: [] }];
      const row = records.find((value) => value.published);
      return { noticeId: "N-6", event: row.event, venue: row.venue, registrationRequired: row.registration === "예", bring: row.bring, endDate: row.endDate ?? null };
    },
  },
  "dev-en-calc-01": {
    why: "18 + 7 - 9 - 2 = 14 available; 9 + 2 = 11 removed.",
    anchors: ["18 usable units", "Seven usable units", "Nine units were shipped", "two of the remaining units"],
    derive: () => ({ available: 18 + 7 - 9 - 2, removedFromUsable: 9 + 2 }),
  },
  "dev-en-calc-02": {
    why: "Only O-7 and O-4 qualify, yielding 4 × 8 + 3 × 5 = 47 tokens across 2 orders.",
    anchors: ["O-7 paid=yes cancelled=no quantity=4 unitTokens=8", "O-2 paid=no cancelled=no quantity=10 unitTokens=9", "O-9 paid=yes cancelled=yes quantity=2 unitTokens=6", "O-4 paid=yes cancelled=no quantity=3 unitTokens=5"],
    derive: () => {
      const rows = [["O-7", true, false, 4, 8], ["O-2", false, false, 10, 9], ["O-9", true, true, 2, 6], ["O-4", true, false, 3, 5]];
      const included = rows.filter(([, paid, cancelled]) => paid && !cancelled);
      return { includedIds: included.map(([id]) => id), orderCount: included.length, totalTokens: included.reduce((sum, [, , , quantity, price]) => sum + quantity * price, 0) };
    },
  },
  "dev-en-calc-03": {
    why: "40 - 15 = 25 unmarked; 15/40 × 100 = 37.5 and 25/40 × 100 = 62.5.",
    anchors: ["Exactly 40 tiles", "exactly 15 were marked", "divided by all 40 inspected tiles multiplied by 100"],
    derive: () => ({ unmarkedCount: 40 - 15, markedPercent: 15 / 40 * 100, unmarkedPercent: (40 - 15) / 40 * 100 }),
  },
  "dev-en-calc-04": {
    why: "2000 + 350 + 750 = 3100 grams; subtract 600 to obtain 2500 grams or 2.5 kilograms.",
    anchors: ["1 kilogram = 1000 grams", "2 kilograms, 350 grams, and 0.75 kilograms", "exactly 600 grams"],
    derive: () => {
      const combined = 2 * 1000 + 350 + 0.75 * 1000;
      return { combinedGrams: combined, remainingGrams: combined - 600, remainingKilograms: (combined - 600) / 1000 };
    },
  },
  "dev-en-calc-05": {
    why: "605 - 550 = 55 elapsed minutes; 55 - 10 = 45 active minutes or 0.75 hours.",
    anchors: ["09:10", "10:05", "HH multiplied by 60 plus MM", "10-minute break", "divided by 60"],
    derive: () => {
      const elapsed = (10 * 60 + 5) - (9 * 60 + 10);
      return { elapsedMinutes: elapsed, activeMinutes: elapsed - 10, activeHours: (elapsed - 10) / 60 };
    },
  },
  "dev-en-calc-06": {
    why: "Open rows at or before 2026-04-10 are J-4 and J-8, including equality; 3 + 4 = 7 units.",
    anchors: ["cutoff 2026-04-10", "J-4 dueDate=2026-04-09 status=open units=3", "J-1 dueDate=2026-04-10 status=closed units=9", "J-8 dueDate=2026-04-10 status=open units=4", "J-2 dueDate=2026-04-11 status=open units=8"],
    derive: () => {
      const rows = [["J-4", "2026-04-09", "open", 3], ["J-1", "2026-04-10", "closed", 9], ["J-8", "2026-04-10", "open", 4], ["J-2", "2026-04-11", "open", 8]];
      const included = rows.filter(([, date, state]) => state === "open" && date <= "2026-04-10");
      return { dueIds: included.map(([id]) => id), dueCount: included.length, dueUnits: included.reduce((sum, [, , , units]) => sum + units, 0) };
    },
  },
  "dev-ko-calc-01": {
    why: "4 × 6 = 24 initially packed; 24 - 3 + 5 = 26 shippable.",
    anchors: ["상자 4개", "각각 6개", "불량 3개", "정상 모형 5개"],
    derive: () => ({ initiallyPacked: 4 * 6, shippable: 4 * 6 - 3 + 5 }),
  },
  "dev-ko-calc-02": {
    why: "7 + 5 + 2 = 14 visitors, 12 paying; 7 × 3 + 5 × 8 + 2 × 0 = 61 tokens.",
    anchors: ["어린이 7명은 1명당 3토큰", "성인 5명은 1명당 8토큰", "면제 방문자 2명은 1명당 0토큰"],
    derive: () => {
      const groups = [[7, 3], [5, 8], [2, 0]];
      return { visitorCount: groups.reduce((sum, [count]) => sum + count, 0), payingCount: groups.filter(([, rate]) => rate > 0).reduce((sum, [count]) => sum + count, 0), totalTokens: groups.reduce((sum, [count, rate]) => sum + count * rate, 0) };
    },
  },
  "dev-ko-calc-03": {
    why: "12000 × 12.5/100 = 1500 discount; 10500 discounted price plus 500 gives 11000 payable.",
    anchors: ["12000포인트", "물품 가격에만 12.5%", "포장비 500포인트"],
    derive: () => {
      const discount = 12000 * 12.5 / 100;
      return { discountPoints: discount, discountedItemPoints: 12000 - discount, payablePoints: 12000 - discount + 500 };
    },
  },
  "dev-ko-calc-04": {
    why: "1.2 × 100 + 85 + 350/10 = 240 cm; subtract 40 to leave 200 cm or 2 m.",
    anchors: ["1미터=100센티미터", "10밀리미터=1센티미터", "1.2미터, 85센티미터, 350밀리미터", "40센티미터를 잘라"],
    derive: () => {
      const combined = 1.2 * 100 + 85 + 350 / 10;
      return { combinedCentimeters: combined, remainingCentimeters: combined - 40, remainingMeters: (combined - 40) / 100 };
    },
  },
  "dev-ko-calc-05": {
    why: "Four approvals contain three distinct IDs in first-approved order; one duplicate approval and two rejections.",
    anchors: ["표 Q-3 승인, 표 Q-1 거절, 표 Q-3 승인, 표 Q-7 승인, 표 Q-1 승인, 표 Q-7 거절", "처음 승인된 순서"],
    derive: () => {
      const rows = [["Q-3", true], ["Q-1", false], ["Q-3", true], ["Q-7", true], ["Q-1", true], ["Q-7", false]];
      const approved = rows.filter(([, accepted]) => accepted).map(([id]) => id);
      const admittedIds = [...new Set(approved)];
      return { admittedIds, uniqueAdmissions: admittedIds.length, duplicateApprovals: approved.length - admittedIds.length, rejectedScans: rows.length - approved.length };
    },
  },
  "dev-ko-calc-06": {
    why: "Both inclusive boundaries qualify, returns and outside dates do not: B-6 then B-9, 5 + 2 = 7 units.",
    anchors: ["시작일 2026-06-03과 종료일 2026-06-08을 모두 포함", "B-6 수령일 2026-06-08 반품 아니오 수량 5", "B-2 수령일 2026-06-02 반품 아니오 수량 9", "B-9 수령일 2026-06-03 반품 아니오 수량 2", "B-4 수령일 2026-06-05 반품 예 수량 8", "B-1 수령일 2026-06-09 반품 아니오 수량 4"],
    derive: () => {
      const rows = [["B-6", "2026-06-08", false, 5], ["B-2", "2026-06-02", false, 9], ["B-9", "2026-06-03", false, 2], ["B-4", "2026-06-05", true, 8], ["B-1", "2026-06-09", false, 4]];
      const included = rows.filter(([, date, returned]) => !returned && date >= "2026-06-03" && date <= "2026-06-08");
      return { includedIds: included.map(([id]) => id), includedCount: included.length, totalUnits: included.reduce((sum, [, , , units]) => sum + units, 0) };
    },
  },
};

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeys(child)]));
  }
  return value;
}

function pathsToLeaves(value, path = []) {
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => pathsToLeaves(child, [...path, key]));
  }
  return [{ path, value }];
}

function changedAt(answer, path, value) {
  const clone = structuredClone(answer);
  let parent = clone;
  for (const key of path.slice(0, -1)) parent = parent[key];
  parent[path.at(-1)] = value;
  return clone;
}

test("development corpus has exactly six unique tasks in each language/task cell", () => {
  assert.equal(corpus.purpose, "development-only");
  assert.equal(corpus.cases.length, 24);
  assert.deepEqual(Object.keys(derivations).sort(), corpus.cases.map(({ id }) => id).sort());
  assert.equal(new Set(corpus.cases.map(({ prompt }) => prompt)).size, 24);
  for (const language of ["en", "ko"]) {
    for (const task of ["structured-extraction", "grounded-calculation"]) {
      assert.equal(corpus.cases.filter((item) => item.language === language && item.task === task).length, 6);
    }
  }
  for (const item of corpus.cases) {
    assert.deepEqual(item.requirements, { needsSearch: false, attachments: [], tools: [] });
    assert.deepEqual(item.grading, { kind: "exact-json", arrayOrder: "ordered", stringNormalization: "none" });
    // No expected, grading, identity, provenance or other fields enter model input.
    assert.deepEqual(modelInputForCase(item), { prompt: item.prompt });
  }
});

for (const item of corpus.cases) {
  const independent = derivations[item.id];
  test(`${item.id}: independently derived known answer: ${independent.why}`, () => {
    for (const fact of independent.anchors) {
      assert.ok(item.prompt.includes(fact), `source fact changed or missing: ${fact}`);
    }
    const answer = independent.derive();
    assert.deepEqual(item.expected, answer);
    assert.equal(gradeDevelopmentAnswer(item, JSON.stringify(answer)).pass, true);
  });

  test(`${item.id}: semantic leaf mutations, missing keys and extra keys fail`, () => {
    const answer = independent.derive();
    for (const { path, value } of pathsToLeaves(answer)) {
      const wrong = typeof value === "number" ? value + 1
        : typeof value === "boolean" ? !value
          : value === null ? "unrecorded" : `${value}!`;
      assert.equal(gradeDevelopmentAnswer(item, JSON.stringify(changedAt(answer, path, wrong))).pass, false, `wrong value at ${path.join(".")}`);
      if (typeof value === "number" || typeof value === "boolean") {
        assert.equal(gradeDevelopmentAnswer(item, JSON.stringify(changedAt(answer, path, String(value)))).pass, false, `coerced type at ${path.join(".")}`);
      }
      if (typeof value === "string") {
        assert.equal(gradeDevelopmentAnswer(item, JSON.stringify(changedAt(answer, path, ` ${value} `))).pass, false, `string whitespace at ${path.join(".")}`);
      }
    }
    for (const key of Object.keys(answer)) {
      const missing = structuredClone(answer);
      delete missing[key];
      assert.equal(gradeDevelopmentAnswer(item, JSON.stringify(missing)).pass, false, `missing ${key}`);
    }
    assert.equal(gradeDevelopmentAnswer(item, JSON.stringify({ ...answer, explanation: "extra" })).pass, false);
    for (const [key, value] of Object.entries(answer)) {
      if (!Array.isArray(value)) continue;
      const altered = value.length > 1 ? [...value].reverse() : ["extra"];
      assert.equal(gradeDevelopmentAnswer(item, JSON.stringify({ ...answer, [key]: altered })).pass, false, `array order/content at ${key}`);
    }
  });

  test(`${item.id}: formatting and object-key order are ignored, decoded strings are preserved`, () => {
    const answer = reverseObjectKeys(independent.derive());
    // Literal and escaped Unicode represent the same JSON string, including ko.
    const alternate = JSON.stringify(answer, null, 3).replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
    assert.equal(gradeDevelopmentAnswer(item, ` \n\t${alternate}\r\n `).pass, true);
  });
}
