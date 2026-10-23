# Changelog

All notable changes to **D-Pilot** are documented in this file. Releases
below v1.0.0's successors are generated automatically by semantic-release from
[Conventional Commits](https://www.conventionalcommits.org/); do not edit them
by hand.

# [2.4.0](https://github.com/ProjectAJ14/d-pilot/compare/v2.3.0...v2.4.0) (2026-10-23)


### Bug Fixes

* **client:** check a 504 with a health ping before calling the server unreachable ([f45a4fd](https://github.com/ProjectAJ14/d-pilot/commit/f45a4fd4883a4847427d08201d9945f50e081a31))
* **client:** don't call a request fetch refuses to send an unreachable server ([96ed419](https://github.com/ProjectAJ14/d-pilot/commit/96ed4196765ebdea88e65a226ee32694039899a7))
* **client:** offer no bug report for an unreachable database ([9df3dd4](https://github.com/ProjectAJ14/d-pilot/commit/9df3dd4d232c39804333fa89041d93e01e7170aa))
* **client:** reload the app's data when the server comes back ([9260e62](https://github.com/ProjectAJ14/d-pilot/commit/9260e62457692ffc66f085b913e5543ef9d6f016))
* **client:** show the network hint on sign-in when the server is unreachable ([6f69483](https://github.com/ProjectAJ14/d-pilot/commit/6f6948391e7d50614e3aeb5bdca0b9deef0559be))
* **mcp-bridge:** find the Microsoft Store Claude Desktop config and trust the system CA ([939e993](https://github.com/ProjectAJ14/d-pilot/commit/939e99311f4b63d338fa30ec29806127b8dcd355))
* **mcp-bridge:** install through symlinks, with a node path that survives upgrades ([373ec1c](https://github.com/ProjectAJ14/d-pilot/commit/373ec1c93b9cb750cf2c04fd7d1642df39a591ad))
* **mcp-bridge:** match node.EXE to node.exe on Windows ([9f838d3](https://github.com/ProjectAJ14/d-pilot/commit/9f838d3cade20fe8636a7a841a4ddb43d0378a5a))
* **mcp-bridge:** trust any real answer, and name portals and bad certificates ([3d0c020](https://github.com/ProjectAJ14/d-pilot/commit/3d0c020d424d676ac89a7bc571e0dcbefb1213a3))
* **mcp-bridge:** write the Claude Desktop backup owner-only ([726c605](https://github.com/ProjectAJ14/d-pilot/commit/726c605243fff3a22f3032105e106ce88df6ab64))
* **mcp-setup:** keep the password prompt waiting when step 2 is pasted ([d7ee10d](https://github.com/ProjectAJ14/d-pilot/commit/d7ee10d8197c1e02d84053ef4e798f61fd8963ab))
* **mcp-setup:** prefill the username, name what's missing, and show the Linux path ([89d68df](https://github.com/ProjectAJ14/d-pilot/commit/89d68dfc6129280bca4da2b4103e9138fae0428b))
* **mcp:** keep the credential out of bridge errors ([80a77a5](https://github.com/ProjectAJ14/d-pilot/commit/80a77a545d8c04b9fca39747411ccea23f339490))
* **mcp:** parse DPILOT_MCP_URL the way fetch does ([a2367a2](https://github.com/ProjectAJ14/d-pilot/commit/a2367a2250adb31217f5bc4e21256cb5d6fc544d))
* **phi:** send unmask reason and notes URI-encoded ([ee0cd85](https://github.com/ProjectAJ14/d-pilot/commit/ee0cd8522518ac7e41b09e9b5ed5d9f8cc959d1e))
* **server:** answer unreachable databases with 503 everywhere, never 502 ([80f8e74](https://github.com/ProjectAJ14/d-pilot/commit/80f8e7481e303556c25df8b708626f34c20f0b4c))
* **server:** stop calling slow queries and refused logins network problems ([6f9b105](https://github.com/ProjectAJ14/d-pilot/commit/6f9b10568bbb63d95da88b7b38d480caa73ce9e1))
* **server:** survive a database dropping an introspection pool's connection ([745c06c](https://github.com/ProjectAJ14/d-pilot/commit/745c06c228692e370ff01612e030efb9b2cd3490))
* **server:** survive a database dropping its idle pooled connections ([e431541](https://github.com/ProjectAJ14/d-pilot/commit/e431541e0a5396cac7ab29ae5b58ea73006600ed))
* **write-requests:** claim a direct-write run so it executes once ([73120ee](https://github.com/ProjectAJ14/d-pilot/commit/73120ee1e550db40411564e8d1aa25eaa771c290))
* **write-requests:** keep a write that never reached its database runnable ([34a567b](https://github.com/ProjectAJ14/d-pilot/commit/34a567b5a33c548fe5d2d5b99ab2bb02c0284d2f))
* **write-requests:** only treat failures before the statement is sent as retryable ([70eb3c0](https://github.com/ProjectAJ14/d-pilot/commit/70eb3c0079514a7f5adf5003ef6dbff6420fb3ef))
* **write-requests:** record NOT_RUN when a write never reached its database ([5c8972c](https://github.com/ProjectAJ14/d-pilot/commit/5c8972c4dc12182961bad28632a6ab6653895dbe))
* **write-requests:** revise only from the status it checked ([860a619](https://github.com/ProjectAJ14/d-pilot/commit/860a61974d169c0896ae8e6598664909b1a63eb6))
* **write-requests:** show a write that never reached its database as it is ([451d024](https://github.com/ProjectAJ14/d-pilot/commit/451d024447d1833c0196a4ffe5d587c99a8f35d6))


### Features

* **client:** show one banner when the D-Pilot server is unreachable ([4c15c0e](https://github.com/ProjectAJ14/d-pilot/commit/4c15c0e2d22382f3eeb10aa3f43999fa8a3b3804))
* **mcp-bridge:** let the bridge add itself to Claude Desktop's config ([a8ef61a](https://github.com/ProjectAJ14/d-pilot/commit/a8ef61a2a43f31b85125af290c57d52d5250e1a3))
* **mcp-setup:** build the token on the page, with macOS and Windows commands ([f759348](https://github.com/ProjectAJ14/d-pilot/commit/f759348acced1092c43d002737a5f44b379234cd))
* **mcp:** add a local stdio bridge that explains an unreachable server ([6dfda11](https://github.com/ProjectAJ14/d-pilot/commit/6dfda110a5a3bfd50fc14e10d1cb2c280b250e42))
* **server:** explain unreachable databases and add a network hint setting ([004f8ac](https://github.com/ProjectAJ14/d-pilot/commit/004f8ac8dadd245b16aa700bec6893b051c2d27f))

# [2.3.0](https://github.com/ProjectAJ14/d-pilot/compare/v2.2.0...v2.3.0) (2026-10-23)


### Features

* **settings:** add user search to User Management ([02c9fb1](https://github.com/ProjectAJ14/d-pilot/commit/02c9fb1431c377b13d7fed87651a6a1060c4421a))

# [2.2.0](https://github.com/ProjectAJ14/d-pilot/compare/v2.1.0...v2.2.0) (2026-10-22)


### Features

* **editor:** show the target environment on Run and the editor ([87f5b93](https://github.com/ProjectAJ14/d-pilot/commit/87f5b93e0a1d5e3eb01b3d131492a1806e0fac41))
* **sidebar:** pin connections to the top of their environment ([e03fb51](https://github.com/ProjectAJ14/d-pilot/commit/e03fb519836f27149ccb9f9f8fe8faad82fdb6ac))
* **sidebar:** reorder pinned connections by drag or Alt+arrows ([b166f0e](https://github.com/ProjectAJ14/d-pilot/commit/b166f0ef9b1819aecd2c07e12a8e03f325783103))

# [2.1.0](https://github.com/ProjectAJ14/d-pilot/compare/v2.0.0...v2.1.0) (2026-10-14)


### Features

* **sidebar:** recent-first connections, global search, env tabs ([7f823b0](https://github.com/ProjectAJ14/d-pilot/commit/7f823b0ad3acb4a4f36cfafee09b30863365f74c))

# [2.0.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.31.0...v2.0.0) (2026-10-14)


* feat(connections)!: stop reading DBFORGE_CONNECTIONS ([0e065a2](https://github.com/ProjectAJ14/d-pilot/commit/0e065a25c7e2dcfaef9b1dbd92ae72b59454ee92))
* feat(settings)!: stop reading AI settings from .env ([a4d3ddd](https://github.com/ProjectAJ14/d-pilot/commit/a4d3ddde8c52cbb56331cd92f78df5df2cff75d3))


### Bug Fixes

* **connections:** don't block a disconnect on a running pg query ([008476b](https://github.com/ProjectAJ14/d-pilot/commit/008476bed8590e7f04fc55cfea6bc11baf914800))
* **connections:** don't close a retired client under a running write ([c3b20d8](https://github.com/ProjectAJ14/d-pilot/commit/c3b20d8a8476fb935d4c2e8111427e2d7d21c4ea))
* **connections:** don't retry the Settings Elasticsearch test ping ([130c2d1](https://github.com/ProjectAJ14/d-pilot/commit/130c2d1eb3211361035578ac117f4ffdb055af97))
* **connections:** force-close on an explicit disconnect again ([08d01d2](https://github.com/ProjectAJ14/d-pilot/commit/08d01d2f13a9266b861e036a6ea277fb8bbf9c26))
* **connections:** hold a retired client per client, not per connection ([b42c1f6](https://github.com/ProjectAJ14/d-pilot/commit/b42c1f65ab6214cf0000eba862daed9e4778b327))
* **connections:** never reject from an explicit disconnect ([68790e5](https://github.com/ProjectAJ14/d-pilot/commit/68790e5e76e265649051529305d2862983899fb0))
* **connections:** retire an edited connection's pool in the background ([1204edb](https://github.com/ProjectAJ14/d-pilot/commit/1204edbffe07928fff688886dfed95d30e16af6d))
* **envs:** keep saved envs that have no connection right now ([7597adb](https://github.com/ProjectAJ14/d-pilot/commit/7597adb252535a61403419a044defe880805b2c4))
* **envs:** let admins revoke envs that have no connection ([23cee32](https://github.com/ProjectAJ14/d-pilot/commit/23cee329c061bc557d838da32635c2b06d98eed6))
* **schema:** keep an introspection that raced a cache clear out of the cache ([2f9681e](https://github.com/ProjectAJ14/d-pilot/commit/2f9681e168b47e73d0d12e50cc69fab6fd10efd6))
* **secrets:** create the key file atomically and log each bad secret once ([35b3f94](https://github.com/ProjectAJ14/d-pilot/commit/35b3f94fc47c891fdb086d4001638974de944422))
* **secrets:** create the key file where hard links are unsupported ([9d5b489](https://github.com/ProjectAJ14/d-pilot/commit/9d5b4898809800e8acecf5da16b3494bef89ad6a))
* **secrets:** make the no-hard-link key file fallback atomic ([02a8d4e](https://github.com/ProjectAJ14/d-pilot/commit/02a8d4e6877f1feec7cbf100dd714ff8f2b526ea))
* **settings:** accept only paths or http(s) URLs for logos and favicon ([f094cb2](https://github.com/ProjectAJ14/d-pilot/commit/f094cb2d32a45fc41ebf1464ec83d0df17175b80))
* **settings:** audit connection fields an update cleared ([3a530a9](https://github.com/ProjectAJ14/d-pilot/commit/3a530a9485fc02fd510644611ca0446bebd278ac))
* **settings:** cap numeric limits at a sane maximum ([4968fb6](https://github.com/ProjectAJ14/d-pilot/commit/4968fb696b382f79513ba2ae6650a71c6c65cc30))
* **settings:** close remaining secret-redirect paths ([cf2df37](https://github.com/ProjectAJ14/d-pilot/commit/cf2df37c2232df7489fea7be3daa47ddbb8e286f))
* **settings:** fall back to the default for out-of-range numbers ([91fb2da](https://github.com/ProjectAJ14/d-pilot/commit/91fb2da205c707766e108ddf1d9fb22ec78be0af))
* **settings:** gate kept passwords on a safe-field allowlist ([63f5cb8](https://github.com/ProjectAJ14/d-pilot/commit/63f5cb81b8f9361839a0a426a838ec8aedd6bc0e))
* **settings:** guard the AI key target while a key is stored ([94e3963](https://github.com/ProjectAJ14/d-pilot/commit/94e3963ecdbe5f258383cf67c537f7803fda42c9))
* **settings:** hide driver errors when a test used stored secrets ([275aeee](https://github.com/ProjectAJ14/d-pilot/commit/275aeee68101dbb109d9a9be7b6fb6706c7fd2dd))
* **settings:** keep an undecryptable connection secret intact ([04381d3](https://github.com/ProjectAJ14/d-pilot/commit/04381d336d0428b446a291ee26b9d001507c424c))
* **settings:** keep an undecryptable secret unset ([b86de39](https://github.com/ProjectAJ14/d-pilot/commit/b86de396fa3720698c03bde0a8c169e2621be91b))
* **settings:** keep production connections in a production env ([fdce6d3](https://github.com/ProjectAJ14/d-pilot/commit/fdce6d3f752a9415466402e3a114b89cfe0c7775))
* **settings:** let an admin clear a stored password or URI ([b395014](https://github.com/ProjectAJ14/d-pilot/commit/b395014820b2f1e7829856c96e601f2707d9af53))
* **settings:** mask secrets in the logged connection-test error ([f39d9ee](https://github.com/ProjectAJ14/d-pilot/commit/f39d9ee45ea895eb23a4af2280894a9e84a3959a))
* **settings:** read bool settings the same way in UI and server ([39b94e4](https://github.com/ProjectAJ14/d-pilot/commit/39b94e44d0364049ac6fad32f3e56ad4bcb9b0e0))
* **settings:** reject backslashes in logo and favicon URLs ([1f4f086](https://github.com/ProjectAJ14/d-pilot/commit/1f4f086b8af7199235145bbe0544e09d8c1a5f2f))
* **settings:** reject whitespace and control characters in asset URLs ([cdd11a6](https://github.com/ProjectAJ14/d-pilot/commit/cdd11a66a8c4fadde7a100256d93d23fa712761f))
* **settings:** report a stored but undecryptable AI key as set ([02a85c6](https://github.com/ProjectAJ14/d-pilot/commit/02a85c6e00270c305438246979c2404ced04dcad))
* **settings:** require a unit and a positive JWT_EXPIRES_IN ([03a741f](https://github.com/ProjectAJ14/d-pilot/commit/03a741fc2f7c93635b02ada265d717da240a8ec2))
* **settings:** require secret re-entry when its target changes ([b6f77f6](https://github.com/ProjectAJ14/d-pilot/commit/b6f77f6949f5af91db57b2a69929c086f6b55fa6))
* **settings:** retire pools without awaiting on a timeout change ([63a0c8d](https://github.com/ProjectAJ14/d-pilot/commit/63a0c8d415869b2cf19105813d3f21e97b173b00))
* **settings:** seed connections once DBFORGE_CONNECTIONS has some ([114698a](https://github.com/ProjectAJ14/d-pilot/commit/114698a15aee3991300fd81e31a8fa769a92b912))
* **settings:** show a limit's clamped value in Settings ([6e46656](https://github.com/ProjectAJ14/d-pilot/commit/6e4665668df8dcce81f6eff3f02dfb18465c12ea))
* **settings:** show copy formats and favicon defaults ([e66dc5f](https://github.com/ProjectAJ14/d-pilot/commit/e66dc5f5f368199883f1952921dc44dfa1cc2794))
* **ui:** align connection form fields ([8f4423c](https://github.com/ProjectAJ14/d-pilot/commit/8f4423cd65aa624b271d0a1160f8b4ca307bf482))
* **ui:** clear the active connection when the last one is deleted ([5d9ca55](https://github.com/ProjectAJ14/d-pilot/commit/5d9ca551f9ef06ddda57fcd55f0dbe78eb80b0f2))
* **ui:** detach tabs from deleted connections through the store ([deb7e9a](https://github.com/ProjectAJ14/d-pilot/commit/deb7e9a97a350dc23a6a69237f35176760f0829f))
* **ui:** forget the remembered schema of a deleted connection ([d9a5cb3](https://github.com/ProjectAJ14/d-pilot/commit/d9a5cb3fe49f1bf4b42263f61b3727e857df073f))
* **ui:** keep a saved orphan env pickable until the user edit is saved ([ddf55f2](https://github.com/ProjectAJ14/d-pilot/commit/ddf55f2bc02d429ba3a48a353469f41f02cc3db9))
* **write:** bind drafts saved before the upgrade to their connection ([13b0293](https://github.com/ProjectAJ14/d-pilot/commit/13b0293c4a450bb233f4facc3ad26532134105ef))
* **write:** bind the default schema and quote it ([f2f2d68](https://github.com/ProjectAJ14/d-pilot/commit/f2f2d683a8bb191d9630a5792a8db2159d9c744c))
* **write:** keep a request's env and target in step with its connection ([4b426a7](https://github.com/ProjectAJ14/d-pilot/commit/4b426a72392652bd288c45e73a573168a9261455))


### Features

* **settings:** admin screens for connections, branding, limits and AI ([e3ad766](https://github.com/ProjectAJ14/d-pilot/commit/e3ad766027004286113d1e9329c23962816e7696))
* **settings:** configure the login page text ([2711674](https://github.com/ProjectAJ14/d-pilot/commit/271167462f6ee34f38c7daa57ae0b1c1f00c3f68))
* **settings:** import connections from JSON ([6f4f48e](https://github.com/ProjectAJ14/d-pilot/commit/6f4f48e821e53ab463858a56123a809b649674af))
* **settings:** import connections from JSON in the UI ([18c5a56](https://github.com/ProjectAJ14/d-pilot/commit/18c5a56f29f54e41183142f375f7ee85e705c2c0))
* **settings:** operator ceilings for limits ([8a78fef](https://github.com/ProjectAJ14/d-pilot/commit/8a78fefa7e9b1d5ecb8dbdb074b1067d7526b9c8))
* **settings:** store runtime config in the app database ([3b7e275](https://github.com/ProjectAJ14/d-pilot/commit/3b7e2759559fcea3f49405885e484945baa39235))
* **settings:** tab title follows the app name ([f2b99f6](https://github.com/ProjectAJ14/d-pilot/commit/f2b99f659c56d01132e7a3d1cb79eccbf5a7889d))
* **settings:** test a connection before saving it ([0911cc5](https://github.com/ProjectAJ14/d-pilot/commit/0911cc591113f42bfe6295a8c510964c57ff51cb))
* **settings:** test connections before importing them ([e5dca1a](https://github.com/ProjectAJ14/d-pilot/commit/e5dca1af052a21f7127f4dd68a3e5bae9e116539))
* **ui:** hide the footer on the login screen ([47492da](https://github.com/ProjectAJ14/d-pilot/commit/47492da2dcd6ce3bd7123e4d3df1e989006cda63))
* **write:** bind a write request to its connection target ([e700d05](https://github.com/ProjectAJ14/d-pilot/commit/e700d05a5befc6783a574f56fb813ea86e2fe7d6))


### Performance Improvements

* **settings:** prepare getSetting once and read MAX_ROWS once per query ([0a0a0a2](https://github.com/ProjectAJ14/d-pilot/commit/0a0a0a2088a51889fb722bcfc005b037c27110ec))
* **settings:** read every connection's secret flags in one query ([769a1df](https://github.com/ProjectAJ14/d-pilot/commit/769a1dfd10397cda9e5f9e27cef5865ce49d8fc6))


### BREAKING CHANGES

* AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY,
AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_MODEL, AZURE_OPENAI_API_VERSION and
AZURE_OPENAI_INSECURE_TLS are no longer read from the environment. Values
already saved in Settings keep working; values that only lived in .env must
be re-entered under Settings -> Azure OpenAI.
* DBFORGE_CONNECTIONS is no longer read. An install that already
imported it keeps its connections. A fresh install must add them in Settings ->
Connections, or paste the old JSON array into Settings -> Connections -> Import.

# [1.31.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.30.0...v1.31.0) (2026-10-14)


### Features

* **write:** admin override to run a pending write without approval ([1385fa2](https://github.com/ProjectAJ14/d-pilot/commit/1385fa27ac3d4fb93c8c6c4efcd766b1921434a3))

# [1.30.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.29.0...v1.30.0) (2026-10-13)


### Features

* **mcp:** in-app setup page that generates the agent prompt ([ef2dc93](https://github.com/ProjectAJ14/d-pilot/commit/ef2dc939bf32c2e312b4012761c693c07dd03e79))

# [1.29.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.28.0...v1.29.0) (2026-10-08)


### Bug Fixes

* **ai:** re-check PHI rules before caching sampled values ([6635e23](https://github.com/ProjectAJ14/d-pilot/commit/6635e2347d09e1ef94f765e0dc3c392f805c5fa5))


### Features

* **ai:** admin toggle for column values and friendly content-filter errors ([42b01f3](https://github.com/ProjectAJ14/d-pilot/commit/42b01f36e5b48a3299a323c74a292903b44a554b))
* **ai:** show enum column values in the AI schema context ([fb9bef8](https://github.com/ProjectAJ14/d-pilot/commit/fb9bef81343aecc690681e9d94f6f7a0fa44c4f6))

# [1.28.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.27.2...v1.28.0) (2026-09-29)


### Features

* **write:** show Mongo verify previews as JSON ([1b16c1d](https://github.com/ProjectAJ14/d-pilot/commit/1b16c1d9180e6555b9b6760bd47af52a3e94182d))

## [1.27.2](https://github.com/ProjectAJ14/d-pilot/compare/v1.27.1...v1.27.2) (2026-09-28)


### Bug Fixes

* **ui:** keep scrollbars off the last row of result tables ([a03814e](https://github.com/ProjectAJ14/d-pilot/commit/a03814e97f79a656c9e2020bf8c424902585d4c6))

## [1.27.1](https://github.com/ProjectAJ14/d-pilot/compare/v1.27.0...v1.27.1) (2026-09-28)


### Bug Fixes

* **mcp:** teach update_artifact and get_artifact the rich page format ([1bdede2](https://github.com/ProjectAJ14/d-pilot/commit/1bdede27cc4f9d7de0ae11c48ef91a87e3da466a))

# [1.27.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.26.2...v1.27.0) (2026-09-28)


### Features

* **artifacts:** rich html blocks in a sandboxed frame ([3e42665](https://github.com/ProjectAJ14/d-pilot/commit/3e4266594e733ef86ced98b619ff8f449c3b2e18))

## [1.26.2](https://github.com/ProjectAJ14/d-pilot/compare/v1.26.1...v1.26.2) (2026-09-28)


### Bug Fixes

* **export:** honor the limit checkbox on CSV/JSON export ([88102ca](https://github.com/ProjectAJ14/d-pilot/commit/88102ca3e3bd01798f75901b526161f6cd105c79))
* **sidebar:** honor the limit checkbox on table auto-run ([5ffe351](https://github.com/ProjectAJ14/d-pilot/commit/5ffe351e2ec294d1d203574f116f569131f94f0e))

## [1.26.1](https://github.com/ProjectAJ14/d-pilot/compare/v1.26.0...v1.26.1) (2026-09-28)


### Bug Fixes

* **mongo:** keep int64 precision and reject invalid $date ([d750d42](https://github.com/ProjectAJ14/d-pilot/commit/d750d42f92a59c211d5c226a4358f8a1cbe5f393))
* **mongo:** make write requests reach real documents and run what was approved ([3a1ad75](https://github.com/ProjectAJ14/d-pilot/commit/3a1ad75168c2ce47a6a2006c8f28e7efed02625d))
* **mongo:** reject coerced EJSON and keep sibling operators ([1b7c324](https://github.com/ProjectAJ14/d-pilot/commit/1b7c3241edcc5d51c5f083439f9c30c586fac7e8))
* **mongo:** reject lossy $numberDecimal and allow exponent doubles ([33196e5](https://github.com/ProjectAJ14/d-pilot/commit/33196e5d508ccbb4065a9ff1db02bdd727bafecc))

# [1.26.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.25.5...v1.26.0) (2026-09-26)


### Bug Fixes

* **errors:** scrub bare identifiers and gate query-error reports ([e210869](https://github.com/ProjectAJ14/d-pilot/commit/e210869192cf302baaf2133f933d00d3cd357d8b))


### Features

* **errors:** report issue from query errors, toasts and crashes ([9543f96](https://github.com/ProjectAJ14/d-pilot/commit/9543f96dae79bdc1a3186287b6cee264df96d530))

## [1.25.5](https://github.com/ProjectAJ14/d-pilot/compare/v1.25.4...v1.25.5) (2026-09-26)


### Bug Fixes

* **ui:** stop status badges truncating and make Disconnect a button ([135ebd9](https://github.com/ProjectAJ14/d-pilot/commit/135ebd9a606693a7ee3b7c2d2a7fac189cdb8acf))

## [1.25.4](https://github.com/ProjectAJ14/d-pilot/compare/v1.25.3...v1.25.4) (2026-09-23)


### Bug Fixes

* **write:** block deleting executed write requests ([a12eee7](https://github.com/ProjectAJ14/d-pilot/commit/a12eee72f3f650b49561582951b36524feb33997))

## [1.25.3](https://github.com/ProjectAJ14/d-pilot/compare/v1.25.2...v1.25.3) (2026-09-21)


### Bug Fixes

* **server:** point the old domain root at the sub-path ([006392b](https://github.com/ProjectAJ14/d-pilot/commit/006392ba99acfe18ccc8b0099d3aef01ec98091b))

## [1.25.2](https://github.com/ProjectAJ14/d-pilot/compare/v1.25.1...v1.25.2) (2026-09-20)


### Bug Fixes

* **ui:** close the boot screen's unguarded mirrors of tokens.css ([37df454](https://github.com/ProjectAJ14/d-pilot/commit/37df45457df248893aa918349d3f1a7fb0d18b15))
* **ui:** paint a boot screen instead of a blank first load ([2a867b6](https://github.com/ProjectAJ14/d-pilot/commit/2a867b6ca9b4df379acdfb9393d62ebf1145adf5))

## [1.25.1](https://github.com/ProjectAJ14/d-pilot/compare/v1.25.0...v1.25.1) (2026-09-20)


### Bug Fixes

* **ui:** label the cell drawer's copy and viewer buttons ([ab7da13](https://github.com/ProjectAJ14/d-pilot/commit/ab7da1363780ca9a88be503a09db7797b8821ac9))
* **ui:** stop double-click smearing a selection down sidebar rows ([7f84eb3](https://github.com/ProjectAJ14/d-pilot/commit/7f84eb31972700a917488106173f8a79dbe2341f))

# [1.25.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.24.0...v1.25.0) (2026-09-20)


### Bug Fixes

* **ui:** say which tab is selected, and stop the sidebar wrapping ([2292cf8](https://github.com/ProjectAJ14/d-pilot/commit/2292cf88006851eb0a1e89704ec536052abc8b13))


### Features

* **query:** open a JSON cell in an external JSON viewer ([306832a](https://github.com/ProjectAJ14/d-pilot/commit/306832adee7ea3e94e7ea628388b0db9aa634348))
* **query:** rename, save or close a tab from a right-click menu ([6903c65](https://github.com/ProjectAJ14/d-pilot/commit/6903c65f8caa77fe4524a3da80d3bf04b9b8ec78))

# [1.24.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.23.3...v1.24.0) (2026-09-20)


### Bug Fixes

* **query:** stop the copy toast lying, vanishing and stacking ([2bec4f2](https://github.com/ProjectAJ14/d-pilot/commit/2bec4f22374f011c0decb6204abff738662919f0))
* **ui:** bring the faces and corners under the design system too ([2c46cec](https://github.com/ProjectAJ14/d-pilot/commit/2c46cec4de3b49d26f0b187515fed5c4e6c8f3fa))
* **ui:** close the gaps the design system left open ([e4b26b2](https://github.com/ProjectAJ14/d-pilot/commit/e4b26b2af69bf0342b50b2daa6b517eab8022e8e))
* **ui:** give Mantine's menus and options the design system's hover ([51d7f3c](https://github.com/ProjectAJ14/d-pilot/commit/51d7f3c315c0035fcc21c03859cb02ce974ba6ed))
* **ui:** make the radius scale actually reach every corner ([10fa8b7](https://github.com/ProjectAJ14/d-pilot/commit/10fa8b71e32341b32e14c62b4ba5492de37447ff))


### Features

* **ui:** icons for the copy menus, and a readable requests filter ([3ce51ec](https://github.com/ProjectAJ14/d-pilot/commit/3ce51ec704ffb793bd0cf4d24958df7af1e0e057))
* **ui:** rebuild the theme on a single-file design system ([06a9ddd](https://github.com/ProjectAJ14/d-pilot/commit/06a9dddd913eb4dcf063833613ed43f9b12ce5a9))

## [1.23.3](https://github.com/ProjectAJ14/d-pilot/compare/v1.23.2...v1.23.3) (2026-09-14)


### Bug Fixes

* **query:** stop counting a trailing comment as a second statement ([d565124](https://github.com/ProjectAJ14/d-pilot/commit/d565124d675807642ef0befe55bcfbdf357b40a3))

## [1.23.2](https://github.com/ProjectAJ14/d-pilot/compare/v1.23.1...v1.23.2) (2026-09-13)


### Bug Fixes

* **requests:** let the owner edit a saved draft from the dashboard ([b99d20e](https://github.com/ProjectAJ14/d-pilot/commit/b99d20e389232a588d87fe5556515c5377cc42c7))

## [1.23.1](https://github.com/ProjectAJ14/d-pilot/compare/v1.23.0...v1.23.1) (2026-09-11)


### Bug Fixes

* **requests:** label a teammate's draft "To submit", not "To review" ([5d234dc](https://github.com/ProjectAJ14/d-pilot/commit/5d234dc41d261b246eba4ff4779f80c6ed64dcea))
* **ui:** make the AI review card and other tinted surfaces readable in dark mode ([27de6a8](https://github.com/ProjectAJ14/d-pilot/commit/27de6a875c0e50b2ce7a7295aa7f16c82b8562de))

# [1.23.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.22.0...v1.23.0) (2026-09-11)

### Bug Fixes

- **config:** carry the sub-path into MCP links and reject an all-slash BASE_PATH ([426a6a4](https://github.com/ProjectAJ14/d-pilot/commit/426a6a49fd314272e0d796642f73552a6513f6b8))

### Features

- **write-requests:** delete a request, and let MCP update and read drafts ([d834d51](https://github.com/ProjectAJ14/d-pilot/commit/d834d51074d49ca7e7affd8680235373a31404c5))

# [1.22.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.21.4...v1.22.0) (2026-09-11)

### Features

- serve the app under a configurable BASE_PATH ([3cf4434](https://github.com/ProjectAJ14/d-pilot/commit/3cf44349e429ed789e5312cc6200c41c83070d6f))

## [1.21.4](https://github.com/ProjectAJ14/d-pilot/compare/v1.21.3...v1.21.4) (2026-09-06)

### Bug Fixes

- **pwa:** reload the app when the update prompt's Reload is clicked ([ffeec4c](https://github.com/ProjectAJ14/d-pilot/commit/ffeec4cf6bbc54da4fc137033e8ecb5dc2ee9a8a))

## [1.21.3](https://github.com/ProjectAJ14/d-pilot/compare/v1.21.2...v1.21.3) (2026-09-06)

### Bug Fixes

- **ui:** use the light-ink logo on the dark theme ([e26e265](https://github.com/ProjectAJ14/d-pilot/commit/e26e26569b671c7c2db37821cd0dc14c9c2d34d4))

## [1.21.2](https://github.com/ProjectAJ14/d-pilot/compare/v1.21.1...v1.21.2) (2026-09-06)

### Bug Fixes

- **pwa:** cache self-hosted woff2 fonts and drop the dead Google Fonts rules ([f0879d2](https://github.com/ProjectAJ14/d-pilot/commit/f0879d23fceca9c41083bee5e9bdd475f672e24a))

## [1.21.1](https://github.com/ProjectAJ14/d-pilot/compare/v1.21.0...v1.21.1) (2026-09-06)

### Bug Fixes

- **ui:** make text readable in dark mode and surface the theme switcher ([3877abb](https://github.com/ProjectAJ14/d-pilot/commit/3877abb2dc2900478aebcfe65f90b647fcc5ecd6)), closes [#788e96](https://github.com/ProjectAJ14/d-pilot/issues/788e96)

# [1.21.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.20.0...v1.21.0) (2026-09-05)

### Features

- **ui:** add dark/light/system theming on a semantic token system ([4958555](https://github.com/ProjectAJ14/d-pilot/commit/495855568689a0f00f2a3af96924b2c58517d6d2))

# [1.20.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.19.0...v1.20.0) (2026-09-05)

### Features

- **write:** save write requests as drafts and let MCP create them ([0dfa141](https://github.com/ProjectAJ14/d-pilot/commit/0dfa141a39710178a79f9d7fd9401e0a3942d93e))

# [1.19.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.18.0...v1.19.0) (2026-09-03)

### Features

- **query:** copy results in configurable formats with cell selection ([ceee0cb](https://github.com/ProjectAJ14/d-pilot/commit/ceee0cb70f5ec3b37c35d24563d8efeeaa31ab8e))

# [1.18.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.17.0...v1.18.0) (2026-08-28)

### Features

- **schema:** clickable FK badge with constraint details ([2629142](https://github.com/ProjectAJ14/d-pilot/commit/262914254db44f4d3eef69b9ffe37c67c47441bd))

# [1.17.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.16.0...v1.17.0) (2026-08-21)

### Features

- **schema:** show foreign key targets, including in results ([0e449c6](https://github.com/ProjectAJ14/d-pilot/commit/0e449c61a322c3ae118976b67fe54cefc176518f))

# [1.16.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.15.0...v1.16.0) (2026-08-20)

### Features

- **artifacts:** markdown text blocks, and archive instead of delete ([842c1f7](https://github.com/ProjectAJ14/d-pilot/commit/842c1f761e6199fa4280cee787f7abca89be111c))

# [1.15.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.14.0...v1.15.0) (2026-08-20)

### Features

- **artifacts:** shareable query documents with MCP authoring ([d674782](https://github.com/ProjectAJ14/d-pilot/commit/d6747820f7ee0bc206b32d2ac5ff90d78e3f1ff2))

# [1.14.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.13.0...v1.14.0) (2026-08-20)

### Features

- **pwa:** add install and update prompts ([440d338](https://github.com/ProjectAJ14/d-pilot/commit/440d338e7e8be3028ea031e610c39f41561e8910))
- **pwa:** register a service worker that never caches API responses ([0b88e18](https://github.com/ProjectAJ14/d-pilot/commit/0b88e18c470d1c88df581582b8e5b1d1ca493208))
- **pwa:** serve the web manifest from APP_NAME ([5d7ff5a](https://github.com/ProjectAJ14/d-pilot/commit/5d7ff5a46e11023921cc6a84bd5f5a1cad471117))

# [1.13.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.12.1...v1.13.0) (2026-08-07)

### Features

- **profile:** rebuild profile as a full-page, scrollable section ([369cb68](https://github.com/ProjectAJ14/d-pilot/commit/369cb686847650dcb046d08f9a6e941972f1a93b))

## [1.12.1](https://github.com/ProjectAJ14/d-pilot/compare/v1.12.0...v1.12.1) (2026-08-07)

### Bug Fixes

- **env:** drop the last hardcoded PROD assumptions outside the rails ([42a3976](https://github.com/ProjectAJ14/d-pilot/commit/42a397643d143bc00666b42d3f056bfd26a130c7))
- **phi:** lock PHI masking for every production-like environment ([fd81636](https://github.com/ProjectAJ14/d-pilot/commit/fd816365765b316825e689365820f046016afbb0))
- **write:** extend the two-person rule to every production-like environment ([1de1f40](https://github.com/ProjectAJ14/d-pilot/commit/1de1f40f07174a26510988bc390cc47192493a00))

# [1.12.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.11.0...v1.12.0) (2026-08-06)

### Features

- **env:** derive the environment list from DBFORGE_CONNECTIONS ([0f11bee](https://github.com/ProjectAJ14/d-pilot/commit/0f11bee12760bcd09dcc0826518d62c18c908971))

# [1.11.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.10.0...v1.11.0) (2026-08-04)

### Features

- **editor:** opt-in vim keybindings in the SQL editors ([da4c7bf](https://github.com/ProjectAJ14/d-pilot/commit/da4c7bf169a7e94875f5d88c5de22753eefdf1ca))

# [1.10.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.9.0...v1.10.0) (2026-08-04)

### Bug Fixes

- **security:** enforce read capability on every connection path ([e9f74c8](https://github.com/ProjectAJ14/d-pilot/commit/e9f74c89b0d394e196cd773aedaeca59b6e0d782))

### Features

- **mcp:** hosted read-only MCP endpoint for AI agents ([9617297](https://github.com/ProjectAJ14/d-pilot/commit/96172972a58729e5e702e58111a966f4a1b9293d))

# [1.9.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.8.0...v1.9.0) (2026-07-23)

### Features

- add Playwright MCP configuration and update UI driving instructions ([2bd75bc](https://github.com/ProjectAJ14/d-pilot/commit/2bd75bc02b61703da10cb1f094cc1a5548b4877f))
- add Playwright MCP configuration and update UI driving instructions ([86b1202](https://github.com/ProjectAJ14/d-pilot/commit/86b12020263d9c46232e26bca7b4cb4228cf9404))
- **write-requests:** multi-statement migrations with atomic rollback ([83146ed](https://github.com/ProjectAJ14/d-pilot/commit/83146edb8b2b09a2a0ee9dc575c8da760021f6e8))

# [1.8.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.7.0...v1.8.0) (2026-07-23)

### Features

- **write-composer:** drag-resizable SQL editors, shared config with read editor ([4d80423](https://github.com/ProjectAJ14/d-pilot/commit/4d80423c804e708c656623797787e804ac640214))

# [1.7.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.6.0...v1.7.0) (2026-07-22)

### Features

- **write-review:** layered voice — plain summary, technical risk bullets ([7a1c608](https://github.com/ProjectAJ14/d-pilot/commit/7a1c608a7946bef5bc445204dc0de6f9c1ab14d0))

# [1.6.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.5.0...v1.6.0) (2026-07-22)

### Features

- **write-review:** senior-architect AI review persona; fix empty verdict on reasoning models ([36259df](https://github.com/ProjectAJ14/d-pilot/commit/36259dfcd962b47ff7bda4568c75784f39b89c2d))

# [1.5.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.4.0...v1.5.0) (2026-07-17)

### Features

- add live connection pool status and disconnect ([85da7c4](https://github.com/ProjectAJ14/d-pilot/commit/85da7c410db8045787d53665c4a4b5278bd67005))

# [1.4.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.3.0...v1.4.0) (2026-07-14)

### Features

- add rotating open-source callouts to footer and create SKILL.md for local verification ([4b24e4a](https://github.com/ProjectAJ14/d-pilot/commit/4b24e4ae6300256c09c7bd31e35dd4453fc89a04))

# [1.3.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.2.0...v1.3.0) (2026-07-14)

### Bug Fixes

- show full contributor avatars and add footer to login screen ([f48f7be](https://github.com/ProjectAJ14/d-pilot/commit/f48f7be99191761adf99bd27dc840213c314d766))

### Features

- add CSV import/export and bulk delete for PHI tokenization rules ([1b1d7ba](https://github.com/ProjectAJ14/d-pilot/commit/1b1d7ba5d3cd7fe3c2279220db23caeadb5df639))
- surface database connection failures and sync schema dropdowns ([cbb4fd7](https://github.com/ProjectAJ14/d-pilot/commit/cbb4fd7ca2a7ea28c66601093342c1e94ed70471))

# [1.2.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.1.0...v1.2.0) (2026-07-14)

### Features

- context-aware SQL autocomplete with alias and clause scoping ([9eb6f1b](https://github.com/ProjectAJ14/d-pilot/commit/9eb6f1b9db597164b3365c47b806971daae01c5a))
- shareable links for saved queries ([a47e58e](https://github.com/ProjectAJ14/d-pilot/commit/a47e58e27b611ea5cf6b0966ad07441ac79fad3e))

# [1.1.0](https://github.com/ProjectAJ14/d-pilot/compare/v1.0.0...v1.1.0) (2026-07-12)

### Features

- add credential handoff popup and password generator for user onboarding ([7c9c29e](https://github.com/ProjectAJ14/d-pilot/commit/7c9c29ebaedeab06e3e50223bc0b55ec4c4f7901))

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
