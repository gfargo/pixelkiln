import Image from "next/image";
import type { Feature } from "@/app/lib/features";

/** The picture that stands for a feature in the hub and the menu: always a real output of that feature. */
export function FeatureArt({ id }: { id: Feature["id"] }) {
  switch (id) {
    case "pipeline":
      return (
        <div className="feature-art feature-art-shot">
          <Image src="/review-ui-showcase.jpg" alt="The local review sheet: candidates for one sprite side by side, one chosen" width={1280} height={720} sizes="(max-width: 980px) 100vw, 560px" />
        </div>
      );
    case "review":
      return (
        <div className="feature-art feature-art-shot">
          <Image src="/gallery-ui-showcase.jpg" alt="The local gallery page listing a project's sprites with their status and cost" width={1280} height={720} sizes="(max-width: 980px) 100vw, 560px" />
        </div>
      );
    case "characters":
      return (
        <div className="feature-art feature-art-sheet">
          <Image src="/showcase/assets/knight-8dir.png" alt="A knight in plate armour and a blue cape drawn from eight directions" width={1128} height={568} unoptimized />
        </div>
      );
    case "skeletons":
      return (
        <div className="feature-art feature-art-strip">
          <Image src="/showcase/skeleton/wave-poses-three.png" alt="An adventurer sprite three times with its 18-joint skeleton drawn over it: the estimated pose, arms half raised, and a full wave" width={592} height={200} unoptimized />
        </div>
      );
    case "paperdoll":
      return (
        <div className="feature-art feature-art-strip">
          <Image src="/sprites/paperdoll/showcase-stack.png" alt="A bare figure, a suit of armour, a helm and cape, a sword and shield, and all of them stacked into a knight" width={476} height={92} unoptimized />
        </div>
      );
    case "effects":
      return (
        <div className="feature-art feature-art-effects">
          {[
            ["/effects/robot-aura-still.png", "A blue aura around the robot"],
            ["/effects/robot-lightning-still.png", "Lightning striking the robot"],
            ["/effects/robot-shield-still.png", "A shield bubble around the robot"],
          ].map(([src, alt]) => (
            <Image key={src} src={src!} alt={alt!} width={192} height={224} unoptimized />
          ))}
        </div>
      );
    case "tiles":
      return (
        <div className="feature-art feature-art-sheet">
          <Image src="/showcase/tilesets/island.png" alt="A sandy island with a grass meadow in the middle, surrounded by ocean, built from two connected tilesets" width={448} height={320} unoptimized />
        </div>
      );
    case "updates":
      return (
        <div className="feature-art feature-art-sheet">
          <Image src="/showcase/pixflux/knight-options.png" alt="Four pixel art knights drawn with different pixflux style controls" width={1064} height={272} unoptimized />
        </div>
      );
    case "providers":
      return (
        <div className="feature-art feature-art-samples">
          {[
            ["/benchmarks/provider-environments/pixellab/isolated/a/mountain-observatory.png", "PixelLab's mountain observatory"],
            ["/benchmarks/provider-environments/retrodiffusion/isolated/a/mountain-observatory.png", "Retro Diffusion's mountain observatory"],
            ["/benchmarks/provider-environments/comfyui/isolated/a/mountain-observatory.png", "ComfyUI's mountain observatory"],
            ["/benchmarks/provider-scenario-smoke/mountain-keep.png", "Scenario's mountain keep"],
          ].map(([src, alt]) => (
            <Image key={src} src={src!} alt={alt!} width={128} height={128} unoptimized />
          ))}
        </div>
      );
  }
}
