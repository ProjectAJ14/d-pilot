# Changelog

All notable changes to **CEP DB Pilot** are documented in this file. Releases
below v1.0.0's successors are generated automatically by semantic-release from
[Conventional Commits](https://www.conventionalcommits.org/); do not edit them
by hand.

## [1.0.0] - 2026-07-12

Initial release of CEP DB Pilot — an internal, read-first SQL explorer with
built-in PHI masking for your organization's databases.

### Added

- Multi-database query workspace (PostgreSQL, MSSQL, MongoDB, Elasticsearch)
  with a Monaco SQL editor, AG Grid results, and per-tab schema selection.
- PHI shield: pattern-based column masking (FULL / PARTIAL / HASH / REDACT) with
  per-environment enforcement, `alwaysMasked` fields, and audited unmasking.
- Role-based access control (admin / phi_viewer / read) with per-user,
  per-environment access control and PROD safety rails.
- Write mode with a request → approval workflow, workspace, and approval UI.
- AI query generation assistant backed by Azure OpenAI.
- Results tooling: table/JSON view toggle, cell inspector drawer for large
  values, local-timezone datetime cells, and copy-as JSON / DDL / text.
- Tab persistence across sessions and configurable default query limits.
- Audit log with archival, date filtering, and PHI-unmask logging.
- Settings hub with sidebar navigation and usage analytics.
- Configurable app name, logo, and favicon.
- Language-aware SQL formatting and clipboard fallback for insecure contexts.
- App footer showing the release version, GitHub link, and contributors.

### Changed

- Consolidated connection and settings navigation.
- Redesigned the login screen and the Write & Request create/detail/reject flows.

### Fixed

- Enforced PROD safety rails for write mode and PHI masking.
- Corrected doubled `dist` path for static client files in production.
- Bound the server and Vite dev server to `0.0.0.0` for network access.
- Used store logout for 401 handling instead of a full page reload.
