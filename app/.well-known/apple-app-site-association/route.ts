const appID = "F9KS3F6G9F.app.tomverse.shell";

export const dynamic = "force-static";

export function GET() {
  return Response.json(
    {
      applinks: {
        details: [{ appIDs: [appID], components: [{ "/": "/auth/mobile/callback" }] }],
      },
      webcredentials: { apps: [appID] },
    },
    {
      headers: {
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
