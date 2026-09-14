import { spawn } from "node:child_process"

/**
 * Hand a URL or file to the operating system's default handler. Before this
 * lived in one place, the gallery and the review sheet only opened a browser
 * on macOS; on Linux and Windows the server came up and nothing appeared,
 * with the address printed to a terminal the person may not be watching.
 *
 * Returns the command used, for callers that print it. Failure to launch is
 * deliberately quiet: the URL has already been printed, and that is the part
 * that matters when there is no desktop to open it on.
 */
export function openExternal(target: string, command = defaultOpenCommand()): string {
  const [program, ...args] = command
  const child = spawn(program!, [...args, target], { stdio: "ignore", detached: true })
  child.on("error", () => {})
  child.unref()
  return command.join(" ")
}

export function defaultOpenCommand(platform = process.platform): string[] {
  if (platform === "darwin") return ["open"]
  // `start` treats its first quoted argument as a window title; the empty
  // title keeps a URL with spaces or ampersands from being read as one.
  if (platform === "win32") return ["cmd", "/c", "start", ""]
  return ["xdg-open"]
}
