import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatAnswer, ToolActivity } from "./ChatPresentation";
import { currentToolStep, toolSteps, type ActivityEvent } from "./chat-client-state";

const event = (sequence: number, kind: string, payload: ActivityEvent["payload"]): ActivityEvent => ({ sequence, kind, payload, createdAt: "2026-10-11T12:00:00Z" });

describe("chat presentation", () => {
  it("shows descriptions and outcomes with timing in secondary text", () => {
    const events = [event(1, "tool.started", { toolCallId: "a", tool: "find_records", description: "Searching labs for LDL" }), event(2, "tool.completed", { toolCallId: "a", status: "completed", outcome: "2 results returned", durationMs: 200 })];
    const html = renderToStaticMarkup(React.createElement(ToolActivity, { events, active: false }));
    expect(html).toContain("Searching labs for LDL");
    expect(html).toContain("2 results returned");
    expect(html).toContain('class="chat-tool-duration"');
    expect(html).not.toContain(">Done<");
    const running = renderToStaticMarkup(React.createElement(ToolActivity, { events: events.slice(0, 1), active: true }));
    expect(running.match(/Searching labs for LDL/g)).toHaveLength(2);
    expect(currentToolStep(events.slice(0, 1))).toBe("Searching labs for LDL");
  });

  it("pairs completion descriptions with their own call and hides outcomes on failures", () => {
    const steps = toolSteps([event(1, "tool.started", { toolCallId: "a", tool: "read_records", description: "Reading 2 selected records" }), event(2, "tool.completed", { toolCallId: "a", status: "completed", description: "Reading records: Synthetic lab", outcome: "1 record read" })], false);
    expect(steps[0]).toMatchObject({ description: "Reading records: Synthetic lab", outcome: "1 record read" });
    expect(toolSteps([event(1, "tool.started", { toolCallId: "a", tool: "find_records" }), event(2, "tool.completed", { toolCallId: "a", status: "failed", outcome: "2 results returned" })], false)[0].outcome).toBeUndefined();
  });
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
