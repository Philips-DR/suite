"""Google OpenID Connect sign-in with PKCE.

The assistant's own sign-in, separate from the tool credentials (docu-ai's Google Docs,
mail-ai's Gmail). Scopes are openid and email only. See CLAUDE.md, "Authentication"."""

from __future__ import annotations

import hashlib
import logging
import secrets
import time
from abc import ABC, abstractmethod
from base64 import urlsafe_b64encode
from datetime import datetime, timezone
from typing import TYPE_CHECKING
from urllib.parse import urlencode

import httpx

if TYPE_CHECKING:
    from assistant.db import Database

GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo"

log = logging.getLogger("assistant.auth")

SESSION_MAX_AGE = 7 * 24 * 3600  # 7 days
PENDING_MAX_AGE = 600  # 10 minutes for Google's consent screen


class Session:
    __slots__ = ("email", "expires_at")

    def __init__(self, email: str, expires_at: float) -> None:
        self.email = email
        self.expires_at = expires_at


class SessionStore(ABC):
    """Signed-in sessions, and the short-lived state of a sign-in in progress.

    A session is kept by the subclass: in memory (lost on restart, so the user signs in again) or in
    PostgreSQL (survives one). The pending state, which lives for the ten minutes Google's consent
    screen can take, stays in memory in both: losing it only means starting that sign-in over.
    """

    def __init__(self) -> None:
        self._pending: dict[str, tuple[str, str, float]] = {}

    @abstractmethod
    async def create(self, email: str) -> str: ...

    @abstractmethod
    async def get(self, sid: str) -> Session | None: ...

    @abstractmethod
    async def delete(self, sid: str) -> None: ...

    def save_pending(self, state: str, verifier: str, redirect: str) -> None:
        self._pending[state] = (verifier, redirect, time.time() + PENDING_MAX_AGE)

    def pop_pending(self, state: str) -> tuple[str, str] | None:
        entry = self._pending.pop(state, None)
        if entry is None or entry[2] <= time.time():
            return None
        return entry[0], entry[1]

    def _sweep_pending(self) -> None:
        now = time.time()
        self._pending = {k: v for k, v in self._pending.items() if v[2] > now}


class MemorySessionStore(SessionStore):
    """Sessions in a dict. Lost on restart -- the user signs in again."""

    def __init__(self) -> None:
        super().__init__()
        self._sessions: dict[str, Session] = {}

    async def create(self, email: str) -> str:
        sid = secrets.token_urlsafe(32)
        self._sessions[sid] = Session(email, time.time() + SESSION_MAX_AGE)
        if len(self._sessions) % 50 == 0:
            now = time.time()
            self._sessions = {k: v for k, v in self._sessions.items() if v.expires_at > now}
            self._sweep_pending()
        return sid

    async def get(self, sid: str) -> Session | None:
        s = self._sessions.get(sid)
        if s is None:
            return None
        if s.expires_at <= time.time():
            del self._sessions[sid]
            return None
        return s

    async def delete(self, sid: str) -> None:
        self._sessions.pop(sid, None)


class PgSessionStore(SessionStore):
    """Sessions in the sessions table, so a deploy does not sign anyone out."""

    def __init__(self, database: "Database") -> None:
        super().__init__()
        self._db = database

    async def create(self, email: str) -> str:
        sid = secrets.token_urlsafe(32)
        expires = datetime.fromtimestamp(time.time() + SESSION_MAX_AGE, timezone.utc)
        async with self._db.pool.acquire() as conn, conn.transaction():
            await conn.execute("DELETE FROM sessions WHERE expires_at <= now()")
            await conn.execute("INSERT INTO sessions (sid, email, expires_at) VALUES ($1, $2, $3)",
                               sid, email, expires)
        self._sweep_pending()
        return sid

    async def get(self, sid: str) -> Session | None:
        try:
            row = await self._db.pool.fetchrow(
                "SELECT email, expires_at FROM sessions WHERE sid = $1 AND expires_at > now()", sid)
        except Exception:
            # A request this cannot vouch for is not signed in; the guard must answer, not crash.
            log.warning("a session could not be looked up", exc_info=True)
            return None
        return Session(row["email"], row["expires_at"].timestamp()) if row else None

    async def delete(self, sid: str) -> None:
        await self._db.pool.execute("DELETE FROM sessions WHERE sid = $1", sid)


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
