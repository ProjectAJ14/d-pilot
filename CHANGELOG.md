# Changelog

All notable changes to **D-Pilot** are documented in this file. Releases
below v1.0.0's successors are generated automatically by semantic-release from
[Conventional Commits](https://www.conventionalcommits.org/); do not edit them
by hand.

# [1.15.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.14.0...v1.15.0) (2026-08-20)


### Features

* **artifacts:** shareable query documents with MCP authoring ([d674782](https://github.com/ProjectAJ14/d-pilot/commit/d6747820f7ee0bc206b32d2ac5ff90d78e3f1ff2))

# [1.14.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.13.0...v1.14.0) (2026-08-20)


### Features

* **pwa:** add install and update prompts ([440d338](https://github.com/ProjectAJ14/d-pilot/commit/440d338e7e8be3028ea031e610c39f41561e8910))
* **pwa:** register a service worker that never caches API responses ([0b88e18](https://github.com/ProjectAJ14/d-pilot/commit/0b88e18c470d1c88df581582b8e5b1d1ca493208))
* **pwa:** serve the web manifest from APP_NAME ([5d7ff5a](https://github.com/ProjectAJ14/d-pilot/commit/5d7ff5a46e11023921cc6a84bd5f5a1cad471117))

# [1.13.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.12.1...v1.13.0) (2026-08-07)


### Features

* **profile:** rebuild profile as a full-page, scrollable section ([369cb68](https://github.com/ProjectAJ14/d-pilot/commit/369cb686847650dcb046d08f9a6e941972f1a93b))

## [1.12.1](https://github.com/ProjectAJ14/d-pilot/compare/v1.12.0...v1.12.1) (2026-08-07)


### Bug Fixes

* **env:** drop the last hardcoded PROD assumptions outside the rails ([42a3976](https://github.com/ProjectAJ14/d-pilot/commit/42a397643d143bc00666b42d3f056bfd26a130c7))
* **phi:** lock PHI masking for every production-like environment ([fd81636](https://github.com/ProjectAJ14/d-pilot/commit/fd816365765b316825e689365820f046016afbb0))
* **write:** extend the two-person rule to every production-like environment ([1de1f40](https://github.com/ProjectAJ14/d-pilot/commit/1de1f40f07174a26510988bc390cc47192493a00))

# [1.12.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.11.0...v1.12.0) (2026-08-06)


### Features

* **env:** derive the environment list from DBFORGE_CONNECTIONS ([0f11bee](https://github.com/ProjectAJ14/d-pilot/commit/0f11bee12760bcd09dcc0826518d62c18c908971))

# [1.11.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.10.0...v1.11.0) (2026-08-04)


### Features

* **editor:** opt-in vim keybindings in the SQL editors ([da4c7bf](https://github.com/ProjectAJ14/d-pilot/commit/da4c7bf169a7e94875f5d88c5de22753eefdf1ca))

# [1.10.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.9.0...v1.10.0) (2026-08-04)


### Bug Fixes

* **security:** enforce read capability on every connection path ([e9f74c8](https://github.com/ProjectAJ14/d-pilot/commit/e9f74c89b0d394e196cd773aedaeca59b6e0d782))


### Features

* **mcp:** hosted read-only MCP endpoint for AI agents ([9617297](https://github.com/ProjectAJ14/d-pilot/commit/96172972a58729e5e702e58111a966f4a1b9293d))

# [1.9.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.8.0...v1.9.0) (2026-07-23)


### Features

* add Playwright MCP configuration and update UI driving instructions ([2bd75bc](https://github.com/ProjectAJ14/d-pilot/commit/2bd75bc02b61703da10cb1f094cc1a5548b4877f))
* add Playwright MCP configuration and update UI driving instructions ([86b1202](https://github.com/ProjectAJ14/d-pilot/commit/86b12020263d9c46232e26bca7b4cb4228cf9404))
* **write-requests:** multi-statement migrations with atomic rollback ([83146ed](https://github.com/ProjectAJ14/d-pilot/commit/83146edb8b2b09a2a0ee9dc575c8da760021f6e8))

# [1.8.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.7.0...v1.8.0) (2026-07-23)


### Features

* **write-composer:** drag-resizable SQL editors, shared config with read editor ([4d80423](https://github.com/ProjectAJ14/d-pilot/commit/4d80423c804e708c656623797787e804ac640214))

# [1.7.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.6.0...v1.7.0) (2026-07-22)


### Features

* **write-review:** layered voice — plain summary, technical risk bullets ([7a1c608](https://github.com/ProjectAJ14/d-pilot/commit/7a1c608a7946bef5bc445204dc0de6f9c1ab14d0))

# [1.6.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.5.0...v1.6.0) (2026-07-22)


### Features

* **write-review:** senior-architect AI review persona; fix empty verdict on reasoning models ([36259df](https://github.com/ProjectAJ14/d-pilot/commit/36259dfcd962b47ff7bda4568c75784f39b89c2d))

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
