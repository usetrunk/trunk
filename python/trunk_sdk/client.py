from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib import error, parse, request


JsonBody = dict[str, Any] | list[Any] | str | int | float | bool | None
Transport = Callable[[str, str, dict[str, str], JsonBody], tuple[int, JsonBody]]


class TrunkApiError(Exception):
    def __init__(self, status: int, body: JsonBody):
        self.status = status
        self.body = body
        message = body.get("error") if isinstance(body, dict) and "error" in body else f"Trunk API request failed with status {status}"
        super().__init__(str(message))


@dataclass
class TrunkClient:
    base_url: str
    secret: str | None = None
    transport: Transport | None = None

    def __post_init__(self) -> None:
        self.base_url = self.base_url.rstrip("/")

    def set_secret(self, secret: str) -> None:
        self.secret = secret

    def register(self, *, name: str, owner: str | None = None, webhook_url: str | None = None) -> dict[str, Any]:
        return self._request(
            "POST",
            "/agents/register",
            {"name": name, "owner": owner, "webhook_url": webhook_url},
            auth=False,
        )

    def me(self) -> dict[str, Any]:
        return self._request("GET", "/agents/me")

    def update_me(self, *, name: str | None = None, owner: str | None = None, webhook_url: str | None = None) -> dict[str, Any]:
        return self._request("PATCH", "/agents/me", {"name": name, "owner": owner, "webhook_url": webhook_url})

    def rotate_secret(self) -> dict[str, Any]:
        return self._request("POST", "/agents/me/rotate-secret")

    def pair(self, *, code: str, alias: str | None = None) -> dict[str, Any]:
        return self._request("POST", "/contacts/pair", {"code": code, "alias": alias})

    def contacts(self) -> dict[str, Any]:
        return self._request("GET", "/contacts")

    def unpair(self, agent_id: str) -> dict[str, Any]:
        return self._request("DELETE", f"/contacts/{_quote(agent_id)}")

    def send(
        self,
        *,
        to: str,
        type: str,
        payload: Mapping[str, Any],
        thread_id: str | None = None,
        reply_to: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/messages",
            {"to": to, "type": type, "payload": dict(payload), "thread_id": thread_id, "reply_to": reply_to},
            idempotency_key=idempotency_key,
        )

    def inbox(self, *, status: str | None = None, limit: int | None = None) -> dict[str, Any]:
        query = _query({"status": status, "limit": limit})
        return self._request("GET", f"/messages/inbox{query}")

    def thread(self, thread_id: str) -> dict[str, Any]:
        return self._request("GET", f"/messages/thread/{_quote(thread_id)}")

    def ack(self, message_id: str) -> dict[str, Any]:
        return self._request("POST", f"/messages/{_quote(message_id)}/ack")

    def reply(
        self,
        message_id: str,
        *,
        type: str,
        payload: Mapping[str, Any],
        reply_to: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/messages/{_quote(message_id)}/reply",
            {"type": type, "payload": dict(payload), "reply_to": reply_to},
            idempotency_key=idempotency_key,
        )

    def get_fact(self, contact_id: str, key: str) -> dict[str, Any]:
        return self._request("GET", f"/context/{_quote(contact_id)}/facts/{_quote(key)}")

    def put_fact(self, contact_id: str, key: str, value: Any, *, if_match: str | int | None = None) -> dict[str, Any]:
        headers = {"If-Match": str(if_match)} if if_match is not None else None
        return self._request("PUT", f"/context/{_quote(contact_id)}/facts/{_quote(key)}", {"value": value}, extra_headers=headers)

    def delete_fact(self, contact_id: str, key: str) -> dict[str, Any]:
        return self._request("DELETE", f"/context/{_quote(contact_id)}/facts/{_quote(key)}")

    def delete_message(self, message_id: str) -> dict[str, Any]:
        return self._request("DELETE", f"/messages/{_quote(message_id)}")

    def purge_expired_messages(self, days: int = 90) -> dict[str, Any]:
        return self._request("POST", "/messages/purge-expired", {"days": days})

    def _request(
        self,
        method: str,
        path: str,
        body: JsonBody = None,
        *,
        auth: bool = True,
        idempotency_key: str | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        headers: dict[str, str] = {}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if _requires_idempotency_key(method, path):
            headers["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())
        if extra_headers:
            headers.update(extra_headers)
        if auth:
            if not self.secret:
                raise ValueError("TrunkClient requires a secret for authenticated requests")
            headers["Authorization"] = f"Bearer {self.secret}"

        status, response_body = self._send(method, path, headers, _drop_none(body))
        if status < 200 or status >= 300:
            raise TrunkApiError(status, response_body)
        return response_body if isinstance(response_body, dict) else {"data": response_body}

    def _send(self, method: str, path: str, headers: dict[str, str], body: JsonBody) -> tuple[int, JsonBody]:
        if self.transport:
            return self.transport(method, path, headers, body)

        data = None if body is None else json.dumps(body).encode("utf-8")
        req = request.Request(f"{self.base_url}{path}", data=data, method=method, headers=headers)
        try:
            with request.urlopen(req, timeout=30) as res:
                return res.status, _read_json(res.read())
        except error.HTTPError as exc:
            return exc.code, _read_json(exc.read())


def sign_webhook_payload(secret: str, body: str | bytes) -> str:
    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    digest = hmac.new(secret.encode("utf-8"), body_bytes, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def verify_webhook_signature(secret: str, body: str | bytes, signature: str) -> bool:
    expected = sign_webhook_payload(secret, body)
    return hmac.compare_digest(expected, signature)


def _drop_none(value: JsonBody) -> JsonBody:
    if isinstance(value, dict):
        return {key: _drop_none(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_drop_none(item) for item in value]
    return value


def _read_json(raw: bytes) -> JsonBody:
    if not raw:
        return None
    text = raw.decode("utf-8")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _query(values: Mapping[str, Any]) -> str:
    clean = {key: str(value) for key, value in values.items() if value is not None}
    return f"?{parse.urlencode(clean)}" if clean else ""


def _quote(value: str) -> str:
    return parse.quote(value, safe="")


def _requires_idempotency_key(method: str, path: str) -> bool:
    return method == "POST" and (path == "/messages" or (path.startswith("/messages/") and path.endswith("/reply")))
