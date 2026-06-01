import hmac
import hashlib


def sign_webhook_payload(secret: str, body: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), body.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def verify_webhook_signature(secret: str, body: str, signature: str) -> bool:
    expected = sign_webhook_payload(secret, body)
    return hmac.compare_digest(expected, signature)
