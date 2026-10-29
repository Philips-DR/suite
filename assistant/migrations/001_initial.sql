-- The first schema. Migrations are applied in file-name order, each once, by assistant/db.py,
-- and a file that has been applied is never edited: a change is a new, higher-numbered file.
--
-- Used now: facts, sessions, audit_log. Laid down for later, with nothing reading or writing them
-- yet: users (multi-user) and dossiers + dossier_refs (one record per goal, e.g. a job application).

CREATE TABLE users (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email      TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dossiers (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dossier_refs (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dossier_id UUID NOT NULL REFERENCES dossiers (id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('google_doc', 'gmail_draft', 'file', 'url')),
    value      TEXT NOT NULL,
    label      TEXT NOT NULL DEFAULT '',
    position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX dossier_refs_dossier ON dossier_refs (dossier_id, position);

-- What the assistant knows about the user (was memory.json). The id is the short one the model
-- passes to `forget`. user_id stays NULL until multi-user makes it required.
CREATE TABLE facts (
    id               TEXT PRIMARY KEY,
    user_id          UUID REFERENCES users (id) ON DELETE CASCADE,
    kind             TEXT NOT NULL CHECK (kind IN ('person', 'project', 'preference', 'spelling', 'fact')),
    subject          TEXT NOT NULL,
    content          TEXT NOT NULL,
    source           TEXT,
    scope_dossier_id UUID REFERENCES dossiers (id) ON DELETE CASCADE,
    created_at       DATE NOT NULL DEFAULT CURRENT_DATE,
    -- clock_timestamp(), not now(): now() is one value for a whole transaction, and facts keep the
    -- order they were written in by this column.
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Signed-in sessions (was a dict in memory, lost on every restart).
CREATE TABLE sessions (
    sid        TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

-- One row per tool call (was audit.jsonl). arguments and result are the short summaries the
-- file kept, not the whole text.
CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    logged_at   TIMESTAMPTZ NOT NULL,
    tool        TEXT NOT NULL,
    arguments   TEXT,
    outcome     TEXT NOT NULL,
    error       TEXT,
    duration_ms INTEGER,
    result      TEXT,
    origin      TEXT,
    user_id     UUID REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX audit_log_logged_at ON audit_log (logged_at);
CREATE INDEX audit_log_tool ON audit_log (tool);
