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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createGalleryEditHandler, createGalleryPriceHandler } from "../src/gallery/edit.ts"
import { createGenerateHandlers } from "../src/gallery/generate.ts"
import { createGallerySkeletonHandlers } from "../src/gallery/skeleton.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { SKELETON_LABELS, scaffoldSkeletonSet } from "../src/skeleton.ts"
import { serveGallery } from "../src/gallery/server.ts"
import { buildGallerySnapshot } from "../src/gallery/snapshot.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { poll } from "../src/pipeline/poll.ts"
import { submit } from "../src/pipeline/submit.ts"
import { openProject } from "../src/project.ts"
import { FakeProvider } from "../src/providers/fake.ts"
import { createProFlashQuoter } from "../src/providers/pixellab.ts"

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

  // The pose editor, on a PixelLab project resolved offline: drag a joint on
  // an existing skeleton animation and save it, then estimate poses for a
  // new one (the estimate client is stubbed) and drag in the create form.
  const poseDir = path.join(dir, "poses-project")
  await mkdir(path.join(poseDir, "art"), { recursive: true })
  await mkdir(path.join(poseDir, "poses"))
  await writeFile(path.join(poseDir, "art", "hero.png"), encodeRgbaPng(64, 64, Buffer.alloc(64 * 64 * 4, 120)))
  const standing = SKELETON_LABELS.map((label, i) => ({
    label,
    x: label.startsWith("RIGHT") ? 0.35 : label.startsWith("LEFT") ? 0.65 : 0.5,
    y: Math.min(0.95, 0.1 + i * 0.045),
    z_index: 1,
  }))
  const posesFile = path.join(poseDir, "poses", "hero-wave.json")
  await writeFile(posesFile, JSON.stringify(scaffoldSkeletonSet(standing, 3)))
  const poseManifest = path.join(poseDir, "pixelkiln.manifest.json")
  await writeFile(poseManifest, JSON.stringify({
    name: "pose-smoke",
    provider: "pixellab",
    styles: { chars: { outDir: "out" } },
    assets: {
      hero: { prompt: "a knight", width: 64, height: 64, source: "art/hero.png" },
      "hero-wave": { prompt: "waving", revision: { mode: "animate-skeleton", from: "hero", keypointsFile: "poses/hero-wave.json", direction: "south" } },
    },
  }, null, 2))
  const loadPoses = () => openProject(poseManifest, { env: false })
  const reloadPoses = async () => buildGallerySnapshot(await loadPoses())
  const poseServer = await serveGallery({
    load: reloadPoses,
    open: false,
    onProgress: quiet,
    edit: createGalleryEditHandler({ manifestFor: () => poseManifest, loadProject: loadPoses, reload: reloadPoses, onProgress: quiet }),
    skeleton: createGallerySkeletonHandlers({ loadProject: loadPoses, client: () => ({ estimateSkeleton: async () => ({ keypoints: standing, usage: null }) }) }),
  })
  try {
    page.on("dialog", (dialog) => { void dialog.accept() })
    const pressButton = (scope: string, text: string) => page.evaluate((sel, label) => {
      const b = ([...document.querySelectorAll(sel)] as HTMLButtonElement[]).find((x) => x.textContent === label)
      b?.click()
      return Boolean(b)
    }, scope, text)
    /** Drags a named joint on the editor's stage by (dx, dy) screen pixels, the way a person does. */
    const dragJoint = async (label: string, dx: number, dy: number) => {
      const handle = await page.evaluateHandle((name) => {
        const hit = [...document.querySelectorAll(".pose-stage circle.joint")].find((c) => c.querySelector("title")?.textContent === name)!
        hit.scrollIntoView({ block: "center" })
        return hit
      }, label)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const box = (await handle.asElement()!.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 })
      await page.mouse.up()
    }
    await page.goto(`${poseServer.url}#chars/hero-wave`, { waitUntil: "networkidle0" })
    check(await page.$(".drawer .poses svg.pose") !== null, "a skeleton animation shows its poses")
    check(await pressButton(".drawer button", "Edit poses"), "a skeleton animation offers Edit poses")
    await page.waitForSelector(".pose-editor svg.stage", { timeout: 5_000 })
    await dragJoint("RIGHT ARM", -30, -40)
    await pressButton(".drawer form.edit button", "Save poses")
    await noticeMatches("Poses saved")
    const saved = JSON.parse(await readFile(posesFile, "utf8")) as { frames: { label: string; y: number }[][] }
    const arm = saved.frames[0]!.find((j) => j.label === "RIGHT ARM")!
    const was = standing.find((j) => j.label === "RIGHT ARM")!
    check(arm.y < was.y - 0.05, "dragging a joint and saving rewrites the keypoints file")

    await page.goto(`${poseServer.url}#chars/hero`, { waitUntil: "networkidle0" })
    check(await pressButton(".drawer button", "+ Skeleton animation"), "a sprite offers + Skeleton animation")
    await page.waitForSelector("form.edit", { timeout: 5_000 })
    await pressButton("form.edit button", "Estimate poses")
    await page.waitForSelector("form.edit .pose-editor svg.stage", { timeout: 5_000 })
    await dragJoint("LEFT LEG", 25, 0)
    const drafted = JSON.parse(await page.$eval("form.edit textarea", (t) => (t as HTMLTextAreaElement).value)) as { frames: { label: string; x: number }[][] }
    check(drafted.frames[0]!.find((j) => j.label === "LEFT LEG")!.x > 0.7, "dragging in the create form writes the JSON")
  } finally {
    await poseServer.close()
  }

  // The character studio: draft a character with its own sprite and loops,
  // see it priced, then create and generate it; the job's waves take the
  // base first and everything drawn from it after.
  const studioDir = path.join(dir, "studio-project")
  await mkdir(studioDir, { recursive: true })
  const studioManifest = path.join(studioDir, "pixelkiln.manifest.json")
  await writeFile(studioManifest, JSON.stringify({
    name: "studio-smoke",
    provider: "pixellab",
    styles: { props: { outDir: "out/props" } },
    assets: { crate: { prompt: "a crate", width: 32, height: 32, styles: ["props"] } },
  }, null, 2))
  const spritePath = path.join(studioDir, "sprite.png")
  await writeFile(spritePath, encodeRgbaPng(64, 64, Buffer.alloc(64 * 64 * 4, 150)))
  const studioProvider = new FakeProvider({ candidates: 1 })
  const loadStudio = () => openProject(studioManifest, { env: false })
  const reloadStudio = async () => buildGallerySnapshot(await loadStudio())
  const studioServer = await serveGallery({
    load: reloadStudio,
    open: false,
    onProgress: quiet,
    edit: createGalleryEditHandler({ manifestFor: () => studioManifest, loadProject: loadStudio, reload: reloadStudio, onProgress: quiet }),
    // PixelLab's quote endpoint stands in here: every Pro Flash question is answered 6 + 2.
    price: createGalleryPriceHandler({
      manifestFor: () => studioManifest,
      quoteFor: async () => createProFlashQuoter({ proFlashCost: async () => ({ image: 6, rotations: 2, total: 8 }) }),
    }),
    generate: createGenerateHandlers({
      loadProject: loadStudio,
      providerFor: () => studioProvider,
      // The fake bills a flat 40 a submission where PixelLab's own estimate is
      // far lower, so the ceiling here covers the fake's figure, not plan's.
      budget: { amount: 1000, byProvider: {} },
      reload: reloadStudio,
      pollIntervalMs: 50,
      submitSpacingMs: 0,
      onProgress: quiet,
    }),
  })
  try {
    await page.goto(studioServer.url, { waitUntil: "networkidle0" })
    await page.click("#studio")
    await page.waitForSelector(".studio-form", { timeout: 5_000 })
    await page.type(".studio-form input[placeholder='e.g. mira']", "mira")
    await page.type(".studio-form textarea", "a young knight in silver armour")
    // Pro Flash is priced by PixelLab's own quote, marked live.
    const setEngine = (engine: string) => page.evaluate((value) => {
      const select = [...document.querySelectorAll(".studio-form select")].find((s) => [...(s as HTMLSelectElement).options].some((o) => o.value === "pro-flash")) as HTMLSelectElement
      select.value = value
      select.dispatchEvent(new Event("change", { bubbles: true }))
    }, engine)
    await setEngine("pro-flash")
    await page.waitForSelector(".studio-price .quote-live", { timeout: 10_000 })
    const live = await page.$eval(".studio-price", (n) => n.textContent ?? "")
    check(/characters\/mira8 generations live/.test(live) && /provisional/.test(live), "a Pro Flash base is priced by PixelLab's live quote")
    await setEngine("v3")
    await page.waitForFunction(() => !document.querySelector(".studio-price .quote-live") && /Total:/.test(document.querySelector(".studio-price")?.textContent ?? ""), { timeout: 10_000 })
    const file = await page.$(".studio-form input[type=file]")
    await (file as unknown as { uploadFile: (p: string) => Promise<void> }).uploadFile(spritePath)
    await page.waitForFunction(() => /Total:/.test(document.querySelector(".studio-price")?.textContent ?? ""), { timeout: 10_000 })
    await new Promise((resolve) => setTimeout(resolve, 800))
    const quote = await page.$eval(".studio-price", (n) => n.textContent ?? "")
    check(/characters\/mira1 generation/.test(quote), "the studio prices a base drawn from its own sprite as its rotations")
    check(/characters\/mira\.walk\.eastfree \(mirrored\)/.test(quote) && /Total: 17 generations/.test(quote), "loops are priced per direction, mirrors free, with a total")
    await page.evaluate(() => (document.querySelector(".studio-form .actions button.primary") as HTMLButtonElement).click())
    let finished: { phase: string; counts: { submitted: number } } | undefined
    for (let i = 0; i < 150 && !finished; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      const jobs = (await (await fetch(new URL("/api/jobs", studioServer.url))).json()) as { jobs: { phase: string; counts: { submitted: number } }[] }
      if (jobs.jobs[0] && ["done", "failed"].includes(jobs.jobs[0].phase)) finished = jobs.jobs[0]
    }
    check(finished?.phase === "done" && finished.counts.submitted === 6, "Create & generate draws the base, then its loops and mirror, in waves")
    const written = JSON.parse(await readFile(studioManifest, "utf8")) as { styles: Record<string, unknown>; assets: Record<string, unknown> }
    check(Boolean(written.styles.characters) && Object.keys(written.assets).join(",") === "crate,mira,mira.walk,mira.idle", "the studio saved the style, base, and loops in one write")
  } finally {
    await studioServer.close()
  }

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
