"""
Search + Crawl example.

Demonstrates using search() to find URLs, then crawl() to
scrape multiple pages in a single call.

Requires a private key with USDC on Base for paid endpoints.
"""

import os
from anybrowse import AnybrowseClient


def main():
    private_key = os.environ.get("ETH_PRIVATE_KEY")

    client = AnybrowseClient(private_key=private_key)

    # Step 1: SERP search
    print("=== Searching for python asyncio tutorial ===\n")
    serp = client.search("python asyncio tutorial", count=5)

    if serp.get("error") == "payment_required":
        print("Payment required for search. Set ETH_PRIVATE_KEY env var.")
        return

    for i, result in enumerate(serp.get("results", []), 1):
        print(f"  {i}. {result[title]}")
        print(f"     {result[url]}")
        print(f"     {result.get(description, )[:100]}")
        print()

    # Step 2: Crawl for richer content
    print("=== Crawling top 3 results for python asyncio tutorial ===\n")
    crawl_data = client.crawl("python asyncio tutorial", count=3)

    if crawl_data.get("error") == "payment_required":
        print("Payment required for crawl. Set ETH_PRIVATE_KEY env var.")
        return

    for page in crawl_data.get("results", []):
        status = page.get("status", "unknown")
        title = page.get("title", "No title")
        markdown = page.get("markdown", "")
        print(f"  [{status}] {title}")
        print(f"  URL: {page.get(url)}")
        print(f"  Content: {len(markdown)} chars")
        print(f"  Preview: {markdown[:150]}...")
        print()


if __name__ == "__main__":
    main()
