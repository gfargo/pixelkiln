"use client";

import { useState } from "react";
import { trackCodeCopied, type CtaSection } from "@/app/lib/analytics";

export function CodeCopyButton({ text, id, section }: { text: string; id: string; section: CtaSection }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(text);
    trackCodeCopied(id, section);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button className="code-window-copy" type="button" onClick={copy} aria-label="Copy the code in this window">
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
