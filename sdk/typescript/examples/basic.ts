/**
 * Basic usage of the Anybrowse SDK.
 *
 * Run with: npx tsx examples/basic.ts
 */
import { AnybrowseClient } from "../src/index.js";

async function main() {
  const client = new AnybrowseClient();

  // ── Scrape a single page ────────────────────────────────────────────────
  console.log("--- Scrape ---");
  const page = await client.scrape("https://example.com");
  console.log(`Title:  ${page.title}`);
  console.log(`Status: ${page.status}`);
  console.log(`Markdown (first 200 chars):\n${page.markdown.slice(0, 200)}\n`);

  // ── Crawl for a topic ───────────────────────────────────────────────────
  console.log("--- Crawl ---");
  const crawl = await client.crawl("typescript sdk design patterns", 2);
  console.log(`Query: ${crawl.query}`);
  for (const result of crawl.results) {
    console.log(`  [${result.status}] ${result.title} — ${result.url}`);
  }
  console.log();

  // ── SERP search ─────────────────────────────────────────────────────────
  console.log("--- Search ---");
  const serp = await client.search("anybrowse web scraping api", 3);
  for (const result of serp.results) {
    console.log(`  ${result.title}`);
    console.log(`    ${result.url}`);
    console.log(`    ${result.description}\n`);
  }
}

main().catch(console.error);
