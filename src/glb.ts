/**
 * Read and rewrite binary glTF (`.glb`) without a dependency, in the spirit
 * of `png.ts`: enough of the container to list what a model holds, read its
 * vertex data, and swap one embedded image for another.
 *
 * A `.glb` is a 12-byte header, a JSON chunk, and (usually) one BIN chunk the
 * JSON's `bufferViews` point into. Replacing an image splices new bytes into
 * the BIN chunk where the old ones were and moves the offsets of the views
 * behind it. Every other view (positions, normals, tangents, skin matrices,
 * animation tracks, the other images) keeps its bytes exactly; the JSON is
 * re-serialised, so its whitespace and number spelling may change while its
 * values do not.
 *
 * Works on `Uint8Array` only, so the gallery page can bundle it too.
 */

const MAGIC = 0x46546c67 // "glTF"
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

export interface GltfBufferView {
  buffer: number
  byteOffset?: number
  byteLength: number
  byteStride?: number
  target?: number
  [key: string]: unknown
}

export interface GltfAccessor {
  bufferView?: number
  byteOffset?: number
  componentType: number
  normalized?: boolean
  count: number
  type: string
  min?: number[]
  max?: number[]
  sparse?: unknown
  [key: string]: unknown
}

export interface GltfImage {
  bufferView?: number
  mimeType?: string
  uri?: string
  name?: string
  [key: string]: unknown
}

export interface GltfTextureInfo {
  index: number
  texCoord?: number
  [key: string]: unknown
}

export interface GltfMaterial {
  name?: string
  pbrMetallicRoughness?: {
    baseColorTexture?: GltfTextureInfo
    metallicRoughnessTexture?: GltfTextureInfo
    [key: string]: unknown
  }
  normalTexture?: GltfTextureInfo
  occlusionTexture?: GltfTextureInfo
  emissiveTexture?: GltfTextureInfo
  [key: string]: unknown
}

export interface GltfPrimitive {
  attributes: Record<string, number>
  indices?: number
  material?: number
  mode?: number
  [key: string]: unknown
}

export interface GltfNode {
  name?: string
  mesh?: number
  skin?: number
  children?: number[]
  translation?: number[]
  rotation?: number[]
  scale?: number[]
  matrix?: number[]
  extras?: Record<string, unknown>
  [key: string]: unknown
}

export interface GltfAnimation {
  name?: string
  channels: Array<{ sampler: number; target: { node?: number; path: string } }>
  samplers: Array<{ input: number; output: number; interpolation?: string }>
  [key: string]: unknown
}

export interface GltfJson {
  asset: { version: string; generator?: string; [key: string]: unknown }
  scene?: number
  scenes?: Array<{ nodes?: number[]; [key: string]: unknown }>
  nodes?: GltfNode[]
  meshes?: Array<{ name?: string; primitives: GltfPrimitive[]; [key: string]: unknown }>
  skins?: Array<{ joints: number[]; inverseBindMatrices?: number; skeleton?: number; [key: string]: unknown }>
  materials?: GltfMaterial[]
  textures?: Array<{ source?: number; sampler?: number; [key: string]: unknown }>
  images?: GltfImage[]
  animations?: GltfAnimation[]
  accessors?: GltfAccessor[]
  bufferViews?: GltfBufferView[]
  buffers?: Array<{ byteLength: number; uri?: string; [key: string]: unknown }>
  [key: string]: unknown
}

export interface GlbDocument {
  json: GltfJson
  /** The BIN chunk (buffer 0); empty when the file has none. */
  bin: Uint8Array
  /** Chunks of any other type, kept as they were and written back after BIN. */
  extraChunks: Array<{ type: number; data: Uint8Array }>
}

const pad4 = (n: number) => (n + 3) & ~3

/** Parse a `.glb`. Throws with a plain reason on anything that is not one. */
export function parseGlb(bytes: Uint8Array): GlbDocument {
  if (bytes.length < 20) throw new Error("invalid glb: shorter than a header and one chunk")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== MAGIC) throw new Error("invalid glb: missing the glTF signature")
  const version = view.getUint32(4, true)
  if (version !== 2) throw new Error(`invalid glb: container version ${version}; only version 2 is supported`)
  const total = view.getUint32(8, true)
  if (total > bytes.length) throw new Error(`invalid glb: header says ${total} bytes, the file has ${bytes.length}`)
  let offset = 12
  let json: GltfJson | null = null
  let bin: Uint8Array | null = null
  const extraChunks: GlbDocument["extraChunks"] = []
  while (offset + 8 <= total) {
    const length = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (start + length > total) throw new Error("invalid glb: a chunk runs past the end of the file")
    const data = bytes.subarray(start, start + length)
    if (type === CHUNK_JSON && !json) {
      let parsed: unknown
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data))
      } catch (error) {
        throw new Error(`invalid glb: the JSON chunk does not parse (${error instanceof Error ? error.message : String(error)})`)
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid glb: the JSON chunk is not an object")
      json = parsed as GltfJson
    } else if (type === CHUNK_BIN && !bin) {
      bin = data
    } else {
      extraChunks.push({ type, data })
    }
    offset = start + pad4(length)
  }
  if (!json) throw new Error("invalid glb: no JSON chunk")
  if (!json.asset || typeof json.asset.version !== "string") throw new Error("invalid glb: the JSON has no asset.version")
  const declared = json.buffers?.[0]?.byteLength
  if (bin && typeof declared === "number") {
    if (declared > bin.length) throw new Error(`invalid glb: buffer 0 declares ${declared} bytes, the BIN chunk has ${bin.length}`)
    // The chunk is padded to four bytes; the buffer is what the JSON says.
    bin = bin.subarray(0, declared)
  }
  const document: GlbDocument = { json, bin: bin ?? new Uint8Array(0), extraChunks }
  for (const [index, bufferView] of (json.bufferViews ?? []).entries()) {
    if (bufferView.buffer !== 0) continue
    const start = bufferView.byteOffset ?? 0
    if (start < 0 || bufferView.byteLength < 0 || start + bufferView.byteLength > document.bin.length) {
      throw new Error(`invalid glb: bufferView ${index} runs past the end of the buffer`)
    }
  }
  return document
}

/** Write a document back out as `.glb` bytes. */
export function serializeGlb(document: GlbDocument): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(document.json))
  const jsonLength = pad4(json.length)
  const hasBin = document.bin.length > 0
  const binLength = pad4(document.bin.length)
  const extra = document.extraChunks.reduce((sum, chunk) => sum + 8 + pad4(chunk.data.length), 0)
  const total = 12 + 8 + jsonLength + (hasBin ? 8 + binLength : 0) + extra
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  let offset = 12
  view.setUint32(offset, jsonLength, true)
  view.setUint32(offset + 4, CHUNK_JSON, true)
  out.set(json, offset + 8)
  // JSON is padded with spaces, binary with zeros, as the format asks.
  out.fill(0x20, offset + 8 + json.length, offset + 8 + jsonLength)
  offset += 8 + jsonLength
  if (hasBin) {
    view.setUint32(offset, binLength, true)
    view.setUint32(offset + 4, CHUNK_BIN, true)
    out.set(document.bin, offset + 8)
    offset += 8 + binLength
  }
  for (const chunk of document.extraChunks) {
    const length = pad4(chunk.data.length)
    view.setUint32(offset, length, true)
    view.setUint32(offset + 4, chunk.type, true)
    out.set(chunk.data, offset + 8)
    offset += 8 + length
  }
  return out
}

export type EmbeddedImageType = "image/png" | "image/jpeg"

/** The type and pixel size of a PNG or JPEG, read from its header; null for anything else. */
export function imageInfo(bytes: Uint8Array): { mimeType: EmbeddedImageType; width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    return { mimeType: "image/png", width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null
      const marker = bytes[offset + 1]!
      if (marker === 0xff) { offset += 1; continue }
      // Markers without a length: restart markers, start and end of image.
      if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) { offset += 2; continue }
      const length = view.getUint16(offset + 2)
      // Start-of-frame markers carry the size; C4, C8 and CC are tables, not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (offset + 9 > bytes.length) return null
        return { mimeType: "image/jpeg", width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
      }
      if (length < 2) return null
      offset += 2 + length
    }
  }
  return null
}

/** The bytes of one embedded image. Throws for an image kept outside the file. */
export function glbImageBytes(document: GlbDocument, imageIndex: number): { bytes: Uint8Array; mimeType: string | null } {
  const image = document.json.images?.[imageIndex]
  if (!image) throw new Error(`the model has no image ${imageIndex}`)
  if (typeof image.bufferView !== "number") {
    throw new Error(`image ${imageIndex} is not embedded in the file (it names ${image.uri ? "a uri" : "no data"})`)
  }
  const bufferView = document.json.bufferViews?.[image.bufferView]
  if (!bufferView || bufferView.buffer !== 0) throw new Error(`image ${imageIndex} points at a bufferView the file does not hold`)
  const start = bufferView.byteOffset ?? 0
  return { bytes: document.bin.subarray(start, start + bufferView.byteLength), mimeType: image.mimeType ?? null }
}

/**
 * A copy of the document with one image's bytes replaced. Only that image's
 * span of the buffer changes; the views after it move by the size difference
 * and keep their bytes. An image whose bytes something else also reads (a
 * shared or overlapping view), or one kept as a uri, gets a new view at the
 * end of the buffer instead, so nothing else is disturbed.
 */
export function replaceGlbImage(
  document: GlbDocument,
  imageIndex: number,
  bytes: Uint8Array,
  mimeType: EmbeddedImageType,
): GlbDocument {
  const source = document.json
  const image = source.images?.[imageIndex]
  if (!image) throw new Error(`the model has no image ${imageIndex}`)
  const json = structuredCloneJson(source)
  const views = (json.bufferViews ??= [])
  const target = json.images![imageIndex]!
  const viewIndex = typeof image.bufferView === "number" ? image.bufferView : -1
  const old = viewIndex >= 0 ? source.bufferViews?.[viewIndex] : undefined
  const usedElsewhere = viewIndex >= 0 && (
    (source.images ?? []).some((other, index) => index !== imageIndex && other.bufferView === viewIndex) ||
    (source.accessors ?? []).some((accessor) => accessor.bufferView === viewIndex)
  )
  const oldStart = old?.byteOffset ?? 0
  const oldEnd = old ? oldStart + old.byteLength : 0
  const overlapped = old
    ? (source.bufferViews ?? []).some((other, index) => {
        if (index === viewIndex || other.buffer !== 0) return false
        const start = other.byteOffset ?? 0
        return start < oldEnd && start + other.byteLength > oldStart
      })
    : false

  let bin: Uint8Array
  if (!old || old.buffer !== 0 || usedElsewhere || overlapped) {
    const start = pad4(document.bin.length)
    bin = new Uint8Array(start + bytes.length)
    bin.set(document.bin)
    bin.set(bytes, start)
    views.push({ buffer: 0, byteOffset: start, byteLength: bytes.length })
    target.bufferView = views.length - 1
    delete target.uri
  } else {
    // Whatever sits between this view and the next one is alignment padding.
    let next = document.bin.length
    for (const [index, other] of (source.bufferViews ?? []).entries()) {
      if (index === viewIndex || other.buffer !== 0) continue
      const start = other.byteOffset ?? 0
      if (start >= oldEnd && start < next) next = start
    }
    // Keep everything behind on the alignment it had: accessors need theirs.
    let length = bytes.length
    while ((oldStart + length - next) % 4 !== 0) length++
    const shift = oldStart + length - next
    bin = new Uint8Array(document.bin.length + shift)
    bin.set(document.bin.subarray(0, oldStart))
    bin.set(bytes, oldStart)
    bin.set(document.bin.subarray(next), oldStart + length)
    for (const [index, other] of views.entries()) {
      if (other.buffer !== 0) continue
      if (index === viewIndex) other.byteLength = bytes.length
      else if ((other.byteOffset ?? 0) >= next) other.byteOffset = (other.byteOffset ?? 0) + shift
    }
  }
  target.mimeType = mimeType
  json.buffers = json.buffers?.length ? json.buffers : [{ byteLength: 0 }]
  json.buffers[0] = { ...json.buffers[0]!, byteLength: bin.length }
  return { json, bin, extraChunks: document.extraChunks }
}

function structuredCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }

export interface AccessorData {
  /** Flat values, `size` per element; integers normalised to 0..1 or -1..1 when the accessor says so. */
  data: Float32Array | Uint32Array
  size: number
  count: number
}

/**
 * Read an accessor into a fresh array: floats (and normalised integers) as
 * `Float32Array`, other integers as `Uint32Array`. Honours `byteStride`; a
 * sparse accessor is refused.
 */
export function readAccessor(document: GlbDocument, accessorIndex: number): AccessorData {
  const accessor = document.json.accessors?.[accessorIndex]
  if (!accessor) throw new Error(`the model has no accessor ${accessorIndex}`)
  if (accessor.sparse) throw new Error(`accessor ${accessorIndex} is sparse, which is not supported`)
  const size = COMPONENTS[accessor.type]
  if (!size) throw new Error(`accessor ${accessorIndex} has unknown type ${accessor.type}`)
  const bytesPer = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[accessor.componentType]
  if (!bytesPer) throw new Error(`accessor ${accessorIndex} has unknown component type ${accessor.componentType}`)
  const float = accessor.componentType === 5126 || accessor.normalized === true
  const out = float ? new Float32Array(accessor.count * size) : new Uint32Array(accessor.count * size)
  if (typeof accessor.bufferView !== "number") return { data: out, size, count: accessor.count }
  const bufferView = document.json.bufferViews?.[accessor.bufferView]
  if (!bufferView || bufferView.buffer !== 0) throw new Error(`accessor ${accessorIndex} points at a bufferView the file does not hold`)
  const stride = bufferView.byteStride || bytesPer * size
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  if (accessor.count && start + stride * (accessor.count - 1) + bytesPer * size > document.bin.length) {
    throw new Error(`accessor ${accessorIndex} runs past the end of the buffer`)
  }
  const view = new DataView(document.bin.buffer, document.bin.byteOffset, document.bin.byteLength)
  for (let element = 0; element < accessor.count; element++) {
    for (let component = 0; component < size; component++) {
      const at = start + element * stride + component * bytesPer
      let value: number
      switch (accessor.componentType) {
        case 5120: value = view.getInt8(at); if (accessor.normalized) value = Math.max(value / 127, -1); break
        case 5121: value = view.getUint8(at); if (accessor.normalized) value /= 255; break
        case 5122: value = view.getInt16(at, true); if (accessor.normalized) value = Math.max(value / 32767, -1); break
        case 5123: value = view.getUint16(at, true); if (accessor.normalized) value /= 65535; break
        case 5125: value = view.getUint32(at, true); break
        default: value = view.getFloat32(at, true)
      }
      out[element * size + component] = value
    }
  }
  return { data: out, size, count: accessor.count }
}

export type TextureRole = "baseColor" | "normal" | "metallicRoughness" | "occlusion" | "emissive"

export interface GlbImageSummary {
  index: number
  mimeType: string | null
  width: number | null
  height: number | null
  bytes: number | null
  /** False for an image the file only names by uri. */
  embedded: boolean
  /** What materials use it for, without repeats. */
  roles: TextureRole[]
  /** Names of the materials that use it. */
  materials: string[]
  /** Names of the meshes drawn with those materials. */
  meshes: string[]
}

export interface GlbSummary {
  generator: string | null
  meshes: Array<{ name: string; primitives: number; vertices: number; triangles: number }>
  /** Bone names of every skin, without repeats, in skin order. */
  bones: string[]
  animations: string[]
  images: GlbImageSummary[]
  /** Mesh nodes other than the body: the parts a viewer can show and hide. */
  items: string[]
}

/** What a model holds, for a record that lists it without drawing it. */
export function describeGlb(document: GlbDocument): GlbSummary {
  const json = document.json
  const images: GlbImageSummary[] = (json.images ?? []).map((image, index) => {
    let info: ReturnType<typeof imageInfo> = null
    let bytes: number | null = null
    const embedded = typeof image.bufferView === "number"
    if (embedded) {
      try {
        const data = glbImageBytes(document, index)
        bytes = data.bytes.length
        info = imageInfo(data.bytes)
      } catch {
        // Listed without a size; reading it for an edit reports why.
      }
    }
    return {
      index,
      mimeType: info?.mimeType ?? image.mimeType ?? null,
      width: info?.width ?? null,
      height: info?.height ?? null,
      bytes,
      embedded,
      roles: [],
      materials: [],
      meshes: [],
    }
  })
  const imageOfTexture = (info: GltfTextureInfo | undefined) =>
    info && typeof info.index === "number" ? json.textures?.[info.index]?.source : undefined
  const meshesOfMaterial = new Map<number, string[]>()
  for (const [meshIndex, mesh] of (json.meshes ?? []).entries()) {
    for (const primitive of mesh.primitives ?? []) {
      if (typeof primitive.material !== "number") continue
      const names = meshesOfMaterial.get(primitive.material) ?? []
      const name = mesh.name ?? `mesh ${meshIndex}`
      if (!names.includes(name)) names.push(name)
      meshesOfMaterial.set(primitive.material, names)
    }
  }
  for (const [materialIndex, material] of (json.materials ?? []).entries()) {
    const uses: Array<[TextureRole, GltfTextureInfo | undefined]> = [
      ["baseColor", material.pbrMetallicRoughness?.baseColorTexture],
      ["normal", material.normalTexture],
      ["metallicRoughness", material.pbrMetallicRoughness?.metallicRoughnessTexture],
      ["occlusion", material.occlusionTexture],
      ["emissive", material.emissiveTexture],
    ]
    for (const [role, info] of uses) {
      const summary = images[imageOfTexture(info) ?? -1]
      if (!summary) continue
      if (!summary.roles.includes(role)) summary.roles.push(role)
      const name = material.name ?? `material ${materialIndex}`
      if (!summary.materials.includes(name)) summary.materials.push(name)
      for (const mesh of meshesOfMaterial.get(materialIndex) ?? []) {
        if (!summary.meshes.includes(mesh)) summary.meshes.push(mesh)
      }
    }
  }
  const bones: string[] = []
  for (const skin of json.skins ?? []) {
    for (const joint of skin.joints ?? []) {
      const name = json.nodes?.[joint]?.name ?? `node ${joint}`
      if (!bones.includes(name)) bones.push(name)
    }
  }
  const meshes = (json.meshes ?? []).map((mesh, index) => {
    let vertices = 0
    let triangles = 0
    for (const primitive of mesh.primitives ?? []) {
      const position = json.accessors?.[primitive.attributes?.POSITION ?? -1]
      const count = position?.count ?? 0
      vertices += count
      if ((primitive.mode ?? 4) === 4) {
        triangles += Math.floor((typeof primitive.indices === "number" ? json.accessors?.[primitive.indices]?.count ?? 0 : count) / 3)
      }
    }
    return { name: mesh.name ?? `mesh ${index}`, primitives: mesh.primitives?.length ?? 0, vertices, triangles }
  })
  return {
    generator: typeof json.asset.generator === "string" ? json.asset.generator : null,
    meshes,
    bones,
    animations: (json.animations ?? []).map((animation, index) => animation.name ?? `animation ${index}`),
    images,
    items: modelItems(json),
  }
}

/** True for a mesh node that is part of the body rather than something worn. */
export function isBodyNode(node: GltfNode): boolean {
  return Array.isArray(node.extras?.hiddenBy) || node.extras?.body === true
}

/**
 * The separate parts of a model a viewer can show and hide: every mesh node
 * that is not marked as body, when the file marks any body at all. A model
 * with no such marks is one piece, and has no items.
 */
export function modelItems(json: GltfJson): string[] {
  const meshNodes = (json.nodes ?? []).filter((node) => typeof node.mesh === "number")
  if (!meshNodes.some(isBodyNode)) return meshNodes.length > 1 ? meshNodes.map((node, index) => node.name ?? `part ${index + 1}`) : []
  return meshNodes.filter((node) => !isBodyNode(node)).map((node, index) => node.name ?? `part ${index + 1}`)
}
