// End-to-end smoke for the bridge: open → paint → save, against a built
// editor, driven through the host page. Needs Chrome (CHROME env or the usual
// paths) and puppeteer-core on the path; the build dir is the first argument.
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import puppeteer from "puppeteer-core"

const build = path.resolve(process.argv[2] ?? ".work/build")
const chrome = process.env.CHROME ?? [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium",
].find(existsSync)
if (!chrome) { console.error("no Chrome found; set CHROME"); process.exit(2) }
const here = path.dirname(fileURLToPath(import.meta.url))
const port = 4399
const server = spawn(process.execPath, [path.join(here, "../scripts/serve.mjs"), build, String(port)], { stdio: ["ignore", "pipe", "inherit"] })
await new Promise((resolve) => server.stdout.on("data", (d) => { if (String(d).includes("bridge host")) resolve() }))
const fail = (msg) => { console.error("FAIL: " + msg); process.exitCode = 1 }
// Under software WebGL the wasm compile blocks the renderer for 30-60 s, so
// give the protocol room and poll slowly rather than hammer a stalled thread.
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, protocolTimeout: 600_000, args: ["--no-first-run", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox"] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => { if (/EXTENSION ERROR|SCRIPT ERROR|pixelkiln/.test(m.text())) console.log("  console:", m.text().slice(0, 200)) })
  await page.setViewport({ width: 1400, height: 900 })
  const t0 = Date.now()
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => window.__host.ready !== null, { timeout: 300_000, polling: 2000 })
  const ready = await page.evaluate(() => window.__host.ready)
  console.log(`ready in ${Math.round((Date.now() - t0) / 1000)}s:`, JSON.stringify(ready))
  if (ready.version !== 4) fail("protocol version " + ready.version)

  await page.evaluate(() => window.__host.openSample())
  await page.waitForFunction(() => window.__host.opened !== null, { timeout: 30_000 })
  const opened = await page.evaluate(() => window.__host.opened)
  console.log("opened:", JSON.stringify(opened))
  if (opened.width !== 32 || opened.height !== 32) fail("opened size " + opened.width + "x" + opened.height)
  if (opened.source !== "png") fail("opened from " + opened.source + ", expected png")
  await new Promise((r) => setTimeout(r, 1500))
  if (await page.evaluate(() => window.__host.dirty)) fail("document dirty right after open")

  // Paint one pixel: the pencil is the default left tool; click the canvas
  // centre inside the iframe. The canvas fills the iframe's viewport.
  const frame = await page.$("#editor")
  const box = await frame.boundingBox()
  await page.mouse.click(box.x + box.width * 0.48, box.y + box.height * 0.45)
  await new Promise((r) => setTimeout(r, 1200))
  const dirty = await page.evaluate(() => window.__host.dirty)
  console.log("dirty after paint:", dirty)
  if (!dirty) fail("no dirty message after painting")

  const request = await page.evaluate(() => window.__host.requestSave())
  await page.waitForFunction(() => window.__host.lastSave !== null, { timeout: 30_000 })
  const save = await page.evaluate(() => { const s = window.__host.lastSave; return { request: s.request, width: s.width, height: s.height, png: s.png.length, pxo: s.pxo.length, differs: (() => { const a = new Uint8Array(window.__host.sample); if (a.length !== s.png.length) return true; for (let i = 0; i < a.length; i++) if (a[i] !== s.png[i]) return true; return false })(), pngSig: [...s.png.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(""), pxoSig: [...s.pxo.slice(0, 2)].map((b) => b.toString(16)).join("") } })
  console.log("save:", JSON.stringify(save))
  if (save.request !== request) fail("save answered a different request")
  if (save.width !== 32 || save.height !== 32) fail("saved size changed")
  if (save.pngSig !== "89504e470d0a1a0a") fail("save is not a PNG")
  if (!save.differs) fail("saved PNG is identical to the sample; paint did not land")
  if (save.pxo < 100 || save.pxoSig !== "504b") fail("pxo missing or not a zip")
  const single = await page.evaluate(() => window.__host.lastSave.frames.map((f) => [f.role, f.png.length]))
  if (single.length !== 1 || single[0][0] !== null || single[0][1] !== save.png) fail("single image save should carry one untagged frame equal to png: " + JSON.stringify(single))
  if (await page.evaluate(() => window.__host.dirty)) fail("still dirty after save")

  // Round trip the project file: re-open from the .pxo, save again, and the
  // flattened PNG must be the same bytes; the painted pixel survived.
  const firstPng = await page.evaluate(() => [...window.__host.lastSave.png])
  await page.evaluate(() => window.__host.reopenLastSave())
  await page.waitForFunction(() => window.__host.opened !== null, { timeout: 30_000 })
  const reopened = await page.evaluate(() => window.__host.opened)
  console.log("reopened:", JSON.stringify(reopened))
  if (reopened.source !== "pxo") fail("reopen used " + reopened.source + ", expected pxo")
  if (reopened.width !== 32 || reopened.height !== 32) fail("reopened size " + reopened.width + "x" + reopened.height)
  if (reopened.layers < 1 || reopened.frames < 1) fail("reopened project has no layers or frames")
  await new Promise((r) => setTimeout(r, 1000))
  if (await page.evaluate(() => window.__host.dirty)) fail("document dirty right after reopen")
  await page.evaluate(() => window.__host.requestSave())
  await page.waitForFunction(() => window.__host.lastSave !== null, { timeout: 30_000 })
  const secondPng = await page.evaluate(() => [...window.__host.lastSave.png])
  const same = firstPng.length === secondPng.length && firstPng.every((b, i) => b === secondPng[i])
  console.log("reopen round trip: png " + secondPng.length + " B, identical: " + same)
  if (!same) fail("PNG after reopening the pxo differs from the one saved before")

  // A project file Pixelorama cannot read falls back to the PNG, and says so.
  await page.evaluate(() => window.__host.reopenLastSave(true))
  await page.waitForFunction(() => window.__host.opened !== null, { timeout: 30_000 })
  const fallback = await page.evaluate(() => window.__host.opened)
  console.log("corrupt pxo fallback:", JSON.stringify(fallback))
  if (fallback.source !== "png") fail("corrupt pxo did not fall back to png (" + fallback.source + ")")
  // An ordered frame set: one project, a frame per member, roles round-tripped.
  await page.evaluate(() => window.__host.openFrames(3, 8))
  await page.waitForFunction(() => window.__host.opened !== null, { timeout: 30_000 })
  const framesOpened = await page.evaluate(() => window.__host.opened)
  console.log("frames opened:", JSON.stringify(framesOpened))
  if (framesOpened.source !== "frames" || framesOpened.frames !== 3 || framesOpened.width !== 32) fail("frame set did not open as 3 frames from frames")
  await new Promise((r) => setTimeout(r, 1000))
  await page.mouse.click(box.x + box.width * 0.48, box.y + box.height * 0.45)
  await new Promise((r) => setTimeout(r, 1200))
  if (!(await page.evaluate(() => window.__host.dirty))) fail("no dirty message after painting a frame")
  await page.evaluate(() => window.__host.requestSave())
  await page.waitForFunction(() => window.__host.lastSave !== null, { timeout: 30_000 })
  const framesSaved = await page.evaluate(async () => {
    const s = window.__host.lastSave
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
    const changed = []
    for (const [i, f] of s.frames.entries()) changed.push(!same(await window.__host.pixels(f.png), await window.__host.pixels(window.__host.sampleFrames[i])))
    return { roles: s.frames.map((f) => f.role), sizes: s.frames.map((f) => f.png.length), pngIsFirst: same([...s.png], [...s.frames[0].png]), changed }
  })
  console.log("frames saved:", JSON.stringify(framesSaved))
  if (framesSaved.roles.join() !== "frame-00,frame-01,frame-02") fail("frame roles did not round-trip: " + framesSaved.roles.join())
  if (!framesSaved.pngIsFirst) fail("png is not the first frame")
  if (framesSaved.changed.filter(Boolean).length !== 1) fail("expected exactly one frame to change after painting: " + JSON.stringify(framesSaved.changed))
  const framesFirst = await page.evaluate(() => window.__host.lastSave.frames.map((f) => [...f.png]))
  await page.evaluate(() => window.__host.reopenLastSave())
  await page.waitForFunction(() => window.__host.opened !== null, { timeout: 30_000 })
  const framesReopened = await page.evaluate(() => window.__host.opened)
  console.log("frames reopened:", JSON.stringify(framesReopened))
  if (framesReopened.source !== "pxo" || framesReopened.frames !== 3) fail("frame set did not reopen as 3 frames from pxo")
  await page.evaluate(() => window.__host.requestSave())
  await page.waitForFunction(() => window.__host.lastSave !== null, { timeout: 30_000 })
  const framesSecond = await page.evaluate(() => ({ roles: window.__host.lastSave.frames.map((f) => f.role), pngs: window.__host.lastSave.frames.map((f) => [...f.png]) }))
  const framesSame = framesSecond.pngs.length === 3 && framesSecond.pngs.every((p, i) => p.length === framesFirst[i].length && p.every((b, j) => b === framesFirst[i][j]))
  console.log("frames round trip: roles " + framesSecond.roles.join() + ", identical: " + framesSame)
  if (!framesSame || framesSecond.roles.join() !== "frame-00,frame-01,frame-02") fail("frames after reopening the pxo differ or lost their roles")

  // The generated-art reference: a layer for looking that never reaches the save.
  await page.evaluate(() => window.__host.openWithReference())
  await page.waitForFunction(() => window.__host.opened !== null, { timeout: 30_000 })
  const refOpened = await page.evaluate(() => window.__host.opened)
  console.log("reference opened:", JSON.stringify(refOpened))
  if (!refOpened.reference || refOpened.layers !== 1) fail("reference layer missing or counted as a user layer: " + JSON.stringify(refOpened))
  await new Promise((r) => setTimeout(r, 1000))
  if (await page.evaluate(() => window.__host.dirty)) fail("document dirty right after opening with a reference")
  await page.evaluate(() => window.__host.requestSave())
  await page.waitForFunction(() => window.__host.lastSave !== null, { timeout: 30_000 })
  const refSave = await page.evaluate(async () => {
    const s = window.__host.lastSave
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
    return { frames: s.frames.length, pixelsEqualSample: same(await window.__host.pixels(s.png), await window.__host.pixels(window.__host.sample)) }
  })
  console.log("save with reference:", JSON.stringify(refSave))
  if (!refSave.pixelsEqualSample) fail("the reference layer leaked into the saved image")
  await page.evaluate(() => window.__host.showReference(false))
  await new Promise((r) => setTimeout(r, 800))
  await page.evaluate(() => window.__host.showReference(true))
  await new Promise((r) => setTimeout(r, 800))
  // Reopening the project file keeps the layer once, refreshed, still not saved.
  await page.evaluate(() => window.__host.reopenLastSave())
  await page.waitForFunction(() => window.__host.opened !== null, { timeout: 30_000 })
  const refReopened = await page.evaluate(() => window.__host.opened)
  console.log("reference reopened:", JSON.stringify(refReopened))
  if (refReopened.source !== "pxo" || !refReopened.reference || refReopened.layers !== 1) fail("reference layer not restored once from the pxo: " + JSON.stringify(refReopened))

  const errs = await page.evaluate(() => window.__host.errors)
  if (errs.length) fail("bridge errors: " + JSON.stringify(errs))
  if (errors.length) console.log("page errors:", errors.slice(0, 3))
  await page.screenshot({ path: path.join(process.cwd(), "smoke.png") })
  console.log(process.exitCode ? "smoke FAILED" : "smoke OK")
} finally {
  await browser.close()
  server.kill()
}
