import { encodeRgbaPng } from "../../src/png.ts"
import { serializeGlb, type GltfJson } from "../../src/glb.ts"

/**
 * A small rigged model for tests: a body of two quads (one moved by the hips,
 * one by the left lower arm) on one 8×8 texture, and a separate "Helm" quad
 * on its own texture, on a three-bone skeleton with one animation. It has
 * everything the gallery reads from a real model (skin, tangents, a normal
 * map, `hiddenBy` extras) in a few kilobytes.
 */
export function solidPng(size: number, rgba: [number, number, number, number]): Buffer {
  const pixels = Buffer.alloc(size * size * 4)
  for (let at = 0; at < pixels.length; at += 4) pixels.set(rgba, at)
  return encodeRgbaPng(size, size, pixels)
}

export const TINY_BONES = ["Hips", "LeftLowerArm", "Head"]

export function tinyGlb(opts: { bodyTexture?: Buffer; helmTexture?: Buffer } = {}): Buffer {
  const chunks: Buffer[] = []
  let length = 0
  const bufferViews: NonNullable<GltfJson["bufferViews"]> = []
  const accessors: NonNullable<GltfJson["accessors"]> = []
  const view = (bytes: Buffer, target?: number) => {
    const padding = (4 - (length % 4)) % 4
    if (padding) { chunks.push(Buffer.alloc(padding)); length += padding }
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, ...(target ? { target } : {}) })
    chunks.push(bytes)
    length += bytes.length
    return bufferViews.length - 1
  }
  const floats = (values: number[], type: string, extra: Record<string, unknown> = {}) => {
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type]!
    accessors.push({ bufferView: view(Buffer.from(new Float32Array(values).buffer), 34962), componentType: 5126, count: values.length / size, type, ...extra })
    return accessors.length - 1
  }
  const bytes = (values: number[], type: string) => {
    accessors.push({ bufferView: view(Buffer.from(new Uint8Array(values)), 34962), componentType: 5121, count: values.length / 4, type })
    return accessors.length - 1
  }
  const shorts = (values: number[]) => {
    accessors.push({ bufferView: view(Buffer.from(new Uint16Array(values).buffer), 34963), componentType: 5123, count: values.length, type: "SCALAR" })
    return accessors.length - 1
  }
  /** One quad facing +Z: its corner positions, its place on the texture, and the bone that moves it. */
  const quad = (x: number, y: number, uv: [number, number, number, number], bone: number) => ({
    positions: [x, y, 0, x + 0.4, y, 0, x + 0.4, y + 0.4, 0, x, y + 0.4, 0],
    uvs: [uv[0], uv[3], uv[2], uv[3], uv[2], uv[1], uv[0], uv[1]],
    joints: [bone, 0, 0, 0, bone, 0, 0, 0, bone, 0, 0, 0, bone, 0, 0, 0],
  })
  const primitive = (quads: Array<ReturnType<typeof quad>>, material: number) => {
    const positions = quads.flatMap((q) => q.positions)
    const count = positions.length / 3
    const xs = positions.filter((_, index) => index % 3 === 0)
    const ys = positions.filter((_, index) => index % 3 === 1)
    return {
      attributes: {
        POSITION: floats(positions, "VEC3", { min: [Math.min(...xs), Math.min(...ys), 0], max: [Math.max(...xs), Math.max(...ys), 0] }),
        NORMAL: floats(Array.from({ length: count }, () => [0, 0, 1]).flat(), "VEC3"),
        TEXCOORD_0: floats(quads.flatMap((q) => q.uvs), "VEC2"),
        JOINTS_0: bytes(quads.flatMap((q) => q.joints), "VEC4"),
        WEIGHTS_0: floats(Array.from({ length: count }, () => [1, 0, 0, 0]).flat(), "VEC4"),
        TANGENT: floats(Array.from({ length: count }, () => [1, 0, 0, 1]).flat(), "VEC4"),
      },
      indices: shorts(quads.flatMap((_, index) => [0, 1, 2, 0, 2, 3].map((corner) => corner + index * 4))),
      material,
    }
  }
  const body = primitive([quad(-0.2, 0.8, [0.05, 0.05, 0.45, 0.45], 0), quad(0.3, 1.0, [0.55, 0.55, 0.95, 0.95], 1)], 0)
  const helm = primitive([quad(-0.2, 1.4, [0.1, 0.1, 0.9, 0.9], 2)], 1)
  // Each bone's inverse bind matrix undoes where the bone rests, so the rest pose is the mesh as modelled.
  const unmove = (x: number, y: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, 0, 1]
  const inverseBind = floats([...unmove(0, 1), ...unmove(0.5, 1.2), ...unmove(0, 1.6)], "MAT4")
  const times = floats([0, 0.5, 1], "SCALAR", { min: [0], max: [1] })
  const turns = floats([0, 0, 0, 1, 0, 0, 0.3826834, 0.9238795, 0, 0, 0, 1], "VEC4")
  const image = (png: Buffer) => ({ bufferView: view(png), mimeType: "image/png" })
  const images = [
    image(opts.bodyTexture ?? solidPng(8, [200, 120, 80, 255])),
    image(solidPng(4, [128, 128, 255, 255])),
    image(opts.helmTexture ?? solidPng(8, [90, 90, 110, 255])),
  ]
  const json: GltfJson = {
    asset: { version: "2.0", generator: "pixelkiln test fixture" },
    scene: 0,
    scenes: [{ nodes: [0, 3, 4] }],
    nodes: [
      { name: "Hips", translation: [0, 1, 0], children: [1, 2] },
      { name: "LeftLowerArm", translation: [0.5, 0.2, 0] },
      { name: "Head", translation: [0, 0.6, 0] },
      { name: "Character", mesh: 0, skin: 0, extras: { body: true, hiddenBy: [] } },
      { name: "Helm", mesh: 1, skin: 0 },
    ],
    meshes: [{ name: "Character", primitives: [body] }, { name: "Helm", primitives: [helm] }],
    skins: [{ joints: [0, 1, 2], inverseBindMatrices: inverseBind }],
    materials: [
      { name: "Sprite", pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, normalTexture: { index: 1 } },
      { name: "Helm", pbrMetallicRoughness: { baseColorTexture: { index: 2 }, metallicFactor: 0, roughnessFactor: 1 } },
    ],
    textures: [{ source: 0, sampler: 0 }, { source: 1, sampler: 0 }, { source: 2, sampler: 0 }],
    images,
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    animations: [{ name: "Wave", channels: [{ sampler: 0, target: { node: 1, path: "rotation" } }], samplers: [{ input: times, output: turns, interpolation: "LINEAR" }] }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: length }],
  }
  return Buffer.from(serializeGlb({ json, bin: Buffer.concat(chunks), extraChunks: [] }))
}
