import { CopyCommand } from "@/app/ui/copy-command";
import { TrackedLink } from "@/app/ui/tracked-link";

export function InstallSection() {
  return (
        <section className="install-section shell">
          <div className="install-panel">
            <div>
              <h2>Teach your agent PixelKiln.</h2>
              <p>The skill tells compatible agents when to plan, when to ask for a budget, when to restore existing work, when to stop for human review, and how to verify output.</p>
            </div>
            <div className="install-actions">
              <CopyCommand command="npx skills add gfargo/pixelkiln@pixelkiln" />
              <div>
                <TrackedLink
                  className="button button-primary"
                  id="install_agent_setup"
                  section="install"
                  href="/docs/agents"
                >
                  Agent setup
                </TrackedLink>
                <TrackedLink
                  className="button button-secondary"
                  id="install_library_quickstart"
                  section="install"
                  href="/docs/getting-started"
                >
                  Library quickstart
                </TrackedLink>
              </div>
            </div>
          </div>
        </section>
  );
}
