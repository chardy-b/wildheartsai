import type { Paragraph, Root, RootContent, TableRow, Text } from "mdast";

const literal = (value: string): Text => ({ type: "text", value });
const paragraph = (value: string): Paragraph => ({ type: "paragraph", children: [literal(value)] });
const columns = (line: string) => line.trim().split(/\t+| {2,}/);
const bullet = (line: string) => /^[•●▪◦]\s+(.+)$/.exec(line.trim());
const field = (line: string) => /^([\p{L}][\p{L}\p{N} /()_-]{0,59}:)\s+(.+)$/u.exec(line.trim());
function heading(line: string) {
  const value = line.trim();
  return value.length <= 80 && !value.includes("[REDACTED]") && (
    /^[\p{L}][\p{L} /()&-]{2,}:$/u.test(value) ||
    /^(?:assessment(?: and plan)?|plan|findings|impression|results|laboratory results|medications|allergies|vital signs|medical history|history of present illness|physical examination|recommendations|follow[ -]?up)$/i.test(value) ||
    (/^[\p{Lu}][\p{Lu} /()&-]{2,}$/u.test(value) && value.replace(/[^\p{L}]/gu, "").length >= 3)
  );
}

// Format only literal paragraphs. Existing Markdown (including code, lists,
// links and tables) retains its syntax. No raw words, geometry or table cells
// are consulted: callers can pass redacted text without reintroducing PII.
export function remarkDocumentStructure() {
  return (tree: Root) => {
    tree.children = tree.children.flatMap((node): RootContent[] => {
      if (node.type !== "paragraph" || !node.children.every(child => child.type === "text" || child.type === "break")) return [node];
      const lines = node.children.map(child => child.type === "text" ? child.value : "\n").join("").split("\n");
      const blocks: RootContent[] = [];
      let prose: string[] = [];
      const flush = () => { if (prose.length) blocks.push(paragraph(prose.join("\n"))); prose = []; };
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const cells = columns(line);
        // Require a consistent run of columns. Neutral column labels avoid
        // interpreting an OCR data row as a clinically meaningful header.
        if (cells.length >= 2 && cells.length <= 12 && i + 1 < lines.length && columns(lines[i + 1]).length === cells.length) {
          flush();
          const rows: TableRow[] = [];
          while (i < lines.length && columns(lines[i]).length === cells.length) {
            rows.push({ type: "tableRow", children: columns(lines[i]).map(value => ({ type: "tableCell", children: [literal(value)] })) });
            i++;
          }
          i--;
          blocks.push({ type: "table", children: [
            { type: "tableRow", children: cells.map((_, index) => ({ type: "tableCell", children: [literal(`Column ${index + 1}`)] })) },
            ...rows,
          ] });
        } else if (heading(line)) {
          flush(); blocks.push({ type: "heading", depth: 3, children: [literal(line.trim())] });
        } else if (bullet(line)) {
          flush();
          const items: string[] = [];
          while (i < lines.length && bullet(lines[i])) { items.push(bullet(lines[i])![1]); i++; }
          i--;
          blocks.push({ type: "list", ordered: false, spread: false, children: items.map(value => ({ type: "listItem", spread: false, children: [paragraph(value)] })) });
        } else {
          const match = field(line);
          if (match) {
            flush(); blocks.push({ type: "paragraph", children: [{ type: "strong", children: [literal(match[1])] }, literal(` ${match[2]}`)] });
          } else if (!line.trim()) flush();
          else prose.push(line);
        }
      }
      flush();
      return blocks;
    });
  };
}
