"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const SUBJECTS = [
  { id: "knight", label: "Dark knight" },
  { id: "hero", label: "Bare base" },
] as const;
type SubjectId = (typeof SUBJECTS)[number]["id"];

/** Screen pixels per rendered pixel when the pixel look is on. */
const PIXEL = 3;

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
  const [subject, setSubject] = useState<SubjectId>("knight");
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

      let mixer: import("three").AnimationMixer | null = null;
      let action: import("three").AnimationAction | null = null;
      let helper: import("three").SkeletonHelper | null = null;
      let pixelOn = true;
      let playing = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      const resize = () => {
        const width = element.clientWidth;
        const height = element.clientHeight;
        const step = pixelOn ? PIXEL : 1 / Math.min(window.devicePixelRatio || 1, 2);
        renderer.setSize(Math.max(1, Math.round(width / step)), Math.max(1, Math.round(height / step)), false);
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
          mesh.material = new THREE.MeshToonMaterial({ map: source.map, gradientMap: ramp });
          mesh.frustumCulled = false;
        });
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
        renderer.render(scene, camera);
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
        <p className="spin-note">
          Drag to turn it. This is one mesh, not
          frames. Its shape is generated from four of the eight sprites. Its
          surface is painted by a second model, shown each sprite in turn with
          the mesh turned to face it. Fifteen bones are placed from the joints
          found in each view, and the walk turns those bones. Seams still show
          where two painted views meet.
        </p>
      </div>
    </div>
  );
}
