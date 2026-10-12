import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatAnswer, ToolActivity } from "./ChatPresentation";
import { toolSteps, type ActivityEvent } from "./chat-client-state";

const event = (sequence: number, kind: string, payload: ActivityEvent["payload"]): ActivityEvent => ({ sequence, kind, payload, createdAt: "2026-10-11T12:00:00Z" });

describe("chat presentation", () => {
  it("pairs concurrent calls by ID even when they finish out of order without tool names", () => {
    const events = [event(1, "tool.started", { toolCallId: "a", tool: "find_records" }), event(2, "tool.started", { toolCallId: "b", tool: "read_research" }), event(3, "tool.completed", { toolCallId: "b", status: "failed" })];
    expect(toolSteps(events, true)).toEqual([{ id: "a", tool: "find_records", status: "running" }, { id: "b", tool: "read_research", status: "failed" }]);
    expect(toolSteps(events, false)[0].status).toBe("interrupted");
    const html = renderToStaticMarkup(React.createElement(ToolActivity, { events, active: true }));
    expect(html).toContain("Searching your records");
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("read_research");
  });

  it("never attaches an unmatched completion to another running lookup", () => {
    expect(toolSteps([event(1, "tool.started", { toolCallId: "a", tool: "read_records" }), event(2, "tool.completed", { toolCallId: "missing", status: "completed" })], true)[0].status).toBe("running");
    expect(toolSteps([event(1, "tool.started", { toolCallId: "a", tool: "read_records" }), event(2, "tool.completed", {})], true)[0].status).toBe("running");
  });

  it("formats answers while keeping HTML and executable links inert", () => {
    const html = renderToStaticMarkup(React.createElement(ChatAnswer, { text: '## Results\n\n**Context** and `units`\n\n- First\n- Second\n\n<script>unsafe()</script>\n[open](javascript:unsafe())' }));
    expect(html).toContain("<h3>Results</h3>");
    expect(html).toContain("<strong>Context</strong>");
    expect(html).toContain("<ul><li>First</li><li>Second</li></ul>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<a ");
  });
});
