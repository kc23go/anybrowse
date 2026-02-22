"""
Full x402 payment example.

Shows the complete flow:
1. Make request -> get 402
2. SDK automatically signs USDC payment on Base
3. Retries with X-PAYMENT header
4. Returns scraped content

Requirements:
  pip install "anybrowse[payment]"
  export ETH_PRIVATE_KEY="0x..."  # Must have USDC on Base

The wallet needs USDC (on Base network) to pay for API calls.
Typical cost is fractions of a cent per request.
"""

import os
import sys
from anybrowse import AnybrowseClient


def main():
    private_key = os.environ.get("ETH_PRIVATE_KEY")

    if not private_key:
        print("Set ETH_PRIVATE_KEY environment variable.")
        print("  export ETH_PRIVATE_KEY=0xYOUR_PRIVATE_KEY")
        sys.exit(1)

    client = AnybrowseClient(private_key=private_key)

    # Scrape a page with automatic payment
    print("Scraping https://example.com ...\n")
    try:
        result = client.scrape("https://example.com")

        print(f"Title:  {result.get(title)}")
        print(f"URL:    {result.get(url)}")
        print(f"Status: {result.get(status)}")
        print(f"\nMarkdown:\n{result.get(markdown, )[:500]}")

    except Exception as e:
        print(f"Error: {e}")

    # Search with payment
    print("\n\nSearching for web3 micropayments ...\n")
    try:
        serp = client.search("web3 micropayments", count=3)

        for r in serp.get("results", []):
            print(f"  - {r[title]}")
            print(f"    {r[url]}")
            print()

    except Exception as e:
        print(f"Error: {e}")

    # Crawl with payment
    print("Crawling x402 protocol specification ...\n")
    try:
        data = client.crawl("x402 protocol specification", count=2)

        for page in data.get("results", []):
            print(f"  [{page.get(status)}] {page.get(title)}")
            md = page.get("markdown", "")
            print(f"  {len(md)} chars of markdown")
            print()

    except Exception as e:
        print(f"Error: {e}")

    client.close()


if __name__ == "__main__":
    main()
