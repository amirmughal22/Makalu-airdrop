import type { MetadataRoute } from "next";

/** Refuse all crawlers — no indexing of this app. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        disallow: "/",
      },
    ],
  };
}
