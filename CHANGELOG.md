# Changelog

## 0.1.0 (unreleased)

### Runtime and transport

- Development-only embedded Streamable HTTP endpoint, named `adonis`, with exact path `/__adonis/mcp` by default.
- Application-owned definition registry and bounded capture buffers; a separate MCP server per request, capability diagnostics, exact Host/Origin checks, loopback peer enforcement and bounded request/results.
- Project profiling for API, Inertia, Edge and hybrid surfaces, separating declared packages from verified runtime integrations and generated/source evidence.

### Inspection and development tools

- 28 tools covering routes/middleware, config/Env presence, partial container/events inventory, instrumented logs/handled exceptions, Lucid models/schema/migrations, model reads and raw SQL.
- Real loopback HTTP requests with surface/domain selection, request correlation, supported temporary impersonation and tenant mapping.
- Vine compiled-validator, Inertia page/shared-prop/transformer, Tuyau generated-schema and Edge view discovery; permission/Bouncer and database queue adapters.
- Trusted VM evaluator, fresh-process Ace runner, source-location resolution and offline installed-package documentation search.
- Five JSON resources: profile, routes, models, config subtree and safe package/rc metadata. Two capability-aware prompts: `debug_request` and `add_feature`.

### Installation and documentation

- Production-safe type-only config and app-local development provider, idempotent configure wiring, optional capture instrumentation and VM flag setup, skill installation and port/path-aware client next steps.
- English README with full configuration/extension references, compatibility boundaries, security limits, troubleshooting and client-specific recipes sourced from official documentation.
- One profile-driven English agent skill distributed through npm and repository installation.

### Deviations from the original design

The [implementation-plan decisions](docs/IMPLEMENTATION_PLAN.md#3-keputusan-dan-koreksi-eksplisit-terhadap-desain) record evidence and rationale; these are deliberate corrections, not compatibility aliases:

- **D01–D03:** per-request MCP server ownership, SDK v2 + Zod v4, `/__adonis/mcp` and client name `adonis`; no Tidewave path/name alias or SDK v1 shim.
- **D21–D22:** type-only `McpConfig` with `satisfies` and an app-local `app.inDev` wrapper replace production-loaded runtime config/package imports. Extra tool modules are lazy.
- **D24/D38:** log/exception capture requires opt-in public-hook instrumentation through an app-local development gateway; no zero-config observer claim.
- **D34–D36:** endpoint interception is the first server middleware, not an app route. MCP traffic bypasses app bodyparser/Shield middleware, so no CSRF exemption is required. Conflicting app routes retain their path; owned transport exchanges close during termination.
- **D25/D37:** container inventory is partial, provider origins are reported only when observed, events cover persistent listeners, and package activation without a verified runtime signal remains unknown.
- **D26/D61–D64:** trusted `vm.compileFunction` evaluation uses the application importer and requires `--experimental-vm-modules`. Timeout/cancellation only stops waiting, not execution; this is a REPL, not a sandbox.
- **D27/D52:** temporary token cleanup and deadline-bound cookie credentials provide no server residue plus a bounded replay window, not instant cookie revocation.
- **D28/D46–D47:** PostgreSQL raw SQL requires a dedicated least-privilege reader/read-only connection; SQLite uses a read-only child executor. SQL policy supplements the database boundary; unsupported read-only access never falls back to the app's write pool. Write mode is explicit.
- **D29:** tenant raw SQL requires proven FORCE RLS with a reader without BYPASSRLS; schema/database-per-tenant strategies are not claimed.
- **D30/D56–D60:** introspection preserves runtime/source/generated provenance and unknown dynamic cases, rather than claiming complete schema/type inference. React/Vue are tested; four-adapter Inertia support is not claimed. Queue and permissions use the concrete tested package adapters.
- **D31/D65–D66:** Ace commands execute in a fresh console subprocess with a POSIX watchdog, not in the HTTP process. Interactive commands are unsupported and exit 0 does not establish interactive completion.
- **D67–D69:** source lookup uses bounded, verified evidence; package docs search is offline and lexical with explicit package-generation cache limits, not a network or semantic search service.

### Compatibility and remaining boundaries

- Current evidence covers Node 24.21.0, Core 7.6.0, Lucid 22.4.2, SDK server 2.3.1/node 2.1.1 and MCP protocols 2026-07-28/2025-11-25 on macOS arm64; see the README for optional-package versions.
- Claude Code 2.1.295 was exercised end to end (project `.mcp.json`, `debug_request` and `add_feature` prompts as slash commands, tool calls against a live app). Cursor, VS Code and Zed recipes use configuration formats from official docs and are not exercised by this release.
- Other OS/Node/database matrices, actual assembler hard-restart behavior and registry HMR rebuild are not claimed. Generated type freshness, dynamic metadata coverage, capture coverage and trusted application-code side effects remain explicit limitations.
