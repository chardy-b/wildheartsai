"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { WildcardFile } from "@/lib/wildcards";
import { DocumentMarkdown } from "../DocumentMarkdown";

export function FileViewer({ file, onPageChange, overlays }: { file: WildcardFile; onPageChange?: (page: number) => void; overlays?: { box: [number, number, number, number]; label: string; color?: string }[] }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [pageText, setPageText] = useState("");
  const [rendering, setRendering] = useState(false);
  const [width, setWidth] = useState(600);
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const url = `/api/wildcards/${file.id}`;
  useEffect(() => { onPageChange?.(page); }, [page, onPageChange]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.floor(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    const controller = new AbortController();
    async function load() {
      try {
        if (file.type === "application/pdf") {
          const library = await import("pdfjs-dist");
          if (!active) return;
          library.GlobalWorkerOptions.workerSrc = "/api/wildcards/pdfjs/build/pdf.worker.min.mjs";
          task = library.getDocument({ url, withCredentials: true, useWasm: false, enableXfa: false,
            cMapUrl: "/api/wildcards/pdfjs/cmaps/", cMapPacked: true,
            standardFontDataUrl: "/api/wildcards/pdfjs/standard_fonts/" });
          const document = await task.promise;
          if (active) setPdf(document);
        } else if (file.type.startsWith("text/")) {
          const response = await fetch(url, { cache: "no-store", signal: controller.signal });
          if (!response.ok) throw new Error();
          const content = await response.text();
          if (active) setText(content);
        }
      } catch { if (active) setError("This file could not be previewed. Try downloading the original to open it on your device."); }
    }
    void load();
    return () => { active = false; controller.abort(); void task?.destroy(); };
  }, [url, file.type]);

  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let active = true;
    let render: RenderTask | undefined;
    setRendering(true);
    setPageText("");
    async function draw() {
      try {
        const documentPage = await pdf!.getPage(page);
        if (!active || !canvas.current) return;
        const viewport = documentPage.getViewport({ scale: Math.min(width, 1200) / documentPage.getViewport({ scale: 1 }).width });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        canvas.current.width = Math.floor(viewport.width * outputScale);
        canvas.current.height = Math.floor(viewport.height * outputScale);
        render = documentPage.render({ canvas: canvas.current, viewport, transform: [outputScale, 0, 0, outputScale, 0, 0] });
        await render.promise;
        const content = await documentPage.getTextContent();
        if (active) setPageText(content.items.map((item) => "str" in item ? item.str : "").join(" "));
      } catch { if (active) setError("This page could not be previewed. Download the original to open it on your device."); }
      finally { if (active) setRendering(false); }
    }
    void draw();
    return () => { active = false; render?.cancel(); };
  }, [pdf, page, width]);

  return <div ref={container} className="wildcard-viewer">
    {error && <p role="alert">{error}</p>}
    {file.type === "application/pdf" ? <>
      {!pdf && !error && <p role="status">Loading PDF…</p>}
      {pdf && <>
        <div className="wildcard-pagination">
          <button type="button" disabled={page === 1 || rendering} onClick={() => setPage((value) => value - 1)}>Previous page</button>
          <span aria-live="polite">Page {page} of {pdf.numPages}</span>
          <button type="button" disabled={page === pdf.numPages || rendering} onClick={() => setPage((value) => value + 1)}>Next page</button>
        </div>
        <div className="workbench-overlay"><canvas ref={canvas} aria-label={`Page ${page} of ${file.name}`} />
          {overlays?.map(({ box: [x, y, r, b], label, color }, i) => <span key={i} className="workbench-overlay-mark" title={label} style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${(r - x) * 100}%`, height: `${(b - y) * 100}%`, borderColor:color, background:color ? `${color}18` : undefined }} />)}
        </div>
        {pageText && <details><summary>Read embedded PDF text</summary><p>Read in your browser by PDF.js from the PDF text layer; OCR was not run here.</p><DocumentMarkdown text={pageText} /></details>}
      </>}
    </> : file.type.startsWith("image/") ?
      // Authenticated route serves the original; image optimization would cache it.
      // eslint-disable-next-line @next/next/no-img-element
      <div className="workbench-overlay"><img src={url} alt={file.name} onError={() => setError("This image could not be previewed. Try downloading the original.")} />
        {overlays?.map(({box:[x,y,r,b],label,color},i)=><span key={i} className="workbench-overlay-mark" title={label} style={{left:`${x*100}%`,top:`${y*100}%`,width:`${(r-x)*100}%`,height:`${(b-y)*100}%`,borderColor:color,background:color ? `${color}18` : undefined}} />)}
      </div> :
      text === null ? !error && <p role="status">Loading text…</p> : <><DocumentMarkdown text={text} /><details><summary>View original plain text</summary><pre>{text}</pre></details></>}
  </div>;
}
