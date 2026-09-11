import {
  benchmarkDigest,
  canonicalBenchmarkJson,
  DEVELOPMENT_LIMITS,
  parseBenchmarkJson,
  strictBenchmarkObject,
  type JsonValue,
} from "./routerDevelopmentBenchmark";

/** Prompt-only oracle, implemented before seeing the corpus author's expected values.
 * These bindings freeze the complete natural-language rules AND supplied records.
 * This is a finite synthetic development oracle, not an arbitrary prompt interpreter,
 * a human label, or an independent statistical sample. No author/corpus imports.
 */
const PROMPT_DIGESTS: Readonly<Record<string, string>> = Object.freeze({
  "v2-en-calc-advanced-01": "c1403dd3b0635ce3ae35ed559d810cd6829beedf54fc1e771b5cf43f71fe76d9",
  "v2-en-calc-advanced-02": "e75c4ceee53d69c9ddb1f0ab4321704ff4c49f799227d86fb655412e026e91fd",
  "v2-en-calc-advanced-03": "9b2eb3068c33aec14f07c7a7e2b6f97fd7cae9a232dce4ff6833e8513440c5a6",
  "v2-en-calc-advanced-04": "aa0548de689d5075ba9daf29440c020e7719b07c3a3ffc47d05c284b9e2f9320",
  "v2-en-calc-advanced-05": "5fab757c76a5a29bcf3b2227a52ef5cf3d4ae0fc71112c8a66de32f26b1eaee8",
  "v2-en-calc-advanced-06": "66187f026ee84cb99ff501529d33f379c633420aaf44cf5b78132f7a9421867e",
  "v2-en-calc-basic-01": "8d22772e63af283e897951162a7baec506e78a55f2953bba34fda80af5b2407f",
  "v2-en-calc-basic-02": "e830ded28a1713db00cda16e427e607a61c8005fc4ed65b6c8bc1c9c205309a6",
  "v2-en-calc-basic-03": "cf8b072fab69add100e0c57c366cd71a1e67043767ad03222a75d917ec7374bf",
  "v2-en-calc-basic-04": "7d25b524822c40ef02c1af2d0d8c84b7ef2ac77b65d062a30f660002fbeac8d4",
  "v2-en-calc-basic-05": "e7ca175fe8f31a6684bdbaef6276bc90a24ed1fd030acb383cac54605f11408c",
  "v2-en-calc-basic-06": "7fdd1074d31fb59e1baece1a7a3de6bf02503f3e2de8846d67a167b29d140360",
  "v2-en-extract-advanced-01": "a4a39e12b7e83dae26bf32e57579d04672f445909c184f65eade5961e4ea41f1",
  "v2-en-extract-advanced-02": "f07a7c79f6f061746fecfdcf51a75609df71d3ce5d3ff97a5254e75894f7fa2b",
  "v2-en-extract-advanced-03": "a74b17a5e96d40e3cf4cd25784afc8007ddd9c21ea7a8b5100819204167b35ff",
  "v2-en-extract-advanced-04": "2b376e8020142069acea04a4f6d8248c775c6afc89fd2b7a1d924220af75b1db",
  "v2-en-extract-advanced-05": "1786113164e985d884ba6543cef5887e634366a3d6915272c6c932ed68cbc427",
  "v2-en-extract-advanced-06": "78f83d1bb58e8328c24473a4bff23dc843456552fe16bed7d37469979cd88b35",
  "v2-en-extract-basic-01": "8c4e9fc07c221564bf0ff72b2d70f32f71cbe602767d5a7bc8b233c3818fdf57",
  "v2-en-extract-basic-02": "0b09606d0b46801dec088aed2a031986ced155376d1aa228a375d95908ab99e4",
  "v2-en-extract-basic-03": "68facfd106936f52ebe6702eafa6b19bd2bb1e8e9374d2656ea66e219866429a",
  "v2-en-extract-basic-04": "e4b7c53efd023d271970a265cafafcea0782cc0857d6fb8d0d63a1a84b131ef7",
  "v2-en-extract-basic-05": "5425c87bbe915fd881baa24aa04b5c8e1d8faaabe3d6b0b241e062a7e391b28e",
  "v2-en-extract-basic-06": "e269f2b4606c02ef8d746b382703ab23fda708ea312f8be6566503470e4dfb28",
  "v2-ko-calc-advanced-01": "6846134ed834fcb677fd05f4e58a9785b864f5e3f24df7616b43b325da30a900",
  "v2-ko-calc-advanced-02": "f47c20a2bfba8ae3174c07f5d7a0527812afa191600e8ab5720dc5d00cf2ae18",
  "v2-ko-calc-advanced-03": "cf76d394ac24a315d23b41cc0da693d3b0f95a6ae4a5bb2d69232c9a678247ab",
  "v2-ko-calc-advanced-04": "20bbf24c826099bf2aea26c38c97da5b8b75864c6dd78e8e2903fe7f4c4c9af1",
  "v2-ko-calc-advanced-05": "791fd04cecaf0ce41b6dd241fbf217776694ec277df1cc7517315ad768a8a6a2",
  "v2-ko-calc-advanced-06": "13e59401ffcc5761fd199926abf3feea18db84f54aaee059b1e59b75333c0c56",
  "v2-ko-calc-basic-01": "6ed29e710d63a0c2a6063f746b5c154403ba639a1701db228d5dcafb4e2316aa",
  "v2-ko-calc-basic-02": "04134cf4fd85c261f2ed32b3dc8518652104dd5644de3945ce4b509f28dce621",
  "v2-ko-calc-basic-03": "baa061ac19b31c5a9ffd38db64328ca984bf58c0cdd2927050a80935062324a8",
  "v2-ko-calc-basic-04": "cfea3daac882c6313fd5e444e301884a6c262153d61eeaf493a5a64ccb07e881",
  "v2-ko-calc-basic-05": "2ee21c208a176c99a27bd962c9ab2ed861840d81d077561147821ce2590a1c6d",
  "v2-ko-calc-basic-06": "0a68b1ad0e8e5db0c637d393fa49ba0dfc03842caa98e3151252e19505a8cd07",
  "v2-ko-extract-advanced-01": "5b008ea5bf983c7c5712af1959edb95bd1405d37ea80ce04e368fc792a4b8529",
  "v2-ko-extract-advanced-02": "86dfa80fbe3bcdd886b4a1a18213613e531287eaf22f56fcef88b9492cf5268b",
  "v2-ko-extract-advanced-03": "95aad77798b51a10154cd5a6353f805f04a797dfffbfa34b325ef3dce5d8645b",
  "v2-ko-extract-advanced-04": "9619eb30aa374b416043582f25e25a3203e2dec1dbecfa19175b033168ffe4e3",
  "v2-ko-extract-advanced-05": "86777e0a6afac00a0e215a688217d8a6d05e6a81b582469615ee6472d8065ecc",
  "v2-ko-extract-advanced-06": "4d9b60e71848cb30d6e57c8708150efe491fc647f6a2515110a07da6b8cc061d",
  "v2-ko-extract-basic-01": "b48bdc3452d4603e514571668588cf07fe93febf36f2d1c12c0174d8c266baa6",
  "v2-ko-extract-basic-02": "fe685cb2dcc9b247f394cec85c751bdf8eddea42bd152ce014cabf2fc5f4625e",
  "v2-ko-extract-basic-03": "661f70c71e74afd78c9e014150b9e04b215f982bb9afb77cfc7486f4ba95ce5c",
  "v2-ko-extract-basic-04": "7282a8c097818d5fb89a84fc4d41ac41516d34d31c98347a62f82e2ac84abd78",
  "v2-ko-extract-basic-05": "1d0d63d428635c33d68e1ed191ed95092e75003971c705d717c8867e5bc078ac",
  "v2-ko-extract-basic-06": "70bcee5caefcd705c76faf47bc556fe56047f0f609e6c541a57692ab737fb27b",
});

type Row = { [key: string]: JsonValue };
const fail = (reason: string): never => { throw new Error(`v2_oracle_${reason}`); };
const has = (r: Row, k: string) => Object.prototype.hasOwnProperty.call(r, k);
const object = (v: unknown): Row => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return fail("object_required");
  return v as Row;
};
const array = (v: unknown): JsonValue[] => Array.isArray(v) ? v : fail("array_required");
const rows = (v: unknown): Row[] => array(v).map(object);
const string = (v: unknown): string => typeof v === "string" ? v : fail("string_required");
const strings = (v: unknown): string[] => array(v).map(string);
const boolean = (v: unknown): boolean => typeof v === "boolean" ? v : fail("boolean_required");
const number = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : fail("number_required");
const integer = (v: unknown): number => {
  const n = number(v);
  return Number.isSafeInteger(n) ? n : fail("safe_integer_required");
};
const nonnegative = (v: unknown): number => {
  const n = integer(v);
  return n >= 0 ? n : fail("negative_quantity");
};
const optionalString = (r: Row, key: string): string | null => !has(r, key) || r[key] === null ? null : string(r[key]);
const one = (r: Row[]): Row => r.length === 1 ? r[0] : fail("nonunique_selection");
const uniqueIndex = (items: Row[], key: string): Map<string, Row> => {
  const result = new Map<string, Row>();
  for (const r of items) {
    const id = string(r[key]);
    if (result.has(id)) fail("duplicate_lookup_key");
    result.set(id, r);
  }
  return result;
};
const newest = (items: Row[], key: string): Row | null => {
  if (!items.length) return null;
  const max = Math.max(...items.map(r => integer(r[key])));
  return one(items.filter(r => r[key] === max));
};
const date = (v: unknown): string => {
  const s = string(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) return fail("invalid_iso_date");
  return s;
};

// Exact decimal rational arithmetic, separate from the author's calculator.
// No binary-floating intermediate rounding is used for rates/conversions/means.
type Fraction = { n: bigint; d: bigint };
const zero = BigInt(0), oneBig = BigInt(1), ten = BigInt(10);
const fraction = (v: number): Fraction => {
  const text = String(number(v));
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(text);
  if (!match) return fail("decimal_required");
  const digits = match[3] ?? "";
  const power = Number(match[4] ?? 0) - digits.length;
  let n = BigInt(match[2] + digits) * (match[1] ? -oneBig : oneBig);
  let d = oneBig;
  if (power >= 0) n *= ten ** BigInt(power); else d = ten ** BigInt(-power);
  return { n, d };
};
const product = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.n, d: a.d * b.d });
const quotient = (a: Fraction, b: Fraction): Fraction => {
  if (b.n <= zero) return fail("positive_divisor_required");
  return { n: a.n * b.d, d: a.d * b.n };
};
const exactNumber = (f: Fraction): number => {
  const result = Number(f.n) / Number(f.d);
  const back = fraction(result);
  if (back.n * f.d !== f.n * back.d) return fail("nonfinite_decimal_result");
  return result;
};
const scale = (value: number, multiply: number, divide = 1): number => exactNumber(quotient(product(fraction(value), fraction(multiply)), fraction(divide)));
const sum = (values: number[]): number => values.reduce((total, value) => integer(total + integer(value)), 0);
const roundHalfUp = (numerator: number, denominator: number): number => {
  const f = quotient(fraction(nonnegative(numerator)), fraction(nonnegative(denominator)));
  return integer(Number((f.n * BigInt(2) + f.d) / (f.d * BigInt(2))));
};
const ceilDivide = (value: number, divisor: number): number => {
  const n = BigInt(nonnegative(value)), d = BigInt(nonnegative(divisor));
  if (d === zero) return fail("positive_divisor_required");
  return integer(Number((n + d - oneBig) / d));
};
const time = (v: unknown): number => {
  const m = /^(\d{2}):(\d{2})$/.exec(string(v));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return fail("invalid_time");
  return Number(m[1]) * 60 + Number(m[2]);
};

function extract(source: Row, ko: boolean, advanced: boolean, family: number): Row {
  if (family === 1) {
    if (!advanced && !ko) {
      const r = one(rows(source.crates).filter(r => r.destination === "Harbor Shed" && boolean(r.dispatched) && boolean(r.sealed)));
      return { crateId: string(r.id), destination: string(r.destination), sealed: boolean(r.sealed), labels: strings(r.labels) };
    }
    if (!advanced) {
      const r = one(rows(source.물품).filter(r => r.접수처 === "돌빛관" && boolean(r.접수완료) && boolean(r.대여가능)));
      return { itemId: string(r.번호), name: string(r.이름), loanable: boolean(r.대여가능), parts: strings(r.구성품) };
    }
    if (!ko) {
      const bookings = rows(source.bookings).filter(r => boolean(r.confirmed) && !boolean(r.cancelled) && integer(r.seats) >= 5 && r.zone === "East" && strings(r.access).includes("lift"))
        .map(r => ({ id: string(r.id), seats: integer(r.seats), contact: optionalString(r, "contact") }));
      return { bookings, selectedCount: bookings.length };
    }
    const documents = rows(source.배포목록).filter(r => boolean(r.승인) && boolean(r.공개) && strings(r.언어).includes("ko") && r.종류 === "안내" && integer(r.쪽수) >= 4 && integer(r.쪽수) <= 8)
      .map(r => ({ id: string(r.코드), pages: integer(r.쪽수), owner: optionalString(r, "담당자") }));
    return { documents, count: documents.length };
  }
  if (family === 2) {
    if (!advanced) {
      const r = newest(rows(source[ko ? "판본" : "revisions"]).filter(r => r[ko ? "문서" : "document"] === (ko ? "반달" : "DUNE") && boolean(r[ko ? "승인" : "published"])), ko ? "판" : "revision");
      if (!r) return fail("missing_latest");
      return ko
        ? { document: string(r.문서), revision: integer(r.판), title: string(r.제목), parts: strings(r.구성), locker: optionalString(r, "보관함") }
        : { document: string(r.document), revision: integer(r.revision), title: string(r.title), tags: strings(r.tags), reviewer: optionalString(r, "reviewer") };
    }
    const order = strings(source[ko ? "요청순서" : "requestedOrder"]);
    if (new Set(order).size !== order.length) return fail("duplicate_requested_id");
    const cutoff = date(source[ko ? "기준일" : "cutoff"]);
    const items = order.map((id): Row => {
      const r = newest(rows(source[ko ? "판본" : "revisions"]).filter(r => r[ko ? "코드" : "id"] === id && boolean(r[ko ? "게시" : "published"]) && date(r[ko ? "시작일" : "effective"]) <= cutoff), ko ? "판" : "revision");
      const record: Row | null = r === null ? null : ko
        ? { revision: integer(r.판), venue: string(r.장소), guide: optionalString(r, "안내원") }
        : { revision: integer(r.revision), label: string(r.label), owner: optionalString(r, "owner") };
      return { id, record };
    });
    return ko ? { exhibits: items } : { items };
  }
  if (family === 3) {
    if (!advanced && !ko) {
      const r = one(rows(source.deliveries).filter(r => boolean(r.approved)));
      const room = uniqueIndex(rows(source.rooms), "key").get(string(r.roomKey));
      if (!room) return fail("missing_room");
      return { deliveryId: string(r.id), room: { building: string(room.building), floor: integer(room.floor) }, equipment: strings(room.equipment) };
    }
    if (!advanced) {
      const r = one(rows(source.낭독회).filter(r => boolean(r.확정)));
      const host = uniqueIndex(rows(source.명단), "코드").get(string(r.진행자코드));
      if (!host) return fail("missing_host");
      return { eventId: string(r.번호), title: string(r.제목), host: string(host.이름), equipment: strings(host.도구) };
    }
    const middle = uniqueIndex(rows(source[ko ? "작품표" : "rooms"]), ko ? "코드" : "key");
    const last = uniqueIndex(rows(source[ko ? "보관표" : "owners"]), ko ? "코드" : "key");
    const selected: JsonValue[] = [];
    for (const r of rows(source[ko ? "예약" : "requests"])) {
      if (!boolean(r[ko ? "유효" : "active"])) continue;
      const m = middle.get(string(r[ko ? "작품코드" : "roomKey"]));
      if (!m || !boolean(m[ko ? "대여허용" : "stepFree"])) continue;
      const l = last.get(string(m[ko ? "보관코드" : "ownerKey"]));
      selected.push(ko
        ? { id: string(r.번호), title: string(m.제목), location: l ? string(l.위치) : null }
        : { id: string(r.id), room: string(m.name), owner: l ? string(l.name) : null });
    }
    return ko ? { reservations: selected, count: selected.length } : { requests: selected, count: selected.length };
  }
  if (family === 4) {
    if (!advanced) {
      let state = { ...object(source[ko ? "초기상태" : "initial"]) };
      for (const event of rows(source[ko ? "변경" : "events"])) state = { ...state, ...object(ko ? event : event.patch) };
      return ko
        ? { id: string(state.id), status: string(state.상태), team: string(state.담당), note: optionalString(state, "메모") }
        : { ticket: string(state.ticket), status: string(state.status), team: string(state.team), note: optionalString(state, "note") };
    }
    const initial = rows(source[ko ? "초기" : "initial"]);
    const states = uniqueIndex(initial.map(r => ({ ...r })), ko ? "번호" : "id");
    for (const event of rows(source[ko ? "변경" : "events"])) {
      const id = string(event[ko ? "번호" : "id"]);
      const previous = states.get(id);
      if (previous) states.set(id, { ...previous, ...object(event[ko ? "수정" : "patch"]) });
    }
    const selected = [...states.values()].filter(r => r[ko ? "상태" : "status"] === (ko ? "확정" : "ready") && !boolean(r[ko ? "취소" : "locked"]))
      .map(r => ({ id: string(r[ko ? "번호" : "id"]), status: string(r[ko ? "상태" : "status"]), note: optionalString(r, ko ? "메모" : "note") }));
    return ko ? { confirmed: selected, count: selected.length } : { ready: selected, count: selected.length };
  }
  if (family === 5) {
    const requested = advanced
      ? [...strings(source[ko ? "현장목록" : "priority"]), ...strings(source[ko ? "온라인목록" : "regular"])]
      : strings(source[ko ? "신청" : "requested"]);
    const allowed = new Set(advanced
      ? [...strings(source[ko ? "자격가" : "allowA"]), ...strings(source[ko ? "자격나" : "allowB"])]
      : strings(source[ko ? "허용" : "allowed"]));
    const denied = new Set(strings(source[ko ? advanced ? "정지" : "차단" : "denied"]));
    if (advanced) for (const id of strings(source[ko ? "만료" : "retired"])) denied.add(id);
    const codes: string[] = [];
    let duplicatesIgnored = 0, rejectedOccurrences = 0;
    for (const id of requested) {
      if (!allowed.has(id) || denied.has(id)) rejectedOccurrences++;
      else if (codes.includes(id)) duplicatesIgnored++;
      else codes.push(id);
    }
    return advanced ? { codes, duplicatesIgnored, rejectedOccurrences } : ko ? { names: codes, duplicatesIgnored } : { codes, duplicatesIgnored };
  }
  if (family === 6) {
    if (!advanced) {
      const r = object(source[ko ? "현재표시" : "label"]);
      return { id: string(r[ko ? "번호" : "id"]), caption: string(r[ko ? "제목" : "caption"]), active: boolean(r[ko ? "공개" : "active"]),
        tags: has(r, ko ? "표식" : "tags") ? strings(r[ko ? "표식" : "tags"]) : [], shelf: optionalString(r, ko ? "보관위치" : "shelf"), printedText: string(r[ko ? "인쇄문구" : "printedText"]) };
    }
    const base = object(source[ko ? "기본" : "base"]), override = object(source[ko ? "수정" : "override"]);
    const field = (key: string) => has(override, key) ? override[key] : base[key];
    const panel = object(field(ko ? "안내판" : "panel"));
    const contact = field(ko ? "연락처" : "contact");
    return { title: string(field(ko ? "제목" : "title")), enabled: boolean(field(ko ? "사용" : "enabled")), tags: strings(field(ko ? "표식" : "tags")),
      contact: contact === undefined || contact === null ? null : string(contact), panel: { left: string(panel[ko ? "왼쪽" : "left"]), right: string(panel[ko ? "오른쪽" : "right"]) } };
  }
  return fail("unknown_extraction_family");
}

function calculate(source: Row, ko: boolean, advanced: boolean, family: number): Row {
  if (family === 1) {
    const events = rows(source[ko ? "변동" : "events"]).filter(r => boolean(r[ko ? "확정" : "accepted"]));
    const delta = (r: Row) => {
      const kind = string(r[ko ? "구분" : "kind"]);
      const quantity = nonnegative(r[ko ? "수량" : advanced ? "units" : "quantity"]);
      if ((ko ? ["입고", "반품"] : ["receipt", "return"]).includes(kind)) return quantity;
      if ((ko ? ["출고", "폐기"] : ["shipment", "damage"]).includes(kind)) return -quantity;
      return fail("unknown_stock_event");
    };
    if (!advanced) {
      const values = events.map(delta), added = sum(values.filter(n => n >= 0)), removed = -sum(values.filter(n => n < 0));
      const remaining = integer(nonnegative(source[ko ? "기초재고" : "opening"]) + added - removed);
      return ko ? { added, removed, remaining } : { received: added, removed, remaining };
    }
    const opening = rows(source[ko ? "기초표" : "opening"]), index = uniqueIndex(opening, ko ? "품목" : "sku");
    const order = ko ? opening.map(r => string(r.품목)) : strings(source.outputOrder);
    if (order.length !== index.size || new Set(order).size !== order.length) return fail("invalid_stock_order");
    const stock = order.map(sku => {
      const r = index.get(sku);
      if (!r) return fail("unknown_sku");
      const ending = integer(nonnegative(r[ko ? "수량" : "units"]) + sum(events.filter(e => e[ko ? "품목" : "sku"] === sku).map(delta)));
      return { sku, ending, available: integer(ending - nonnegative(r[ko ? "검사대기" : "reserved"])) };
    });
    return { stock, totalAvailable: sum(stock.map(r => r.available)) };
  }
  if (family === 2) {
    const lines = rows(source[ko ? "항목" : "lines"]).filter(r => ko ? boolean(r[advanced ? "승인" : "결제대상"]) : advanced ? !boolean(r.cancelled) : true);
    const subtotal = sum(lines.map(r => integer(scale(nonnegative(r[ko ? "수량" : "quantity"]), nonnegative(r[ko ? "단가" : "unitPoints"]))) - (advanced ? nonnegative(r[ko ? "항목차감" : "lineRebate"]) : 0)));
    if (!advanced) {
      const afterRebate = integer(subtotal - nonnegative(source[ko ? "장바구니차감액" : "orderRebate"]));
      return { subtotal, afterRebate, total: integer(afterRebate + nonnegative(source[ko ? "포장점수" : "deliveryPoints"])) };
    }
    if (ko) {
      const discount = integer(scale(subtotal, 1, 8)), afterDiscount = integer(subtotal - discount);
      return { itemIds: lines.map(r => string(r.번호)), lineNetTotal: subtotal, discount, afterDiscount, total: integer(afterDiscount + nonnegative(source.배송점수)) };
    }
    const orderRebate = integer(scale(subtotal, 1, 10)), taxable = integer(subtotal - orderRebate), tax = roundHalfUp(integer(scale(taxable, 5)), 100);
    return { lineIds: lines.map(r => string(r.id)), lineNetTotal: subtotal, orderRebate, taxable, tax, total: sum([taxable, tax, nonnegative(source.deliveryPoints)]) };
  }
  if (family === 3) {
    const convert = (value: JsonValue, unit: JsonValue): number => {
      const n = number(value), u = string(unit);
      if (n < 0) return fail("negative_measure");
      if (ko) {
        if (u === "m") return integer(scale(n, 100));
        if (u === "cm") return integer(n);
        if (u === "mm") return integer(scale(n, 1, 10));
      } else {
        if (u === "kg") return integer(scale(n, 1000));
        if (u === "g") return integer(n);
      }
      return fail("unknown_measure_unit");
    };
    if (!advanced) {
      const total = sum(rows(source[ko ? "끈" : "masses"]).map(r => convert(r[ko ? "길이" : "value"], r[ko ? "단위" : "unit"])));
      const remaining = integer(total - nonnegative(source[ko ? "절단량cm" : "usedGrams"]));
      return ko ? { totalCm: total, remainingCm: remaining, remainingM: scale(remaining, 1, 100) } : { totalGrams: total, remainingGrams: remaining, remainingKg: scale(remaining, 1, 1000) };
    }
    const included = rows(source[ko ? "막대" : "batches"]).filter(r => boolean(r[ko ? "사용가능" : "accepted"]));
    const usable = included.map(r => integer(convert(r[ko ? "길이" : "mass"], r[ko ? "단위" : "unit"]) - nonnegative(r[ko ? "손질cm" : "wasteGrams"])));
    const total = sum(usable), available = integer(total - nonnegative(source[ko ? "공동보관cm" : "reserveGrams"]));
    return ko
      ? { rods: included.map((r, i) => ({ id: string(r.번호), usableCm: usable[i] })), usableTotalCm: total, availableCm: available, availableM: scale(available, 1, 100) }
      : { batches: included.map((r, i) => ({ id: string(r.id), usableGrams: usable[i] })), usableTotalGrams: total, availableGrams: available, availableKg: scale(available, 1, 1000) };
  }
  if (family === 4) {
    if (!advanced) {
      const elapsedMinutes = nonnegative(time(source[ko ? "종료" : "end"]) - time(source[ko ? "시작" : "start"]));
      const rest = ko ? sum(array(source.휴식분).map(nonnegative)) : nonnegative(source.breakMinutes);
      const workingMinutes = nonnegative(elapsedMinutes - rest);
      return ko ? { elapsedMinutes, workingMinutes, workingHours: scale(workingMinutes, 1, 60) } : { elapsedMinutes, workingMinutes };
    }
    const timestamp = (v: JsonValue) => {
      const r = object(v);
      return integer(scale(nonnegative(r[ko ? "날" : "day"]), 1440) + time(r[ko ? "시각" : "time"]));
    };
    const windows = rows(source[ko ? "작업" : "windows"]).map((r): Row => {
      const start = timestamp(r[ko ? "시작" : "start"]), end = timestamp(r[ko ? "종료" : "end"]);
      const intervals = rows(r[ko ? "휴식" : "breaks"]).map(b => ({ start: timestamp(b[ko ? "시작" : "start"]), end: timestamp(b[ko ? "종료" : "end"]) }));
      const chronological = [...intervals].sort((a, b) => a.start - b.start);
      for (let i = 0; i < chronological.length; i++) {
        const b = chronological[i];
        if (b.start < start || b.end > end || b.end < b.start || (i > 0 && chronological[i - 1].end > b.start)) fail("invalid_break_interval");
      }
      const workingMinutes = nonnegative(end - start - sum(intervals.map(b => b.end - b.start)));
      const id = string(r[ko ? "번호" : "id"]);
      if (ko) return { id, workingMinutes };
      const blocks = ceilDivide(workingMinutes, 15);
      return { id, workingMinutes, blocks, points: integer(scale(blocks, 5)) };
    });
    const totalWorkingMinutes = sum(windows.map(r => integer(r.workingMinutes)));
    return ko ? { windows, totalWorkingMinutes, blocks30: ceilDivide(totalWorkingMinutes, 30) } : { windows, totalWorkingMinutes, totalPoints: sum(windows.map(r => integer(r.points))) };
  }
  if (family === 5) {
    const included = rows(source[ko ? "묶음" : "groups"]).filter(r => !advanced || boolean(r[ko ? "채택" : "included"]));
    const adjusted = included.map(r => !advanced ? integer(r[ko ? "점수" : "score"]) : ko
      ? Math.max(0, integer(r.원점수) - nonnegative(r.감점)) : Math.min(10, integer(r.rawScore) + nonnegative(r.bonus)));
    const samples = sum(included.map(r => nonnegative(r[ko ? "개수" : "count"])));
    const weightedTotal = sum(included.map((r, i) => integer(scale(adjusted[i], nonnegative(r[ko ? "개수" : "count"])))));
    const mean = scale(weightedTotal, 1, samples), target = number(source[ko ? "기준" : "target"]);
    const targetFraction = fraction(target);
    const meets = BigInt(weightedTotal) * targetFraction.d >= targetFraction.n * BigInt(samples);
    const result: Row = { samples, weightedTotal, mean, [ko ? "passes" : "meetsTarget"]: meets };
    if (advanced) result.groups = included.map((r, i) => ({ id: string(r[ko ? "번호" : "id"]), adjustedScore: adjusted[i] }));
    return result;
  }
  if (family === 6) {
    const starting = nonnegative(source[ko ? advanced ? "처음점수" : "전체점수" : advanced ? "startingPoints" : "points"]);
    const protectedPoints = nonnegative(source[ko ? advanced ? "안전점수" : "보관점수" : advanced ? "protectedPoints" : "reserved"]);
    let balance = nonnegative(starting - protectedPoints), totalUnits = 0, totalSpent = 0;
    const allocations = rows(source[ko ? "신청" : "requests"]).map((r): Row => {
      const price = nonnegative(r[ko ? advanced ? "단가" : "개당점수" : "pointsPerUnit"]);
      if (!price) return fail("zero_unit_price");
      const requested = nonnegative(r[ko ? advanced ? "희망" : "희망개수" : "requested"]);
      const rowLimit = advanced ? nonnegative(r[ko ? "행상한" : "rowLimit"]) : requested;
      const open = !advanced || boolean(r[ko ? "승인" : "open"]);
      const affordable = integer(Number(BigInt(balance) / BigInt(price)));
      const units = open ? Math.min(requested, rowLimit, affordable) : 0;
      const spent = integer(scale(units, price));
      balance = nonnegative(balance - spent); totalSpent = integer(totalSpent + spent); totalUnits = integer(totalUnits + units);
      const id = string(r[ko ? "번호" : "id"]);
      return advanced ? { id, units, spent } : { id, units };
    });
    if (balance + totalSpent + protectedPoints !== starting) return fail("allocation_conservation");
    return advanced
      ? { allocations, totalSpent, spendableRemaining: balance, [ko ? "totalBalance" : "finalBalance"]: integer(balance + protectedPoints) }
      : { allocations, totalUnits, spendableRemaining: balance, protectedPoints };
  }
  return fail("unknown_calculation_family");
}

export interface V2PromptDerivation {
  expected: JsonValue;
  checks: string[];
  rationale: string;
  promptDigest: string;
}

/** Rejects changed rules/facts even when they happen to yield the same answer. */
export function deriveExpectedForV2Prompt(input: { id: string; prompt: string }): V2PromptDerivation {
  const fields = strictBenchmarkObject(input, ["id", "prompt"], "v2 oracle input");
  const id = string(fields.id), prompt = string(fields.prompt);
  if (Buffer.byteLength(prompt, "utf8") > DEVELOPMENT_LIMITS.promptBytes) return fail("prompt_too_large");
  const promptDigest = benchmarkDigest(prompt);
  if (!Object.prototype.hasOwnProperty.call(PROMPT_DIGESTS, id)) return fail("unfrozen_id");
  if (PROMPT_DIGESTS[id] !== promptDigest) return fail("unfrozen_prompt");
  const match = /^v2-(en|ko)-(extract|calc)-(basic|advanced)-(0[1-6])$/.exec(id);
  if (!match) return fail("unsupported_id");
  const begin = "\nSOURCE_JSON\n", end = "\nEND_SOURCE_JSON";
  const start = prompt.indexOf(begin), finish = prompt.indexOf(end);
  if (start < 0 || finish <= start || prompt.indexOf(begin, start + begin.length) >= 0 || prompt.indexOf(end, finish + end.length) >= 0) return fail("source_framing");
  const source = object(parseBenchmarkJson(prompt.slice(start + begin.length, finish), DEVELOPMENT_LIMITS.promptBytes));
  const ko = match[1] === "ko", advanced = match[3] === "advanced", family = Number(match[4]);
  const expected = match[2] === "extract" ? extract(source, ko, advanced, family) : calculate(source, ko, advanced, family);
  canonicalBenchmarkJson(expected);
  return {
    expected,
    promptDigest,
    checks: ["full_prompt_digest_frozen", "strict_source_json", "independent_prompt_rule_derivation", "exact_json_output", match[2] === "calc" ? "decimal_rational_arithmetic" : "explicit_null_presence_and_source_order"],
    rationale: `Prompt-only ${match[1]} ${match[2]} ${match[3]} family ${match[4]}; rules transcribed independently and applied to SOURCE_JSON. No authored expected values are read.`,
  };
}
