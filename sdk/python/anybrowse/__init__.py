"""
Anybrowse Python SDK

A minimal client for the Anybrowse web scraping and search API.
Supports x402 micropayments (USDC on Base) for paid endpoints.
"""

__version__ = "0.1.0"

import requests
from typing import Optional

from .x402 import (
    parse_402_response,
    sign_payment,
    HAS_ETH_ACCOUNT,
    FACILITATOR_URL,
)


class AnybrowseClient:
    """
    Client for the Anybrowse API.

    Args:
        base_url: API base URL. Defaults to https://anybrowse.dev
        private_key: Optional hex-encoded Ethereum private key for x402 payments.
            If not provided, paid endpoints will return 402 payment info instead of content.
        timeout: Request timeout in seconds. Defaults to 30.
    """

    def __init__(
        self,
        base_url: str = "https://anybrowse.dev",
        private_key: Optional[str] = None,
        timeout: int = 30,
    ):
        self.base_url = base_url.rstrip("/")
        self.private_key = private_key
        self.timeout = timeout
        self._session = requests.Session()
        self._session.headers.update({
            "Content-Type": "application/json",
            "Accept": "application/json",
        })

    def scrape(self, url: str) -> dict:
        """
        Scrape a single URL and return its content as markdown.

        Args:
            url: The URL to scrape.

        Returns:
            dict with keys: url, title, markdown, status
        """
        return self._request("POST", "/scrape", json={"url": url})

    def crawl(self, query: str, count: int = 3) -> dict:
        """
        Search and scrape multiple pages for a query.

        Args:
            query: Search query string.
            count: Number of pages to crawl. Defaults to 3.

        Returns:
            dict with keys: query, results (list of {url, title, markdown, status})
        """
        return self._request("POST", "/crawl", json={"q": query, "count": count})

    def search(self, query: str, count: int = 5) -> dict:
        """
        Search the web and return SERP results (no scraping).

        Args:
            query: Search query string.
            count: Number of results. Defaults to 5.

        Returns:
            dict with keys: results (list of {url, title, description})
        """
        return self._request("POST", "/serp/search", json={"q": query, "count": count})

    def _request(self, method: str, path: str, **kwargs) -> dict:
        """
        Make an API request with automatic x402 payment handling.

        If the server returns 402 and a private key is configured,
        the client will sign the payment and retry the request
        with the X-PAYMENT header.
        """
        url = self.base_url + path
        kwargs.setdefault("timeout", self.timeout)

        response = self._session.request(method, url, **kwargs)

        # Happy path - got content directly
        if response.status_code == 200:
            return response.json()

        # Payment required
        if response.status_code == 402:
            payment_info = response.json()

            # No private key - return the 402 info for the caller to inspect
            if not self.private_key:
                return {
                    "error": "payment_required",
                    "status": 402,
                    "payment_info": payment_info,
                }

            # Sign and retry
            return self._pay_and_retry(method, url, payment_info, **kwargs)

        # Other errors
        response.raise_for_status()
        return response.json()

    def _pay_and_retry(
        self, method: str, url: str, payment_info: dict, **kwargs
    ) -> dict:
        """Sign an x402 payment and retry the request."""
        requirements = parse_402_response(payment_info)
        payment_header = sign_payment(self.private_key, requirements)

        # Retry with payment header
        headers = kwargs.pop("headers", {})
        headers["X-PAYMENT"] = payment_header
        kwargs["headers"] = headers

        response = self._session.request(method, url, **kwargs)
        response.raise_for_status()
        return response.json()

    def close(self):
        """Close the underlying HTTP session."""
        self._session.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
