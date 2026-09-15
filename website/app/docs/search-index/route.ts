import { buildSearchIndex } from "@/app/lib/search-index";

// Built once at build time from the same Markdown the pages render; the
// palette fetches it the first time it opens.
export const dynamic = "force-static";

export async function GET() {
  const index = await buildSearchIndex();
  return Response.json(index, {
    headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" },
  });
}
