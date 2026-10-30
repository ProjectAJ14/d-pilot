// Registers the docker-compose.dev.yml databases as D-Pilot connections, in the
// SQLite store under DATA_DIR (from .env). Upserts by id, so re-running only
// refreshes them; any other connection is left alone. Run by npm run dev:db —
// restart a running server to pick the changes up.
import "dotenv/config";
import {
  initDatabase,
  saveDbConnections,
} from "../server/services/sqlite-store.js";

const ENVS = [
  { env: "DEV", port: 5433 },
  { env: "QA", port: 5434 },
  { env: "PROD", port: 5435 },
];

initDatabase();
saveDbConnections(
  ENVS.map(({ env, port }) => ({
    id: `local-${env.toLowerCase()}-pg`,
    name: `Local Postgres ${env}`,
    env,
    type: "postgres" as const,
    host: "localhost",
    port,
    database: `dpilot_${env.toLowerCase()}`,
    username: "dpilot",
    password: "dpilot",
    schema: "app_core",
  })),
);
console.log(
  `Registered ${ENVS.map((e) => `Local Postgres ${e.env} (localhost:${e.port})`).join(", ")}`,
);
