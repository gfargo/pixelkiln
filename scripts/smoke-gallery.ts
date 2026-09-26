/**
 * Drive the gallery in a real browser the way a person does.
 *
 * The three gallery bugs reported from use this year (no Edit or Regenerate
 * buttons, no sign that a regeneration was running, orphans that could not
 * be regenerated) were all visible from the page and invisible to the unit
 * tests, which render HTML and parse JSON. This script serves a gallery over
 * the in-memory FakeProvider, opens it in headless Chrome, and walks the
 * flows those bugs sat on: the buttons are there, a generation shows a badge
 * on its card and lands, a regeneration keeps the replaced generation, and
 * that generation comes back for free. It also fails on any console error
 * or failed request, which is how a broken client script shows up first.
 *
 * Needs a Chrome or Chromium binary: set CHROME, or one of the usual paths
 * is used. Without one it skips, unless CI is set, in which case it fails.
 */
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createGalleryEditHandler } from "../src/gallery/edit.ts"
import { createGenerateHandlers } from "../src/gallery/generate.ts"
import { serveGallery } from "../src/gallery/server.ts"
import { buildGallerySnapshot } from "../src/gallery/snapshot.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { poll } from "../src/pipeline/poll.ts"
import { submit } from "../src/pipeline/submit.ts"
import { openProject } from "../src/project.ts"
import { FakeProvider } from "../src/providers/fake.ts"

const CHROME_CANDIDATES = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter((candidate): candidate is string => Boolean(candidate))

const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
if (!chrome) {
  const message = "gallery smoke: no Chrome found; set CHROME to a browser binary"
  if (process.env.CI) {
    console.error(message)
    process.exit(1)
  }
  console.log(`${message} (skipped)`)
  process.exit(0)
}

const puppeteer = await import("puppeteer-core")

const dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-gallery-smoke-"))
const manifestPath = path.join(dir, "pixelkiln.manifest.json")
await writeFile(manifestPath, JSON.stringify({
  name: "gallery-smoke",
  styles: { base: { generator: "map", outDir: "out", promptSuffix: "clean pixel art" } },
  assets: {
    anvil: { prompt: "an anvil", width: 32, height: 32 },
    hammer: { prompt: "a hammer", width: 32, height: 32 },
  },
}, null, 2))

const provider = new FakeProvider({ candidates: 1, processingPolls: 3 })
const quiet = () => {}

// One asset generated ahead of time, one left missing, so the page has both a
// record to regenerate and a placeholder to generate.
{
  const project = await openProject(manifestPath, { assets: ["anvil"], env: false })
  const plan = await project.plan()
  await submit(provider, project.loaded, plan.actionable, project.lock, project.lockPath, { spacingMs: 0, onProgress: quiet })
  await poll(provider, project.lock, project.lockPath, { intervalMs: 0, specs: project.specs, onProgress: quiet })
  await fetchAssets(provider, project.specs, project.lock, project.lockPath, { onProgress: quiet })
}

const loadProject = () => openProject(manifestPath, { env: false })
const reload = async () => buildGallerySnapshot(await loadProject())
const server = await serveGallery({
  load: reload,
  open: false,
  onProgress: quiet,
  edit: createGalleryEditHandler({ manifestFor: () => manifestPath, loadProject, reload, onProgress: quiet }),
  generate: createGenerateHandlers({
    loadProject,
    providerFor: () => provider,
    budget: { amount: 20, byProvider: {} },
    reload,
    pollIntervalMs: 100,
    submitSpacingMs: 0,
    onProgress: quiet,
  }),
})

// The page's state lives inside its bundle; main.ts exposes it on
// `window.__pixelkiln` for exactly this kind of test.
declare const __pixelkiln: {
  S: { snap: { items: { id: string; state: string; outputs: { sha256: string }[]; history: { index: number; outputs: { sha256: string }[] }[] }[] } }
  ui: { notice: { text: string } | null }
}

const failures: string[] = []
const check = (ok: unknown, what: string) => {
  if (!ok) failures.push(what)
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`)
}

// A launch can time out waiting for the DevTools endpoint when another Chrome
// is still shutting down on the same machine; one more try is cheap.
const launch = () => puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--no-first-run"] })
const browser = await launch().catch(async (error: unknown) => {
  console.log(`  chrome launch failed once (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); retrying`)
  return launch()
})
try {
  const page = await browser.newPage()
  const consoleErrors: string[] = []
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()) })
  page.on("pageerror", (error) => consoleErrors.push(String(error)))
  page.on("requestfailed", (request) => consoleErrors.push(`request failed: ${request.url()}`))
  page.on("response", (response) => { if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`) })

  await page.setViewport({ width: 1280, height: 900 })
  await page.goto(server.url, { waitUntil: "networkidle0" })

  const item = (id: string) => page.evaluate((key) => {
    const found = __pixelkiln.S.snap.items.find((x) => x.id === key)
    return found ? { state: found.state, sha: found.outputs[0]?.sha256 ?? null, history: found.history.map((g) => g.outputs[0]?.sha256 ?? null) } : null
  }, id)
  const drawerButtons = () => page.evaluate(() => [...document.querySelectorAll(".drawer .gen button")].map((b) => b.textContent ?? ""))
  const notice = () => page.evaluate(() => __pixelkiln.ui.notice?.text ?? "")
  const noticeMatches = (pattern: string) => page.waitForFunction((re: string) => new RegExp(re).test(__pixelkiln.ui.notice?.text ?? ""), { timeout: 30_000, polling: 200 }, pattern)
  // The notice lands before the snapshot refresh that follows it, so wait for
  // the record itself to show the result.
  // Polled from here rather than with waitForFunction: the page's content
  // security policy refuses the string evaluation that polling relies on.
  const waitForItem = async (id: string, test: (item: any) => boolean) => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const found = await page.evaluate((key) => __pixelkiln.S.snap.items.find((x) => x.id === key) ?? null, id)
      if (found && test(found)) return true
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return false
  }
  const submitDialog = async () => {
    await page.waitForSelector(".dialog form button[type=submit]", { timeout: 5_000 })
    await page.click(".dialog form button[type=submit]")
  }

  console.log("\ngallery smoke")
  check((await page.$$(".card")).length === 2, "two cards render")
  check((await item("base/anvil"))?.state === "ok", "anvil is ok")
  check((await item("base/hammer"))?.state === "missing", "hammer is missing")

  // Generate the missing one: the button is offered, the card shows a badge
  // while the job runs, the record settles as ok.
  await page.goto(`${server.url}#base/hammer`, { waitUntil: "networkidle0" })
  await page.waitForSelector(".drawer", { timeout: 5_000 })
  check((await drawerButtons()).some((label) => label.startsWith("Generate")), "missing record offers Generate")
  await page.evaluate(() => ([...document.querySelectorAll(".drawer .gen button")] as HTMLButtonElement[]).find((b) => b.textContent?.startsWith("Generate"))!.click())
  await submitDialog()
  await page.waitForSelector(".card .busy-badge", { timeout: 10_000 }).then(() => check(true, "card shows a busy badge while generating"), () => check(false, "card shows a busy badge while generating"))
  await noticeMatches("Regenerated|Done")
  check(await waitForItem("base/hammer", (item) => item.state === "ok"), "hammer is ok after generating")
  check((await page.$$(".card .busy-badge")).length === 0, "badge clears when the job lands")

  // Regenerate the existing one: the replaced generation is kept and listed.
  const before = await item("base/anvil")
  await page.goto(`${server.url}#base/anvil`, { waitUntil: "networkidle0" })
  await page.waitForSelector(".drawer", { timeout: 5_000 })
  check((await drawerButtons()).some((label) => label.startsWith("Regenerate")), "ok record offers Regenerate")
  await page.evaluate(() => ([...document.querySelectorAll(".drawer .gen button")] as HTMLButtonElement[]).find((b) => b.textContent?.startsWith("Regenerate"))!.click())
  await submitDialog()
  await noticeMatches("Regenerated")
  await waitForItem("base/anvil", (item) => item.outputs[0]?.sha256 !== before?.sha)
  const after = await item("base/anvil")
  check(after?.state === "ok" && after.sha !== before?.sha, "regeneration produced a new current generation")
  check(after?.history.length === 1 && after.history[0] === before?.sha, "the replaced generation is #1 in history")
  check(await page.evaluate(() => /Previous generations \(1\)/.test(document.querySelector(".drawer")?.textContent ?? "")), "drawer lists Previous generations (1)")

  // Bring it back for free: the current and the previous swap.
  await page.evaluate(() => ([...document.querySelectorAll(".drawer .version button")] as HTMLButtonElement[]).find((b) => /Restore this one/.test(b.textContent ?? ""))!.click())
  await submitDialog()
  await noticeMatches("Brought back")
  await waitForItem("base/anvil", (item) => item.outputs[0]?.sha256 === before?.sha)
  const restored = await item("base/anvil")
  check(restored?.sha === before?.sha, "restore made the earlier generation current again")
  check(restored?.history.length === 1 && restored.history[0] === after?.sha, "the one it replaced is now #1 in history")
  check(/Brought back generation #1/.test(await notice()), "the record says which generation came back")

  // Create an image-to-image revision of the completed anvil generation from
  // its drawer, the gallery UI path onto `add-asset` with a `revision` field.
  await page.goto(`${server.url}#base/anvil`, { waitUntil: "networkidle0" })
  await page.waitForSelector(".drawer", { timeout: 5_000 })
  const hasRevisionButton = () => page.evaluate(() =>
    [...document.querySelectorAll(".drawer button")].some((b) => /New revision/.test(b.textContent ?? "")))
  check(await hasRevisionButton(), "ok record offers + New revision")
  await page.evaluate(() => ([...document.querySelectorAll(".drawer button")] as HTMLButtonElement[]).find((b) => /New revision/.test(b.textContent ?? ""))!.click())
  await page.waitForSelector(".drawer form.edit", { timeout: 5_000 })
  await page.evaluate(() => {
    const form = document.querySelector(".drawer form.edit")!
    const id = form.querySelector("input[placeholder=\"asset-id\"]") as HTMLInputElement
    id.value = "anvil-worn"
    const prompt = form.querySelector("textarea") as HTMLTextAreaElement
    prompt.value = "add rust and wear"
  })
  // A refresh while the form is open (the auto-refresh timer, a job landing)
  // must not throw away what was typed.
  // (Clicked in the page: with the drawer open its scrim covers the header,
  // and a pointer click there closes the drawer instead.)
  await page.evaluate(() => (document.getElementById("refresh") as HTMLButtonElement).click())
  await new Promise((resolve) => setTimeout(resolve, 500))
  check(
    await page.evaluate(() => (document.querySelector(".drawer form.edit textarea") as HTMLTextAreaElement | null)?.value === "add rust and wear"),
    "an open form survives a refresh",
  )
  await page.click(".drawer form.edit button[type=submit]")
  await noticeMatches("Added to the manifest")
  check(
    await waitForItem("base/anvil-worn", (item) => item.revisionParentKey === "base/anvil" && item.asset?.revision?.mode === "image-to-image"),
    "revision asset created with its parent recorded",
  )

  check(consoleErrors.length === 0, `no console errors or failed requests${consoleErrors.length ? `:\n    ${consoleErrors.join("\n    ")}` : ""}`)
} finally {
  await browser.close()
  await server.close()
  await rm(dir, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\ngallery smoke failed: ${failures.length} check(s)`)
  process.exit(1)
}
console.log("\ngallery smoke passed")
