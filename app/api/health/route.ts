export const dynamic = "force-dynamic";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function GET() {
  return Response.json({ ok: true }, { status: 200, headers });
}

export function HEAD() {
  return new Response(null, {
    status: 204,
    headers,
  });
}
