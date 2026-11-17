"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const SUBJECTS = [
  { id: "parts", label: "Dressed from parts" },
  { id: "knight", label: "Dark knight, one piece" },
  { id: "hero", label: "Bare base" },
] as const;
type SubjectId = (typeof SUBJECTS)[number]["id"];

/** Screen pixels per rendered pixel when the pixel look is on. */
const PIXEL = 3;
/** The most colours the pixel look snaps to. */
const PALETTE_MAX = 32;

function subscribeReducedMotion(callback: () => void) {
  const list = window.matchMedia("(prefers-reduced-motion: reduce)");
  list.addEventListener("change", callback);
  return () => list.removeEventListener("change", callback);
}

type Controls = {
  setWalking: (on: boolean) => void;
  setSpinning: (on: boolean) => void;
  setPixel: (on: boolean) => void;
  setBones: (on: boolean) => void;
  setWorn: (item: string, on: boolean) => void;
  dispose: () => void;
};

/**
 * A real mesh in the page: the character's shape generated from its sprites,
 * painted from them by a second model, hung on a fifteen-bone skeleton and
 * given a walk. The
 * file it loads is the .glb a game engine would import. three.js is fetched
 * only when this mounts.
 */
export function MeshViewer() {
  const host = useRef<HTMLDivElement>(null);
  const controls = useRef<Controls | null>(null);
  const [subject, setSubject] = useState<SubjectId>("parts");
  // The separate meshes the loaded file holds besides the body, and which of them are shown.
  const [items, setItems] = useState<string[]>([]);
  const [worn, setWorn] = useState<Record<string, boolean>>({});
  const [walking, setWalking] = useState(true);
  const [spinning, setSpinning] = useState(false);
  const [pixel, setPixel] = useState(true);
  const [bones, setBones] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let cancelled = false;
    let cleanup = () => {};
    setStatus("loading");
    setItems([]);

    (async () => {
      const THREE = await import("three");
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      if (cancelled) return;

      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
      } catch {
        setStatus("failed");
        return;
      }
      const canvas = renderer.domElement;
      canvas.className = "mesh-canvas";
      element.appendChild(canvas);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
      camera.position.set(2.6, 1.9, 4.6);
      const orbit = new OrbitControls(camera, canvas);
      orbit.target.set(0, 0.9, 0);
      orbit.enablePan = false;
      // No zoom: the wheel belongs to the page, or scrolling past the model would stop here.
      orbit.enableZoom = false;
      orbit.maxPolarAngle = Math.PI * 0.55;
      orbit.autoRotateSpeed = 3;
      orbit.update();

      scene.add(new THREE.AmbientLight(0xffffff, 1.5));
      const sun = new THREE.DirectionalLight(0xffffff, 2.2);
      sun.position.set(-2.5, 4, 3);
      scene.add(sun);

      // Three flat bands of light, the way the sprites are shaded.
      const ramp = new THREE.DataTexture(new Uint8Array([150, 150, 150, 255, 205, 205, 205, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat);
      ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
      ramp.needsUpdate = true;

      // The pixel look is drawn in two steps: the scene into a small picture, then that picture onto the
      // canvas with each pixel moved to the nearest of the sprites' own colours and a dark line drawn
      // inside the outline, the way the sprites are drawn.
      const target = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      const post = new THREE.ShaderMaterial({
        transparent: true,
        depthTest: false,
        uniforms: {
          frame: { value: target.texture },
          texel: { value: new THREE.Vector2(1, 1) },
          palette: { value: Array.from({ length: PALETTE_MAX }, () => new THREE.Vector3()) },
          count: { value: 0 },
        },
        vertexShader: "varying vec2 at; void main() { at = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
        fragmentShader: `
          uniform sampler2D frame; uniform vec2 texel; uniform vec3 palette[${PALETTE_MAX}]; uniform int count; varying vec2 at;
          void main() {
            vec4 here = texture2D(frame, at);
            if (here.a < 0.5) discard;
            vec3 colour = pow(here.rgb, vec3(1.0 / 2.2));
            if (count > 0) {
              vec3 best = colour; float nearest = 1e9;
              for (int i = 0; i < ${PALETTE_MAX}; i++) {
                if (i >= count) break;
                vec3 gap = (palette[i] - colour) * vec3(0.55, 1.0, 0.4);
                float d = dot(gap, gap);
                if (d < nearest) { nearest = d; best = palette[i]; }
              }
              colour = best;
            }
            float around = min(min(texture2D(frame, at + vec2(texel.x, 0.0)).a, texture2D(frame, at - vec2(texel.x, 0.0)).a),
                               min(texture2D(frame, at + vec2(0.0, texel.y)).a, texture2D(frame, at - vec2(0.0, texel.y)).a));
            if (around < 0.5) colour *= 0.3;
            gl_FragColor = vec4(colour, 1.0);
          }`,
      });
      const postScene = new THREE.Scene();
      postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post));
      const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

      let mixer: import("three").AnimationMixer | null = null;
      let action: import("three").AnimationAction | null = null;
      let helper: import("three").SkeletonHelper | null = null;
      const parts = new Map<string, import("three").Object3D>();
      let pixelOn = true;
      let playing = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      const resize = () => {
        const width = element.clientWidth;
        const height = element.clientHeight;
        const step = pixelOn ? PIXEL : 1 / Math.min(window.devicePixelRatio || 1, 2);
        const across = Math.max(1, Math.round(width / step));
        const down = Math.max(1, Math.round(height / step));
        renderer.setSize(across, down, false);
        target.setSize(across, down);
        post.uniforms.texel.value.set(1 / across, 1 / down);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(element);
      resize();

      try {
        const gltf = await new GLTFLoader().loadAsync(`/models/${subject}.glb`);
        if (cancelled) return;
        gltf.scene.traverse((node) => {
          const mesh = node as import("three").SkinnedMesh;
          if (!mesh.isMesh) return;
          const source = mesh.material as import("three").MeshStandardMaterial;
          if (source.map) {
            // The texture holds more detail than the low-resolution render has pixels. Averaging it down
            // gives clean pixels; picking single texels gives noise.
            source.map.magFilter = THREE.LinearFilter;
            source.map.minFilter = THREE.LinearMipmapLinearFilter;
            source.map.generateMipmaps = true;
            source.map.needsUpdate = true;
          }
          // The model carries the sprites' colours with it, as hex strings on its material.
          const colours: unknown = source.userData?.palette;
          if (Array.isArray(colours)) {
            const list = colours.filter((entry): entry is string => typeof entry === "string").slice(0, PALETTE_MAX);
            list.forEach((hex, index) => {
              const value = Number.parseInt(hex.replace("#", ""), 16);
              post.uniforms.palette.value[index].set(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
            });
            post.uniforms.count.value = list.length;
          }
          mesh.material = new THREE.MeshToonMaterial({ map: source.map, gradientMap: ramp });
          mesh.frustumCulled = false;
          // Every mesh but the body is something the character wears, on the same skeleton.
          if (mesh.name !== "Character") parts.set(mesh.name, mesh);
        });
        setItems([...parts.keys()]);
        setWorn(Object.fromEntries([...parts.keys()].map((name) => [name, true])));
        scene.add(gltf.scene);
        helper = new THREE.SkeletonHelper(gltf.scene);
        helper.visible = false;
        scene.add(helper);
        mixer = new THREE.AnimationMixer(gltf.scene);
        const clip = gltf.animations.find((entry) => entry.name === "Walk") ?? gltf.animations[0];
        if (clip) {
          action = mixer.clipAction(clip);
          action.play();
          action.paused = !playing;
        }
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("failed");
      }

      const clock = new THREE.Clock();
      let frame = 0;
      const tick = () => {
        frame = requestAnimationFrame(tick);
        const delta = clock.getDelta();
        mixer?.update(delta);
        orbit.update();
        if (pixelOn) {
          renderer.setRenderTarget(target);
          renderer.clear();
          renderer.render(scene, camera);
          renderer.setRenderTarget(null);
          renderer.render(postScene, postCamera);
        } else {
          renderer.render(scene, camera);
        }
      };
      tick();

      controls.current = {
        setWalking: (on) => {
          playing = on;
          if (action) {
            action.paused = !on;
            if (!on) action.time = 0;
          }
        },
        setSpinning: (on) => { orbit.autoRotate = on; },
        setPixel: (on) => { pixelOn = on; canvas.classList.toggle("mesh-canvas-smooth", !on); resize(); },
        setBones: (on) => { if (helper) helper.visible = on; },
        setWorn: (item, on) => { const part = parts.get(item); if (part) part.visible = on; },
        dispose: () => {},
      };
      // Bring a freshly loaded model in line with the switches as they stand.
      controls.current.setPixel(element.dataset.pixel !== "off");
      controls.current.setBones(element.dataset.bones === "on");
      controls.current.setSpinning(element.dataset.spin === "on");
      controls.current.setWalking(element.dataset.walk !== "off" && playing);

      cleanup = () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        orbit.dispose();
        target.dispose();
        post.dispose();
        renderer.dispose();
        canvas.remove();
        controls.current = null;
      };
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [subject]);

  useEffect(() => { controls.current?.setWalking(walking && !reducedMotion); }, [walking, reducedMotion, status]);
  useEffect(() => { controls.current?.setSpinning(spinning && !reducedMotion); }, [spinning, reducedMotion, status]);
  useEffect(() => { controls.current?.setPixel(pixel); }, [pixel, status]);
  useEffect(() => { controls.current?.setBones(bones); }, [bones, status]);
  useEffect(() => { for (const [item, on] of Object.entries(worn)) controls.current?.setWorn(item, on); }, [worn, status]);

  const subjectLabel = SUBJECTS.find((entry) => entry.id === subject)!.label.toLowerCase();

  return (
    <div className="spin">
      <div className="spin-stage-column">
        <div
          ref={host}
          className="mesh-stage"
          data-walk={walking ? "on" : "off"}
          data-spin={spinning ? "on" : "off"}
          data-pixel={pixel ? "on" : "off"}
          data-bones={bones ? "on" : "off"}
          role="img"
          aria-label={`A 3D model of the ${subjectLabel}${walking ? ", walking" : ""}. Drag to turn it.`}
        >
          {status !== "ready" ? (
            <p className="mesh-status">{status === "loading" ? "Loading the model" : "This browser could not draw the model."}</p>
          ) : null}
        </div>
        <div className="builder-motion">
          <button type="button" className="builder-toggle" aria-pressed={walking} onClick={() => setWalking((current) => !current)}>
            {walking ? "Stand" : "Walk"}
          </button>
          <button type="button" className="builder-toggle" aria-pressed={spinning} onClick={() => setSpinning((current) => !current)}>
            {spinning ? "Stop" : "Spin"}
          </button>
        </div>
        <p className="builder-readout">
          <span>.glb</span>
          <a className="text-link" href={`/models/${subject}.glb`} download>Download this model</a>, with its skeleton and walk.
        </p>
      </div>
      <div className="builder-controls">
        <div className="builder-slot" role="group" aria-label="Character">
          <span className="builder-slot-label">Character</span>
          <div className="builder-options">
            {SUBJECTS.map((option) => (
              <button key={option.id} type="button" className="builder-option" aria-pressed={subject === option.id} onClick={() => setSubject(option.id)}>
                {option.label}
              </button>
            ))}
          </div>
        </div>
        {items.length > 0 ? (
          <div className="builder-slot" role="group" aria-label="What the character wears">
            <span className="builder-slot-label">Wearing</span>
            <div className="builder-options">
              {items.map((item) => (
                <button key={item} type="button" className="builder-option" aria-pressed={worn[item] ?? true} onClick={() => setWorn((current) => ({ ...current, [item]: !(current[item] ?? true) }))}>
                  {item.replaceAll("_", " ")}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="builder-slot" role="group" aria-label="How it is drawn">
          <span className="builder-slot-label">Show</span>
          <div className="builder-options">
            <button type="button" className="builder-option" aria-pressed={pixel} onClick={() => setPixel((current) => !current)}>
              Pixel look
            </button>
            <button type="button" className="builder-option" aria-pressed={bones} onClick={() => setBones((current) => !current)}>
              Skeleton
            </button>
          </div>
        </div>
        {subject === "parts" ? (
          <p className="spin-note">
            Drag to turn it. The body and each thing it wears are separate
            meshes on one skeleton, in one file. Each item was drawn as its
            own sprite layer over the bare body, the way the 2D builder
            above does it. The body was then meshed wearing that one item,
            and the item cut out of the result wherever its layer has
            pixels. Items are moved to just above the skin and follow the
            body&apos;s bones. Every part is painted by a second model
            from its own sprites. Skin can still show through the armour
            while it walks.
          </p>
        ) : (
          <p className="spin-note">
            Drag to turn it. This is one mesh, not
            frames. The character was first redrawn with its arms out, and its
            shape generated from four of those eight sprites. Its surface is
            painted by a second model, shown each sprite in turn with the mesh
            turned to face it. Fifteen bones are placed from the joints found
            in each view, and the walk lowers the arms and turns those bones.
            The pixel look snaps every pixel to the sprites&apos; own colours.
            The cape is still rigid.
          </p>
        )}
      </div>
    </div>
  );
}
