/**
 * The smallest client PixelLab's MCP server needs: one JSON-RPC `tools/call`
 * per request, over plain HTTP.
 *
 * A few PixelLab tools exist only on the MCP server, with no REST endpoint
 * (the VFX workbench, as of October 2026). The server at
 * `https://api.pixellab.ai/mcp` takes the same API key as the REST API, as a
 * bearer token, and answers each POST on its own: no session id is issued,
 * so no `initialize` handshake is needed before a call (checked live). The
 * reply comes back either as JSON or as a short server-sent-event stream
 * whose `data:` lines carry the JSON-RPC message; both are read here.
 */
import { PixelLabError } from "./client.ts"
import { fetchWithRetry, type RetryingFetch } from "./http.ts"

export const PIXELLAB_MCP_URL = "https://api.pixellab.ai/mcp"
const PROTOCOL_VERSION = "2025-06-18"

export interface McpImage {
  mimeType: string
  /** Base64, as the server sends it. */
  data: string
}

export interface McpToolResult {
  /** Every text block of the reply, joined by newlines. */
  text: string
  images: McpImage[]
}

/** The JSON-RPC message in a reply body, whether it came as plain JSON or as an SSE stream. */
export function parseMcpBody(body: string): Record<string, unknown> {
  const trimmed = body.trim()
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Record<string, unknown>
  let last: Record<string, unknown> | undefined
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    const message = JSON.parse(payload) as Record<string, unknown>
    // A stream may carry notifications before the response; the response is the one with an id.
    if ("id" in message) last = message
  }
  if (!last) throw new Error(`PixelLab MCP reply had no JSON-RPC response: ${body.slice(0, 200)}`)
  return last
}

/**
 * A tool reply asking to be retried shortly. The VFX workbench answers
 * "the pixel tools are busy. retry in a few seconds." while another render
 * on the account is still running (seen live with two effects in one `gen`).
 */
export function isBusyReply(text: string): boolean {
  return /\bbusy\b.*\bretry\b/i.test(text)
}

export class PixelLabMcpClient {
  private readonly http: RetryingFetch
  private readonly url: string
  private readonly busyRetries: number
  private readonly sleep: (ms: number) => Promise<void>
  private nextId = 1

  constructor(
    private readonly apiKey: string,
    opts: { url?: string; timeoutMs?: number; fetch?: typeof fetch; busyRetries?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    if (!apiKey) throw new Error("PIXELLAB_API_KEY is required")
    this.url = opts.url ?? PIXELLAB_MCP_URL
    this.http = fetchWithRetry(opts.fetch, { timeoutMs: opts.timeoutMs ?? 180_000 })
    this.busyRetries = opts.busyRetries ?? 4
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * Call one tool and return its text and images. A tool-level error
   * (`isError`) throws with the tool's own message, after a few spaced
   * retries when the tool only said it was busy.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    for (let attempt = 0; ; attempt++) {
      const reply = await this.callOnce(name, args)
      if (!reply.isError) return { text: reply.text, images: reply.images }
      if (attempt < this.busyRetries && isBusyReply(reply.text)) {
        await this.sleep(2000 * 2 ** attempt)
        continue
      }
      throw new Error(`PixelLab ${name}: ${reply.text || "the tool reported an error"}`)
    }
  }

  private async callOnce(name: string, args: Record<string, unknown>): Promise<McpToolResult & { isError: boolean }> {
    const auth = this.apiKey.startsWith("Bearer ") ? this.apiKey : `Bearer ${this.apiKey}`
    const id = this.nextId++
    const res = await this.http(this.url, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    })
    const body = await res.text()
    if (!res.ok) throw new PixelLabError(`MCP ${name} → ${res.status}`, res.status, body)
    const message = parseMcpBody(body)
    const error = message.error as { code?: number; message?: string } | undefined
    if (error) throw new Error(`PixelLab MCP ${name} failed: ${error.message ?? JSON.stringify(error)}`)
    const result = (message.result ?? {}) as { content?: Array<Record<string, unknown>>; isError?: boolean }
    const text = (result.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n")
    const images = (result.content ?? [])
      .filter((block) => block.type === "image" && typeof block.data === "string")
      .map((block) => ({ mimeType: String(block.mimeType ?? "image/png"), data: block.data as string }))
    return { text, images, isError: Boolean(result.isError) }
  }
}

export function mcpClientFromEnv(): PixelLabMcpClient {
  const key = process.env.PIXELLAB_API_KEY
  if (!key) {
    throw new Error(
      "PIXELLAB_API_KEY is not set.\n" +
        "Looked in the environment, and in .env.local / .env beside the manifest and in the current directory.",
    )
  }
  return new PixelLabMcpClient(key)
}
