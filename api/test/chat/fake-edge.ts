// A scripted stand-in for the VPS edge service (inference relay and research), used as the chat
// tests' outbound service. Runs in Node, in the Vitest process. Markers in the question pick a
// script: [plain] answers at once; [slow] delays the answer after the tool; [slowfirst] delays
// the tool call; [summary] reads records, then saves a summary with one of them as evidence.
const TOKEN = "test-edge-token";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stream(deltas: Record<string, unknown>[], finish: string): Response {
  const lines = deltas.map((delta, i) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: i === deltas.length - 1 ? finish : null }] })}\n\n`);
  return new Response(`${lines.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
const toolCall = (name: string, args: unknown, n: number) => stream([{ role: "assistant", tool_calls: [{ index: 0, id: `call_${n}_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, {}], "tool_calls");
const answer = (text: string) => stream([{ role: "assistant", content: text.slice(0, 10) }, { content: text.slice(10) }, {}], "stop");

export async function fakeEdge(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== "edge.test") return new Response("no network in tests", { status: 502 });
  if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  if (url.pathname === "/v1/research/search") return Response.json({ snapshotId: "a".repeat(64), results: [] });
  if (url.pathname !== "/v1/inference/chat/completions") return new Response("not found", { status: 404 });
  const body = (await request.json()) as { messages: { role: string; content?: unknown }[] };
  const question = String([...body.messages].reverse().find((m) => m.role === "user")?.content ?? "");
  const results = body.messages.filter((m) => m.role === "tool");
  if (question.includes("[plain]")) return answer("Hello from the fake model.");
  if (!results.length) {
    if (question.includes("[slowfirst]")) await delay(1500);
    return toolCall("find_records", { query: "eosinophils", limit: 5 }, 1);
  }
  if (question.includes("[summary]") && results.length === 1) {
    const found = JSON.parse(String(results[0].content)) as { records: { citation: { id: string } }[] };
    return toolCall("save_summary", { title: "Eosinophils", text: "Two biopsies were read.", coverageState: "partial", evidence: [{ kind: "record", targetId: found.records[0].citation.id }] }, 2);
  }
  if (question.includes("[slow]")) await delay(1500);
  return answer(`I read ${results.length} tool result(s) for you.`);
}
