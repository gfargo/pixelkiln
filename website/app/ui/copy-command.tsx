"use client";

import { useState } from "react";
import { trackInstallCommandCopied } from "@/app/lib/analytics";

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(command);
    trackInstallCommandCopied();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button className="copy-command" type="button" onClick={copy}>
      <span aria-hidden="true">$</span>
      <code>{command}</code>
      <span className="copy-label">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}
