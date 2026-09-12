// Write manifest.json beside a web build: every file with its sha256 and
// size, plus the pins it was built from. This is what tools/pixelorama-bridge/pin.json
// copies once a build is published, and what the gallery verifies on download.
import { createHash } from "node:crypto"
import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
const dir = path.resolve(process.argv[2] ?? ".")
const pin = JSON.parse(await readFile(new URL("../pin.json", import.meta.url), "utf8"))
// The protocol is the bridge's, not the pin's: pin.json describes the build
// already published, while this manifest describes the one just built.
const bridge = await readFile(new URL("../overlay/src/Extensions/PixelKilnBridge/PixelKilnBridge.gd", import.meta.url), "utf8")
const protocol = Number(/^const PROTOCOL_VERSION := (\d+)$/m.exec(bridge)?.[1])
if (!Number.isInteger(protocol)) throw new Error("PROTOCOL_VERSION not found in PixelKilnBridge.gd")
const files = {}
for (const name of (await readdir(dir)).sort()) {
  if (name === "manifest.json" || name.startsWith(".")) continue
  const bytes = await readFile(path.join(dir, name))
  files[name] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }
}
const manifest = { pixelorama: pin.pixelorama, godot: pin.godot, extensionsApi: pin.extensionsApi, protocol, builtAt: new Date().toISOString(), files }
await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
console.log(`manifest.json: ${Object.keys(files).length} files, ${Object.values(files).reduce((n, f) => n + f.bytes, 0)} bytes`)
