import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { docs, getDoc, readDoc } from "@/app/lib/docs";
import { linkResolver, splitDoc } from "@/app/lib/doc-sections";
import { pageMetadata } from "@/app/lib/metadata";
import { TrackedLink } from "@/app/ui/tracked-link";
import { DocMarkdown, DocShell, DocSidebar, DocToc, docJsonLd } from "./doc-page";

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

export default async function DocPage({ params }: DocPageProps) {
  const doc = getDoc((await params).slug);
  if (!doc) notFound();

  const { absolute, content } = await readDoc(doc);
  const resolve = await linkResolver();
  const split = await splitDoc(doc);
  const crumbs = [
    { name: "PixelKiln", path: "/" },
    { name: "Documentation", path: "/docs" },
    { name: doc.title, path: `/docs/${doc.slug}` },
  ];
  const jsonLd = docJsonLd(doc, crumbs, doc.title, doc.description);

  if (!split) {
    return (
      <DocShell jsonLd={jsonLd} sidebar={<DocSidebar active={doc} split={null} />} toc={<DocToc content={content} editFile={doc.file} />}>
        <div className="doc-heading">
          <span>{doc.group}</span>
          <h1>{doc.title}</h1>
          <p>{doc.description}</p>
        </div>
        <DocMarkdown content={content} sourceFile={absolute} resolve={resolve} />
      </DocShell>
    );
  }

  // A split doc's parent page: its introduction, then a map of its pages.
  return (
    <DocShell jsonLd={jsonLd} sidebar={<DocSidebar active={doc} split={split} />} toc={<DocToc content="" editFile={doc.file} />}>
      <div className="doc-heading">
        <span>{doc.group}</span>
        <h1>{doc.title}</h1>
        <p>{doc.description}</p>
      </div>
      {split.preamble && <DocMarkdown content={split.preamble} sourceFile={absolute} resolve={resolve} />}
      <div className="doc-children">
        {split.groups.map((group, index) => (
          <section className="doc-child-group" key={group.id ?? `group-${index}`} id={group.id ?? undefined}>
            {group.title && <h2>{group.title}</h2>}
            {group.intro && <DocMarkdown content={group.intro} sourceFile={absolute} resolve={resolve} />}
            <div className="doc-child-grid">
              {group.children.map((child) => (
                <TrackedLink
                  className="doc-child-card"
                  id={`doc_child_${doc.slug}_${child.slug}`}
                  section="docs_sidebar"
                  href={`/docs/${doc.slug}/${child.slug}`}
                  key={child.slug}
                >
                  <h3>{child.title}</h3>
                  {child.summary && <p>{child.summary}</p>}
                </TrackedLink>
              ))}
            </div>
          </section>
        ))}
      </div>
      <p className="doc-whole-link">
        The whole reference is one Markdown file:{" "}
        <Link href={`https://github.com/gfargo/pixelkiln/blob/main/${doc.file}`}>{doc.file}</Link>.
      </p>
    </DocShell>
  );
}
