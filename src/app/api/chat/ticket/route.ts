export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store, private", "Pragma": "no-cache" };

// Retire the browser/VPS credential path even if obsolete environment values remain.
export async function POST() {
  return Response.json({ error: "chat_ticket_retired" }, { status: 410, headers });
}
