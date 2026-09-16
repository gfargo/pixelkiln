import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { docs, getDoc, readDoc } from "@/app/lib/docs";
import { linkResolver, splitDoc } from "@/app/lib/doc-sections";
import { pageMetadata } from "@/app/lib/metadata";
import { DocMarkdown, DocShell, DocSidebar, DocToc, docJsonLd } from "../doc-page";

type ChildPageProps = {
  params: Promise<{ slug: string; child: string }>;
};

export const dynamicParams = false;

export async function generateStaticParams() {
  const params: { slug: string; child: string }[] = [];
  for (const doc of docs) {
    const split = await splitDoc(doc);
    for (const child of split?.children ?? []) params.push({ slug: doc.slug, child: child.slug });
  }
  return params;
}

export async function generateMetadata({ params }: ChildPageProps): Promise<Metadata> {
  const { slug, child: childSlug } = await params;
  const doc = getDoc(slug);
  const child = (await (doc ? splitDoc(doc) : null))?.children.find((entry) => entry.slug === childSlug);
  if (!doc || !child) return {};
  return pageMetadata({
    title: `${child.title} · ${doc.title}`,
    description: child.summary || doc.description,
    path: `/docs/${doc.slug}/${child.slug}`,
    type: "article",
  });
}

export default async function ChildPage({ params }: ChildPageProps) {
  const { slug, child: childSlug } = await params;
  const doc = getDoc(slug);
  const split = doc ? await splitDoc(doc) : null;
  const index = split?.children.findIndex((entry) => entry.slug === childSlug) ?? -1;
  if (!doc || !split || index < 0) notFound();

  const child = split.children[index]!;
  const previous = split.children[index - 1];
  const next = split.children[index + 1];
  const { absolute } = await readDoc(doc);
  const resolve = await linkResolver();
  const crumbs = [
    { name: "PixelKiln", path: "/" },
    { name: "Documentation", path: "/docs" },
    { name: doc.title, path: `/docs/${doc.slug}` },
    { name: child.title, path: `/docs/${doc.slug}/${child.slug}` },
  ];
  const jsonLd = docJsonLd(doc, crumbs, `${child.title} · ${doc.title}`, child.summary || doc.description);
  // The child's own heading is the page title; the table of contents lists what is under it.
  const body = child.content.replace(/^## [^\n]+\n+/, "");

  return (
    <DocShell jsonLd={jsonLd} sidebar={<DocSidebar active={doc} split={split} activeChild={child.slug} />} toc={<DocToc content={body} editFile={doc.file} />}>
      <div className="doc-heading">
        <span>
          <Link href={`/docs/${doc.slug}`}>{doc.title}</Link>
          {child.group ? <> › {child.group}</> : null}
        </span>
        <h1 id={child.id}>{child.title}</h1>
      </div>
      <DocMarkdown content={body} sourceFile={absolute} resolve={resolve} />
      <nav className="doc-siblings" aria-label="Neighbouring sections">
        {previous ? <Link href={`/docs/${doc.slug}/${previous.slug}`}><span>Previous</span>{previous.title}</Link> : <span />}
        {next ? <Link className="next" href={`/docs/${doc.slug}/${next.slug}`}><span>Next</span>{next.title}</Link> : <span />}
      </nav>
    </DocShell>
  );
}
