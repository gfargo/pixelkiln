const configured = process.env.NEXT_PUBLIC_SITE_URL
  ?? "https://pixelkiln.griffen.codes";

export const siteUrl = configured.replace(/\/$/, "");
