#!/usr/bin/env python3
"""
camoufox_scrape.py — scrape a URL using camoufox (anti-detection Firefox)

Usage: python3 camoufox_scrape.py <url>
Output: JSON to stdout with fields: title, html, error
"""
import sys
import json

def scrape(url: str) -> dict:
    try:
        from camoufox.sync_api import Camoufox

        with Camoufox(headless=True, geoip=True) as browser:
            page = browser.new_page()
            page.goto(url, timeout=30000, wait_until="domcontentloaded")

            # Human-like scroll
            page.evaluate("window.scrollBy(0, Math.random() * 300 + 100)")
            page.wait_for_timeout(500)

            title = page.title()
            html = page.content()

            return {"title": title, "html": html, "error": None}
    except Exception as e:
        return {"title": "", "html": "", "error": str(e)}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"title": "", "html": "", "error": "No URL provided"}))
        sys.exit(1)

    url = sys.argv[1]
    result = scrape(url)
    print(json.dumps(result))
