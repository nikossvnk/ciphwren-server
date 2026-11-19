import hashlib
import hmac
import json
import secrets
import time

from django.conf import settings

from etebase_server.django.utils import CallbackContext
from etebase_server.fastapi.utils import b64encode

TICKET_VALID_SECONDS = 60


def make_ticket(user_id: int, secret: str) -> str:
    """`<payload>.<signature>`, both base64url; the account service checks the signature, expiry and nonce"""
    payload = json.dumps(
        {"uid": user_id, "exp": int(time.time()) + TICKET_VALID_SECONDS, "nonce": b64encode(secrets.token_bytes(16))},
        separators=(",", ":"),
    ).encode()
    signature = hmac.new(secret.encode(), payload, hashlib.sha256).digest()
    return f"{b64encode(payload)}.{b64encode(signature)}"


def dashboard_url(context: CallbackContext) -> str:
    """ETEBASE_DASHBOARD_URL_FUNC: the dashboard's address with a one-time login ticket for the user"""
    assert context.user is not None
    # In the fragment, so it doesn't end up in the logs of servers on the way
    return f"{settings.ETEBASE_DASHBOARD_URL}#{make_ticket(context.user.id, settings.ETEBASE_DASHBOARD_TICKET_SECRET)}"
