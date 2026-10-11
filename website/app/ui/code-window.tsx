import type { ReactNode } from "react";
import type { CtaSection } from "@/app/lib/analytics";
import { CodeCopyButton } from "./code-copy-button";

type Language = "shell" | "json";

/**
 * Code that never scrolls sideways. Each line wraps
 * inside the window with a hanging indent instead: a shell command breaks only
 * between a flag and the next one (never between `--out` and its value) and
 * its continuation sits under the command, and a JSON line keeps its own
 * indentation with continuations two characters further in.
 */
export function CodeWindow({
  title,
  code,
  language,
  copyId,
  section,
}: {
  title: string;
  code: string;
  language: Language;
  copyId: string;
  section: CtaSection;
}) {
  const lines = splitLines(code);
  // Shell windows copy their commands, not the comments between them.
  const copyText = language === "shell"
    ? lines.filter((line) => line.trim() && !line.trim().startsWith("#")).join("\n")
    : lines.join("\n");
  return (
    <figure className="code-window">
      <div className="code-window-bar">
        <div className="terminal-lights" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <figcaption>{title}</figcaption>
        <CodeCopyButton text={copyText} id={copyId} section={section} />
      </div>
      <CodeBody code={code} language={language} className="code-window-body" />
    </figure>
  );
}

/** The wrapping, coloured code on its own, for a card that brings its own frame. */
export function CodeBody({ code, language, className }: { code: string; language: Language; className?: string }) {
  return (
    <pre className={["code-body", `code-${language}`, className].filter(Boolean).join(" ")}>
      <code>{splitLines(code).map((line, index) => (language === "shell" ? shellLine(line, index) : jsonLine(line, index)))}</code>
    </pre>
  );
}

function splitLines(code: string): string[] {
  return code.replace(/^\n+|\n+$/g, "").split("\n");
}

function shellLine(line: string, key: number): ReactNode {
  const trimmed = line.trim();
  if (!trimmed) return <span key={key} className="code-line code-blank" />;
  if (trimmed.startsWith("#")) return <span key={key} className="code-line code-comment">{trimmed}</span>;
  const [program, ...rest] = trimmed.split(/\s+/);
  const groups: ReactNode[] = [];
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!;
    if (word.startsWith("-")) {
      const value = rest[i + 1] && !rest[i + 1]!.startsWith("-") ? rest[++i] : undefined;
      groups.push(
        <span key={i} className="code-group">
          <span className="code-flag">{word}</span>
          {value ? <> <span className="code-value">{value}</span></> : null}
        </span>,
      );
    } else {
      groups.push(<span key={i} className="code-group code-word">{word}</span>);
    }
  }
  return (
    <span key={key} className="code-line code-command">
      <span className="code-prompt" aria-hidden="true">$</span>
      <span className="code-text">
        <span className="code-program">{program}</span>
        {groups.map((group, index) => <span key={index}> {group}</span>)}
      </span>
    </span>
  );
}

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?)|([{}[\],:])|(…)/g;

function jsonLine(line: string, key: number): ReactNode {
  const indent = line.length - line.trimStart().length;
  const text = line.trimStart();
  if (!text) return <span key={key} className="code-line code-blank" />;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    if (match[1] && match[2]) {
      parts.push(<span key={at} className="code-key">{match[1]}</span>, match[2]);
    } else if (match[1]) {
      parts.push(<span key={at} className="code-string">{match[1]}</span>);
    } else if (match[3]) {
      parts.push(<span key={at} className="code-literal">{match[3]}</span>);
    } else {
      parts.push(<span key={at} className="code-punct">{match[0]}</span>);
    }
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <span key={key} className="code-line" style={{ ["--indent" as string]: indent }}>
      {parts}
    </span>
  );
}
