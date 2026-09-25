import { describe, expect, it } from "vitest";
import { MAX_NOTE_CHARS, noteToText } from "./note-text";

describe("noteToText", () => {
  it("turns HTML into plain text, keeping paragraph and line breaks and dropping scripts and styles", () => {
    const html = `<html><head><style>p{color:red}</style><script>alert(1)</script></head><body>
      <p>Chief complaint:&nbsp;cough &amp; fever</p><div>Plan<br>Rest &lt;3 days&gt;</div><ul><li>Fluids</li><li>Tylenol</li></ul></body></html>`;
    expect(noteToText("text/html", html)).toBe("Chief complaint: cough & fever\nPlan\nRest <3 days>\nFluids\nTylenol");
  });

  it("turns RTF into plain text", () => {
    const rtf = String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}{\*\generator Epic;}\f0\fs20 Assessment:\par Stable\'e9 condition.\par}`;
    expect(noteToText("text/rtf", rtf)).toBe("Assessment:\nStableé condition.");
  });

  it("passes plain text through and gives up on other formats", () => {
    expect(noteToText("text/plain; charset=utf-8", "  Follow up in 2 weeks.  ")).toBe("Follow up in 2 weeks.");
    expect(noteToText("application/pdf", "%PDF-1.4")).toBeNull();
  });

  it("caps very long notes", () => {
    const text = noteToText("text/plain", "a".repeat(MAX_NOTE_CHARS + 500))!;
    expect(text.length).toBeLessThanOrEqual(MAX_NOTE_CHARS + 40);
    expect(text.endsWith("[Note shortened]")).toBe(true);
  });
});
