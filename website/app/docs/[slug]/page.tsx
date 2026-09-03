import type { Metadata } from "next";
/* eslint-disable @next/next/no-img-element -- Markdown images have unknown source dimensions. */
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  docGroups,
  docHref,
  docs,
  getDoc,
  headingId,
  readDoc,
  tableOfContents,
} from "@/app/lib/docs";
import { absoluteUrl, pageMetadata } from "@/app/lib/metadata";
import { JsonLd } from "@/app/ui/json-ld";
import { SiteFooter, SiteHeader } from "@/app/ui/site-chrome";
import { TrackedLink } from "@/app/ui/tracked-link";

type DocPageProps = {
  params: Promise<{ slug: string }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return docs.map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({ params }: DocPageProps): Promise<Metadata> {
  const doc = getDoc((await params).slug);
  if (!doc) return {};
  return pageMetadata({
    title: doc.title,
    description: doc.description,
    path: `/docs/${doc.slug}`,
    type: "article",
  });
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return nodeText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function markdownComponents(sourceFile: string): Components {
  return {
    h2: ({ children }) => <h2 id={headingId(nodeText(children))}>{children}</h2>,
    h3: ({ children }) => <h3 id={headingId(nodeText(children))}>{children}</h3>,
    a: ({ href, children }) => {
      const resolved = docHref(sourceFile, href);
      if (resolved?.startsWith("/")) return <Link href={resolved}>{children}</Link>;
      return <a href={resolved}>{children}</a>;
    },
    img: ({ src, alt }) => typeof src === "string"
      ? <img src={docHref(sourceFile, src)} alt={alt ?? ""} loading="lazy" />
      : null,
  };
}

export default async function DocPage({ params }: DocPageProps) {
  const doc = getDoc((await params).slug);
  if (!doc) notFound();

  const { absolute, content } = await readDoc(doc);
  const toc = tableOfContents(content);
  const pageUrl = absoluteUrl(`/docs/${doc.slug}`);
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        headline: doc.title,
        description: doc.description,
        url: pageUrl,
        mainEntityOfPage: pageUrl,
        isPartOf: absoluteUrl("/docs"),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "PixelKiln", item: absoluteUrl("/") },
          { "@type": "ListItem", position: 2, name: "Documentation", item: absoluteUrl("/docs") },
          { "@type": "ListItem", position: 3, name: doc.title, item: pageUrl },
        ],
      },
    ],
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <SiteHeader compact />
      <main className="docs-layout shell">
        <aside className="docs-sidebar" aria-label="Documentation navigation">
          <Link className="docs-back" href="/docs">← All documentation</Link>
          {docGroups.map((group) => (
            <div className="sidebar-group" key={group}>
              <span>{group}</span>
              {docs
                .filter((entry) => entry.group === group)
                .map((entry) => (
                  <Link
                    className={entry.slug === doc.slug ? "active" : undefined}
                    href={`/docs/${entry.slug}`}
                    key={entry.slug}
                  >
                    {entry.title}
                  </Link>
                ))}
            </div>
          ))}
        </aside>

        <article className="doc-article">
          <div className="doc-heading">
            <span>{doc.group}</span>
            <h1>{doc.title}</h1>
            <p>{doc.description}</p>
          </div>
          <div className="markdown-body">
            <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents(absolute)}>
              {content}
            </Markdown>
          </div>
        </article>

        <aside className="docs-toc" aria-label="On this page">
          <span>On this page</span>
          {toc.map((heading) => (
            <a className={heading.depth === 3 ? "nested" : undefined} href={`#${heading.id}`} key={`${heading.id}-${heading.depth}`}>
              {heading.title}
            </a>
          ))}
          <TrackedLink
            className="edit-link"
            id="doc_edit_on_github"
            section="docs_sidebar"
            href={`https://github.com/gfargo/pixelkiln/edit/main/${doc.file}`}
            external
          >
            Edit on GitHub ↗
          </TrackedLink>
        </aside>
      </main>
      <SiteFooter />
    </>
  );
}
