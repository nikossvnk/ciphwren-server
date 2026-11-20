"""Internal API for an account service that manages the users of a hosted server.

Mounted at `/internal/v1/` only when `ETEBASE_INTERNAL_API_SECRETS` is set. It must only be reachable
from the private network the account service runs in, never through the public reverse proxy.
"""
