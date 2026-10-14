import { describe, expect, it } from "vitest";
import { buildFileTree, relativePathError } from "./wildcards-paths";
import type { WildcardFile } from "./wildcards";

function file(id: string, relativePath?: string): WildcardFile {
  return { id, name: "note.txt", relativePath, type: "text/plain", sizeBytes: 5, uploadedAt: "2026-10-14T00:00:00.000Z", status: "ready" };
}

describe("relative file paths", () => {
  it("preserves Unicode, spaces, case, and the selected root while allowing legacy files", () => {
    expect(relativePathError("note.txt", undefined)).toBeNull();
    expect(relativePathError("note.txt", "Résumés/Visit 1/note.txt")).toBeNull();
    expect(relativePathError("note.txt", "note.txt")).toBeNull();
  });
  it.each([null, 5, {}, "", "/note.txt", "../note.txt", "Root/./note.txt", "Root/../note.txt", "Root//note.txt", "Root/note.txt/", "Root\\note.txt", "C:/note.txt", "Root/other.txt", "Root/Note.txt", "Root/\n/note.txt", "Root/\u0000/note.txt", "Root/\u202e/note.txt", "Root/\u2066/note.txt", `${"a".repeat(256)}/note.txt`, `${"a/".repeat(32)}note.txt`, `${("a".repeat(200) + "/").repeat(6)}note.txt`])("rejects unsafe or mismatched path %j", (path) => {
    expect(relativePathError("note.txt", path)).not.toBeNull();
  });
});

describe("uploaded file structure", () => {
  it("groups nested files, keeps duplicate paths and legacy files, and totals every folder", () => {
    const root = buildFileTree([file("loose"), file("a", "Records/Visits/note.txt"), file("b", "Records/Labs/note.txt"), file("c", "Records/Visits/note.txt")]);
    expect(root.files.map((file) => file.id)).toEqual(["loose"]);
    expect(root.fileCount).toBe(4);
    expect(root.sizeBytes).toBe(20);
    const records = root.folders.get("Records")!;
    expect(records.fileCount).toBe(3);
    expect(records.sizeBytes).toBe(15);
    expect(records.folders.get("Visits")?.files.map((file) => file.id)).toEqual(["a", "c"]);
    expect(records.folders.get("Labs")?.files[0].id).toBe("b");
    expect(records.folders.get("Visits")?.path).toBe("Records/Visits");
  });
  it("separates roots and treats unusual directory names as data", () => {
    const root = buildFileTree([file("a", "__proto__/note.txt"), file("b", "constructor/note.txt"), file("c", "records/note.txt"), file("d", "Records/note.txt")]);
    expect(root.folders.size).toBe(4);
    expect(root.folders.get("__proto__")?.files[0].id).toBe("a");
  });
  it("removes inferred folders when their final file is removed", () => {
    const files = [file("a", "Records/Visits/note.txt"), file("b", "Records/Labs/note.txt")];
    expect(buildFileTree(files.slice(1)).folders.get("Records")?.folders.has("Visits")).toBe(false);
    expect(buildFileTree([]).folders.size).toBe(0);
  });
});
