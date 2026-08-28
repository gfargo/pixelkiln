import Link from "next/link";

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
        <Link href="/#workflow">Workflow</Link>
        <Link href="/docs">Docs</Link>
        <a href="https://github.com/gfargo/pixelkiln">GitHub</a>
      </nav>
      <Link className="nav-cta" href="/docs/getting-started">
        Start building <span aria-hidden="true">↗</span>
      </Link>
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
          <p>Deterministic mechanics. Human judgment. Durable pixels.</p>
        </div>
        <div className="footer-links">
          <div>
            <span>Explore</span>
            <Link href="/docs">Documentation</Link>
            <Link href="/#workflow">Workflow</Link>
            <Link href="/docs/generators">Generators</Link>
          </div>
          <div>
            <span>Project</span>
            <a href="https://github.com/gfargo/pixelkiln">GitHub</a>
            <a href="https://github.com/gfargo/pixelkiln/issues">Roadmap</a>
            <Link href="/docs/contributing">Contributing</Link>
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
