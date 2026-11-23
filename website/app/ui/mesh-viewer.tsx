"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/** Every model the site can show. `pixel` says whether its pixel look starts on. */
const SUBJECTS = [
  { id: "parts", label: "Painted, from 256 px sprites", pixel: false },
  { id: "heavy", label: "Second body, same items", pixel: false },
  { id: "great", label: "Two hands on a greatsword", pixel: false },
  { id: "spear", label: "Two hands on a spear", pixel: false },
  { id: "pixel", label: "Pixel, from 64 px sprites", pixel: true },
] as const;
export type MeshSubject = (typeof SUBJECTS)[number]["id"];
type SubjectId = MeshSubject;

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
  setClip: (name: string) => void;
  dispose: () => void;
};

/**
 * A real mesh in the page: the character's shape generated from its sprites,
 * painted from them by a second model, hung on a fifteen-bone skeleton and
 * given a walk. The
 * file it loads is the .glb a game engine would import. three.js is fetched
 * only when this mounts.
 */
export function MeshViewer({ subjects, initial }: { subjects?: MeshSubject[]; initial?: MeshSubject } = {}) {
  const offered = SUBJECTS.filter((entry) => !subjects || subjects.includes(entry.id));
  const start = initial ?? offered[0]!.id;
  const host = useRef<HTMLDivElement>(null);
  const controls = useRef<Controls | null>(null);
  const [subject, setSubject] = useState<SubjectId>(start);
  // The separate meshes the loaded file holds besides the body, and which of them are shown.
  const [items, setItems] = useState<string[]>([]);
  const [worn, setWorn] = useState<Record<string, boolean>>({});
  // The animations the loaded file carries, and the one playing.
  const [clips, setClips] = useState<string[]>([]);
  const [clip, setClip] = useState("Walk");
  const [walking, setWalking] = useState(true);
  const [spinning, setSpinning] = useState(false);
  const [pixel, setPixel] = useState<boolean>(SUBJECTS.find((entry) => entry.id === start)!.pixel);
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
    setClips([]);

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
      // Pieces of the body, each with the names of the items that cover it. A piece is hidden while any of them is worn.
      const skin: Array<{ piece: import("three").Object3D; hiddenBy: string[] }> = [];
      const wornNow = new Map<string, boolean>();
      const showSkin = () => { for (const { piece, hiddenBy } of skin) piece.visible = !hiddenBy.some((item) => wornNow.get(item) ?? true); };
      let play: (name: string) => void = () => {};
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
          // A thinned model carries its lost relief as a normal map, and the tangents it was baked against.
          mesh.material = new THREE.MeshToonMaterial({ map: source.map, gradientMap: ramp, normalMap: source.normalMap ?? null });
          mesh.frustumCulled = false;
          // Every mesh but the body is something the character wears, on the same skeleton.
          const hiddenBy: unknown = mesh.userData?.hiddenBy;
          if (Array.isArray(hiddenBy)) skin.push({ piece: mesh, hiddenBy: hiddenBy.map((item) => String(item).replaceAll(" ", "_")) });
          else if (mesh.name !== "Character") parts.set(mesh.name, mesh);
        });
        showSkin();
        setItems([...parts.keys()]);
        setWorn(Object.fromEntries([...parts.keys()].map((name) => [name, true])));
        scene.add(gltf.scene);
        helper = new THREE.SkeletonHelper(gltf.scene);
        helper.visible = false;
        scene.add(helper);
        mixer = new THREE.AnimationMixer(gltf.scene);
        const first = gltf.animations.find((entry) => entry.name === "Great_Walk") ?? gltf.animations.find((entry) => entry.name === "Spear_Walk") ?? gltf.animations.find((entry) => entry.name === "Shield_Walk") ?? gltf.animations.find((entry) => entry.name === "Walk_Loop") ?? gltf.animations.find((entry) => entry.name === "Walk") ?? gltf.animations[0];
        if (first) {
          action = mixer.clipAction(first);
          action.play();
          action.paused = !playing;
        }
        setClips(gltf.animations.map((entry) => entry.name));
        setClip(first?.name ?? "");
        play = (name) => {
          const next = gltf.animations.find((entry) => entry.name === name);
          if (!next || !mixer) return;
          mixer.stopAllAction();
          action = mixer.clipAction(next);
          action.reset().play();
          action.paused = !playing;
        };
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
        setWorn: (item, on) => { const part = parts.get(item); if (part) part.visible = on; wornNow.set(item, on); showSkin(); },
        setClip: (name) => play(name),
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
          <a className="text-link" href={`/models/${subject}.glb`} download>Download this model</a>, with its skeleton and {clips.length > 1 ? "animations" : "walk"}.
        </p>
      </div>
      <div className="builder-controls">
        <div className="builder-slot" role="group" aria-label="Model" hidden={offered.length < 2}>
          <span className="builder-slot-label">Model</span>
          <div className="builder-options">
            {offered.map((option) => (
              <button key={option.id} type="button" className="builder-option" aria-pressed={subject === option.id} onClick={() => { setSubject(option.id); setPixel(option.pixel); }}>
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
        {clips.length > 1 ? (
          <div className="builder-slot" role="group" aria-label="Animation">
            <span className="builder-slot-label">Motion</span>
            <div className="builder-options">
              {clips.map((name) => (
                <button key={name} type="button" className="builder-option" aria-pressed={clip === name} onClick={() => { setClip(name); controls.current?.setClip(name); }}>
                  {name.replaceAll("_", " ").replace(/ Loop$/, "")}
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
        {subject === "heavy" ? (
          <p className="spin-note">
            Drag to turn it. A different body, heavier and broader, wearing
            the items made on the first one. Nothing was redrawn or meshed
            again for him but his own body. Each item was reshaped to his
            bones and to how much thicker he is, then fitted to his skin.
            His hands were drawn as closed fists, so they have no finger
            bones: the sword runs through his right fist, which is found
            on the mesh. The shield is strapped across his left forearm. Pick the shield block or the shield bash to see it used. Take the
            armour off to see the body under it.
          </p>
        ) : subject === "great" ? (
          <p className="spin-note">
            Drag to turn it. The first body with a greatsword in both
            hands. No free library has two-handed motions, so the four
            named Great were made here: the path of the sword is written
            down and both arms are solved to it, over the legs and trunk
            of a stock idle, walk and jog. Pick the great attack. The
            other motions are stock one-handed ones bent until the
            second hand reaches the grip, and some of those bend a wrist
            further than a wrist goes.
          </p>
        ) : subject === "spear" ? (
          <p className="spin-note">
            Drag to turn it. The first body with a generated spear, the
            left hand forward and the right a way behind it on the
            shaft. The five motions named Spear were made here the same
            way as the greatsword&apos;s: the shaft&apos;s path is
            written down and both arms are solved to it. He stands
            side-on, the left shoulder and foot forward and the head
            looking along the shaft. Pick the spear thrust, which steps
            out with the left foot, or the spear advance, which
            moves forward without leaving the stance. The other
            motions are stock one-handed ones bent towards the shaft,
            and in those the right hand is often a few centimetres off
            it.
          </p>
        ) : subject === "pixel" ? (
          <p className="spin-note">
            Drag to turn it. The same character made the cheaper way: sprites
            drawn at 64 pixels, meshed and painted from those sprites with no
            redraw, and its colours snapped to the sprites&apos; own. It is
            stocky, because a 64 pixel sprite gives a quarter of its height
            to the head, and its texture is soft under the pixel look. It
            has the same body skeleton, the same separate items and the
            same motions as the painted one, in half the triangles. Its
            hands are too small to have a thumb apart, so they get no
            finger bones.
          </p>
        ) : subject === "parts" ? (
          <p className="spin-note">
            Drag to turn it. The body and each thing it wears are separate
            meshes on one skeleton, in one file. The generator drew the
            bare figure at 256 pixels in eight directions, then the same
            figure wearing each item. An image model redrew every one of
            those large, and both the shapes and the paint come from the
            redraws. Each item is cut out of the mesh of the figure
            wearing it, moved to just above the skin, and follows the
            body&apos;s bones. The skin under an item is hidden while the
            item is worn. Every part was then thinned to a fifth of its
            triangles, with its paint and relief baked back on. The
            motions other than the first walk come from a free animation
            library made for a different skeleton, carried over bone by
            bone. The sword is a separate mesh too, made from eight
            sprites of a sword and placed in the right hand, whose thumb
            and fingers have bones and close round the grip. The
            shield, made the same way, is strapped across the left forearm.
            Pick the shield block or the shield bash to see it used. Switch the pixel look on to see
            it as pixel art.
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
