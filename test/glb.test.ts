import { describe, expect, it } from "vitest"
import { describeGlb, glbImageBytes, imageInfo, parseGlb, readAccessor, replaceGlbImage, serializeGlb, type GlbDocument } from "../src/glb.ts"
import { pieceLabel, regionName, uvGuide } from "../src/glb-guide.ts"
import { sha256 } from "../src/hash.ts"
import { solidPng, tinyGlb } from "./fixtures/tiny-glb.ts"

/** The bytes of every bufferView except the named ones, by index. */
function viewHashes(document: GlbDocument, skip: number[] = []): Map<number, string> {
  const hashes = new Map<number, string>()
  for (const [index, view] of (document.json.bufferViews ?? []).entries()) {
    if (skip.includes(index)) continue
    const start = view.byteOffset ?? 0
    hashes.set(index, sha256(Buffer.from(document.bin.subarray(start, start + view.byteLength))))
  }
  return hashes
}

describe("glb container", () => {
  it("parses a model and writes the same bytes back", () => {
    const bytes = tinyGlb()
    const document = parseGlb(bytes)
    expect(document.json.asset.version).toBe("2.0")
    expect(document.bin.length).toBe(document.json.buffers![0]!.byteLength)
    expect(Buffer.from(serializeGlb(document)).equals(bytes)).toBe(true)
  })

  it("rejects what is not a glb, with the reason", () => {
    expect(() => parseGlb(Buffer.from("not a model at all, just text"))).toThrow(/glTF signature/)
    expect(() => parseGlb(Buffer.alloc(4))).toThrow(/shorter than/)
    const truncated = tinyGlb().subarray(0, 200)
    expect(() => parseGlb(truncated)).toThrow(/invalid glb/)
    const wrongVersion = Buffer.from(tinyGlb())
    wrongVersion.writeUInt32LE(1, 4)
    expect(() => parseGlb(wrongVersion)).toThrow(/version 1/)
  })

  it("rejects a bufferView that runs past the buffer", () => {
    const document = parseGlb(tinyGlb())
    document.json.bufferViews![0]!.byteLength = document.bin.length + 4
    expect(() => parseGlb(serializeGlb(document))).toThrow(/bufferView 0 runs past/)
  })

  it("keeps chunks it does not know", () => {
    const document = parseGlb(tinyGlb())
    document.extraChunks.push({ type: 0x12345678, data: Buffer.from([1, 2, 3, 4, 5]) })
    const again = parseGlb(serializeGlb(document))
    expect(again.extraChunks).toHaveLength(1)
    expect(again.extraChunks[0]!.type).toBe(0x12345678)
    expect([...again.extraChunks[0]!.data.subarray(0, 5)]).toEqual([1, 2, 3, 4, 5])
  })

  it("describes meshes, bones, animations, items and what each image is for", () => {
    const summary = describeGlb(parseGlb(tinyGlb()))
    expect(summary.generator).toBe("pixelkiln test fixture")
    expect(summary.meshes.map((mesh) => [mesh.name, mesh.vertices, mesh.triangles])).toEqual([["Character", 8, 4], ["Helm", 4, 2]])
    expect(summary.bones).toEqual(["Hips", "LeftLowerArm", "Head"])
    expect(summary.animations).toEqual(["Wave"])
    expect(summary.items).toEqual(["Helm"])
    expect(summary.images.map((image) => [image.roles, image.materials, image.meshes, image.width, image.mimeType])).toEqual([
      [["baseColor"], ["Sprite"], ["Character"], 8, "image/png"],
      [["normal"], ["Sprite"], ["Character"], 4, "image/png"],
      [["baseColor"], ["Helm"], ["Helm"], 8, "image/png"],
    ])
  })

  it("reads accessors, with integers kept as integers", () => {
    const document = parseGlb(tinyGlb())
    const primitive = document.json.meshes![0]!.primitives[0]!
    const positions = readAccessor(document, primitive.attributes.POSITION!)
    expect(positions.size).toBe(3)
    expect(positions.count).toBe(8)
    expect(positions.data[0]).toBeCloseTo(-0.2)
    const joints = readAccessor(document, primitive.attributes.JOINTS_0!)
    expect(joints.data).toBeInstanceOf(Uint32Array)
    expect([...joints.data.subarray(0, 4)]).toEqual([0, 0, 0, 0])
    expect(joints.data[16]).toBe(1)
    expect([...readAccessor(document, primitive.indices!).data.subarray(0, 6)]).toEqual([0, 1, 2, 0, 2, 3])
  })

  it("reads the size of a PNG and a JPEG from the header", () => {
    expect(imageInfo(solidPng(8, [0, 0, 0, 255]))).toEqual({ mimeType: "image/png", width: 8, height: 8 })
    // SOI, an APP0 segment to skip, then a baseline frame header: 3 rows by 5 columns.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x03, 0x00, 0x05, 0x01, 0x01, 0x11, 0x00])
    expect(imageInfo(jpeg)).toEqual({ mimeType: "image/jpeg", width: 5, height: 3 })
    expect(imageInfo(Buffer.from("GIF89a..."))).toBeNull()
  })
})

describe("replacing an embedded image", () => {
  it("changes that image only and keeps every other view byte for byte", () => {
    const original = parseGlb(tinyGlb())
    const painted = solidPng(8, [10, 200, 30, 255])
    const imageView = original.json.images![0]!.bufferView!
    const before = viewHashes(original, [imageView])
    const edited = parseGlb(serializeGlb(replaceGlbImage(original, 0, painted, "image/png")))
    expect(Buffer.from(glbImageBytes(edited, 0).bytes).equals(painted)).toBe(true)
    expect(viewHashes(edited, [imageView])).toEqual(before)
    // The images after it moved, and still read back whole.
    expect(imageInfo(glbImageBytes(edited, 1).bytes)).toEqual({ mimeType: "image/png", width: 4, height: 4 })
    expect(Buffer.from(glbImageBytes(edited, 2).bytes).equals(Buffer.from(glbImageBytes(original, 2).bytes))).toBe(true)
    expect(edited.json.buffers![0]!.byteLength).toBe(edited.bin.length)
    // Nothing but offsets, one length and the buffer size changed in the JSON.
    const strip = (document: GlbDocument) => JSON.stringify({
      ...document.json,
      buffers: null,
      bufferViews: document.json.bufferViews!.map((view) => ({ ...view, byteOffset: 0, byteLength: 0 })),
    })
    expect(strip(edited)).toBe(strip(original))
  })

  it("keeps the views behind it aligned, whatever the new size", () => {
    const original = parseGlb(tinyGlb())
    for (const extra of [1, 2, 3, 5]) {
      const bytes = Buffer.concat([solidPng(8, [1, 2, 3, 255]), Buffer.alloc(extra)])
      const edited = replaceGlbImage(original, 0, bytes, "image/png")
      for (const [index, view] of edited.json.bufferViews!.entries()) {
        const was = original.json.bufferViews![index]!.byteOffset ?? 0
        expect(((view.byteOffset ?? 0) - was) % 4).toBe(0)
      }
      expect(glbImageBytes(edited, 0).bytes.length).toBe(bytes.length)
      expect(parseGlb(serializeGlb(edited)).json.images).toHaveLength(3)
    }
  })

  it("does not change the document it was given", () => {
    const original = parseGlb(tinyGlb())
    const snapshot = JSON.stringify(original.json)
    replaceGlbImage(original, 2, solidPng(8, [9, 9, 9, 255]), "image/png")
    expect(JSON.stringify(original.json)).toBe(snapshot)
  })

  it("records the new type when a JPEG becomes a PNG", () => {
    const document = parseGlb(tinyGlb())
    document.json.images![0]!.mimeType = "image/jpeg"
    expect(replaceGlbImage(document, 0, solidPng(8, [0, 0, 0, 255]), "image/png").json.images![0]!.mimeType).toBe("image/png")
  })

  it("gives a shared view a copy of its own instead of changing both users", () => {
    const original = parseGlb(tinyGlb())
    original.json.images![2]!.bufferView = original.json.images![0]!.bufferView
    const painted = solidPng(8, [250, 0, 250, 255])
    const edited = parseGlb(serializeGlb(replaceGlbImage(original, 0, painted, "image/png")))
    expect(Buffer.from(glbImageBytes(edited, 0).bytes).equals(painted)).toBe(true)
    expect(Buffer.from(glbImageBytes(edited, 2).bytes).equals(Buffer.from(glbImageBytes(original, 2).bytes))).toBe(true)
    expect(edited.json.bufferViews!.length).toBe(original.json.bufferViews!.length + 1)
    expect(viewHashes(edited, [edited.json.bufferViews!.length - 1])).toEqual(viewHashes(original))
  })

  it("embeds an image the file only named by uri", () => {
    const original = parseGlb(tinyGlb())
    original.json.images![2] = { uri: "helm.png" }
    expect(() => glbImageBytes(original, 2)).toThrow(/not embedded/)
    const edited = replaceGlbImage(original, 2, solidPng(8, [1, 1, 1, 255]), "image/png")
    expect(edited.json.images![2]!.uri).toBeUndefined()
    expect(imageInfo(glbImageBytes(edited, 2).bytes)?.width).toBe(8)
  })

  it("refuses an image the model does not have", () => {
    expect(() => replaceGlbImage(parseGlb(tinyGlb()), 9, solidPng(8, [0, 0, 0, 255]), "image/png")).toThrow(/no image 9/)
  })
})

describe("region names", () => {
  it("turns bone names into words", () => {
    expect(regionName("LeftLowerArm")).toBe("Left lower arm")
    expect(regionName("Hips")).toBe("Hips")
    expect(regionName("mixamorig:RightUpLeg")).toBe("Right up leg")
    expect(regionName("upper_arm.L")).toBe("Left upper arm")
    expect(regionName("DEF-forearm.R")).toBe("Right forearm")
    expect(regionName("Spine2")).toBe("Spine 2")
    expect(regionName("Leg armour")).toBe("Leg armour")
  })
})

describe("unwrap pieces", () => {
  it("finds one piece per island and names it after its dominant bone", () => {
    const guide = uvGuide(parseGlb(tinyGlb()), 0)
    expect(guide.pieces).toHaveLength(2)
    expect(guide.pieces.map((piece) => piece.region).sort()).toEqual(["Hips", "Left lower arm"])
    expect(guide.regions.sort()).toEqual(["Hips", "Left lower arm"])
    const hips = guide.pieces.find((piece) => piece.bone === "Hips")!
    expect(hips.meshes).toEqual(["Character"])
    expect(hips.triangles).toBe(2)
    expect(hips.bounds.map((value) => Number(value.toFixed(3)))).toEqual([0.05, 0.05, 0.45, 0.45])
    expect(hips.area).toBeCloseTo(0.16)
    // The outline is the quad's four edges; the diagonal the two triangles share is inside, not on it.
    expect(hips.outline).toHaveLength(16)
    expect(hips.anchor[0]).toBeGreaterThan(0.05)
    expect(hips.anchor[0]).toBeLessThan(0.45)
    expect(hips.facing).toBe("front")
    expect(pieceLabel(hips)).toBe("Hips, front")
  })

  it("only reads the meshes drawn with that texture", () => {
    const guide = uvGuide(parseGlb(tinyGlb()), 2)
    expect(guide.pieces).toHaveLength(1)
    expect(guide.pieces[0]!.region).toBe("Head")
    expect(guide.pieces[0]!.meshes).toEqual(["Helm"])
    expect(uvGuide(parseGlb(tinyGlb()), 7).pieces).toEqual([])
  })

  it("joins one unwrap split across several meshes back into whole pieces", () => {
    // Give the helm the body's material and a place on the body's texture that
    // touches the hips piece along an edge: a body cut into two meshes.
    const document = parseGlb(tinyGlb())
    const helm = document.json.meshes![1]!.primitives[0]!
    helm.material = 0
    const view = document.json.bufferViews![document.json.accessors![helm.attributes.TEXCOORD_0!]!.bufferView!]!
    new Float32Array(document.bin.buffer, document.bin.byteOffset + view.byteOffset!, 8).set([0.45, 0.45, 0.5, 0.45, 0.5, 0.05, 0.45, 0.05])
    const guide = uvGuide(document, 0)
    expect(guide.pieces).toHaveLength(2)
    const joined = guide.pieces.find((piece) => piece.meshes.length === 2)!
    expect(joined.meshes).toEqual(["Character", "Helm"])
    expect(joined.triangles).toBe(4)
    expect(joined.region).toBe("Hips")
    // Six boundary edges: the shared edge between the two meshes is no longer an outline.
    expect(joined.outline).toHaveLength(24)
  })

  it("names a piece of an unskinned mesh after the mesh", () => {
    const document = parseGlb(tinyGlb())
    for (const node of document.json.nodes!) delete node.skin
    expect(uvGuide(document, 2).pieces[0]).toMatchObject({ bone: null, region: "Helm" })
  })

  it("orders pieces largest first and numbers them", () => {
    const guide = uvGuide(parseGlb(tinyGlb()), 0)
    expect(guide.pieces.map((piece) => piece.id)).toEqual([0, 1])
    expect(guide.pieces[0]!.area).toBeGreaterThanOrEqual(guide.pieces[1]!.area)
  })
})
