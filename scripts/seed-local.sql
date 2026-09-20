-- Local development fixtures for D-Pilot.
-- Generic names only (app_core / orders / customers), per the repo's rule that
-- nothing company- or deployment-specific goes in the codebase. Column names
-- are chosen to hit the default PHI rules (*first_name*, *email*, *phone*,
-- *date_of_birth*, *address_line_1*, *zip_code*) so masking is visible.
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
  DATE '1960-01-01' + (n * 97),
  n || ' Example Street',
  lpad(((10000 + n * 7) % 100000)::text, 5, '0')
FROM generate_series(1, 120) AS n;

INSERT INTO app_core.orders (customer_id, status, total_cents, notes, placed_at)
SELECT
  1 + (n % 120),
  (ARRAY['draft','placed','shipped','cancelled'])[1 + (n % 4)],
  (n * 1327) % 500000,
  CASE WHEN n % 11 = 0 THEN 'Flagged for manual review' ELSE NULL END,
  CASE WHEN n % 4 = 0 THEN NULL ELSE now() - (n || ' hours')::interval END
FROM generate_series(1, 400) AS n;

INSERT INTO app_core.order_items (order_id, sku, quantity, unit_cents)
SELECT 1 + (n % 400), 'SKU-' || lpad(((n * 13) % 500)::text, 4, '0'), 1 + (n % 5), ((n * 311) % 20000) + 100
FROM generate_series(1, 1200) AS n;

ANALYZE;
