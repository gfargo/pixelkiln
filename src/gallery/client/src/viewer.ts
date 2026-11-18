import { glbImageBytes, isBodyNode, readAccessor, type GlbDocument } from "../../../glb.ts"

// ---- a small glTF viewer ---------------------------------------------------
// Draws one `.glb` with WebGL2 and nothing else: skinned meshes on their
// skeleton, base colour and normal maps, the animations the file carries, and
// parts that can be shown and hidden. It covers what a generated character
// model uses (triangles, one skin, TRS animation) and not the whole format;
// no morph targets, cameras, lights, or extensions. Shading is three flat
// bands, the way the sprites the models come from are shaded.
//
// Written for this page instead of bundling a 3D library: the gallery inlines
// its whole script into every page load, and works offline with no install.

type Mat4 = Float32Array

const identity = (): Mat4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function multiply(a: Mat4, b: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  for (let column = 0; column < 4; column++) {
    const b0 = b[column * 4], b1 = b[column * 4 + 1], b2 = b[column * 4 + 2], b3 = b[column * 4 + 3]
    for (let row = 0; row < 4; row++) {
      out[column * 4 + row] = a[row] * b0 + a[4 + row] * b1 + a[8 + row] * b2 + a[12 + row] * b3
    }
  }
  return out
}

function compose(t: ArrayLike<number>, q: ArrayLike<number>, s: ArrayLike<number>, out: Mat4): Mat4 {
  const x = q[0], y = q[1], z = q[2], w = q[3]
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z
  out[0] = (1 - 2 * (yy + zz)) * s[0]; out[1] = 2 * (xy + wz) * s[0]; out[2] = 2 * (xz - wy) * s[0]; out[3] = 0
  out[4] = 2 * (xy - wz) * s[1]; out[5] = (1 - 2 * (xx + zz)) * s[1]; out[6] = 2 * (yz + wx) * s[1]; out[7] = 0
  out[8] = 2 * (xz + wy) * s[2]; out[9] = 2 * (yz - wx) * s[2]; out[10] = (1 - 2 * (xx + yy)) * s[2]; out[11] = 0
  out[12] = t[0]; out[13] = t[1]; out[14] = t[2]; out[15] = 1
  return out
}

function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2)
  const out = new Float32Array(16)
  out[0] = f / aspect; out[5] = f; out[10] = (far + near) / (near - far); out[11] = -1; out[14] = (2 * far * near) / (near - far)
  return out
}

function lookAt(eye: number[], target: number[]): Mat4 {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2]
  const zl = Math.hypot(zx, zy, zz) || 1
  zx /= zl; zy /= zl; zz /= zl
  // Right is up × back, with up fixed at +Y.
  let xx = zz, xy = 0, xz = -zx
  const xl = Math.hypot(xx, xy, xz) || 1
  xx /= xl; xy /= xl; xz /= xl
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]), -(yx * eye[0] + yy * eye[1] + yz * eye[2]), -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1,
  ])
}

function slerp(a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number, t: number, out: number[]) {
  let bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3]
  const ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3]
  let cos = ax * bx + ay * by + az * bz + aw * bw
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw }
  let wa = 1 - t, wb = t
  if (cos < 0.9995) {
    const angle = Math.acos(cos), sin = Math.sin(angle)
    wa = Math.sin((1 - t) * angle) / sin; wb = Math.sin(t * angle) / sin
  }
  out[0] = ax * wa + bx * wb; out[1] = ay * wa + by * wb; out[2] = az * wa + bz * wb; out[3] = aw * wa + bw * wb
  const length = Math.hypot(out[0], out[1], out[2], out[3]) || 1
  out[0] /= length; out[1] /= length; out[2] /= length; out[3] /= length
}

const VERTEX = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUv;
layout(location=3) in vec4 aJoints;
layout(location=4) in vec4 aWeights;
layout(location=5) in vec4 aTangent;
uniform mat4 uViewProjection;
uniform mat4 uModel;
uniform bool uSkinned;
uniform mat4 uJoints[JOINTS];
out vec2 vUv;
out vec3 vNormal;
out vec4 vTangent;
void main() {
  mat4 model = uModel;
  if (uSkinned) {
    model = aWeights.x * uJoints[int(aJoints.x)] + aWeights.y * uJoints[int(aJoints.y)]
          + aWeights.z * uJoints[int(aJoints.z)] + aWeights.w * uJoints[int(aJoints.w)];
  }
  vUv = aUv;
  vNormal = mat3(model) * aNormal;
  vTangent = vec4(mat3(model) * aTangent.xyz, aTangent.w);
  gl_Position = uViewProjection * model * vec4(aPosition, 1.0);
}`

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
in vec3 vNormal;
in vec4 vTangent;
uniform sampler2D uColour;
uniform sampler2D uNormalMap;
uniform bool uHasColour;
uniform bool uHasNormalMap;
uniform vec4 uTint;
uniform vec3 uLight;
out vec4 colour;
void main() {
  vec4 base = uTint;
  if (uHasColour) base *= texture(uColour, vUv);
  if (base.a < 0.05) discard;
  vec3 normal = normalize(vNormal);
  if (!gl_FrontFacing) normal = -normal;
  if (uHasNormalMap && dot(vTangent.xyz, vTangent.xyz) > 0.0) {
    vec3 tangent = normalize(vTangent.xyz - normal * dot(normal, vTangent.xyz));
    vec3 bitangent = cross(normal, tangent) * vTangent.w;
    vec3 mapped = texture(uNormalMap, vUv).xyz * 2.0 - 1.0;
    normal = normalize(mat3(tangent, bitangent, normal) * mapped);
  }
  // Three flat bands of light.
  float lit = dot(normal, uLight) * 0.5 + 0.5;
  float band = lit < 0.34 ? 0.59 : lit < 0.67 ? 0.80 : 1.0;
  colour = vec4(base.rgb * band, 1.0);
}`

interface Primitive {
  vao: WebGLVertexArrayObject
  count: number
  indexType: number
  material: number
  skinnedData: boolean
}
interface MeshNode {
  node: number
  name: string
  skin: number
  primitives: Primitive[]
  visible: boolean
  /** Items that cover this piece of the body; it is hidden while any of them shows. */
  hiddenBy: string[] | null
}
interface Channel { node: number; path: string; times: Float32Array; values: Float32Array; width: number; mode: string }
interface Clip { name: string; duration: number; channels: Channel[] }

export interface ViewerScene {
  /** Parts that can be shown and hidden. */
  items: string[]
  clips: string[]
  /** Why part of the file is not drawn as it would be elsewhere, when that is so. */
  note: string | null
}

export interface ModelViewer {
  canvas: HTMLCanvasElement
  /** Draw this document, keeping the camera, the animation, and which items show. */
  show(document: GlbDocument): Promise<ViewerScene>
  setClip(name: string | null): void
  clip(): string | null
  setPlaying(on: boolean): void
  playing(): boolean
  setItem(name: string, on: boolean): void
  itemShown(name: string): boolean
  zoom(factor: number): void
  resetCamera(): void
  /** Fraction of the canvas the model covers right now, 0 to 1. For tests and for telling a blank draw apart. */
  coverage(): number
  /** Decoded images of the shown document, by image index, for thumbnails and for the texture editor. */
  image(index: number): ImageBitmap | null
  /** Swap one image's pixels in place, e.g. as it is painted; the model, pose and camera stay. */
  setImage(index: number, source: ImageBitmap | HTMLCanvasElement): void
  dispose(): void
}

/** Null when the browser has no WebGL2. */
export function createModelViewer(host: HTMLElement): ModelViewer | null {
  const canvas = document.createElement('canvas')
  canvas.className = 'model-canvas'
  const context = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: false })
  if (!context) return null
  host.append(canvas)
  return buildViewer(host, canvas, context)
}

function buildViewer(host: HTMLElement, canvas: HTMLCanvasElement, gl: WebGL2RenderingContext): ModelViewer {

  const jointLimit = Math.max(4, Math.min(128, Math.floor((gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) - 24) / 4)))
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, source)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader failed to compile')
    return s
  }
  const program = gl.createProgram()!
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX.replace('JOINTS', String(jointLimit))))
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'program failed to link')
  const uniform = (name: string) => gl.getUniformLocation(program, name)
  const U = {
    viewProjection: uniform('uViewProjection'), model: uniform('uModel'), skinned: uniform('uSkinned'), joints: uniform('uJoints'),
    colour: uniform('uColour'), normalMap: uniform('uNormalMap'), hasColour: uniform('uHasColour'), hasNormalMap: uniform('uHasNormalMap'),
    tint: uniform('uTint'), light: uniform('uLight'),
  }

  // What is drawn, replaced wholesale by show().
  let doc: GlbDocument | null = null
  let meshNodes: MeshNode[] = []
  let clips: Clip[] = []
  let parents: Int32Array = new Int32Array(0)
  let order: number[] = []
  let rest: Array<{ t: number[]; r: number[]; s: number[]; matrix: Mat4 | null }> = []
  let pose: Array<{ t: number[]; r: number[]; s: number[] }> = []
  let world: Mat4[] = []
  let skins: Array<{ joints: number[]; inverse: Float32Array; matrices: Float32Array }> = []
  let materials: Array<{ colour: WebGLTexture | null; normal: WebGLTexture | null; tint: number[]; doubleSided: boolean }> = []
  let bitmaps: Array<ImageBitmap | null> = []
  /** The GPU textures made from each image, so a painted image can be re-uploaded. */
  let byImage = new Map<number, WebGLTexture[]>()
  let owned: { buffers: WebGLBuffer[]; vaos: WebGLVertexArrayObject[]; textures: WebGLTexture[] } = { buffers: [], vaos: [], textures: [] }
  let centre = [0, 1, 0]
  let radius = 1

  // What survives a reload of the same model: view, motion, and what is worn.
  let yaw = 0.5, pitch = 0.18, distance = 0, framed = false
  let activeClip: string | null = null
  let time = 0
  let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches
  const shown = new Map<string, boolean>()
  let disposed = false
  let generation = 0

  const release = () => {
    for (const b of owned.buffers) gl.deleteBuffer(b)
    for (const v of owned.vaos) gl.deleteVertexArray(v)
    for (const t of owned.textures) gl.deleteTexture(t)
    for (const bitmap of bitmaps) bitmap?.close()
    owned = { buffers: [], vaos: [], textures: [] }
    byImage = new Map()
    bitmaps = []
  }

  const applyVisibility = () => {
    for (const mesh of meshNodes) {
      mesh.visible = mesh.hiddenBy ? !mesh.hiddenBy.some((item) => shown.get(item) ?? true) : shown.get(mesh.name) ?? true
    }
  }

  async function show(next: GlbDocument): Promise<ViewerScene> {
    const mine = ++generation
    const json = next.json
    // Decode every image first; drawing waits on nothing after this.
    const decoded = await Promise.all((json.images ?? []).map(async (_, index) => {
      try {
        const { bytes, mimeType } = glbImageBytes(next, index)
        return await createImageBitmap(new Blob([bytes.slice()], { type: mimeType || 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
      } catch {
        return null
      }
    }))
    if (disposed || mine !== generation) { for (const bitmap of decoded) bitmap?.close(); return { items: [], clips: [], note: null } }
    release()
    doc = next
    bitmaps = decoded
    let note: string | null = null

    const nodes = json.nodes ?? []
    parents = new Int32Array(nodes.length).fill(-1)
    nodes.forEach((node, index) => { for (const child of node.children ?? []) if (child < nodes.length) parents[child] = index })
    // Parents before children, so one pass computes world matrices.
    order = []
    const visit = (index: number) => { order.push(index); for (const child of nodes[index].children ?? []) if (child < nodes.length) visit(child) }
    nodes.forEach((_, index) => { if (parents[index] < 0) visit(index) })
    rest = nodes.map((node) => ({
      t: node.translation ? [...node.translation] : [0, 0, 0],
      r: node.rotation ? [...node.rotation] : [0, 0, 0, 1],
      s: node.scale ? [...node.scale] : [1, 1, 1],
      matrix: node.matrix ? new Float32Array(node.matrix) : null,
    }))
    pose = rest.map((entry) => ({ t: [...entry.t], r: [...entry.r], s: [...entry.s] }))
    world = nodes.map(() => identity())

    skins = (json.skins ?? []).map((skin) => {
      const inverse = typeof skin.inverseBindMatrices === 'number'
        ? readAccessor(next, skin.inverseBindMatrices).data as Float32Array
        : (() => { const all = new Float32Array(skin.joints.length * 16); for (let i = 0; i < skin.joints.length; i++) all.set(identity(), i * 16); return all })()
      if (skin.joints.length > jointLimit) note = 'This skeleton has ' + skin.joints.length + ' bones; this browser draws up to ' + jointLimit + ', so the model is shown in its rest pose.'
      return { joints: skin.joints, inverse, matrices: new Float32Array(Math.min(skin.joints.length, jointLimit) * 16) }
    })

    const texture = (imageIndex: number | undefined) => {
      const bitmap = imageIndex === undefined ? null : bitmaps[imageIndex]
      if (!bitmap) return null
      const t = gl.createTexture()!
      owned.textures.push(t)
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      byImage.set(imageIndex!, [...(byImage.get(imageIndex!) ?? []), t])
      return t
    }
    const sourceOf = (info: { index: number } | undefined) => info ? json.textures?.[info.index]?.source : undefined
    materials = (json.materials ?? []).map((material) => ({
      colour: texture(sourceOf(material.pbrMetallicRoughness?.baseColorTexture)),
      normal: texture(sourceOf(material.normalTexture)),
      tint: Array.isArray(material.pbrMetallicRoughness?.baseColorFactor) ? material.pbrMetallicRoughness.baseColorFactor as number[] : [1, 1, 1, 1],
      doubleSided: material.doubleSided === true,
    }))

    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    const built = new Map<number, Primitive[]>()
    const buildMesh = (meshIndex: number): Primitive[] => {
      const cached = built.get(meshIndex)
      if (cached) return cached
      const primitives: Primitive[] = []
      for (const primitive of json.meshes?.[meshIndex]?.primitives ?? []) {
        if ((primitive.mode ?? 4) !== 4 || typeof primitive.attributes.POSITION !== 'number') continue
        const vao = gl.createVertexArray()!
        owned.vaos.push(vao)
        gl.bindVertexArray(vao)
        const attribute = (location: number, name: string, fallback: number[] | null) => {
          const accessorIndex = primitive.attributes[name]
          if (typeof accessorIndex !== 'number') {
            if (fallback) gl.vertexAttrib4f(location, fallback[0], fallback[1], fallback[2], fallback[3])
            return null
          }
          const { data, size } = readAccessor(next, accessorIndex)
          const buffer = gl.createBuffer()!
          owned.buffers.push(buffer)
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
          gl.bufferData(gl.ARRAY_BUFFER, data instanceof Float32Array ? data : Float32Array.from(data), gl.STATIC_DRAW)
          gl.enableVertexAttribArray(location)
          gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0)
          return data
        }
        const positions = attribute(0, 'POSITION', null)!
        attribute(1, 'NORMAL', [0, 0, 1, 0])
        attribute(2, 'TEXCOORD_0', [0, 0, 0, 0])
        const joints = attribute(3, 'JOINTS_0', [0, 0, 0, 0])
        const weights = attribute(4, 'WEIGHTS_0', [1, 0, 0, 0])
        attribute(5, 'TANGENT', [0, 0, 0, 0])
        for (let at = 0; at < positions.length; at += 3) {
          for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], positions[at + axis]); max[axis] = Math.max(max[axis], positions[at + axis])
          }
        }
        let count = positions.length / 3
        let indexType = 0
        if (typeof primitive.indices === 'number') {
          const indices = readAccessor(next, primitive.indices).data as Uint32Array
          const buffer = gl.createBuffer()!
          owned.buffers.push(buffer)
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer)
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
          count = indices.length
          indexType = gl.UNSIGNED_INT
        }
        primitives.push({ vao, count, indexType, material: typeof primitive.material === 'number' ? primitive.material : -1, skinnedData: Boolean(joints && weights) })
      }
      gl.bindVertexArray(null)
      built.set(meshIndex, primitives)
      return primitives
    }
    const hasBody = nodes.some((node) => typeof node.mesh === 'number' && isBodyNode(node))
    meshNodes = []
    nodes.forEach((node, index) => {
      if (typeof node.mesh !== 'number') return
      const hiddenBy = Array.isArray(node.extras?.hiddenBy) ? (node.extras.hiddenBy as unknown[]).map(String) : null
      meshNodes.push({
        node: index,
        name: node.name ?? 'part ' + (meshNodes.length + 1),
        skin: typeof node.skin === 'number' && skins[node.skin] && skins[node.skin].joints.length <= jointLimit ? node.skin : -1,
        primitives: buildMesh(node.mesh),
        visible: true,
        hiddenBy: hiddenBy ?? (hasBody && isBodyNode(node) ? [] : null),
      })
    })
    const items = meshNodes.filter((mesh) => !mesh.hiddenBy).map((mesh) => mesh.name)
    const toggles = hasBody ? items : items.length > 1 ? items : []
    for (const name of [...shown.keys()]) if (!toggles.includes(name)) shown.delete(name)
    applyVisibility()

    clips = (json.animations ?? []).map((animation, index) => {
      const channels: Channel[] = []
      let duration = 0
      for (const channel of animation.channels ?? []) {
        const sampler = animation.samplers?.[channel.sampler]
        const node = channel.target?.node
        const path = channel.target?.path
        if (!sampler || typeof node !== 'number' || node >= nodes.length || !['translation', 'rotation', 'scale'].includes(path)) continue
        try {
          const times = readAccessor(next, sampler.input).data as Float32Array
          const output = readAccessor(next, sampler.output)
          if (!times.length) continue
          duration = Math.max(duration, times[times.length - 1])
          channels.push({ node, path, times, values: output.data as Float32Array, width: path === 'rotation' ? 4 : 3, mode: sampler.interpolation ?? 'LINEAR' })
        } catch { /* a track that cannot be read is left out */ }
      }
      return { name: animation.name ?? 'animation ' + index, duration, channels }
    }).filter((clip) => clip.channels.length)
    if (!clips.some((clip) => clip.name === activeClip)) {
      activeClip = (clips.find((clip) => /idle/i.test(clip.name)) ?? clips.find((clip) => /walk/i.test(clip.name)) ?? clips[0])?.name ?? null
      time = 0
    }

    if (min[0] <= max[0]) {
      centre = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
      radius = Math.max(0.01, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2)
    }
    if (!framed) { distance = radius / Math.sin((30 * Math.PI / 180) / 2) * 1.05; framed = true }
    return { items: toggles, clips: clips.map((clip) => clip.name), note }
  }

  const scratch = [0, 0, 0, 0]
  function animate() {
    for (let i = 0; i < pose.length; i++) {
      const p = pose[i], r = rest[i]
      p.t[0] = r.t[0]; p.t[1] = r.t[1]; p.t[2] = r.t[2]
      p.r[0] = r.r[0]; p.r[1] = r.r[1]; p.r[2] = r.r[2]; p.r[3] = r.r[3]
      p.s[0] = r.s[0]; p.s[1] = r.s[1]; p.s[2] = r.s[2]
    }
    const clip = clips.find((candidate) => candidate.name === activeClip)
    if (clip) {
      const at = clip.duration > 0 ? time % clip.duration : 0
      for (const channel of clip.channels) {
        const { times, values, width } = channel
        let hi = 0
        while (hi < times.length && times[hi] <= at) hi++
        const lo = Math.max(0, hi - 1)
        hi = Math.min(times.length - 1, hi)
        const span = times[hi] - times[lo]
        const t = channel.mode === 'STEP' || span <= 0 ? 0 : Math.min(1, Math.max(0, (at - times[lo]) / span))
        // A cubic spline stores in-tangent, value, out-tangent per key; the values alone, blended straight, are close enough to look at.
        const stride = channel.mode === 'CUBICSPLINE' ? width * 3 : width
        const offset = channel.mode === 'CUBICSPLINE' ? width : 0
        const a = lo * stride + offset, b = hi * stride + offset
        const target = channel.path === 'translation' ? pose[channel.node].t : channel.path === 'rotation' ? pose[channel.node].r : pose[channel.node].s
        if (channel.path === 'rotation') { slerp(values, a, values, b, t, scratch); target[0] = scratch[0]; target[1] = scratch[1]; target[2] = scratch[2]; target[3] = scratch[3] }
        else for (let i = 0; i < 3; i++) target[i] = values[a + i] + (values[b + i] - values[a + i]) * t
      }
    }
    const local = new Float32Array(16)
    for (const index of order) {
      const matrix = rest[index].matrix
      const own = matrix ?? compose(pose[index].t, pose[index].r, pose[index].s, local)
      if (parents[index] >= 0) multiply(world[parents[index]], own, world[index])
      else world[index].set(own)
    }
    const joint = new Float32Array(16)
    for (const skin of skins) {
      const drawn = skin.matrices.length / 16
      for (let i = 0; i < drawn; i++) {
        multiply(world[skin.joints[i]], skin.inverse.subarray(i * 16, i * 16 + 16) as Mat4, joint)
        skin.matrices.set(joint, i * 16)
      }
    }
  }

  function draw() {
    const width = canvas.width, height = canvas.height
    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    if (!doc || !width || !height) return
    animate()
    gl.enable(gl.DEPTH_TEST)
    gl.useProgram(program)
    const eye = [
      centre[0] + distance * Math.cos(pitch) * Math.sin(yaw),
      centre[1] + distance * Math.sin(pitch),
      centre[2] + distance * Math.cos(pitch) * Math.cos(yaw),
    ]
    const projection = perspective(30 * Math.PI / 180, width / height, Math.max(0.01, distance - radius * 4), distance + radius * 4)
    gl.uniformMatrix4fv(U.viewProjection, false, multiply(projection, lookAt(eye, centre)))
    // The light rides with the camera, up and to the left of it, so a turned model is never in its own shadow.
    const lx = Math.sin(yaw - 0.7) * 0.75, lz = Math.cos(yaw - 0.7) * 0.75
    const ll = Math.hypot(lx, 0.7, lz)
    gl.uniform3f(U.light, lx / ll, 0.7 / ll, lz / ll)
    gl.uniform1i(U.colour, 0)
    gl.uniform1i(U.normalMap, 1)
    for (const mesh of meshNodes) {
      if (!mesh.visible) continue
      const skin = mesh.skin >= 0 ? skins[mesh.skin] : null
      if (skin) gl.uniformMatrix4fv(U.joints, false, skin.matrices)
      gl.uniformMatrix4fv(U.model, false, world[mesh.node])
      for (const primitive of mesh.primitives) {
        const material = materials[primitive.material]
        gl.uniform1i(U.skinned, skin && primitive.skinnedData ? 1 : 0)
        gl.uniform4fv(U.tint, material ? material.tint : [1, 1, 1, 1])
        gl.uniform1i(U.hasColour, material?.colour ? 1 : 0)
        gl.uniform1i(U.hasNormalMap, material?.normal ? 1 : 0)
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, material?.colour ?? null)
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, material?.normal ?? null)
        if (material?.doubleSided) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE)
        gl.bindVertexArray(primitive.vao)
        if (primitive.indexType) gl.drawElements(gl.TRIANGLES, primitive.count, primitive.indexType, 0)
        else gl.drawArrays(gl.TRIANGLES, 0, primitive.count)
      }
    }
    gl.bindVertexArray(null)
  }

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.round(host.clientWidth * ratio)), height = Math.max(1, Math.round(host.clientHeight * ratio))
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
  }
  const observer = new ResizeObserver(resize)
  observer.observe(host)
  resize()

  let frame = 0
  let last = performance.now()
  const tick = (now: number) => {
    if (disposed) return
    // A canvas that left the page stops costing anything.
    if (!canvas.isConnected) { dispose(); return }
    frame = requestAnimationFrame(tick)
    const delta = Math.min(0.1, (now - last) / 1000)
    last = now
    if (playing) time += delta
    draw()
  }
  frame = requestAnimationFrame(tick)

  // Drag to turn. The wheel is left to the page, so scrolling past the model never stops on it.
  let dragging: { x: number; y: number } | null = null
  canvas.addEventListener('pointerdown', (e) => { dragging = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId) })
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return
    yaw -= (e.clientX - dragging.x) * 0.01
    pitch = Math.max(-1.4, Math.min(1.4, pitch + (e.clientY - dragging.y) * 0.01))
    dragging = { x: e.clientX, y: e.clientY }
  })
  const release2 = () => { dragging = null }
  canvas.addEventListener('pointerup', release2)
  canvas.addEventListener('pointercancel', release2)
  canvas.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { yaw -= 0.15; e.preventDefault(); e.stopPropagation() }
    else if (e.key === 'ArrowRight') { yaw += 0.15; e.preventDefault(); e.stopPropagation() }
  })
  canvas.tabIndex = 0

  function dispose() {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(frame)
    observer.disconnect()
    release()
    gl.deleteProgram(program)
    canvas.remove()
  }

  return {
    canvas,
    show,
    setClip: (name) => { if (name !== activeClip) { activeClip = name; time = 0 } },
    clip: () => activeClip,
    setPlaying: (on) => { playing = on },
    playing: () => playing,
    setItem: (name, on) => { shown.set(name, on); applyVisibility() },
    itemShown: (name) => shown.get(name) ?? true,
    zoom: (factor) => { distance = Math.max(radius * 0.6, Math.min(radius * 30, distance * factor)) },
    resetCamera: () => { yaw = 0.5; pitch = 0.18; distance = radius / Math.sin((30 * Math.PI / 180) / 2) * 1.05 },
    coverage: () => {
      draw()
      const pixels = new Uint8Array(canvas.width * canvas.height * 4)
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      let covered = 0
      for (let at = 3; at < pixels.length; at += 4) if (pixels[at] > 0) covered++
      return pixels.length ? covered / (pixels.length / 4) : 0
    },
    image: (index) => bitmaps[index] ?? null,
    setImage: (index, source) => {
      for (const t of byImage.get(index) ?? []) {
        gl.bindTexture(gl.TEXTURE_2D, t)
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
        gl.generateMipmap(gl.TEXTURE_2D)
      }
    },
    dispose,
  }
}
