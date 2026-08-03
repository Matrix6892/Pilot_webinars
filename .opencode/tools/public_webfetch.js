import { tool } from "@opencode-ai/plugin";
import { createHash } from "node:crypto";

import { fetchPublicWeb } from "../../lib/public-web-fetch.mjs";

export default tool({
  description:
    "Fetch one public HTTPS page through the SSRF-safe Koler transport.",
  args: {
    url: tool.schema.string().describe("A public HTTPS URL to open"),
  },
  async execute(args) {
    const page = await fetchPublicWeb(args.url);
    const text = page.text.replace(/\s+/gu, " ").trim().slice(0, 12_000).trim();
    return JSON.stringify({
      url: page.url,
      contentType: page.contentType,
      redirects: page.redirects,
      text,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    });
  },
});
