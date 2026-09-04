import Link from "next/link";
import { TrackedLink } from "@/app/ui/tracked-link";

export function KilnMark() {
  return (
    <span className="kiln-mark" aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => (
        <span key={index} />
      ))}
    </span>
  );
}

export function SiteHeader({ compact = false }: { compact?: boolean }) {
  return (
    <header className={`site-header shell${compact ? " compact" : ""}`}>
      <Link className="brand" href="/" aria-label="PixelKiln home">
        <KilnMark />
        <span>pixelkiln</span>
      </Link>
      <nav aria-label="Primary navigation">
        <TrackedLink id="nav_workflow" section="header" href="/#workflow">Workflow</TrackedLink>
        <TrackedLink id="nav_providers" section="header" href="/#providers">Providers</TrackedLink>
        <TrackedLink id="nav_docs" section="header" href="/docs">Docs</TrackedLink>
        <TrackedLink
          id="nav_github"
          section="header"
          href="https://github.com/gfargo/pixelkiln"
          external
        >
          GitHub
        </TrackedLink>
      </nav>
      <TrackedLink
        className="nav-cta"
        id="nav_start_building"
        section="header"
        href="/docs/getting-started"
      >
        Start building <span aria-hidden="true">↗</span>
      </TrackedLink>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell footer-grid">
        <div>
          <Link className="brand" href="/">
            <KilnMark />
            <span>pixelkiln</span>
          </Link>
          <p>Keep the cost and source of every generated file.</p>
        </div>
        <div className="footer-links">
          <div>
            <span>Explore</span>
            <TrackedLink id="footer_docs" section="footer" href="/docs">Documentation</TrackedLink>
            <TrackedLink id="footer_workflow" section="footer" href="/#workflow">Workflow</TrackedLink>
            <TrackedLink id="footer_providers" section="footer" href="/#providers">Provider results</TrackedLink>
            <TrackedLink id="footer_pixellab" section="footer" href="/docs/pixellab">Set up PixelLab</TrackedLink>
            <TrackedLink id="footer_retro" section="footer" href="/docs/retro-diffusion">Set up Retro Diffusion</TrackedLink>
            <TrackedLink id="footer_comfyui" section="footer" href="/docs/comfyui">Set up ComfyUI</TrackedLink>
            <TrackedLink id="footer_benchmark" section="footer" href="/docs/provider-benchmark">Benchmark</TrackedLink>
            <TrackedLink id="footer_generators" section="footer" href="/docs/generators">Generators</TrackedLink>
          </div>
          <div>
            <span>Project</span>
            <TrackedLink
              id="footer_github"
              section="footer"
              href="https://github.com/gfargo/pixelkiln"
              external
            >
              GitHub
            </TrackedLink>
            <TrackedLink
              id="footer_roadmap"
              section="footer"
              href="https://github.com/gfargo/pixelkiln/issues"
              external
            >
              Roadmap
            </TrackedLink>
            <TrackedLink id="footer_contributing" section="footer" href="/docs/contributing">
              Contributing
            </TrackedLink>
          </div>
        </div>
      </div>
      <div className="shell footer-base">
        <span>MIT licensed · pre-1.0</span>
        <span>Built for game-asset pipelines</span>
      </div>
    </footer>
  );
}
