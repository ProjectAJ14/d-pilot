-- Local development fixtures for D-Pilot.
-- Generic names only (app_core / orders / customers), per the repo's rule that
-- nothing company- or deployment-specific goes in the codebase. Column names
-- are chosen to hit the default PHI rules (*first_name*, *email*, *phone*,
-- *date_of_birth*, *address_line_1*, *zip_code*) so masking is visible.
--
-- The same file seeds every environment of docker-compose.dev.yml and varies
-- by database name: dpilot_qa and dpilot_prod get more rows, DEV carries an
-- unreleased version of open_order_count and the audit trigger has not reached
-- PROD, so the drift report has something to show. pg_cron jobs are added
-- wherever pg_cron runs in this database.
--
-- Load (drops and recreates app_core, so it is safe to re-run):
--   psql -h localhost -U <role> -d <database> -f scripts/seed-local.sql
-- npm run dev:db does this for each local environment.
\set ON_ERROR_STOP on
SELECT current_database() = 'dpilot_prod' AS is_prod,
       current_database() <> 'dpilot_prod' AS has_audit,
       current_database() = 'dpilot_dev' AS is_dev,
       CASE current_database() WHEN 'dpilot_prod' THEN 2000 WHEN 'dpilot_qa' THEN 500 ELSE 120 END AS customers,
       CASE current_database() WHEN 'dpilot_prod' THEN 8000 WHEN 'dpilot_qa' THEN 1500 ELSE 400 END AS orders,
       CASE current_database() WHEN 'dpilot_prod' THEN 24000 WHEN 'dpilot_qa' THEN 4500 ELSE 1200 END AS items,
       EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
         AND current_setting('cron.database_name', true) = current_database() AS has_cron
\gset

DROP SCHEMA IF EXISTS app_core CASCADE;
CREATE SCHEMA app_core;

CREATE TABLE app_core.customers (
  id                serial PRIMARY KEY,
  first_name        text NOT NULL,
  last_name         text NOT NULL,
  email             text NOT NULL UNIQUE,
  phone             text,
  date_of_birth     date,
  address_line_1    text,
  zip_code          text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_core.orders (
  id            serial PRIMARY KEY,
  customer_id   integer NOT NULL REFERENCES app_core.customers(id),
  status        text NOT NULL CHECK (status IN ('draft','placed','shipped','cancelled')),
  total_cents   bigint NOT NULL DEFAULT 0,
  notes         text,
  placed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_core.order_items (
  id          serial PRIMARY KEY,
  order_id    integer NOT NULL REFERENCES app_core.orders(id),
  sku         text NOT NULL,
  quantity    integer NOT NULL DEFAULT 1,
  unit_cents  bigint NOT NULL
);

CREATE INDEX ON app_core.orders (customer_id);
CREATE INDEX ON app_core.orders (status);
CREATE INDEX ON app_core.order_items (order_id);

CREATE VIEW app_core.order_totals AS
SELECT o.id AS order_id, o.status, o.customer_id,
       COALESCE(SUM(i.quantity * i.unit_cents), 0) AS computed_cents
FROM app_core.orders o
LEFT JOIN app_core.order_items i ON i.order_id = o.id
GROUP BY o.id, o.status, o.customer_id;

INSERT INTO app_core.customers (first_name, last_name, email, phone, date_of_birth, address_line_1, zip_code)
SELECT
  (ARRAY['Ada','Grace','Alan','Edsger','Barbara','Ken','Margaret','Linus'])[1 + (n % 8)],
  (ARRAY['Lovelace','Hopper','Turing','Dijkstra','Liskov','Thompson','Hamilton','Torvalds'])[1 + (n % 8)],
  'user' || n || '@example.com',
  '555-01' || lpad((n % 100)::text, 2, '0'),
  DATE '1960-01-01' + (n * 97 % 20000),
  n || ' Example Street',
  lpad(((10000 + n * 7) % 100000)::text, 5, '0')
FROM generate_series(1, :customers) AS n;

INSERT INTO app_core.orders (customer_id, status, total_cents, notes, placed_at)
SELECT
  1 + (n % :customers),
  (ARRAY['draft','placed','shipped','cancelled'])[1 + (n % 4)],
  (n * 1327) % 500000,
  CASE WHEN n % 11 = 0 THEN 'Flagged for manual review' ELSE NULL END,
  CASE WHEN n % 4 = 0 THEN NULL ELSE now() - (n || ' hours')::interval END
FROM generate_series(1, :orders) AS n;

INSERT INTO app_core.order_items (order_id, sku, quantity, unit_cents)
SELECT 1 + (n % :orders), 'SKU-' || lpad(((n * 13) % 500)::text, 4, '0'), 1 + (n % 5), ((n * 311) % 20000) + 100
FROM generate_series(1, :items) AS n;

-- Programmable objects, for the object browser and the drift report.
CREATE VIEW app_core.open_orders AS
SELECT id, customer_id, status, total_cents, placed_at
FROM app_core.orders
WHERE status IN ('draft', 'placed');

CREATE MATERIALIZED VIEW app_core.daily_revenue AS
SELECT date_trunc('day', placed_at) AS day, count(*) AS orders, sum(total_cents) AS revenue_cents
FROM app_core.orders
WHERE status <> 'cancelled' AND placed_at IS NOT NULL
GROUP BY 1;

\if :is_dev
-- Not released yet: DEV counts drafts as open, QA and PROD do not.
CREATE FUNCTION app_core.open_order_count(p_customer_id integer)
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM app_core.orders
  WHERE customer_id = p_customer_id AND status IN ('draft', 'placed')
$$;
\else
CREATE FUNCTION app_core.open_order_count(p_customer_id integer)
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM app_core.orders
  WHERE customer_id = p_customer_id AND status = 'placed'
$$;
\endif

-- Two overloads, so the browser has to tell them apart by arguments.
CREATE PROCEDURE app_core.refresh_order_totals()
LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW app_core.daily_revenue
$$;

CREATE PROCEDURE app_core.refresh_order_totals(p_days integer)
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE app_core.orders o
  SET total_cents = t.computed_cents
  FROM app_core.order_totals t
  WHERE t.order_id = o.id AND o.placed_at > now() - make_interval(days => p_days);
END
$$;

CREATE PROCEDURE app_core.close_stale_orders(p_days integer DEFAULT 30)
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE app_core.orders
  SET status = 'cancelled', notes = 'Closed as stale'
  WHERE status = 'draft' AND created_at < now() - make_interval(days => p_days);
END
$$;

\if :has_audit
-- The audit trigger is on its way to PROD: DEV and QA have it, PROD does not.
CREATE TABLE app_core.orders_audit (
  id         bigserial PRIMARY KEY,
  order_id   integer NOT NULL,
  old_status text,
  new_status text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION app_core.orders_audit_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO app_core.orders_audit (order_id, old_status, new_status)
    VALUES (NEW.id, OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER orders_audit
AFTER UPDATE OF status ON app_core.orders
FOR EACH ROW EXECUTE FUNCTION app_core.orders_audit_fn();
\endif

\if :has_cron
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.unschedule(jobid) FROM cron.job;
SELECT cron.schedule('refresh-daily-revenue', '* * * * *', 'CALL app_core.refresh_order_totals()');
SELECT cron.schedule('close-stale-orders', '0 2 * * *', 'CALL app_core.close_stale_orders(30)');
SELECT cron.schedule('vacuum-orders', '30 3 * * 0', 'VACUUM ANALYZE app_core.orders');
\if :is_prod
-- Paused in PROD, so a disabled job shows up too.
UPDATE cron.job SET active = false WHERE jobname = 'vacuum-orders';
\endif
\endif

ANALYZE;
