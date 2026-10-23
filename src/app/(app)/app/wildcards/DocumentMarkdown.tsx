import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkDocumentStructure } from "@/lib/extraction/document-structure";

const markdownPlugins = [remarkGfm];
const structuredPlugins = [remarkGfm, remarkDocumentStructure];

// Document text is untrusted. No HTML, remote images, or outbound document links.
export function DocumentMarkdown({ text, structure = false }: { text: string; structure?: boolean }) {
  if (text.length > 100_000) return <div className="document-markdown"><p>This large text is shown without Markdown formatting.</p><pre>{text}</pre></div>;
  return <div className="document-markdown"><Markdown remarkPlugins={structure ? structuredPlugins : markdownPlugins} skipHtml components={{ img: () => null, a: ({ children }) => <span>{children}</span>, h1: ({ children }) => <h3>{children}</h3>, h2: ({ children }) => <h3>{children}</h3> }}>{text.trim() ? text : "No text was extracted from this page."}</Markdown></div>;
}
