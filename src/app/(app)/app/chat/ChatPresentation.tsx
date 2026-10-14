"use client";

import { Fragment, useState } from "react";
import { TOOL_LABELS } from "@/lib/chat/tool-activity";
import { describeRunFailure, formatToolDuration, toolSteps, type ActivityEvent } from "./chat-client-state";

export function ChatIcon({ name }: { name: "plus" | "arrow" | "stop" | "chat" | "spark" | "copy" | "down" | "menu" }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none" />,
    chat: <path d="M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z" />,
    spark: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></>,
    down: <path d="M12 5v14m-6-6 6 6 6-6" />,
    menu: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function ToolActivity({ events, active }: { events: ActivityEvent[]; active: boolean }) {
  const steps = toolSteps(events, active);
  if (!steps.length) return null;
  const running = steps.filter(step => step.status === "running");
  const failed = steps.some(step => ["failed", "rejected", "interrupted"].includes(step.status));
  return <details className="chat-tools">
    <summary><span className={`chat-tool-indicator ${running.length ? "is-running" : ""}`} aria-hidden="true">{running.length ? "" : failed ? "!" : "✓"}</span>
      <span>{running.length ? running[0].description ?? TOOL_LABELS[running[0].tool] ?? "Looking up information" : `${steps.length} ${steps.length === 1 ? "step" : "steps"}${failed ? " · Some lookups unavailable" : " completed"}`}</span>
      <span className="chat-disclosure" aria-hidden="true">⌄</span>
    </summary>
    <ol>{steps.map(step => <li key={step.id}>
      <span className={`chat-tool-indicator ${step.status === "running" ? "is-running" : ""}`} aria-hidden="true">{step.status === "running" ? "" : step.status === "completed" ? "✓" : "!"}</span>
      <span className="chat-tool-description">{step.description ?? TOOL_LABELS[step.tool] ?? "Looking up information"}{step.failure && <small className="chat-tool-failure">{describeRunFailure(step.failure)}</small>}</span>
      <span className="chat-tool-status">{step.status === "running" ? "In progress" : step.status === "completed" ? step.outcome ?? "Done" : step.status === "interrupted" ? "Stopped" : "Unavailable"}{formatToolDuration(step.durationMs) && <small className="chat-tool-duration">{formatToolDuration(step.durationMs)}</small>}</span>
    </li>)}</ol>
  </details>;
}

// Render a small, safe subset of Markdown as React text. Never interpret HTML or URLs.
type RecordReference = { id: string; label: string; target: string };
function referencedText(text: string, references: RecordReference[], onReference?: () => void) {
  return text.split(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi).map((part, index) => {
    const reference = references.find(reference => reference.id === part);
    return reference ? <a key={index} className="chat-inline-source" href={`#${reference.target}`} onClick={() => { onReference?.(); requestAnimationFrame(() => { const element = document.getElementById(reference.target); if (element instanceof HTMLDetailsElement) { element.open = true; element.scrollIntoView({ block: "nearest" }); } }); }}>{reference.label}</a> : part;
  });
}
function inline(text: string, references: RecordReference[] = [], onReference?: () => void) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => part.startsWith("**")
    ? <strong key={index}>{referencedText(part.slice(2, -2), references, onReference)}</strong>
    : part.startsWith("`") ? <code key={index}>{referencedText(part.slice(1, -1), references, onReference)}</code> : <Fragment key={index}>{referencedText(part, references, onReference)}</Fragment>);
}

export function ChatAnswer({ text, references = [], onReference }: { text: string; references?: RecordReference[]; onReference?: () => void }) {
  const format = (text: string) => inline(text, references, onReference);
  return <div className="chat-answer">{text.split(/\n\s*\n/).map((block, index) => {
    const lines = block.split("\n");
    if (lines.every(line => /^\s*[-*] /.test(line))) return <ul key={index}>{lines.map((line, i) => <li key={i}>{format(line.replace(/^\s*[-*] /, ""))}</li>)}</ul>;
    if (lines.every(line => /^\s*\d+[.)] /.test(line))) return <ol key={index}>{lines.map((line, i) => <li key={i}>{format(line.replace(/^\s*\d+[.)] /, ""))}</li>)}</ol>;
    return <div key={index}>{lines.map((line, i) => /^#{1,6} /.test(line)
      ? <h3 key={i}>{format(line.replace(/^#{1,6} /, ""))}</h3>
      : <Fragment key={i}>{i > 0 && <br />}{format(line)}</Fragment>)}</div>;
  })}</div>;
}

export function CopyAnswer({ text }: { text: string }) {
  const [status, setStatus] = useState("");
  return <button className="chat-copy" type="button" aria-label="Copy response" onClick={() => {
    void navigator.clipboard.writeText(text).then(() => setStatus("Copied"), () => setStatus("Could not copy"));
  }}><ChatIcon name="copy" /><span role="status">{status || "Copy"}</span></button>;
}
