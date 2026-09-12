// Dev server for the bridge: /editor/* from a web build, / from host/.
// Usage: node serve.mjs <build-dir> [port]
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import path from "node:path"
const build = path.resolve(process.argv[2] ?? ".work/build")
const port = Number(process.argv[3] ?? 4321)
const host = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../host")
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".pck": "application/octet-stream", ".png": "image/png", ".json": "application/json", ".css": "text/css" }
createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x")
  let file
  if (url.pathname.startsWith("/editor/")) file = path.join(build, url.pathname.slice("/editor/".length) || "index.html")
  else file = path.join(host, url.pathname === "/" ? "index.html" : url.pathname)
  if (!file.startsWith(build) && !file.startsWith(host)) { res.writeHead(403); res.end(); return }
  try {
    const body = await readFile(file)
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] ?? "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      ...(url.pathname.startsWith("/editor/") ? { "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:" } : {}),
    })
    res.end(body)
  } catch { res.writeHead(404); res.end("not found") }
}).listen(port, "127.0.0.1", () => console.log(`bridge host: http://127.0.0.1:${port}/  (editor from ${build})`))
