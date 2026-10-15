import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Document text is untrusted. No HTML, remote images, or outbound document links.
export function DocumentMarkdown({ text }: { text: string }) {
  if (text.length > 100_000) return <div className="document-markdown"><p>This large text is shown without Markdown formatting.</p><pre>{text}</pre></div>;
  return <div className="document-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: () => null, a: ({ children }) => <span>{children}</span>, h1: ({ children }) => <h3>{children}</h3>, h2: ({ children }) => <h3>{children}</h3> }}>{text}</Markdown></div>;
}
