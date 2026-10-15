import { UploadError, uploadDocument, type SelectedFile } from "./wildcards-client";
import { fileSizeError } from "./wildcards";
import { documentHash } from "./document-hash";
import { recoveryUploadId } from "./documents-recovery";

type Item = SelectedFile & { id: string; file: File; state: "waiting" | "active" | "done" | "failed"; message: string };
export class DocumentQueue {
  items: Item[] = [];
  running = false;
  paused = false;
  notice = "";
  done = 0;
  failed = 0;
  skipped = 0;
  active?: Item;
  private controller?: AbortController;
  private disposed = false;
  private listeners = new Set<() => void>();
  private revision = 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.revision;
  private emit() { this.revision++; this.listeners.forEach((listener) => listener()); }
  constructor(private refresh: () => void, private owner: string, private transfer = uploadDocument) {}
  add(files: (File | SelectedFile)[]) {
    const selected = new Map<File, Set<string | undefined>>();
    for (const item of this.items) {
      const paths = selected.get(item.file) ?? new Set(); paths.add(item.relativePath); selected.set(item.file, paths);
    }
    let skipped = 0;
    for (const selection of files) {
      const { file, relativePath } = selection instanceof File ? { file: selection, relativePath: selection.webkitRelativePath || undefined } : selection;
      // Separate files can have identical names, sizes, and modification dates.
      // Content fingerprints reconcile repeats without dropping different data.
      if (selected.get(file)?.has(relativePath)) { skipped++; continue; }
      const paths = selected.get(file) ?? new Set(); paths.add(relativePath); selected.set(file, paths);
      this.items.push({ id: crypto.randomUUID(), file, relativePath, state: "waiting", message: "Waiting" });
    }
    this.notice = skipped ? `${skipped} file(s) already in this queue were skipped.` : "";
    this.emit();
    if (!this.paused) void this.run();
  }
  pause() { this.paused = true; this.controller?.abort(); this.emit(); }
  resume() { this.paused = false; this.notice = ""; void this.run(); }
  retry() {
    for (const item of this.items) if (item.state === "failed") { item.state = "waiting"; item.message = "Waiting"; this.failed--; }
    this.resume();
  }
  dispose() { this.disposed = true; this.pause(); }
  attach() { this.disposed = false; }
  private async run() {
    if (this.running || this.disposed) return;
    this.running = true; this.emit();
    try {
      for (const item of this.items) {
        if (this.paused || this.disposed) break;
        if (item.state !== "waiting") continue;
        item.state = "active"; item.message = "Preparing upload…";
        this.active = item;
        this.controller = new AbortController(); this.emit();
        let recoveryKey: string | undefined;
        let sha256: string | undefined;
        try {
          // Only opaque content hashes and upload IDs are retained in this tab.
          // Reselecting the same interrupted file after reload reuses its ID.
          if (!fileSizeError(item.file.size)) {
            sha256 = await documentHash(item.file, this.controller.signal);
            const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
            const fingerprint = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${item.relativePath ?? item.file.name}\0${sha256}`));
            recoveryKey = `document-upload:${this.owner}:${hex(fingerprint)}`;
            try { item.id = await recoveryUploadId(recoveryKey, item.id); } catch { this.notice = "Browser recovery storage is unavailable. Keep this page open to pause and resume safely."; }
          }
          const result = await this.transfer(item.file, (message) => { item.message = message; this.emit(); }, { id: item.id, signal: this.controller.signal, relativePath: item.relativePath, sha256 });
          item.state = "done"; item.message = result?.skipped ? "Already uploaded — skipped." : "Uploaded"; this.done++;
          if (result?.skipped) this.skipped++;
          // Keep successful IDs too: reselecting an interrupted batch after
          // reload must not duplicate the files that already finished.
          if (this.done % 10 === 0) this.refresh();
        } catch (error) {
          if (this.controller.signal.aborted) { item.state = "waiting"; item.message = "Paused — resume to continue"; }
          else {
            item.state = "failed"; this.failed++; item.message = error instanceof Error ? error.message : "Could not upload. Try again.";
            if (!(error instanceof UploadError) || error.pausesQueue) { this.paused = true; this.notice = "Queue paused. Resolve the error, then retry failed files."; }
          }
        }
        this.emit();
      }
    } finally { this.running = false; this.active = undefined; this.controller = undefined; this.emit(); this.refresh(); }
  }
}
