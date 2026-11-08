import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminBars, AdminDonut, AdminGauge, AdminRing, AdminSparkline } from "@/components/admin/ui/AdminCharts";
import { AdminDataTable } from "@/components/admin/ui/AdminDataTable";
import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminPixelAvatar } from "@/components/admin/ui/AdminPixelAvatar";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";

test("an unread number says Unavailable and never renders a zero", () => {
  const html = renderToStaticMarkup(<AdminKpiCard label="AI cost today" value={null} onRetry={() => {}} />);
  assert.match(html, /data-unread="true"/);
  assert.match(html, />Unavailable</);
  assert.match(html, /Could not be read\./);
  assert.match(html, /Try again<\/button>/);
  assert.doesNotMatch(html, />0</);
  // No trend line for a value nobody could read.
  assert.doesNotMatch(html, /<svg[^>]*role="img"/);
});

test("a read number shows its value, detail and trend", () => {
  const html = renderToStaticMarkup(
    <AdminKpiCard label="Revenue today" value="A$ 412" detail="+8% on yesterday" trend={[1, 2, 3]} />
  );
  assert.doesNotMatch(html, /data-unread/);
  assert.match(html, /A\$ 412/);
  assert.match(html, /\+8% on yesterday/);
  assert.match(html, /<svg[^>]*role="img"[^>]*aria-label="Revenue today"/);
});

test("a status chip without words says its tone, and unknown is not healthy", () => {
  assert.match(renderToStaticMarkup(<AdminStatusChip tone="ok" />), /data-tone="ok"[^>]*>Healthy</);
  const unknown = renderToStaticMarkup(<AdminStatusChip tone="unknown" />);
  assert.match(unknown, />Unavailable</);
  assert.match(unknown, /border-dashed/);
  assert.match(renderToStaticMarkup(<AdminStatusChip tone="warn">Slow</AdminStatusChip>), />Slow</);
});

test("a write button without access is locked and says which access it needs", () => {
  const html = renderToStaticMarkup(
    <AdminWriteButton writable={false} requiredRole="ops:write">
      Save
    </AdminWriteButton>
  );
  assert.match(html, /<button[^>]*disabled=""/);
  assert.match(html, /title="Needs ops:write access"/);
  const described = html.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(described);
  assert.match(html, new RegExp(`<span id="${described}" class="sr-only">Needs ops:write access</span>`));
});

test("a step-up action shows it before it is pressed", () => {
  const html = renderToStaticMarkup(<AdminWriteButton stepUp>Approve</AdminWriteButton>);
  assert.match(html, /data-step-up="true"/);
  assert.doesNotMatch(html, /disabled=""/);
});

test("a failed read is an alert with a retry, an empty list is a status", () => {
  const error = renderToStaticMarkup(<AdminStateBlock kind="error" title="Could not load" onRetry={() => {}} />);
  assert.match(error, /role="alert"/);
  assert.match(error, /Try again/);
  const empty = renderToStaticMarkup(<AdminStateBlock kind="empty" title="Nothing to do" />);
  assert.match(empty, /role="status"/);
  assert.doesNotMatch(empty, /Try again/);
  assert.match(renderToStaticMarkup(<AdminStateBlock kind="loading" />), /aria-label="Loading"/);
});

test("a table renders the same rows as a table and as phone cards", () => {
  const rows = [
    { id: "a", email: "user01@example.com", plan: "Pro" },
    { id: "b", email: "user02@example.com", plan: "Max" },
  ];
  const html = renderToStaticMarkup(
    <AdminDataTable
      caption="Users"
      rows={rows}
      rowKey={(row) => row.id}
      columns={[
        { key: "email", header: "User", render: (row) => row.email },
        { key: "plan", header: "Plan", render: (row) => row.plan },
      ]}
      cardTitle={(row) => row.email}
      cardMeta={(row) => row.plan}
    />
  );
  assert.match(html, /<table class="hidden[^"]*sm:table"/);
  assert.match(html, /<caption class="sr-only">Users<\/caption>/);
  assert.match(html, /<ul class="[^"]*sm:hidden" aria-label="Users"/);
  assert.equal(html.match(/user01@example\.com/g)?.length, 2);
});

test("an empty table shows its empty state instead of an empty grid", () => {
  const html = renderToStaticMarkup(
    <AdminDataTable
      caption="Users"
      rows={[]}
      rowKey={() => ""}
      columns={[{ key: "x", header: "X", render: () => null }]}
      emptyState={<AdminStateBlock kind="empty" title="No users yet" />}
    />
  );
  assert.match(html, /No users yet/);
  assert.doesNotMatch(html, /<table/);
});

test("technical details are closed by default", () => {
  const html = renderToStaticMarkup(<AdminTechInfo summary="policy, ids">amux-execution v52</AdminTechInfo>);
  assert.match(html, /<details class=/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  assert.match(html, /Technical details/);
});

test("charts draw nothing they cannot read", () => {
  assert.equal(renderToStaticMarkup(<AdminSparkline values={[]} label="x" />), "");
  assert.equal(renderToStaticMarkup(<AdminBars values={[1, -2]} label="x" />), "");
  assert.equal(renderToStaticMarkup(<AdminDonut segments={[]} label="x" />), "");
  assert.equal(renderToStaticMarkup(<AdminRing fraction={Number.NaN} label="x" />), "");
  assert.equal(renderToStaticMarkup(<AdminGauge score={Number.NaN} label="x" />), "");
  // Colours go through the palette variables, so Light can remap them.
  assert.match(renderToStaticMarkup(<AdminBars values={[1, 2]} color="emerald" label="x" />), /var\(--color-emerald-500\)/);
});

test("a team's avatar is labelled when it stands alone and sits on its tint tile", () => {
  const html = renderToStaticMarkup(<AdminPixelAvatar team="sre" tile={40} body={false} label="SRE" />);
  assert.match(html, /bg-red-500\/15/);
  assert.match(html, /role="img" aria-label="SRE"/);
  assert.match(html, /shape-rendering="crispEdges"/);
  const decorative = renderToStaticMarkup(<AdminPixelAvatar team="marketing" />);
  assert.match(decorative, /aria-hidden="true"/);
});

test("a tile has a heading only when it is given a title", () => {
  assert.match(renderToStaticMarkup(<AdminTile title="Decisions">x</AdminTile>), /<h2[^>]*>Decisions<\/h2>/);
  assert.doesNotMatch(renderToStaticMarkup(<AdminTile>x</AdminTile>), /<h2/);
});
