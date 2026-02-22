"""
x402 micropayment helper for Anybrowse SDK.

Handles EIP-712 structured signing for USDC payments on Base network.
"""

import json
import time
import struct
from typing import Optional

try:
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    HAS_ETH_ACCOUNT = True
except ImportError:
    HAS_ETH_ACCOUNT = False


# x402 constants
CHAIN_ID = 8453  # Base
USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
PAYEE_ADDRESS = "0x8D76E8FB38541d70dF74b14660c39b4c5d737088"
FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402"


def parse_402_response(response_json: dict) -> dict:
    """Extract payment requirements from a 402 response."""
    accepts = response_json.get("accepts", [])
    if not accepts:
        raise ValueError("No payment options in 402 response")

    # Use the first accepted payment option
    option = accepts[0]
    return {
        "scheme": option.get("scheme", "exact"),
        "network": option.get("network", "base-mainnet"),
        "maxAmountRequired": option.get("maxAmountRequired", "0"),
        "resource": option.get("resource", ""),
        "description": option.get("description", ""),
        "mimeType": option.get("mimeType", ""),
        "payTo": option.get("payTo", PAYEE_ADDRESS),
        "maxTimeoutSeconds": option.get("maxTimeoutSeconds", 60),
        "asset": option.get("asset", USDC_ADDRESS),
        "extra": option.get("extra", {}),
    }


def build_eip712_payload(
    payment_requirements: dict,
    payer_address: str,
) -> dict:
    """Build the EIP-712 typed data for an x402 exact payment."""
    amount = payment_requirements["maxAmountRequired"]
    pay_to = payment_requirements["payTo"]
    nonce = str(int(time.time() * 1000))
    expiration = str(int(time.time()) + payment_requirements.get("maxTimeoutSeconds", 60))

    domain = {
        "name": "x402",
        "version": "1",
        "chainId": CHAIN_ID,
        "verifyingContract": payment_requirements.get("asset", USDC_ADDRESS),
    }

    types = {
        "TransferWithAuthorization": [
            {"name": "from", "type": "address"},
            {"name": "to", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "validAfter", "type": "uint256"},
            {"name": "validBefore", "type": "uint256"},
            {"name": "nonce", "type": "bytes32"},
        ],
    }

    # nonce must be bytes32
    nonce_bytes32 = "0x" + int(nonce).to_bytes(32, "big").hex()

    message = {
        "from": payer_address,
        "to": pay_to,
        "value": int(amount),
        "validAfter": 0,
        "validBefore": int(expiration),
        "nonce": nonce_bytes32,
    }

    return {
        "domain": domain,
        "types": types,
        "primaryType": "TransferWithAuthorization",
        "message": message,
    }


def sign_payment(
    private_key: str,
    payment_requirements: dict,
) -> str:
    """
    Sign an x402 payment and return the base64-encoded X-PAYMENT header value.

    Args:
        private_key: Hex-encoded private key (with or without 0x prefix).
        payment_requirements: Parsed payment requirements from parse_402_response().

    Returns:
        Base64-encoded payment header string.

    Raises:
        ImportError: If eth_account is not installed.
    """
    if not HAS_ETH_ACCOUNT:
        raise ImportError(
            "eth_account is required for x402 payments. "
            "Install with: pip install eth-account"
        )

    account = Account.from_key(private_key)
    payer_address = account.address

    eip712_data = build_eip712_payload(payment_requirements, payer_address)

    signable = encode_typed_data(
        domain_data=eip712_data["domain"],
        types=eip712_data["types"],
        primary_type=eip712_data["primaryType"],
        message_data=eip712_data["message"],
    )
    signed = account.sign_message(signable)

    # Build the x402 payment payload
    import base64
    payload = {
        "x402Version": 1,
        "scheme": "exact",
        "network": "base-mainnet",
        "payload": {
            "signature": signed.signature.hex(),
            "authorization": {
                "from": payer_address,
                "to": eip712_data["message"]["to"],
                "value": str(eip712_data["message"]["value"]),
                "validAfter": str(eip712_data["message"]["validAfter"]),
                "validBefore": str(eip712_data["message"]["validBefore"]),
                "nonce": eip712_data["message"]["nonce"],
            },
        },
    }

    payload_json = json.dumps(payload, separators=(",", ":"))
    return base64.b64encode(payload_json.encode()).decode()
