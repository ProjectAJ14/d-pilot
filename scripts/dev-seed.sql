-- Baseline schema for the local dev Postgres (docker-compose.dev.yml).
-- Runs once, on first container boot. Company-agnostic, generic names only —
-- just enough to exercise single-DML writes AND multi-statement migrations
-- (ALTER TABLE, CREATE INDEX, dollar-quoted inserts, etc.).

CREATE SCHEMA IF NOT EXISTS app_core;

CREATE TABLE IF NOT EXISTS app_core.customers (
    id          serial PRIMARY KEY,
    name        text NOT NULL,
    email       text,
    status      text NOT NULL DEFAULT 'active',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_core.orders (
    id           serial PRIMARY KEY,
    customer_id  integer NOT NULL REFERENCES app_core.customers(id),
    total_cents  integer NOT NULL DEFAULT 0,
    status       text NOT NULL DEFAULT 'pending',
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- A config-style table so migrations like "insert missing rows / backfill NULLs"
-- (the V022 example shape) have somewhere realistic to run.
CREATE TABLE IF NOT EXISTS app_core.app_config (
    id            serial PRIMARY KEY,
    config_key    text UNIQUE NOT NULL,
    config_value  text,
    notes         text
);

INSERT INTO app_core.customers (name, email, status) VALUES
    ('Ada Lovelace',   'ada@example.com',   'active'),
    ('Alan Turing',    'alan@example.com',  'active'),
    ('Grace Hopper',   'grace@example.com', 'inactive')
ON CONFLICT DO NOTHING;

INSERT INTO app_core.orders (customer_id, total_cents, status) VALUES
    (1, 1299, 'paid'),
    (1, 4500, 'pending'),
    (2,  999, 'paid')
ON CONFLICT DO NOTHING;

INSERT INTO app_core.app_config (config_key, config_value) VALUES
    ('feature.flags', 'a,b,c'),
    ('retention.days', '30')
ON CONFLICT DO NOTHING;
