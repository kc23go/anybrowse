"""
Basic scrape example — no payment wallet required.

Without a private key, the SDK returns the 402 payment info
so you can inspect what the endpoint costs.
"""

from anybrowse import AnybrowseClient


def main():
    client = AnybrowseClient()

    # Without a wallet, this returns payment requirements
    result = client.scrape("https://example.com")

    if result.get("error") == "payment_required":
        print("Payment required to scrape this page.")
        print(f"Status: {result[status]}")

        info = result["payment_info"]
        accepts = info.get("accepts", [])
        if accepts:
            option = accepts[0]
            print(f"  Network:  {option.get(network)}")
            print(f"  Asset:    {option.get(asset)}")
            print(f"  Amount:   {option.get(maxAmountRequired)}")
            print(f"  Pay to:   {option.get(payTo)}")
            print(f"  Resource: {option.get(resource)}")
    else:
        # If the endpoint ever becomes free or returns content
        print(f"Title: {result.get(title)}")
        print(f"URL:   {result.get(url)}")
        print(f"Markdown preview: {result.get(markdown, )[:300]}")


if __name__ == "__main__":
    main()
