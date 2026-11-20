/**
 * Normal map detail for a 3D model from PixelLab's `/normal-map`, two ways:
 *
 * - `texture`: the material's base colour texture, as laid out in its unwrap,
 *   goes to PixelLab in tiles of at most 512 px, masked to the unwrap's
 *   pieces. What comes back is already a tangent-space map in the texture's
 *   own layout.
 * - `views`: the model is drawn as a whole figure from several directions,
 *   the way a sprite is, each picture goes to PixelLab, and the normals that
 *   come back are carried onto the texture through the model's surface: each
 *   texel takes them from the views that see it, weighted by how squarely.
 *   Sprites of the same figure can stand in for the drawn views.
 *
 * Either way PixelLab is asked for surface detail only (outline rounding and
 * part shapes at 0): the mesh already has its shape, and rounding the edge of
 * every piece of an unwrap would put a ridge along every seam. The detail is
 * blended onto the normal map the model already has, so relief baked from the
 * high-detail mesh is kept; `replace` writes PixelLab's detail alone.
 *
 * Nothing here talks to PixelLab: the caller hands in a function that turns a
 * picture into its normal map, so tests and dry runs need no key.
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { NormalMapKind, NormalMapMode, PixelLabClient } from "../client.ts"
import { normalMapBytes, normalMapCost } from "../pixellab-utils.ts"
import { decodeJpeg } from "../jpeg.ts"
import { decodePng, encodeRgbaPng } from "../png.ts"
import { describeGlb, glbImageBytes, imageInfo, parseGlb, readAccessor, type GlbDocument, type GltfNode } from "../glb.ts"
import { readModelCompanion, saveModelTexture, type ModelEditResult, type ProjectModel } from "./model-edit.ts"

export const MODEL_NORMAL_SOURCES = ["texture", "views", "sprites"] as const
export type ModelNormalSource = (typeof MODEL_NORMAL_SOURCES)[number]

/** PixelLab's largest side for `/normal-map`. */
export const TILE_MAX = 512

export interface Raster {
  width: number
  height: number
  /** RGBA, row-major. */
  pixels: Uint8Array
}

export function decodeImage(bytes: Uint8Array): Raster {
  const info = imageInfo(bytes)
  if (!info) throw new Error("the image is neither PNG nor JPEG")
  if (info.mimeType === "image/png") {
    const png = decodePng(Buffer.from(bytes))
    return { width: png.width, height: png.height, pixels: png.pixels }
  }
  return decodeJpeg(bytes)
}

export function encodeImage(raster: Raster): Buffer {
  return encodeRgbaPng(raster.width, raster.height, Buffer.from(raster.pixels))
}

/** Nearest-neighbour resample; enough for lining a base colour texture up with a normal map of another size. */
export function resample(source: Raster, width: number, height: number): Raster {
  if (source.width === width && source.height === height) return source
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(source.height - 1, Math.floor(((y + 0.5) * source.height) / height))
    for (let x = 0; x < width; x++) {
      const sx = Math.min(source.width - 1, Math.floor(((x + 0.5) * source.width) / width))
      pixels.set(source.pixels.subarray((sy * source.width + sx) * 4, (sy * source.width + sx) * 4 + 4), (y * width + x) * 4)
    }
  }
  return { width, height, pixels }
}

// ---- the model at rest, in world space

type Mat4 = Float64Array

const identity = (): Mat4 => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16)
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[column * 4 + k]!
      out[column * 4 + row] = sum
    }
  }
  return out
}

function localMatrix(node: GltfNode): Mat4 {
  if (node.matrix?.length === 16) return Float64Array.from(node.matrix)
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  const x = qx!, y = qy!, z = qz!, w = qw!
  return Float64Array.from([
    (1 - 2 * (y * y + z * z)) * sx!, 2 * (x * y + z * w) * sx!, 2 * (x * z - y * w) * sx!, 0,
    2 * (x * y - z * w) * sy!, (1 - 2 * (x * x + z * z)) * sy!, 2 * (y * z + x * w) * sy!, 0,
    2 * (x * z + y * w) * sz!, 2 * (y * z - x * w) * sz!, (1 - 2 * (x * x + y * y)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ])
}

function worldMatrices(document: GlbDocument, posed: Map<number, GltfNode> = new Map()): Mat4[] {
  const nodes = document.json.nodes ?? []
  const parentOf = new Map<number, number>()
  nodes.forEach((node, index) => node.children?.forEach((child) => parentOf.set(child, index)))
  const world: Array<Mat4 | undefined> = []
  const resolve = (index: number, depth = 0): Mat4 => {
    const known = world[index]
    if (known) return known
    const parent = parentOf.get(index)
    const local = localMatrix(posed.get(index) ?? nodes[index]!)
    const matrix = parent === undefined || depth > nodes.length ? local : multiply(resolve(parent, depth + 1), local)
    world[index] = matrix
    return matrix
  }
  return nodes.map((_, index) => resolve(index))
}

/** A moment of one of the model's animations to pose it in: by name or index, and seconds from its start. */
export interface ModelPose {
  animation: string | number
  time: number
}

/** "Idle Loop" or "Idle Loop@0.5" or "3": a pose as written on the command line. */
export function parsePose(text: string): ModelPose {
  const at = text.lastIndexOf("@")
  const name = at >= 0 ? text.slice(0, at) : text
  const time = at >= 0 ? Number(text.slice(at + 1)) : 0
  if (!name.trim() || !Number.isFinite(time) || time < 0) throw new Error(`"${text}" is not a pose: give an animation's name or index, and optionally @seconds`)
  return { animation: /^\d+$/.test(name.trim()) ? Number(name.trim()) : name.trim(), time }
}

/**
 * The model's nodes at a moment of an animation: each animated translation,
 * rotation, and scale sampled at `time` (clamped to the clip), linearly, with
 * rotations blended and normalised; a cubic spline key's value is used as is.
 */
/** Names compared without case, spaces, underscores, or hyphens: "Idle Loop" finds "Idle_Loop". */
const loose = (name: string) => name.toLowerCase().replace(/[\s_-]+/g, "")

function poseNodes(document: GlbDocument, pose: ModelPose): Map<number, GltfNode> {
  const animations = document.json.animations ?? []
  const index = typeof pose.animation === "number"
    ? pose.animation
    : animations.findIndex((animation) => loose(animation.name ?? "") === loose(String(pose.animation)))
  const animation = animations[index]
  if (!animation) {
    const names = animations.map((entry, at) => entry.name ?? String(at)).join(", ") || "none"
    throw new Error(`the model has no animation "${pose.animation}"; it has: ${names}`)
  }
  const posed = new Map<number, GltfNode>()
  for (const channel of animation.channels) {
    const node = channel.target.node
    const path = channel.target.path
    if (node === undefined || !["translation", "rotation", "scale"].includes(path)) continue
    const sampler = animation.samplers[channel.sampler]
    if (!sampler) continue
    const times = readAccessor(document, sampler.input).data
    const values = readAccessor(document, sampler.output)
    const width = path === "rotation" ? 4 : 3
    const cubic = sampler.interpolation === "CUBICSPLINE"
    const valueAt = (key: number) => Array.from(values.data.subarray((cubic ? key * 3 + 1 : key) * width, (cubic ? key * 3 + 1 : key) * width + width))
    const last = times.length - 1
    const time = Math.min(Math.max(pose.time, times[0] ?? 0), times[last] ?? 0)
    let key = 0
    while (key < last && times[key + 1]! <= time) key++
    let value = valueAt(key)
    if (key < last && sampler.interpolation !== "STEP" && !cubic) {
      const span = times[key + 1]! - times[key]!
      const f = span > 0 ? (time - times[key]!) / span : 0
      const next = valueAt(key + 1)
      const sign = path === "rotation" && value.reduce((sum, v, k) => sum + v * next[k]!, 0) < 0 ? -1 : 1
      value = value.map((v, k) => v * (1 - f) + next[k]! * sign * f)
    }
    if (path === "rotation") {
      const length = Math.hypot(...value) || 1
      value = value.map((v) => v / length)
    }
    const base = posed.get(node) ?? { ...(document.json.nodes?.[node] ?? {}) }
    if (base.matrix) delete base.matrix
    base[path] = value
    posed.set(node, base)
  }
  return posed
}

/** One drawn primitive at rest: world-space positions, normals, and tangents, plus what it needs from its material. */
export interface RestPrimitive {
  material: number | null
  positions: Float64Array
  normals: Float64Array
  /** xyz and handedness per vertex; computed from the texture coordinates when the file has none. */
  tangents: Float64Array
  indices: Uint32Array
  /** TEXCOORD_n by set. */
  uv: Array<Float32Array | null>
}

/** Every mesh primitive of the model in its rest pose, or at a moment of an animation: skinned meshes by their joints, others by their node's transform. */
export function restPrimitives(document: GlbDocument, pose?: ModelPose): RestPrimitive[] {
  const json = document.json
  const world = worldMatrices(document, pose ? poseNodes(document, pose) : undefined)
  const out: RestPrimitive[] = []
  for (const [nodeIndex, node] of (json.nodes ?? []).entries()) {
    if (typeof node.mesh !== "number") continue
    const mesh = json.meshes?.[node.mesh]
    if (!mesh) continue
    const skin = typeof node.skin === "number" ? json.skins?.[node.skin] : undefined
    let jointMatrices: Mat4[] | null = null
    if (skin) {
      const inverse = typeof skin.inverseBindMatrices === "number" ? readAccessor(document, skin.inverseBindMatrices) : null
      jointMatrices = skin.joints.map((joint, slot) => {
        const bind = inverse ? Float64Array.from(inverse.data.subarray(slot * 16, slot * 16 + 16)) : identity()
        return multiply(world[joint] ?? identity(), bind)
      })
    }
    for (const primitive of mesh.primitives) {
      if ((primitive.mode ?? 4) !== 4 || typeof primitive.attributes.POSITION !== "number") continue
      const position = readAccessor(document, primitive.attributes.POSITION)
      const count = position.count
      const normal = typeof primitive.attributes.NORMAL === "number" ? readAccessor(document, primitive.attributes.NORMAL) : null
      const tangent = typeof primitive.attributes.TANGENT === "number" ? readAccessor(document, primitive.attributes.TANGENT) : null
      const joints = typeof primitive.attributes.JOINTS_0 === "number" ? readAccessor(document, primitive.attributes.JOINTS_0) : null
      const weights = typeof primitive.attributes.WEIGHTS_0 === "number" ? readAccessor(document, primitive.attributes.WEIGHTS_0) : null
      const indices = typeof primitive.indices === "number"
        ? Uint32Array.from(readAccessor(document, primitive.indices).data)
        : Uint32Array.from({ length: count }, (_, index) => index)
      const uv: Array<Float32Array | null> = []
      for (let set = 0; set < 4; set++) {
        const accessor = primitive.attributes[`TEXCOORD_${set}`]
        uv.push(typeof accessor === "number" ? readAccessor(document, accessor).data as Float32Array : null)
      }
      const positions = new Float64Array(count * 3)
      const normals = new Float64Array(count * 3)
      const tangents = new Float64Array(count * 4)
      const blended = new Float64Array(16)
      for (let vertex = 0; vertex < count; vertex++) {
        let matrix: Mat4 = world[nodeIndex]!
        if (jointMatrices && joints && weights) {
          blended.fill(0)
          let total = 0
          for (let slot = 0; slot < Math.min(joints.size, weights.size); slot++) {
            const weight = weights.data[vertex * weights.size + slot]!
            const joint = jointMatrices[joints.data[vertex * joints.size + slot]!]
            if (!(weight > 0) || !joint) continue
            total += weight
            for (let k = 0; k < 16; k++) blended[k]! += joint[k]! * weight
          }
          if (total > 0) {
            for (let k = 0; k < 16; k++) blended[k]! /= total
            matrix = blended
          }
        }
        const px = position.data[vertex * 3]!, py = position.data[vertex * 3 + 1]!, pz = position.data[vertex * 3 + 2]!
        for (let axis = 0; axis < 3; axis++) {
          positions[vertex * 3 + axis] = matrix[axis]! * px + matrix[4 + axis]! * py + matrix[8 + axis]! * pz + matrix[12 + axis]!
        }
        if (normal) {
          const nx = normal.data[vertex * 3]!, ny = normal.data[vertex * 3 + 1]!, nz = normal.data[vertex * 3 + 2]!
          const n = [0, 1, 2].map((axis) => matrix[axis]! * nx + matrix[4 + axis]! * ny + matrix[8 + axis]! * nz)
          const length = Math.hypot(n[0]!, n[1]!, n[2]!) || 1
          for (let axis = 0; axis < 3; axis++) normals[vertex * 3 + axis] = n[axis]! / length
        }
        if (tangent) {
          const tx = tangent.data[vertex * 4]!, ty = tangent.data[vertex * 4 + 1]!, tz = tangent.data[vertex * 4 + 2]!
          const t = [0, 1, 2].map((axis) => matrix[axis]! * tx + matrix[4 + axis]! * ty + matrix[8 + axis]! * tz)
          const length = Math.hypot(t[0]!, t[1]!, t[2]!) || 1
          for (let axis = 0; axis < 3; axis++) tangents[vertex * 4 + axis] = t[axis]! / length
          tangents[vertex * 4 + 3] = tangent.data[vertex * 4 + 3]! < 0 ? -1 : 1
        }
      }
      const restPrimitive: RestPrimitive = { material: primitive.material ?? null, positions, normals, tangents, indices, uv }
      if (!normal) faceNormals(restPrimitive)
      out.push(restPrimitive)
    }
  }
  return out
}

function faceNormals(primitive: RestPrimitive) {
  const { positions: p, normals, indices } = primitive
  for (let at = 0; at + 2 < indices.length; at += 3) {
    const [a, b, c] = [indices[at]!, indices[at + 1]!, indices[at + 2]!]
    const e1 = [0, 1, 2].map((k) => p[b * 3 + k]! - p[a * 3 + k]!)
    const e2 = [0, 1, 2].map((k) => p[c * 3 + k]! - p[a * 3 + k]!)
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
    for (const vertex of [a, b, c]) for (let k = 0; k < 3; k++) normals[vertex * 3 + k]! += n[k]!
  }
  for (let vertex = 0; vertex < normals.length / 3; vertex++) {
    const length = Math.hypot(normals[vertex * 3]!, normals[vertex * 3 + 1]!, normals[vertex * 3 + 2]!) || 1
    for (let k = 0; k < 3; k++) normals[vertex * 3 + k]! /= length
  }
}

/** Tangents from the texture coordinates of `set`, for a primitive whose file has none (Lengyel's method). */
function fillTangents(primitive: RestPrimitive, set: number) {
  const uv = primitive.uv[set]
  const { positions: p, normals: n, tangents, indices } = primitive
  if (!uv || tangents.some((value) => value !== 0)) return
  const count = p.length / 3
  const tan = new Float64Array(count * 3)
  const bit = new Float64Array(count * 3)
  for (let at = 0; at + 2 < indices.length; at += 3) {
    const [a, b, c] = [indices[at]!, indices[at + 1]!, indices[at + 2]!]
    const e1 = [0, 1, 2].map((k) => p[b * 3 + k]! - p[a * 3 + k]!)
    const e2 = [0, 1, 2].map((k) => p[c * 3 + k]! - p[a * 3 + k]!)
    const du1 = uv[b * 2]! - uv[a * 2]!, dv1 = uv[b * 2 + 1]! - uv[a * 2 + 1]!
    const du2 = uv[c * 2]! - uv[a * 2]!, dv2 = uv[c * 2 + 1]! - uv[a * 2 + 1]!
    const det = du1 * dv2 - du2 * dv1
    if (Math.abs(det) < 1e-12) continue
    const r = 1 / det
    for (const vertex of [a, b, c]) {
      for (let k = 0; k < 3; k++) {
        tan[vertex * 3 + k]! += (e1[k]! * dv2 - e2[k]! * dv1) * r
        // glTF's v runs down the image, so the bitangent that points "up" the image is -dP/dv.
        bit[vertex * 3 + k]! += (e2[k]! * du1 - e1[k]! * du2) * r
      }
    }
  }
  for (let vertex = 0; vertex < count; vertex++) {
    const nx = n[vertex * 3]!, ny = n[vertex * 3 + 1]!, nz = n[vertex * 3 + 2]!
    let tx = tan[vertex * 3]!, ty = tan[vertex * 3 + 1]!, tz = tan[vertex * 3 + 2]!
    const dot = tx * nx + ty * ny + tz * nz
    tx -= nx * dot; ty -= ny * dot; tz -= nz * dot
    const length = Math.hypot(tx, ty, tz)
    if (!(length > 1e-12)) continue
    tangents[vertex * 4] = tx / length
    tangents[vertex * 4 + 1] = ty / length
    tangents[vertex * 4 + 2] = tz / length
    // glTF's bitangent is cross(N, T) * w, pointing up the image (towards smaller v).
    const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx
    const up = -(cx * bit[vertex * 3]! + cy * bit[vertex * 3 + 1]! + cz * bit[vertex * 3 + 2]!)
    tangents[vertex * 4 + 3] = up < 0 ? -1 : 1
  }
}

// ---- the surface under each texel of a texture

/** Where each texel of a texture lies on the model: position and tangent frame, for the texels any triangle covers. */
export interface TexelSurface {
  width: number
  height: number
  covered: Uint8Array
  position: Float32Array
  normal: Float32Array
  tangent: Float32Array
  bitangent: Float32Array
}

const textureSource = (document: GlbDocument, texture: number | undefined) =>
  typeof texture === "number" ? document.json.textures?.[texture]?.source ?? null : null

/** The materials whose normal map is this image, with the texture coordinate set each reads it through. */
export function materialsWithNormalImage(document: GlbDocument, image: number): Array<{ material: number; texCoord: number }> {
  return (document.json.materials ?? []).flatMap((material, index) =>
    material.normalTexture && textureSource(document, material.normalTexture.index) === image
      ? [{ material: index, texCoord: material.normalTexture.texCoord ?? 0 }]
      : [])
}

/** The image a material's base colour comes from, with its texture coordinate set; null for a flat colour. */
export function baseColourOf(document: GlbDocument, material: number): { image: number; texCoord: number } | null {
  const info = document.json.materials?.[material]?.pbrMetallicRoughness?.baseColorTexture
  const image = textureSource(document, info?.index)
  return image === null || !info ? null : { image, texCoord: info.texCoord ?? 0 }
}

export function texelSurface(primitives: RestPrimitive[], document: GlbDocument, image: number, width: number, height: number): TexelSurface {
  const users = materialsWithNormalImage(document, image)
  const surface: TexelSurface = {
    width,
    height,
    covered: new Uint8Array(width * height),
    position: new Float32Array(width * height * 3),
    normal: new Float32Array(width * height * 3),
    tangent: new Float32Array(width * height * 3),
    bitangent: new Float32Array(width * height * 3),
  }
  for (const primitive of primitives) {
    const use = users.find((entry) => entry.material === primitive.material)
    if (!use) continue
    const uv = primitive.uv[use.texCoord]
    if (!uv) continue
    fillTangents(primitive, use.texCoord)
    const { positions: p, normals: n, tangents: t, indices } = primitive
    for (let at = 0; at + 2 < indices.length; at += 3) {
      const corners = [indices[at]!, indices[at + 1]!, indices[at + 2]!]
      const xs = corners.map((c) => uv[c * 2]! * width)
      const ys = corners.map((c) => uv[c * 2 + 1]! * height)
      const den = (ys[1]! - ys[2]!) * (xs[0]! - xs[2]!) + (xs[2]! - xs[1]!) * (ys[0]! - ys[2]!)
      if (Math.abs(den) < 1e-12) continue
      const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)))
      const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)))
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5
          const l0 = ((ys[1]! - ys[2]!) * (px - xs[2]!) + (xs[2]! - xs[1]!) * (py - ys[2]!)) / den
          const l1 = ((ys[2]! - ys[0]!) * (px - xs[2]!) + (xs[0]! - xs[2]!) * (py - ys[2]!)) / den
          const l2 = 1 - l0 - l1
          if (l0 < -1e-4 || l1 < -1e-4 || l2 < -1e-4) continue
          const texel = y * width + x
          surface.covered[texel] = 1
          const weights = [l0, l1, l2]
          const nrm = [0, 0, 0], tan = [0, 0, 0], pos = [0, 0, 0]
          let handed = 0
          corners.forEach((c, k) => {
            for (let axis = 0; axis < 3; axis++) {
              pos[axis]! += p[c * 3 + axis]! * weights[k]!
              nrm[axis]! += n[c * 3 + axis]! * weights[k]!
              tan[axis]! += t[c * 4 + axis]! * weights[k]!
            }
            handed += t[c * 4 + 3]! * weights[k]!
          })
          const nl = Math.hypot(nrm[0]!, nrm[1]!, nrm[2]!) || 1
          for (let axis = 0; axis < 3; axis++) nrm[axis]! /= nl
          const dot = tan[0]! * nrm[0]! + tan[1]! * nrm[1]! + tan[2]! * nrm[2]!
          for (let axis = 0; axis < 3; axis++) tan[axis]! -= nrm[axis]! * dot
          const tl = Math.hypot(tan[0]!, tan[1]!, tan[2]!) || 1
          for (let axis = 0; axis < 3; axis++) tan[axis]! /= tl
          const sign = handed < 0 ? -1 : 1
          const bit = [
            (nrm[1]! * tan[2]! - nrm[2]! * tan[1]!) * sign,
            (nrm[2]! * tan[0]! - nrm[0]! * tan[2]!) * sign,
            (nrm[0]! * tan[1]! - nrm[1]! * tan[0]!) * sign,
          ]
          surface.position.set(pos, texel * 3)
          surface.normal.set(nrm, texel * 3)
          surface.tangent.set(tan, texel * 3)
          surface.bitangent.set(bit, texel * 3)
        }
      }
    }
  }
  return surface
}

// ---- detail fields: a tangent-space normal per texel, with how sure it is

export interface DetailField {
  width: number
  height: number
  /** Tangent-space x, y, z per texel; (0, 0, 1) where there is no detail. */
  normal: Float32Array
  /** 0 where nothing was learnt, up to 1. */
  weight: Float32Array
}

const decodeNormal = (pixels: Uint8Array, at: number): [number, number, number] => {
  const x = pixels[at]! / 127.5 - 1, y = pixels[at + 1]! / 127.5 - 1, z = pixels[at + 2]! / 127.5 - 1
  const length = Math.hypot(x, y, z) || 1
  return [x / length, y / length, z / length]
}

// ---- source 1: the texture itself, in tiles

export interface Tile {
  x: number
  y: number
  width: number
  height: number
  png: Buffer
}

/**
 * The base colour texture at the normal map's size, transparent outside the
 * unwrap's pieces (grown by a texel so edges are not read as outline), cut
 * into tiles PixelLab accepts. Tiles with nothing on them are left out.
 */
export function textureTiles(base: Raster, surface: TexelSurface): Tile[] {
  const { width, height } = surface
  const colour = resample(base, width, height)
  const mask = grow(surface.covered, width, height, 1)
  const tiles: Tile[] = []
  const across = Math.ceil(width / TILE_MAX), down = Math.ceil(height / TILE_MAX)
  const tileWidth = Math.ceil(width / across), tileHeight = Math.ceil(height / down)
  for (let ty = 0; ty < down; ty++) {
    for (let tx = 0; tx < across; tx++) {
      const x = tx * tileWidth, y = ty * tileHeight
      const w = Math.min(tileWidth, width - x), h = Math.min(tileHeight, height - y)
      const pixels = new Uint8Array(w * h * 4)
      let any = false
      for (let row = 0; row < h; row++) {
        for (let column = 0; column < w; column++) {
          const texel = (y + row) * width + x + column
          if (!mask[texel]) continue
          any = true
          const at = (row * w + column) * 4
          pixels.set(colour.pixels.subarray(texel * 4, texel * 4 + 3), at)
          pixels[at + 3] = 255
        }
      }
      if (any) tiles.push({ x, y, width: w, height: h, png: encodeImage({ width: w, height: h, pixels }) })
    }
  }
  return tiles
}

/** PixelLab's maps of the tiles, laid back into the texture: already in its tangent space. */
export function detailFromTiles(surface: TexelSurface, tiles: Tile[], maps: Buffer[]): DetailField {
  const { width, height } = surface
  const field = emptyField(width, height)
  tiles.forEach((tile, index) => {
    const map = resample(decodeImage(maps[index]!), tile.width, tile.height)
    for (let row = 0; row < tile.height; row++) {
      for (let column = 0; column < tile.width; column++) {
        const texel = (tile.y + row) * width + tile.x + column
        const at = (row * tile.width + column) * 4
        if (!surface.covered[texel] || map.pixels[at + 3]! < 128) continue
        field.normal.set(decodeNormal(map.pixels, at), texel * 3)
        field.weight[texel] = 1
      }
    }
  })
  return field
}

// ---- source 2: the whole figure, drawn from around it or as sprites drew it

export interface ViewCamera {
  /** Degrees about the up axis: 0 sees the front (+Z), 90 has the figure facing the picture's right. */
  turn: number
  /** Degrees the camera is raised, looking down: 0 is level; a "low top-down" sprite is about 20 to 30. */
  tilt: number
  width: number
  height: number
  /** Picture pixels per model unit. */
  scale: number
  /** The model point, in the camera's right and up, that lands at (offsetX, offsetY). */
  centreX: number
  centreY: number
  offsetX: number
  offsetY: number
}

export interface DrawnView {
  camera: ViewCamera
  png: Buffer
  /** Nearness of the surface at each pixel, for telling what a view can see; -Infinity where empty. */
  depth: Float32Array
  /** For a sprite: the pixels whose normals may be used (where sprite and model agree); all when absent. */
  use?: Uint8Array
}

/** The usual eight directions, by sprite name. */
export const VIEW_TURNS: Record<string, number> = {
  south: 0, "south-east": 45, east: 90, "north-east": 135, north: 180, "north-west": 225, west: 270, "south-west": 315,
}

interface Basis { right: number[]; up: number[]; toward: number[] }

/** The camera's right, up, and towards-the-viewer as directions in the model's frame. */
function basisOf(turn: number, tilt: number): Basis {
  const t = (turn * Math.PI) / 180, e = (tilt * Math.PI) / 180
  const level = [-Math.sin(t), 0, Math.cos(t)]
  return {
    right: [Math.cos(t), 0, Math.sin(t)],
    up: [-level[0]! * Math.sin(e), Math.cos(e), -level[2]! * Math.sin(e)],
    toward: [level[0]! * Math.cos(e), Math.sin(e), level[2]! * Math.cos(e)],
  }
}

const dot = (v: number[], x: number, y: number, z: number) => v[0]! * x + v[1]! * y + v[2]! * z

function project(camera: ViewCamera, basis: Basis, x: number, y: number, z: number): [number, number, number] {
  return [
    (dot(basis.right, x, y, z) - camera.centreX) * camera.scale + camera.offsetX,
    camera.offsetY - (dot(basis.up, x, y, z) - camera.centreY) * camera.scale,
    dot(basis.toward, x, y, z),
  ]
}

function extent(primitives: RestPrimitive[], basis: Basis) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const primitive of primitives) {
    const p = primitive.positions
    for (let vertex = 0; vertex < p.length / 3; vertex++) {
      const x = dot(basis.right, p[vertex * 3]!, p[vertex * 3 + 1]!, p[vertex * 3 + 2]!)
      const y = dot(basis.up, p[vertex * 3]!, p[vertex * 3 + 1]!, p[vertex * 3 + 2]!)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
  }
  return { minX, maxX, minY, maxY }
}

/** The camera that frames the whole model in a square picture of `size`, with a margin. */
export function frameView(primitives: RestPrimitive[], turn: number, size: number, tilt = 0): ViewCamera {
  const { minX, maxX, minY, maxY } = extent(primitives, basisOf(turn, tilt))
  const margin = Math.max(2, Math.round(size * 0.03))
  const scale = (size - 2 * margin) / Math.max(maxX - minX, maxY - minY, 1e-9)
  return { turn, tilt, width: size, height: size, scale, centreX: (minX + maxX) / 2, centreY: (minY + maxY) / 2, offsetX: size / 2, offsetY: size / 2 }
}

/**
 * Draw the model from one direction with its base colour textures, unlit and
 * nearest-sampled, on a transparent ground: a picture PixelLab reads like a
 * sprite. Returns the picture and the depth of every pixel.
 */
export function drawView(document: GlbDocument, primitives: RestPrimitive[], camera: ViewCamera, textures: Map<number, Raster>): DrawnView {
  const { width, height } = camera
  const basis = basisOf(camera.turn, camera.tilt)
  const pixels = new Uint8Array(width * height * 4)
  const depth = new Float32Array(width * height).fill(-Infinity)
  for (const primitive of primitives) {
    const base = primitive.material === null ? null : baseColourOf(document, primitive.material)
    const texture = base ? textures.get(base.image) ?? null : null
    const uv = base ? primitive.uv[base.texCoord] : null
    const factor = (primitive.material === null ? undefined : document.json.materials?.[primitive.material]?.pbrMetallicRoughness?.baseColorFactor) as number[] | undefined
    const flat = [0, 1, 2].map((k) => Math.round(255 * Math.min(1, Math.max(0, Math.pow(factor?.[k] ?? 0.8, 1 / 2.2)))))
    const { positions: p, indices } = primitive
    for (let at = 0; at + 2 < indices.length; at += 3) {
      const corners = [indices[at]!, indices[at + 1]!, indices[at + 2]!]
      const [a, b, c] = corners.map((corner) => project(camera, basis, p[corner * 3]!, p[corner * 3 + 1]!, p[corner * 3 + 2]!)) as unknown as [number[], number[], number[]]
      const den = (b[1]! - c[1]!) * (a[0]! - c[0]!) + (c[0]! - b[0]!) * (a[1]! - c[1]!)
      if (Math.abs(den) < 1e-12) continue
      const x0 = Math.max(0, Math.floor(Math.min(a[0]!, b[0]!, c[0]!))), x1 = Math.min(width - 1, Math.ceil(Math.max(a[0]!, b[0]!, c[0]!)))
      const y0 = Math.max(0, Math.floor(Math.min(a[1]!, b[1]!, c[1]!))), y1 = Math.min(height - 1, Math.ceil(Math.max(a[1]!, b[1]!, c[1]!)))
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5
          const l0 = ((b[1]! - c[1]!) * (px - c[0]!) + (c[0]! - b[0]!) * (py - c[1]!)) / den
          const l1 = ((c[1]! - a[1]!) * (px - c[0]!) + (a[0]! - c[0]!) * (py - c[1]!)) / den
          const l2 = 1 - l0 - l1
          if (l0 < 0 || l1 < 0 || l2 < 0) continue
          const z = l0 * a[2]! + l1 * b[2]! + l2 * c[2]!
          const at = y * width + x
          if (z <= depth[at]!) continue
          depth[at] = z
          let rgb = flat
          if (texture && uv) {
            const u = l0 * uv[corners[0]! * 2]! + l1 * uv[corners[1]! * 2]! + l2 * uv[corners[2]! * 2]!
            const v = l0 * uv[corners[0]! * 2 + 1]! + l1 * uv[corners[1]! * 2 + 1]! + l2 * uv[corners[2]! * 2 + 1]!
            const tx = Math.min(texture.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * texture.width)))
            const ty = Math.min(texture.height - 1, Math.max(0, Math.floor((v - Math.floor(v)) * texture.height)))
            const from = (ty * texture.width + tx) * 4
            rgb = [texture.pixels[from]!, texture.pixels[from + 1]!, texture.pixels[from + 2]!]
          }
          pixels[at * 4] = rgb[0]!
          pixels[at * 4 + 1] = rgb[1]!
          pixels[at * 4 + 2] = rgb[2]!
          pixels[at * 4 + 3] = 255
        }
      }
    }
  }
  return { camera, png: encodeImage({ width, height, pixels }), depth }
}

/** Every distinct base colour image the model uses, decoded. */
export function baseColourTextures(document: GlbDocument): Map<number, Raster> {
  const textures = new Map<number, Raster>()
  for (const index of (document.json.materials ?? []).keys()) {
    const base = baseColourOf(document, index)
    if (!base || textures.has(base.image)) continue
    textures.set(base.image, decodeImage(glbImageBytes(document, base.image).bytes))
  }
  return textures
}

export interface SpriteFit {
  camera: ViewCamera
  /** How much the model's outline and the sprite's agree: shared pixels over either's, 0 to 1. */
  overlap: number
  /** Of the sprite's pixels, the share where the model is drawn in a matching colour, 0 to 1. */
  agreement: number
  /** The model drawn with its textures from the fitted camera, and which of its pixels match the sprite. */
  drawn: DrawnView
}

/** The tilts tried when fitting a sprite: level, and raised in steps to a steep top-down. */
export const FIT_TILTS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45]
const FIT_SCALES = [0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15]
const FIT_SHIFT = 4
/** How far apart two colours may be (RGB distance) and still count as the same paint. */
export const AGREE_DISTANCE = 60

/**
 * Line the model up with a sprite drawn from `turn`. For each camera tilt and
 * a few scales around "the model's height is the sprite's", with the outlines'
 * boxes centred and then shifted a few pixels each way, the model is drawn in
 * its own colours and compared with the sprite pixel by pixel; the camera
 * where the most sprite pixels are matched by the same paint wins. Matching
 * colour, not outline, is what decides, since the texture was painted from
 * art like this and a sprite's proportions (a big head, arms held otherwise)
 * rarely match a mesh's. The returned `drawn.use` marks the pixels whose
 * colours agree: only those carry the sprite's normals onto the model.
 */
export function fitSprite(document: GlbDocument, primitives: RestPrimitive[], sprite: Raster, turn: number, textures: Map<number, Raster> = baseColourTextures(document), tilts = FIT_TILTS): SpriteFit {
  const { width, height } = sprite
  let sx0 = Infinity, sx1 = -Infinity, sy0 = Infinity, sy1 = -Infinity
  let opaque = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (sprite.pixels[(y * width + x) * 4 + 3]! < 128) continue
      opaque++
      sx0 = Math.min(sx0, x); sx1 = Math.max(sx1, x + 1); sy0 = Math.min(sy0, y); sy1 = Math.max(sy1, y + 1)
    }
  }
  if (!opaque) throw new Error("the sprite has no opaque pixels; its alpha must mark the figure")
  const agrees = (model: Uint8Array, at: number, from: number) => {
    if (sprite.pixels[at * 4 + 3]! < 128 || model[from * 4 + 3]! < 128) return false
    return Math.hypot(sprite.pixels[at * 4]! - model[from * 4]!, sprite.pixels[at * 4 + 1]! - model[from * 4 + 1]!, sprite.pixels[at * 4 + 2]! - model[from * 4 + 2]!) < AGREE_DISTANCE
  }
  let best: { camera: ViewCamera; score: number } | null = null
  for (const tilt of tilts) {
    const { minX, maxX, minY, maxY } = extent(primitives, basisOf(turn, tilt))
    for (const factor of FIT_SCALES) {
      const camera: ViewCamera = {
        turn, tilt, width, height, scale: factor * (sy1 - sy0) / Math.max(maxY - minY, 1e-9),
        centreX: (minX + maxX) / 2, centreY: (minY + maxY) / 2, offsetX: (sx0 + sx1) / 2, offsetY: (sy0 + sy1) / 2,
      }
      const model = decodeImage(drawView(document, primitives, camera, textures).png).pixels
      for (let dy = -FIT_SHIFT; dy <= FIT_SHIFT; dy++) {
        for (let dx = -FIT_SHIFT; dx <= FIT_SHIFT; dx++) {
          let score = 0
          for (let y = Math.max(0, dy); y < Math.min(height, height + dy); y++) {
            for (let x = Math.max(0, dx); x < Math.min(width, width + dx); x++) {
              if (agrees(model, y * width + x, (y - dy) * width + x - dx)) score++
            }
          }
          if (!best || score > best.score) best = { camera: { ...camera, offsetX: camera.offsetX + dx, offsetY: camera.offsetY + dy }, score }
        }
      }
    }
  }
  const camera = best!.camera
  const drawn = drawView(document, primitives, camera, textures)
  const model = decodeImage(drawn.png).pixels
  const use = new Uint8Array(width * height)
  let both = 0, either = 0
  for (let at = 0; at < width * height; at++) {
    const inModel = model[at * 4 + 3]! >= 128, inSprite = sprite.pixels[at * 4 + 3]! >= 128
    if (inModel && inSprite) both++
    if (inModel || inSprite) either++
    if (agrees(model, at, at)) use[at] = 1
  }
  drawn.use = use
  return { camera, overlap: either ? both / either : 0, agreement: best!.score / opaque, drawn }
}

/**
 * The sprite with the model's outline over it in red and the pixels that will
 * not be used dimmed, for seeing how well a fit lined up.
 */
function fitPicture(sprite: Raster, drawn: DrawnView): Buffer {
  const { width, height } = sprite
  const pixels = Uint8Array.from(sprite.pixels)
  if (drawn.use) {
    for (let at = 0; at < width * height; at++) {
      if (drawn.use[at]) continue
      for (let k = 0; k < 3; k++) pixels[at * 4 + k] = Math.round(pixels[at * 4 + k]! * 0.3)
    }
  }
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && drawn.depth[y * width + x] !== -Infinity
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inside(x, y) || (inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1))) continue
      pixels.set([255, 40, 40, 255], (y * width + x) * 4)
    }
  }
  return encodeImage({ width, height, pixels })
}

/**
 * Carry PixelLab's maps of the views onto a texture. A texel takes a view's
 * normal when the view sees it (its depth matches what the model drew there)
 * and faces it, weighted by how squarely to the power `power`. A view's normal
 * is in picture space (right, up, towards the viewer); its sideways part is
 * turned into the texel's tangent frame, so what is carried is the detail, not
 * the facing of the view.
 */
export function detailFromViews(surface: TexelSurface, views: DrawnView[], maps: Buffer[], opts: { power?: number } = {}): DetailField {
  const power = opts.power ?? 4
  const { width, height } = surface
  const field = emptyField(width, height)
  const decoded = views.map((view, index) => resample(decodeImage(maps[index]!), view.camera.width, view.camera.height))
  const bases = views.map((view) => basisOf(view.camera.turn, view.camera.tilt))
  const sum = new Float64Array(width * height * 3)
  for (let texel = 0; texel < width * height; texel++) {
    if (!surface.covered[texel]) continue
    const px = surface.position[texel * 3]!, py = surface.position[texel * 3 + 1]!, pz = surface.position[texel * 3 + 2]!
    const nx = surface.normal[texel * 3]!, ny = surface.normal[texel * 3 + 1]!, nz = surface.normal[texel * 3 + 2]!
    let total = 0
    views.forEach((view, index) => {
      const { camera } = view
      const basis = bases[index]!
      const facing = dot(basis.toward, nx, ny, nz)
      if (facing < 0.15) return
      const [sx, sy, z] = project(camera, basis, px, py, pz)
      const ix = Math.floor(sx), iy = Math.floor(sy)
      if (ix < 0 || iy < 0 || ix >= camera.width || iy >= camera.height) return
      // Seen when nothing drawn in front is more than a pixel and a half nearer.
      if (view.depth[iy * camera.width + ix]! - z > 1.5 / camera.scale) return
      if (view.use && !view.use[iy * camera.width + ix]) return
      const map = decoded[index]!
      if (map.pixels[(iy * camera.width + ix) * 4 + 3]! < 128) return
      // Bilinear over the neighbouring pixels that may be used, so a small
      // picture's normals blend across the texels each of its pixels covers.
      const fx = sx - 0.5, fy = sy - 0.5
      const bx = Math.floor(fx), by = Math.floor(fy)
      let mx = 0, my = 0, mz = 0, mw = 0
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const qx = bx + ox, qy = by + oy
        if (qx < 0 || qy < 0 || qx >= camera.width || qy >= camera.height) continue
        const q = qy * camera.width + qx
        if (map.pixels[q * 4 + 3]! < 128 || (view.use && !view.use[q])) continue
        const w = (ox ? fx - bx : 1 - (fx - bx)) * (oy ? fy - by : 1 - (fy - by))
        if (!(w > 0)) continue
        const [nx2, ny2, nz2] = decodeNormal(map.pixels, q * 4)
        mx += nx2 * w; my += ny2 * w; mz += nz2 * w; mw += w
      }
      if (!(mw > 0)) {
        [mx, my, mz] = decodeNormal(map.pixels, (iy * camera.width + ix) * 4)
      } else {
        mx /= mw; my /= mw; mz /= mw
      }
      const d = [0, 1, 2].map((k) => mx * basis.right[k]! + my * basis.up[k]!)
      const tx = d[0]! * surface.tangent[texel * 3]! + d[1]! * surface.tangent[texel * 3 + 1]! + d[2]! * surface.tangent[texel * 3 + 2]!
      const ty = d[0]! * surface.bitangent[texel * 3]! + d[1]! * surface.bitangent[texel * 3 + 1]! + d[2]! * surface.bitangent[texel * 3 + 2]!
      const weight = Math.pow(facing, power)
      sum[texel * 3]! += tx * weight
      sum[texel * 3 + 1]! += ty * weight
      sum[texel * 3 + 2]! += mz * weight
      total += weight
    })
    if (!(total > 0)) continue
    const x = sum[texel * 3]! / total, y = sum[texel * 3 + 1]! / total, z = Math.max(0.05, sum[texel * 3 + 2]! / total)
    const length = Math.hypot(x, y, z)
    field.normal.set([x / length, y / length, z / length], texel * 3)
    field.weight[texel] = 1
  }
  return field
}

// ---- putting it on the normal map

function emptyField(width: number, height: number): DetailField {
  const normal = new Float32Array(width * height * 3)
  for (let texel = 0; texel < width * height; texel++) normal[texel * 3 + 2] = 1
  return { width, height, normal, weight: new Float32Array(width * height) }
}

function grow(mask: Uint8Array, width: number, height: number, by: number): Uint8Array {
  let current = mask
  for (let step = 0; step < by; step++) {
    const next = Uint8Array.from(current)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (current[y * width + x]) continue
        if ((x > 0 && current[y * width + x - 1]) || (x + 1 < width && current[y * width + x + 1]) ||
          (y > 0 && current[(y - 1) * width + x]) || (y + 1 < height && current[(y + 1) * width + x])) next[y * width + x] = 1
      }
    }
    current = next
  }
  return current
}

/** Spread the detail a few texels past the edge of each piece, so filtering at a seam does not pull in flat texels. */
export function bleed(field: DetailField, steps = 2): DetailField {
  const { width, height } = field
  for (let step = 0; step < steps; step++) {
    const weight = Float32Array.from(field.weight)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const texel = y * width + x
        if (weight[texel]) continue
        for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const nx = x + ox, ny = y + oy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height || !weight[ny * width + nx]) continue
          field.normal.set(field.normal.subarray((ny * width + nx) * 3, (ny * width + nx) * 3 + 3), texel * 3)
          field.weight[texel] = 0.5
          break
        }
      }
    }
  }
  return field
}

export interface ApplyOptions {
  /** How much of PixelLab's detail goes on, 0 to 2; 1 as PixelLab drew it. */
  amount?: number
  /** Write PixelLab's detail alone, dropping the baked relief, where it has any. */
  replace?: boolean
}

/**
 * Put a detail field on the model's normal map. Blending is "whiteout": the
 * two maps' sideways parts add and their upright parts multiply, so the baked
 * relief and the new detail both show. Texels with no detail are untouched.
 */
export function applyDetail(existing: Raster, field: DetailField, opts: ApplyOptions = {}): Raster {
  const amount = opts.amount ?? 1
  const { width, height } = field
  const base = resample(existing, width, height)
  const pixels = Uint8Array.from(base.pixels)
  for (let texel = 0; texel < width * height; texel++) {
    if (!field.weight[texel]) continue
    let dx = field.normal[texel * 3]! * amount, dy = field.normal[texel * 3 + 1]! * amount
    const dz = field.normal[texel * 3 + 2]!
    let x: number, y: number, z: number
    if (opts.replace) {
      x = dx; y = dy; z = dz
    } else {
      const [bx, by, bz] = decodeNormal(base.pixels, texel * 4)
      x = bx + dx; y = by + dy; z = bz * dz
    }
    const length = Math.hypot(x, y, z) || 1
    dx = x / length; dy = y / length
    pixels[texel * 4] = Math.round((dx * 0.5 + 0.5) * 255)
    pixels[texel * 4 + 1] = Math.round((dy * 0.5 + 0.5) * 255)
    pixels[texel * 4 + 2] = Math.round((Math.max(0, z / length) * 0.5 + 0.5) * 255)
    pixels[texel * 4 + 3] = 255
  }
  return { width, height, pixels }
}

/** A detail field as a picture (flat is #8080ff), for looking at what PixelLab added before it is blended. */
export function fieldImage(field: DetailField): Raster {
  const pixels = new Uint8Array(field.width * field.height * 4)
  for (let texel = 0; texel < field.width * field.height; texel++) {
    for (let k = 0; k < 3; k++) pixels[texel * 4 + k] = Math.round((field.normal[texel * 3 + k]! * 0.5 + 0.5) * 255)
    pixels[texel * 4 + 3] = 255
  }
  return { width: field.width, height: field.height, pixels }
}

// ---- the whole job: plan, price, call, blend, save

/** What `/normal-map` is asked: surface detail only, plus the caller's choices. */
export interface NormalRequestOptions {
  mode?: NormalMapMode
  kind?: NormalMapKind
  surfaceDetail?: number
  detailSoftness?: number
  strength?: number
}

/** Turns one picture into its normal map (opengl, alpha marking the picture); the caller owns PixelLab. */
export type NormalMapper = (png: Buffer, options: NormalRequestOptions) => Promise<Buffer>

export interface ModelNormalOptions extends NormalRequestOptions, ApplyOptions {
  source: ModelNormalSource
  /** Normal map images to change; all of the model's when left out. */
  images?: number[]
  /** `views` only: directions by name (south, east, …) or degrees. Four when left out. */
  views?: Array<string | number>
  /** `views` only: the side of each drawn view, 8 to 512. */
  size?: number
  /** `sprites` only: the figure's own sprites, each with the direction it was drawn from. */
  sprites?: Array<{ direction: string | number; png: Buffer }>
  /** `sprites` only: leave out a sprite less of which the model matches in colour than this (0 to 1). */
  minAgreement?: number
  /** Pose the model at a moment of one of its animations first, to match the sprites' stance. */
  pose?: ModelPose
}

/** Below this share of matching pixels a sprite is left out: too little of it lines up with the model to trust. */
export const DEFAULT_MIN_AGREEMENT = 0.25

export interface PlannedCall {
  /** What the picture is: "view south", "image 5 tile 0,0". */
  label: string
  png: Buffer
  /** The file the answer is cached in; when it is already there the call is free. */
  cache: string
  cached: boolean
}

export interface ModelNormalPlan {
  source: ModelNormalSource
  /** The model the work starts from: the edited copy when there is one. */
  from: "edit" | "built"
  images: Array<{ image: number; name: string; width: number; height: number }>
  calls: PlannedCall[]
  /** Generations the calls not already cached will cost. */
  cost: number
  dir: string
  /** What may make the result poor, said before anything is spent. */
  warnings: string[]
  /** `sprites` only: how each sprite lined up with the model. */
  fits?: Array<{ label: string; turn: number; tilt: number; overlap: number; agreement: number; png: Buffer }>
}

export const DEFAULT_VIEWS = ["south", "east", "north", "west"]

/** What the edit record names as the editor of a map this wrote. */
const PIXELLAB_EDITOR = "pixellab normal-map"

const turnOf = (view: string | number): number => {
  if (typeof view === "number") return view
  const named = VIEW_TURNS[view.toLowerCase()]
  if (named !== undefined) return named
  const degrees = Number(view)
  if (Number.isFinite(degrees)) return degrees
  throw new Error(`"${view}" is not a direction: use south, south-east, east, north-east, north, north-west, west, south-west, or degrees`)
}

const viewName = (turn: number) => Object.entries(VIEW_TURNS).find(([, degrees]) => degrees === ((turn % 360) + 360) % 360)?.[0] ?? `${turn}deg`

/** Where a model's own sprites are looked for: `<model>.sprites/` beside it, one `<direction>.png` each. */
export function modelSpritesDir(modelFile: string): string {
  return modelFile.replace(/\.glb$/i, "") + ".sprites"
}

/**
 * The sprites in a folder, by file name: `south.png`, `north-east.png`, and so
 * on (a PixelLab character's `rotations/` folder is laid out this way, and is
 * looked in when the folder holds one). Other files are ignored.
 */
export async function readSpriteFolder(dir: string): Promise<Array<{ direction: string; png: Buffer; file: string }>> {
  const folder = existsSync(path.join(dir, "rotations")) ? path.join(dir, "rotations") : dir
  const names = (await readdir(folder)).filter((name) => name.toLowerCase().endsWith(".png") && VIEW_TURNS[name.slice(0, -4).toLowerCase()] !== undefined).sort()
  return Promise.all(names.map(async (name) => ({ direction: name.slice(0, -4).toLowerCase(), png: await readFile(path.join(folder, name)), file: path.join(folder, name) })))
}

/** Where a model's PixelLab inputs and answers are kept: `<edit>.normal-map/`. */
export function modelNormalDir(editFile: string): string {
  return editFile.replace(/\.glb$/i, "") + ".normal-map"
}

interface Prepared {
  plan: ModelNormalPlan
  document: GlbDocument
  primitives: RestPrimitive[]
  surfaces: Map<number, TexelSurface>
  tiles: Map<number, Tile[]>
  views: DrawnView[]
}

function requestKey(png: Buffer, options: NormalRequestOptions): string {
  const asked = JSON.stringify([options.mode ?? "lite", options.kind ?? null, options.surfaceDetail ?? null, options.detailSoftness ?? null, options.strength ?? null])
  return createHash("sha256").update(png).update(asked).digest("hex").slice(0, 16)
}

async function prepare(model: ProjectModel, opts: ModelNormalOptions): Promise<Prepared> {
  const fromEdit = existsSync(model.editFile)
  const document = parseGlb(await readFile(fromEdit ? model.editFile : model.file))
  const summary = describeGlb(document)
  const normalImages = summary.images.filter((image) => image.roles.includes("normal"))
  if (!normalImages.length) throw new Error("the model has no normal maps; this adds detail to one it has, it does not add a new one")
  const wanted = opts.images?.length ? opts.images : normalImages.map((image) => image.index)
  for (const index of wanted) {
    if (!normalImages.some((image) => image.index === index)) throw new Error(`image ${index} is not one of the model's normal maps`)
  }
  const primitives = restPrimitives(document, opts.pose)
  const dir = path.join(modelNormalDir(model.editFile), opts.source)
  const surfaces = new Map<number, TexelSurface>()
  const tiles = new Map<number, Tile[]>()
  const calls: PlannedCall[] = []
  const images: ModelNormalPlan["images"] = []
  const call = (label: string, png: Buffer) => {
    const cache = path.join(dir, `${label.replace(/[^a-z0-9]+/gi, "-")}.${requestKey(png, opts)}.normal.png`)
    calls.push({ label, png, cache, cached: existsSync(cache) })
  }
  for (const index of wanted) {
    const summaryImage = summary.images[index]!
    const width = summaryImage.width ?? 0, height = summaryImage.height ?? 0
    if (!width || !height) throw new Error(`image ${index} has no readable size`)
    images.push({ image: index, name: `${summaryImage.materials[0] ?? `image ${index}`} normal map`, width, height })
    surfaces.set(index, texelSurface(primitives, document, index, width, height))
  }
  let views: DrawnView[] = []
  let fits: ModelNormalPlan["fits"]
  const warnings: string[] = []
  if (opts.source === "sprites") {
    if (!opts.sprites?.length) throw new Error("the sprites source needs the figure's sprites, each named by the direction it faces")
    const minimum = opts.minAgreement ?? DEFAULT_MIN_AGREEMENT
    const textures = baseColourTextures(document)
    fits = []
    const poor: string[] = []
    for (const sprite of opts.sprites) {
      const turn = turnOf(sprite.direction)
      const label = `sprite ${viewName(turn)}`
      const raster = decodeImage(sprite.png)
      if (raster.width < 8 || raster.height < 8 || raster.width > TILE_MAX || raster.height > TILE_MAX) {
        throw new Error(`${label} is ${raster.width}x${raster.height}; PixelLab's normal map takes 8 to ${TILE_MAX} px a side`)
      }
      const fit = fitSprite(document, primitives, raster, turn, textures)
      const drawn = fit.drawn
      fits.push({ label, turn, tilt: fit.camera.tilt, overlap: Math.round(fit.overlap * 1000) / 1000, agreement: Math.round(fit.agreement * 1000) / 1000, png: fitPicture(raster, drawn) })
      if (fit.agreement < minimum) { poor.push(`${label} ${Math.round(fit.agreement * 100)}%`); continue }
      if (fit.agreement < 0.5) {
        warnings.push(`${label}: ${Math.round(fit.agreement * 100)}% of it lines up with the model in colour; only that part is used, so the detail will be patchy`)
      }
      const coarse = frameView(primitives, turn, TILE_MAX, fit.camera.tilt).scale / fit.camera.scale
      if (coarse >= 3) {
        warnings.push(`${label}: each of its pixels covers what ${Math.round(coarse)} pixels a side of a ${TILE_MAX} px drawn view would; the detail will be soft`)
      }
      views.push(drawn)
      call(label, encodeImage(raster))
    }
    if (poor.length && views.length) warnings.push(`left out, too little of it lines up: ${poor.join(", ")}`)
    if (!views.length) {
      throw new Error(`no sprite lines up with the model well enough (${poor.join(", ")}; at least ${Math.round(minimum * 100)}% needed). ` +
        "Pose the model like the sprites with --pose <animation>[@seconds], check the directions, or use --source views: " +
        "sprites only help when the model was built to their proportions")
    }
  } else if (opts.source === "texture") {
    for (const index of wanted) {
      const material = materialsWithNormalImage(document, index)[0]
      const base = material ? baseColourOf(document, material.material) : null
      if (!base) throw new Error(`image ${index}'s material has no base colour texture to read detail from`)
      const cut = textureTiles(decodeImage(glbImageBytes(document, base.image).bytes), surfaces.get(index)!)
      tiles.set(index, cut)
      for (const tile of cut) call(`image ${index} tile ${tile.x},${tile.y}`, tile.png)
    }
  } else {
    const size = opts.size ?? TILE_MAX
    if (!Number.isInteger(size) || size < 8 || size > TILE_MAX) throw new Error(`--size is 8 to ${TILE_MAX} px for a drawn view, not ${size}`)
    const textures = baseColourTextures(document)
    const turns = [...new Set((opts.views?.length ? opts.views : DEFAULT_VIEWS).map(turnOf))]
    views = turns.map((turn) => drawView(document, primitives, frameView(primitives, turn, size), textures))
    views.forEach((view) => call(`view ${viewName(view.camera.turn)}`, view.png))
  }
  const cost = Math.round(calls.filter((entry) => !entry.cached).length * normalMapCost(opts.mode) * 100) / 100
  return { plan: { source: opts.source, from: fromEdit ? "edit" : "built", images, calls, cost, dir, warnings, ...(fits ? { fits } : {}) }, document, primitives, surfaces, tiles, views }
}

/** What a run would send and cost, without sending anything. The pictures are written beside the cache for a look. */
export async function planModelNormals(model: ProjectModel, opts: ModelNormalOptions): Promise<ModelNormalPlan> {
  const { plan } = await prepare(model, opts)
  await mkdir(plan.dir, { recursive: true })
  for (const entry of plan.calls) await writeFile(entry.cache.replace(/\.[0-9a-f]{16}\.normal\.png$/, ".png"), entry.png)
  for (const fit of plan.fits ?? []) await writeFile(path.join(plan.dir, `${fit.label.replace(/[^a-z0-9]+/gi, "-")}.fit.png`), fit.png)
  return plan
}

export interface ModelNormalResult extends ModelEditResult {
  plan: ModelNormalPlan
  /** Calls actually sent (the rest came from the cache). */
  sent: number
  /** `<edit>.normal-map/<source>/image-<n>.detail.png`: PixelLab's detail alone, per image. */
  details: string[]
}

/**
 * Make normal map detail with PixelLab and save it into the model's edited
 * copy, one record per normal map. Answers are cached by picture and request,
 * so changing `amount` or `replace` and running again costs nothing.
 */
export async function generateModelNormals(model: ProjectModel, opts: ModelNormalOptions, mapper: NormalMapper, hooks: { onCall?: (label: string, cached: boolean) => void; now?: Date } = {}): Promise<ModelNormalResult> {
  const prepared = await prepare(model, opts)
  const { plan, document } = prepared
  await mkdir(plan.dir, { recursive: true })
  const request: NormalRequestOptions = {
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.surfaceDetail !== undefined ? { surfaceDetail: opts.surfaceDetail } : {}),
    ...(opts.detailSoftness !== undefined ? { detailSoftness: opts.detailSoftness } : {}),
    ...(opts.strength !== undefined ? { strength: opts.strength } : {}),
  }
  const answers: Buffer[] = []
  let sent = 0
  for (const entry of plan.calls) {
    hooks.onCall?.(entry.label, entry.cached)
    await writeFile(entry.cache.replace(/\.[0-9a-f]{16}\.normal\.png$/, ".png"), entry.png)
    if (entry.cached) { answers.push(await readFile(entry.cache)); continue }
    const answer = await mapper(entry.png, request)
    sent++
    await writeFile(entry.cache, answer)
    answers.push(answer)
  }
  let result: ModelEditResult | null = null
  const details: string[] = []
  const companion = await readModelCompanion(model.editFile)
  let offset = 0
  for (const { image } of plan.images) {
    const surface = prepared.surfaces.get(image)!
    let field: DetailField
    if (plan.source === "texture") {
      const tiles = prepared.tiles.get(image)!
      field = detailFromTiles(surface, tiles, answers.slice(offset, offset + tiles.length))
      offset += tiles.length
    } else {
      field = detailFromViews(surface, prepared.views, answers)
    }
    bleed(field)
    const detail = path.join(plan.dir, `image-${image}.detail.png`)
    await writeFile(detail, encodeImage(fieldImage(field)))
    details.push(detail)
    // Blend onto the map as it was before any PixelLab detail, so running
    // again re-tunes the detail instead of stacking it. That map is kept the
    // first time; a hand paint or an adopt since then starts it afresh.
    const basePath = path.join(modelNormalDir(model.editFile), `image-${image}.base.png`)
    const record = companion?.textures.find((entry) => entry.image === image)
    const ours = record?.editor.startsWith(PIXELLAB_EDITOR) === true && existsSync(basePath)
    const existing = ours ? decodeImage(await readFile(basePath)) : decodeImage(glbImageBytes(document, image).bytes)
    if (!ours) await writeFile(basePath, encodeImage(existing))
    const png = encodeImage(applyDetail(existing, field, opts))
    result = await saveModelTexture(model, {
      image,
      png,
      editor: `${PIXELLAB_EDITOR} (${plan.source}${opts.replace ? ", replace" : ""})`,
      protocol: 0,
      ...(hooks.now ? { now: hooks.now } : {}),
    })
  }
  return { ...result!, plan, sent, details }
}

/**
 * The mapper that asks PixelLab: surface detail only, outline rounding and
 * part shapes at 0 so no piece of an unwrap and no outline of a view gets a
 * bevel of its own. The client is made on first use, so a run whose answers
 * are all cached needs no key.
 */
export function modelNormalMapper(client: () => Pick<PixelLabClient, "normalMap" | "getBackgroundJob">): NormalMapper {
  return async (png, options) => (await normalMapBytes(client(), png, {
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.kind ? { kind: options.kind } : {}),
    shape: {
      outlineRounding: 0,
      partShapes: 0,
      ...(options.surfaceDetail !== undefined ? { surfaceDetail: options.surfaceDetail } : {}),
      ...(options.detailSoftness !== undefined ? { detailSoftness: options.detailSoftness } : {}),
      ...(options.strength !== undefined ? { strength: options.strength } : {}),
    },
  })).png
}
