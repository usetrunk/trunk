"""
Trunk webhook signature verification helper (Python).

Usage:
    from verify_webhook import verify_trunk_webhook

    @app.post("/trunk-webhook")
    def handle_webhook(request):
        is_valid = verify_trunk_webhook(
            signature=request.headers.get("X-Trunk-Signature"),
            raw_body=request.data,
            webhook_secret=YOUR_WEBHOOK_SECRET,
        )
        if not is_valid:
            return {"error": "Invalid signature"}, 401
        # Process message...
"""

import hashlib
import hmac


def verify_trunk_webhook(
    signature: str | None,
    raw_body: bytes | str,
    webhook_secret: str,
) -> bool:
    if not signature or not signature.startswith("sha256="):
        return False

    expected = signature[7:]

    if isinstance(raw_body, str):
        raw_body = raw_body.encode("utf-8")

    computed = hmac.new(
        webhook_secret.encode("utf-8"),
        raw_body,
        hashlib.sha256,
    ).hexdigest()

    return hmac.compare_digest(expected, computed)
