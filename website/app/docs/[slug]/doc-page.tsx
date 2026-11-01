/* eslint-disable @next/next/no-img-element -- Markdown images have unknown source dimensions. */
import Link from "next/link";
import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { docGroups, docHref, docs, headingId, tableOfContents, type DocEntry, type LinkResolver } from "@/app/lib/docs";
import type { SplitDoc } from "@/app/lib/doc-sections";
import { absoluteUrl } from "@/app/lib/metadata";
import { JsonLd, type JsonLdValue } from "@/app/ui/json-ld";
import { SiteFooter, SiteHeader } from "@/app/ui/site-chrome";
import { TrackedLink } from "@/app/ui/tracked-link";

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return nodeText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

export function markdownComponents(sourceFile: string, resolve?: LinkResolver): Components {
  return {
    h2: ({ children }) => <h2 id={headingId(nodeText(children))}>{children}</h2>,
    h3: ({ children }) => <h3 id={headingId(nodeText(children))}>{children}</h3>,
    h4: ({ children }) => <h4 id={headingId(nodeText(children))}>{children}</h4>,
    a: ({ href, children }) => {
      const resolved = docHref(sourceFile, href, resolve);
      if (resolved?.startsWith("/")) return <Link href={resolved}>{children}</Link>;
      return <a href={resolved}>{children}</a>;
    },
    img: ({ src, alt }) => typeof src === "string"
      ? <img src={docHref(sourceFile, src)} alt={alt ?? ""} loading="lazy" />
      : null,
  };
}

export function DocMarkdown({ content, sourceFile, resolve }: { content: string; sourceFile: string; resolve?: LinkResolver }) {
  return (
    <div className="markdown-body">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents(sourceFile, resolve)}>
        {content}
      </Markdown>
    </div>
  );
}

/** The left column: every page, with a split doc's children listed under it while it is open. */
export function DocSidebar({ active, split, activeChild }: { active: DocEntry; split: SplitDoc | null; activeChild?: string }) {
  return (
    <aside className="docs-sidebar" aria-label="Documentation navigation">
      <Link className="docs-back" href="/docs">← All documentation</Link>
      {docGroups.map((group) => (
        <div className="sidebar-group" key={group}>
          <span>{group}</span>
          {docs
            .filter((entry) => entry.group === group)
            .map((entry) => (
              <div key={entry.slug}>
                <Link className={entry.slug === active.slug && !activeChild ? "active" : undefined} href={`/docs/${entry.slug}`}>
                  {entry.title}
                </Link>
                {entry.slug === active.slug && split && (
                  <div className="sidebar-children">
                    {split.children.map((child) => (
                      <Link
                        key={child.slug}
                        className={child.slug === activeChild ? "active" : undefined}
                        href={`/docs/${entry.slug}/${child.slug}`}
                      >
                        {child.title}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            ))}
        </div>
      ))}
    </aside>
  );
}

export function DocToc({ content, editFile }: { content: string; editFile: string }) {
  const toc = tableOfContents(content).filter((heading) => heading.depth >= 2);
  return (
    <aside className="docs-toc" aria-label="On this page">
      {toc.length > 0 && <span>On this page</span>}
      {toc.map((heading) => (
        <a className={heading.depth === 3 ? "nested" : undefined} href={`#${heading.id}`} key={`${heading.id}-${heading.depth}`}>
          {heading.title}
        </a>
      ))}
      <TrackedLink
        className="edit-link"
        id="doc_edit_on_github"
        section="docs_sidebar"
        href={`https://github.com/gfargo/pixelkiln/edit/main/${editFile}`}
        external
      >
        Edit on GitHub ↗
      </TrackedLink>
    </aside>
  );
}

export function docJsonLd(doc: DocEntry, crumbs: { name: string; path: string }[], headline: string, description: string) {
  const pageUrl = absoluteUrl(crumbs[crumbs.length - 1]!.path);
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        headline,
        description,
        url: pageUrl,
        mainEntityOfPage: pageUrl,
        isPartOf: absoluteUrl(crumbs.length > 3 ? `/docs/${doc.slug}` : "/docs"),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "PixelKiln", item: absoluteUrl("/") },
          { "@type": "ListItem", position: 2, name: "Documentation", item: absoluteUrl("/docs") },
          ...crumbs.slice(2).map((crumb, index) => ({ "@type": "ListItem", position: index + 3, name: crumb.name, item: absoluteUrl(crumb.path) })),
        ],
      },
    ],
  };
}

/** Docs in sidebar order, so "next" matches what the reader sees on the left. */
const orderedDocs = docGroups.flatMap((group) => docs.filter((entry) => entry.group === group));

/** Ends every docs page with somewhere to go, so a reader who lands from search is not left at a dead end. */
export function DocNext({ active }: { active: DocEntry }) {
  const index = orderedDocs.findIndex((entry) => entry.slug === active.slug);
  const next = orderedDocs[index + 1];
  const previous = index > 0 ? orderedDocs[index - 1] : undefined;
  return (
    <nav className="doc-next" aria-label="Keep reading">
      {previous && (
        <TrackedLink className="doc-next-card" id={`doc_prev_${active.slug}`} section="docs_pager" href={`/docs/${previous.slug}`}>
          <span>← Previous</span>
          <strong>{previous.title}</strong>
        </TrackedLink>
      )}
      {next && (
        <TrackedLink className="doc-next-card doc-next-forward" id={`doc_next_${active.slug}`} section="docs_pager" href={`/docs/${next.slug}`}>
          <span>Next →</span>
          <strong>{next.title}</strong>
        </TrackedLink>
      )}
      {active.slug !== "getting-started" && (
        <TrackedLink className="doc-next-card doc-next-start" id={`doc_start_${active.slug}`} section="docs_pager" href="/docs/getting-started">
          <span>New to PixelKiln?</span>
          <strong>Read the quickstart</strong>
        </TrackedLink>
      )}
    </nav>
  );
}

export function DocShell({ jsonLd, sidebar, toc, active, children }: { jsonLd: JsonLdValue; sidebar: ReactNode; toc: ReactNode; active: DocEntry; children: ReactNode }) {
  return (
    <>
      <JsonLd data={jsonLd} />
      <SiteHeader compact />
      <main className="docs-layout shell">
        {sidebar}
        <article className="doc-article">
          {children}
          <DocNext active={active} />
        </article>
        {toc}
      </main>
      <SiteFooter />
    </>
  );
}
