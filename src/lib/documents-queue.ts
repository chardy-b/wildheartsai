import { UploadError, uploadDocument } from "./wildcards-client";
import { fileSizeError } from "./wildcards";

type Item = { id: string; file: File; state: "waiting" | "active" | "done" | "failed"; message: string };
export class DocumentQueue {
  items: Item[] = [];
  running = false;
  paused = false;
  notice = "";
  done = 0;
  failed = 0;
  private controller?: AbortController;
  private disposed = false;
  private listeners = new Set<() => void>();
  private revision = 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.revision;
  private emit() { this.revision++; this.listeners.forEach((listener) => listener()); }
  constructor(private refresh: () => void, private owner: string, private transfer = uploadDocument) {}
  add(files: File[]) {
    const selected = new Set(this.items.map(({ file }) => file));
    let skipped = 0;
    for (const file of files) {
      // Separate files can have identical names, sizes, and modification dates.
      // Content fingerprints reconcile repeats without dropping different data.
      if (selected.has(file)) { skipped++; continue; }
      selected.add(file);
      this.items.push({ id: crypto.randomUUID(), file, state: "waiting", message: "Waiting" });
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
        this.controller = new AbortController(); this.emit();
        let recoveryKey: string | undefined;
        try {
          // Only opaque content hashes and upload IDs are retained in this tab.
          // Reselecting the same interrupted file after reload reuses its ID.
          if (!fileSizeError(item.file.size)) {
            const digest = await crypto.subtle.digest("SHA-256", await item.file.arrayBuffer());
            const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
            const fingerprint = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${item.file.name}\0${hex(digest)}`));
            recoveryKey = `document-upload:${this.owner}:${hex(fingerprint)}`;
            try { item.id = sessionStorage.getItem(recoveryKey) ?? item.id; sessionStorage.setItem(recoveryKey, item.id); } catch { /* Storage may be disabled; in-memory retries still work. */ }
          }
          await this.transfer(item.file, (message) => { item.message = message; this.emit(); }, { id: item.id, signal: this.controller.signal });
          item.state = "done"; item.message = "Uploaded"; this.done++;
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
    } finally { this.running = false; this.controller = undefined; this.emit(); this.refresh(); }
  }
}
