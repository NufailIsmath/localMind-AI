"use client";

import { Fragment, type ReactNode } from "react";

/**
 * A small, safe Markdown renderer (no dangerouslySetInnerHTML): code blocks,
 * headings, lists, paragraphs, **bold**, *italic*, `code` and [S1]-style
 * citations rendered as clickable chips.
 *
 * Security: model output is attacker-influenceable (a shared document can
 * carry a prompt injection), so URLs are rendered as INERT text — never as
 * links or images. Otherwise an injected answer could hide stolen data in a
 * link (https://attacker/?d=secret) that leaks on one click, or in an image
 * that leaks with zero clicks. The full URL stays visible and can be copied.
 */
export function Markdown({ text, onCite }: { text: string; onCite?: (ref: string) => void }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      blocks.push(
        <pre key={key++}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1]!.length + 2, 6);
      const Tag = `h${level}` as "h3";
      blocks.push(<Tag key={key++}>{inline(heading[2]!, onCite)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*+]|\d+\.)\s+/, ""));
        i++;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={key++}>
          {items.map((it, n) => (
            <li key={n}>{inline(it, onCite)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,4}\s|\s*([-*+]|\d+\.)\s)/.test(lines[i]!)) {
      para.push(lines[i++]!);
    }
    blocks.push(
      <p key={key++}>
        {para.map((p, n) => (
          <Fragment key={n}>
            {n > 0 && <br />}
            {inline(p, onCite)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="markdown">{blocks}</div>;
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[S\d+\]|https?:\/\/[^\s)]+)/g;

function inline(text: string, onCite?: (ref: string) => void): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^\*[^*]/.test(part) && part.endsWith("*") && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
    const cite = part.match(/^\[(S\d+)\]$/);
    if (cite) {
      return (
        <button key={i} type="button" className="cite" onClick={() => onCite?.(cite[1]!)} title={`Show source ${cite[1]}`}>
          {cite[1]}
        </button>
      );
    }
    if (/^https?:\/\//.test(part)) {
      return (
        <span key={i} className="inert-url" title="Links in answers aren't clickable. Copy the address if you trust it.">
          {part}
        </span>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}
