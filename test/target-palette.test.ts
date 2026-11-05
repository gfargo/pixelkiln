import path from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { PixelLabClient, targetPaletteBody } from "../src/client.ts"
import { PixelLabProvider, sendsTargetPalette, targetPaletteFor } from "../src/providers/pixellab.ts"
import type { ResolvedSpec } from "../src/types.ts"

const GB = ["#081820", "#346856", "#88c070", "#e0f8d0"]
const PALETTE = { colors: GB, name: "Game Boy", maxColors: 4 }
const WIRE = { colors: GB, name: "Game Boy", max_colors: 4 }
const IMG = { base64: "AAAA", format: "png" as const }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-target-palette-"))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

async function resolve(style: Record<string, unknown>, assets: Record<string, unknown>) {
  const file = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(file, JSON.stringify({
    name: "target-palette",
    provider: "pixellab",
    styles: { base: { outDir: "art", ...style } },
    assets,
  }))
  return resolveSpecs(await loadManifest(file))
}

// The shapes below were hashed on origin/main before target_palette was wired
// to more tools. Sending a palette must not move a hash: `palette` was always
// part of identity, and `paletteName`/`maxColors` only join it when set. If one
// of these moves, every consuming lockfile goes stale on upgrade.
describe("hashes of existing specs do not move", () => {
  const cases: { name: string; style: Record<string, unknown>; assets: Record<string, unknown>; hashes: Record<string, string> }[] = [
    {
      name: "pixflux still",
      style: { generator: "pixflux", size: 64, palette: GB },
      assets: { rock: { prompt: "a mossy rock" } },
      hashes: { rock: "be57a03dd666bf39c94bad84723e034ccdc92cecdccb0225f6d13788ca3919b3" },
    },
    {
      name: "imageProFlash still",
      style: { generator: "imageProFlash", size: 64, palette: GB },
      assets: { rock: { prompt: "a mossy rock" } },
      hashes: { rock: "8557954e11230c58431f9c65411f9e975e9ea79bc2a67de98f672c208b776326" },
    },
    {
      name: "pro character base and state",
      style: { generator: "character", mode: "pro", size: 48, palette: GB },
      assets: { hero: { prompt: "a knight" }, "hero.hurt": { prompt: "bleeding", state: { of: "hero" } } },
      hashes: {
        hero: "0d190eb247235a91bb2d8b23c78ba16251df9c8b3115cf1132282d3ae730041a",
        "hero.hurt": "26432f6056a8ece49362b288fdb2fb4b6bfde720cb42d53dd58da0549af953bf",
      },
    },
    {
      name: "tiles",
      style: { generator: "tiles", tileSize: 32, palette: GB },
      assets: { grass: { prompt: "grass tiles" } },
      hashes: { grass: "7f0a4a06eefcd82afd3e9036e861ae59e70cc65b1e920b87546cf8691f136727" },
    },
    {
      name: "pro terrain",
      style: { generator: "terrain", terrainMode: "pro", terrainTileSize: 32, palette: GB },
      assets: { shore: { prompt: "1). deep water 2). sand" } },
      hashes: { shore: "30895f8ae9953e6a9518a6d5b3434e6033c86e77006f488c40b771951e7bc891" },
    },
    {
      name: "objectPro base and state",
      style: { generator: "objectPro", size: 64, palette: GB },
      assets: { rune: { prompt: "a stone rune" }, "rune.lit": { prompt: "glowing", state: { of: "rune" } } },
      hashes: {
        rune: "9895253ad091b484a172e970a01c4403ee619e4dea9aa5e038e342da9a7fefd8",
        "rune.lit": "bfd8511764262f5e9909e379497f76e6bd35827751773cd0c73e54a681a197e8",
      },
    },
    {
      name: "1dir",
      style: { generator: "1dir", size: 32, palette: GB },
      assets: { crate: { prompt: "a crate" } },
      hashes: { crate: "4d9c55f85f5b40d46322ebcadac51c9b1d0c9e17cd925370cf98b0fdaed8bff2" },
    },
  ]

  for (const entry of cases) {
    it(`pins ${entry.name}`, async () => {
      const specs = await resolve(entry.style, entry.assets)
      expect(Object.fromEntries(specs.map((spec) => [spec.assetId, spec.specHash]))).toEqual(entry.hashes)
    })
  }

  it("hashes paletteName and maxColors only when set, on every generator that takes them", async () => {
    const styles: Record<string, unknown>[] = [
      { generator: "imageProFlash", size: 64 },
      { generator: "tiles", tileSize: 32 },
      { generator: "1dir", size: 32 },
      { generator: "uiElement", size: 64 },
    ]
    for (const style of styles) {
      const plain = await resolve({ ...style, palette: GB }, { a: { prompt: "a thing" } })
      const capped = await resolve({ ...style, palette: GB, maxColors: 4 }, { a: { prompt: "a thing" } })
      const named = await resolve({ ...style, palette: GB, paletteName: "Game Boy" }, { a: { prompt: "a thing" } })
      expect(plain[0]).not.toHaveProperty("paletteName")
      expect(plain[0]).not.toHaveProperty("maxColors")
      expect(capped[0]).toMatchObject({ maxColors: 4 })
      expect(new Set([plain[0]!.specHash, capped[0]!.specHash, named[0]!.specHash]).size).toBe(3)
    }
  })
})

describe("paletteName and maxColors on the style", () => {
  const generators = ["imagePro", "imageProFlash", "objectPro", "1dir", "character", "tiles", "terrain", "uiAsset", "uiElement"]
  const prompt = (generator: string) => (generator === "terrain" ? "1). water 2). sand" : "a thing")

  for (const generator of generators) {
    it(`accepts them on ${generator}`, async () => {
      const specs = await resolve(
        { generator, palette: GB, paletteName: "Game Boy", maxColors: 4, ...(generator === "uiAsset" ? { size: 256 } : {}) },
        { a: { prompt: prompt(generator) } },
      )
      expect(specs[0]).toMatchObject({ palette: GB, paletteName: "Game Boy", maxColors: 4 })
    })
  }

  it("refuses them where no PixelLab route takes target_palette", async () => {
    for (const generator of ["pixflux", "map", "isometricTile"]) {
      await expect(resolve({ generator, maxColors: 4 }, { a: { prompt: "a thing" } })).rejects.toThrow(/maxColors applies to the .* generators only/)
    }
    await expect(resolve({ generator: "tiles", paletteName: "PICO-8" }, { a: { prompt: "t" } })).rejects.toThrow(/set palette too/)
    await expect(resolve({ generator: "tiles", maxColors: 65 }, { a: { prompt: "t" } })).rejects.toThrow()
    await expect(resolve({ generator: "tiles", maxColors: 1 }, { a: { prompt: "t" } })).rejects.toThrow()
  })
})

describe("targetPaletteBody", () => {
  it("spells the field once: colours, name, cap", () => {
    expect(targetPaletteBody(PALETTE)).toEqual({ target_palette: WIRE })
    expect(targetPaletteBody({ maxColors: 8 })).toEqual({ target_palette: { max_colors: 8 } })
  })
  it("sends nothing for no palette, an empty one, or a bare name", () => {
    expect(targetPaletteBody()).toEqual({})
    expect(targetPaletteBody({ colors: [] })).toEqual({})
    expect(targetPaletteBody({ colors: [], name: "PICO-8" })).toEqual({})
  })
})

describe("PixelLabClient wire", () => {
  const calls: { path: string; body: Record<string, unknown> }[] = []
  beforeEach(() => {
    calls.length = 0
    // The reply is deliberately not any endpoint's real shape: only the
    // request body is under test, and response validation rejecting it is
    // swallowed by `sent`.
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ path: new URL(String(input)).pathname.replace(/^\/v2/, ""), body: init?.body ? JSON.parse(String(init.body)) : {} })
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    }))
  })
  const client = () => new PixelLabClient("key")
  const sent = async (call: Promise<unknown>) => {
    await call.catch(() => undefined)
    return calls.at(-1)!
  }

  // Every wrapped endpoint that takes the field, with and without a palette.
  const routes: { name: string; path: string; call: (targetPalette?: typeof PALETTE) => Promise<unknown> }[] = [
    { name: "createImagePro", path: "/generate-image-v2", call: (targetPalette) => client().createImagePro({ description: "d", width: 64, height: 64, targetPalette }) },
    { name: "createImageProFlash", path: "/create-image-pro-flash", call: (targetPalette) => client().createImageProFlash({ description: "d", width: 64, height: 64, targetPalette }) },
    { name: "createObjectProFlash", path: "/create-object-pro-flash", call: (targetPalette) => client().createObjectProFlash({ description: "d", directions: 8, size: 64, targetPalette }) },
    { name: "createObjectProState", path: "/objects/obj-1/states", call: (targetPalette) => client().createObjectProState({ objectId: "obj-1", editDescription: "lit", targetPalette }) },
    { name: "animateObject (pro)", path: "/objects/obj-1/animations", call: (targetPalette) => client().animateObject({ objectId: "obj-1", directions: 8, direction: "east", mode: "pro", targetPalette }) },
    { name: "create1Direction", path: "/create-1-direction-object", call: (targetPalette) => client().create1Direction({ description: "d", size: 32, targetPalette }) },
    { name: "createTilesPro", path: "/create-tiles-pro", call: (targetPalette) => client().createTilesPro({ description: "d", targetPalette }) },
    { name: "createTileset (pro)", path: "/create-tileset", call: (targetPalette) => client().createTileset({ lowerDescription: "a", upperDescription: "b", mode: "pro", targetPalette }) },
    { name: "createUiAsset", path: "/create-ui-asset", call: (targetPalette) => client().createUiAsset({ description: "d", width: 256, height: 256, targetPalette }) },
    { name: "generateUiV2", path: "/generate-ui-v2", call: (targetPalette) => client().generateUiV2({ description: "d", width: 64, height: 64, targetPalette }) },
    { name: "createCharacter (pro)", path: "/create-character-pro", call: (targetPalette) => client().createCharacter({ mode: "pro", description: "d", size: 48, directions: 8, template: "mannequin", targetPalette }) },
    { name: "createCharacter (pro-flash)", path: "/create-character-pro-flash", call: (targetPalette) => client().createCharacter({ mode: "pro-flash", description: "d", size: 48, directions: 8, template: "mannequin", targetPalette }) },
    { name: "createCharacterState", path: "/create-character-state", call: (targetPalette) => client().createCharacterState({ characterId: "c-1", editDescription: "hurt", targetPalette }) },
    { name: "createPortraitCharacterPro", path: "/portrait-character-pro", call: (targetPalette) => client().createPortraitCharacterPro({ direction: "character_to_portrait", image: IMG, targetPalette }) },
    {
      name: "transferOutfitV2",
      path: "/transfer-outfit-v2",
      call: (targetPalette) => client().transferOutfitV2({
        referenceImage: { ...IMG, width: 32, height: 32 },
        frames: [{ ...IMG, width: 32, height: 32 }, { ...IMG, width: 32, height: 32 }],
        imageSize: { width: 32, height: 32 },
        targetPalette,
      }),
    },
    { name: "interpolationV2", path: "/interpolation-v2", call: (targetPalette) => client().interpolationV2({ startImage: IMG, endImage: IMG, width: 32, height: 32, action: "morph", targetPalette }) },
    { name: "editAnimationV2", path: "/edit-animation-v2", call: (targetPalette) => client().editAnimationV2({ frames: [IMG, IMG], width: 32, height: 32, description: "cape", targetPalette }) },
  ]

  for (const route of routes) {
    it(`${route.name} sends target_palette on ${route.path}, and nothing without one`, async () => {
      const withPalette = await sent(route.call(PALETTE))
      expect(withPalette.path).toBe(route.path)
      expect(withPalette.body.target_palette).toEqual(WIRE)

      const bare = await sent(route.call())
      expect(bare.body).not.toHaveProperty("target_palette")
      // The only difference the palette makes is that one key.
      const { target_palette: _sent, ...rest } = withPalette.body
      expect(rest).toEqual(bare.body)
    })
  }

  it("sends a bare colour cap with no colours", async () => {
    const call = await sent(client().createTilesPro({ description: "d", targetPalette: { colors: [], maxColors: 8 } }))
    expect(call.body.target_palette).toEqual({ max_colors: 8 })
  })

  it("keeps the standard terrain set, the v3 object animation, and the other modes free of the field", async () => {
    expect((await sent(client().createTileset({ lowerDescription: "a", upperDescription: "b", targetPalette: PALETTE }))).body).not.toHaveProperty("target_palette")
    expect((await sent(client().createTileset({ lowerDescription: "a", upperDescription: "b", mode: "standard", targetPalette: PALETTE }))).body).not.toHaveProperty("target_palette")
    expect((await sent(client().animateObject({ objectId: "obj-1", directions: 8, direction: "east", mode: "v3", targetPalette: PALETTE }))).body).not.toHaveProperty("target_palette")
    for (const mode of ["standard", "v3"] as const) {
      const call = await sent(client().createCharacter({ mode, description: "d", size: 48, directions: 8, template: "mannequin", targetPalette: PALETTE }))
      expect(call.body).not.toHaveProperty("target_palette")
    }
  })

  it("leaves the standard character and animation swatches exactly as they were", async () => {
    const standard = await sent(client().createCharacter({
      mode: "standard", description: "d", size: 48, directions: 8, template: "mannequin", paletteSwatchBase64: "SWATCH",
    }))
    expect(standard.path).toBe("/create-character-with-8-directions")
    expect(standard.body).toMatchObject({ color_image: { type: "base64", base64: "SWATCH", format: "png" }, force_colors: true })
    expect(standard.body).not.toHaveProperty("target_palette")

    const animation = await sent(client().animateCharacter({
      characterId: "c-1", animationName: "walk", mode: "v3", directions: ["east"], paletteSwatchBase64: "SWATCH",
    }))
    expect(animation.path).toBe("/animate-character")
    expect(animation.body).toMatchObject({ color_image: { type: "base64", base64: "SWATCH", format: "png" }, force_colors: true })
    expect(animation.body).not.toHaveProperty("target_palette")
  })

  it("lets the palette win over a style image on Pro Flash and keeps the style options as they were", async () => {
    const call = await sent(client().createImageProFlash({
      description: "d",
      width: 64,
      height: 64,
      styleImage: { image: IMG, width: 32, height: 32 },
      styleTraits: { outline: false },
      targetPalette: PALETTE,
    }))
    expect(call.body.style_options).toEqual({ outline: false })
    expect(call.body.target_palette).toEqual(WIRE)
  })
})

describe("which spec sends target_palette", () => {
  const base = { palette: GB, paletteName: "Game Boy", maxColors: 4 } as const
  const spec = (fields: Record<string, unknown>) => ({ ...base, ...fields }) as unknown as ResolvedSpec

  it("sends for the single-image, tile, UI, and 1dir generators", () => {
    for (const generator of ["imagePro", "imageProFlash", "1dir", "tiles", "uiAsset", "uiElement"]) {
      expect(sendsTargetPalette(spec({ generator }))).toBe(true)
    }
    expect(targetPaletteFor(spec({ generator: "tiles" }))).toEqual({ colors: GB, name: "Game Boy", maxColors: 4 })
  })

  it("keeps pixflux, map and isometric tiles on their own mechanism", () => {
    for (const generator of ["pixflux", "map", "isometricTile", "animation", "frames"]) {
      expect(sendsTargetPalette(spec({ generator }))).toBe(false)
      expect(targetPaletteFor(spec({ generator }))).toBeUndefined()
    }
  })

  it("sends for a top-down Pro terrain set only", () => {
    expect(sendsTargetPalette(spec({ generator: "terrain", terrainMode: "pro" }))).toBe(true)
    expect(sendsTargetPalette(spec({ generator: "terrain", terrainMode: "standard" }))).toBe(false)
    expect(sendsTargetPalette(spec({ generator: "terrain" }))).toBe(false)
    expect(sendsTargetPalette(spec({ generator: "terrain", terrainMode: "pro", terrainOrientation: "sidescroller" }))).toBe(false)
  })

  it("sends for pro and pro-flash character bases, states, portraits and outfits, not standard, v3 or animations", () => {
    const character = (kind: string, mode: string) => spec({ generator: "character", character: { kind, mode } })
    expect(sendsTargetPalette(character("base", "pro"))).toBe(true)
    expect(sendsTargetPalette(character("base", "pro-flash"))).toBe(true)
    expect(sendsTargetPalette(character("base", "standard"))).toBe(false)
    expect(sendsTargetPalette(character("base", "v3"))).toBe(false)
    for (const mode of ["standard", "v3", "pro"]) {
      expect(sendsTargetPalette(character("state", mode))).toBe(true)
      expect(sendsTargetPalette(character("portrait", mode))).toBe(true)
      expect(sendsTargetPalette(character("outfit", mode))).toBe(true)
      expect(sendsTargetPalette(character("animation", mode))).toBe(false)
    }
  })

  it("sends for object bases and states, and for a pro animation only", () => {
    const object = (kind: string, animation?: { mode: string }) => spec({ generator: "objectPro", objectPro: { kind, animation } })
    expect(sendsTargetPalette(object("base"))).toBe(true)
    expect(sendsTargetPalette(object("state"))).toBe(true)
    expect(sendsTargetPalette(object("animation", { mode: "pro" }))).toBe(true)
    expect(sendsTargetPalette(object("animation", { mode: "v3" }))).toBe(false)
  })

  it("sends for interpolate and edit-animation revisions, not for the endpoints that take none", () => {
    const revision = (mode: string) => spec({ generator: "pixflux", revision: { mode } })
    expect(sendsTargetPalette(revision("interpolate"))).toBe(true)
    expect(sendsTargetPalette(revision("edit-animation"))).toBe(true)
    for (const mode of ["animate", "animate-pixminimax", "animate-skeleton", "reduce-colors", "inpaint", "correct-pixelart", "remove-background", "normal-map", "image-to-image"]) {
      expect(sendsTargetPalette(revision(mode))).toBe(false)
    }
  })

  it("sends nothing when the style sets neither colours nor a cap", () => {
    expect(targetPaletteFor(spec({ generator: "tiles", palette: [], paletteName: undefined, maxColors: undefined }))).toBeUndefined()
    expect(targetPaletteFor(spec({ generator: "tiles", palette: [], maxColors: 8 }))).toEqual({ colors: [], name: "Game Boy", maxColors: 8 })
  })
})

describe("provider submit", () => {
  it("hands tiles, 1dir, a UI element and a Pro terrain set the style's palette", async () => {
    const createTilesPro = vi.fn(async () => ({ tile_id: "t", background_job_id: "b", status: "processing" }))
    const create1Direction = vi.fn(async () => ({ object_id: "o", background_job_id: "b", status: "processing", n_frames: 4 }))
    const generateUiV2 = vi.fn(async () => ({ background_job_id: "b", status: "processing" }))
    const createTileset = vi.fn(async () => ({ tileset_id: "s", background_job_id: "b", status: "processing" }))
    const provider = new PixelLabProvider({ createTilesPro, create1Direction, generateUiV2, createTileset } as never)
    const style = { palette: GB, paletteName: "Game Boy", maxColors: 4 }
    const expected = { targetPalette: { colors: GB, name: "Game Boy", maxColors: 4 } }

    const [tiles] = await resolve({ ...style, generator: "tiles", tileSize: 32 }, { a: { prompt: "grass" } })
    await provider.submit(tiles!, [])
    expect(createTilesPro).toHaveBeenCalledWith(expect.objectContaining(expected))

    const [oneDir] = await resolve({ ...style, generator: "1dir", size: 32 }, { a: { prompt: "a crate" } })
    await provider.submit(oneDir!, [])
    expect(create1Direction).toHaveBeenCalledWith(expect.objectContaining(expected))

    const [element] = await resolve({ ...style, generator: "uiElement", size: 64 }, { a: { prompt: "a button" } })
    await provider.submit(element!, [])
    expect(generateUiV2).toHaveBeenCalledWith(expect.objectContaining(expected))

    const [pro] = await resolve({ ...style, generator: "terrain", terrainMode: "pro", terrainTileSize: 32 }, { a: { prompt: "1). water 2). sand" } })
    await provider.submit(pro!, [])
    expect(createTileset).toHaveBeenLastCalledWith(expect.objectContaining(expected))
    const [standard] = await resolve({ ...style, generator: "terrain", terrainTileSize: 16 }, { a: { prompt: "1). water 2). sand" } })
    await provider.submit(standard!, [])
    expect(createTileset).toHaveBeenLastCalledWith(expect.objectContaining({ targetPalette: undefined }))
  })

  it("sends no target_palette when the style has no palette", async () => {
    const createTilesPro = vi.fn(async () => ({ tile_id: "t", background_job_id: "b", status: "processing" }))
    const [tiles] = await resolve({ generator: "tiles", tileSize: 32 }, { a: { prompt: "grass" } })
    await new PixelLabProvider({ createTilesPro } as never).submit(tiles!, [])
    expect(createTilesPro).toHaveBeenCalledWith(expect.objectContaining({ targetPalette: undefined }))
  })

  it("draws Pro characters and object states with the palette, and keeps the standard base on its swatch", async () => {
    const createCharacter = vi.fn(async () => ({ character_id: "c", background_job_id: "b" }))
    const createCharacterState = vi.fn(async () => ({ character_id: "c2", background_job_id: "b" }))
    const createObjectProState = vi.fn(async () => ({ object_id: "o2", background_job_id: "b" }))
    const provider = new PixelLabProvider({ createCharacter, createCharacterState, createObjectProState } as never)
    const expected = { targetPalette: { colors: GB, name: "Game Boy", maxColors: 4 } }
    const style = { palette: GB, paletteName: "Game Boy", maxColors: 4, size: 48 }

    const pro = await resolve({ ...style, generator: "character", mode: "pro" }, { hero: { prompt: "a knight" }, "hero.hurt": { prompt: "hurt", state: { of: "hero" } } })
    await provider.submit(pro.find((s) => s.assetId === "hero")!, [])
    expect(createCharacter).toHaveBeenLastCalledWith(expect.objectContaining(expected))
    await provider.submit(pro.find((s) => s.assetId === "hero.hurt")!, [], { parentObjectId: "c" } as never)
    expect(createCharacterState).toHaveBeenLastCalledWith(expect.objectContaining(expected))

    const standard = await resolve({ ...style, generator: "character", mode: "standard" }, { hero: { prompt: "a knight" } })
    await provider.submit(standard[0]!, [])
    expect(createCharacter).toHaveBeenLastCalledWith(expect.objectContaining({
      targetPalette: undefined,
      paletteSwatchBase64: expect.any(String),
    }))

    const props = await resolve({ ...style, generator: "objectPro" }, { rune: { prompt: "a rune" }, "rune.lit": { prompt: "glowing", state: { of: "rune" } } })
    await provider.submit(props.find((s) => s.assetId === "rune.lit")!, [], { parentObjectId: "o" } as never)
    expect(createObjectProState).toHaveBeenLastCalledWith(expect.objectContaining(expected))
  })
})

describe("validation", () => {
  const provider = new PixelLabProvider({} as never)
  const many = (n: number) => Array.from({ length: n }, (_, i) => `#${(i + 1).toString(16).padStart(6, "0")}`)

  it("refuses a one-colour or 257-colour palette on every route that sends it, while resolving the manifest", async () => {
    for (const style of [
      { generator: "tiles", tileSize: 32 },
      { generator: "imageProFlash", size: 64 },
      { generator: "1dir", size: 32 },
      { generator: "character", mode: "pro", size: 48 },
    ]) {
      await expect(resolve({ ...style, palette: ["#000000"] }, { a: { prompt: "a thing" } })).rejects.toThrow(/target palette takes 2 to 256 colours/)
      await expect(resolve({ ...style, palette: many(257) }, { a: { prompt: "a thing" } })).rejects.toThrow(/target palette takes 2 to 256 colours/)
      const [ok] = await resolve({ ...style, palette: many(256) }, { a: { prompt: "a thing" } })
      expect(() => provider.validate(ok!, [])).not.toThrow()
    }
  })

  it("leaves a one-colour palette alone where the palette is not sent as target_palette", async () => {
    for (const style of [
      { generator: "pixflux", size: 64 },
      { generator: "character", mode: "standard", size: 48 },
      { generator: "terrain", terrainTileSize: 16 },
    ]) {
      const [spec] = await resolve({ ...style, palette: ["#000000"] }, { a: { prompt: style.generator === "terrain" ? "1). water 2). sand" : "a thing" } })
      expect(() => provider.validate(spec!, [])).not.toThrow()
    }
  })
})
