"""Google OpenID Connect sign-in with PKCE.

The assistant's own sign-in, separate from the tool credentials (docu-ai's Google Docs,
mail-ai's Gmail). Scopes are openid and email only. See CLAUDE.md, "Authentication"."""

from __future__ import annotations

import hashlib
import secrets
import time
from base64 import urlsafe_b64encode
from urllib.parse import urlencode

import httpx

GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo"

SESSION_MAX_AGE = 7 * 24 * 3600  # 7 days
PENDING_MAX_AGE = 600  # 10 minutes for Google's consent screen


class Session:
    __slots__ = ("email", "expires_at")

    def __init__(self, email: str, expires_at: float) -> None:
        self.email = email
        self.expires_at = expires_at


class SessionStore:
    """In-memory sessions and pending OAuth state. Lost on restart -- the user signs in again."""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._pending: dict[str, tuple[str, str, float]] = {}

    def create(self, email: str) -> str:
        sid = secrets.token_urlsafe(32)
        self._sessions[sid] = Session(email, time.time() + SESSION_MAX_AGE)
        if len(self._sessions) % 50 == 0:
            self._sweep()
        return sid

    def get(self, sid: str) -> Session | None:
        s = self._sessions.get(sid)
        if s is None:
            return None
        if s.expires_at <= time.time():
            del self._sessions[sid]
            return None
        return s

    def delete(self, sid: str) -> None:
        self._sessions.pop(sid, None)

    def save_pending(self, state: str, verifier: str, redirect: str) -> None:
        self._pending[state] = (verifier, redirect, time.time() + PENDING_MAX_AGE)

    def pop_pending(self, state: str) -> tuple[str, str] | None:
        entry = self._pending.pop(state, None)
        if entry is None or entry[2] <= time.time():
            return None
        return entry[0], entry[1]

    def _sweep(self) -> None:
        now = time.time()
        self._sessions = {k: v for k, v in self._sessions.items() if v.expires_at > now}
        self._pending = {k: v for k, v in self._pending.items() if v[2] > now}


def pkce_pair() -> tuple[str, str]:
    """A PKCE code_verifier and its S256 challenge."""
    verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def google_login_url(client_id: str, redirect_uri: str, state: str, challenge: str) -> str:
    return GOOGLE_AUTH_ENDPOINT + "?" + urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "access_type": "online",
        "prompt": "select_account",
    })


class AuthError(Exception):
    pass


async def exchange_code(client_id: str, client_secret: str, redirect_uri: str,
                        code: str, verifier: str) -> dict:
    """Exchange an authorization code + PKCE verifier for tokens."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(GOOGLE_TOKEN_ENDPOINT, data={
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "code": code,
            "code_verifier": verifier,
            "grant_type": "authorization_code",
        })
        if r.status_code != 200:
            raise AuthError(f"token exchange failed ({r.status_code})")
        return r.json()


async def fetch_userinfo(access_token: str) -> dict:
    """The authenticated user's email, fetched directly from Google over TLS."""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(GOOGLE_USERINFO_ENDPOINT,
                             headers={"Authorization": f"Bearer {access_token}"})
        if r.status_code != 200:
            raise AuthError(f"userinfo request failed ({r.status_code})")
        return r.json()


def parse_allowed_emails(value: str | None) -> frozenset[str]:
    return frozenset(e.strip().lower() for e in (value or "").split(",") if e.strip())


def set_cookie(sid: str, secure: bool) -> str:
    parts = [f"session={sid}", f"Max-Age={SESSION_MAX_AGE}", "Path=/", "HttpOnly", "SameSite=Lax"]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def clear_cookie(secure: bool) -> str:
    parts = ["session=", "Max-Age=0", "Path=/", "HttpOnly", "SameSite=Lax"]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)
