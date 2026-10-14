import type { WildcardFile } from "./wildcards";

export const MAX_PATH_DEPTH = 32;

// Paths describe relationships only; object storage always uses opaque keys.
export function relativePathError(name: string, path: unknown): string | null {
  if (path === undefined) return null;
  if (typeof path !== "string" || !path || path.length > 1024) return "Use a relative file path of 1–1024 characters.";
  const segments = path.split("/");
  if (segments.length > MAX_PATH_DEPTH || segments.some((segment) =>
    !segment || segment === "." || segment === ".." || segment.length > 255 ||
    /[\x00-\x1f\x7f\\\u202a-\u202e\u2066-\u2069]/u.test(segment)) || /^[a-z]:/i.test(path)) {
    return "Use a relative file path without empty folders, dot segments, backslashes, or control characters, at most 32 levels deep.";
  }
  if (segments.at(-1) !== name) return "The file path must end with the original filename.";
  return null;
}

export type FileFolder = {
  name: string;
  path: string;
  folders: Map<string, FileFolder>;
  files: WildcardFile[];
  fileCount: number;
  sizeBytes: number;
};

export function buildFileTree(files: WildcardFile[]): FileFolder {
  const root: FileFolder = { name: "", path: "", folders: new Map(), files: [], fileCount: 0, sizeBytes: 0 };
  for (const file of files) {
    let folder = root;
    const segments = (file.relativePath ?? file.name).split("/").slice(0, -1);
    for (const name of segments) {
      folder.fileCount++;
      folder.sizeBytes += file.sizeBytes;
      let child = folder.folders.get(name);
      if (!child) {
        child = { name, path: folder.path ? `${folder.path}/${name}` : name, folders: new Map(), files: [], fileCount: 0, sizeBytes: 0 };
        folder.folders.set(name, child);
      }
      folder = child;
    }
    folder.fileCount++;
    folder.sizeBytes += file.sizeBytes;
    // Keep all file IDs, even when names or complete paths are identical.
    folder.files.push(file);
  }
  return root;
}
