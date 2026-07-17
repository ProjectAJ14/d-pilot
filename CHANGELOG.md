# Changelog

All notable changes to **D-Pilot** are documented in this file. Releases
below v1.0.0's successors are generated automatically by semantic-release from
[Conventional Commits](https://www.conventionalcommits.org/); do not edit them
by hand.

# [1.5.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.4.0...v1.5.0) (2026-07-17)


### Features

* add live connection pool status and disconnect ([85da7c4](https://github.com/ProjectAJ14/d-pilot/commit/85da7c410db8045787d53665c4a4b5278bd67005))

# [1.4.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.3.0...v1.4.0) (2026-07-14)


### Features

* add rotating open-source callouts to footer and create SKILL.md for local verification ([4b24e4a](https://github.com/ProjectAJ14/d-pilot/commit/4b24e4ae6300256c09c7bd31e35dd4453fc89a04))

# [1.3.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.2.0...v1.3.0) (2026-07-14)


### Bug Fixes

* show full contributor avatars and add footer to login screen ([f48f7be](https://github.com/ProjectAJ14/d-pilot/commit/f48f7be99191761adf99bd27dc840213c314d766))


### Features

* add CSV import/export and bulk delete for PHI tokenization rules ([1b1d7ba](https://github.com/ProjectAJ14/d-pilot/commit/1b1d7ba5d3cd7fe3c2279220db23caeadb5df639))
* surface database connection failures and sync schema dropdowns ([cbb4fd7](https://github.com/ProjectAJ14/d-pilot/commit/cbb4fd7ca2a7ea28c66601093342c1e94ed70471))

# [1.2.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.1.0...v1.2.0) (2026-07-14)


### Features

* context-aware SQL autocomplete with alias and clause scoping ([9eb6f1b](https://github.com/ProjectAJ14/d-pilot/commit/9eb6f1b9db597164b3365c47b806971daae01c5a))
* shareable links for saved queries ([a47e58e](https://github.com/ProjectAJ14/d-pilot/commit/a47e58e27b611ea5cf6b0966ad07441ac79fad3e))

# [1.1.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.0.0...v1.1.0) (2026-07-12)


### Features

* add credential handoff popup and password generator for user onboarding ([7c9c29e](https://github.com/ProjectAJ14/d-pilot/commit/7c9c29ebaedeab06e3e50223bc0b55ec4c4f7901))

## [1.0.0] - 2026-07-12

Initial release of D-Pilot — an internal, read-first SQL explorer with
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
