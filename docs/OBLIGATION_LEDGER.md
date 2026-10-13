# Obligation Ledger — @rikology/adonisjs-mcp

Tanggal dibuat: 13 Oktober 2026 (M0)  
Sumber kewajiban: [DESIGN.md](./DESIGN.md) dan [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)  
Bukti spike: [docs/spikes/](./spikes/)

Ledger ini adalah daftar tunggal kewajiban yang harus dibuktikan sebelum `0.1.0`. Setiap baris hanya boleh berpindah ke `SELESAI` bila kolom bukti menunjuk artefak nyata: test/skenario yang dijalankan, output smoke, atau laporan spike. Kewajiban tidak boleh dihapus atau dipersempit tanpa persetujuan eksplisit pengguna; perubahan cakupan dicatat di bagian 12.

## 1. Cara membaca

| Status | Arti |
| --- | --- |
| `TERBUKA` | Belum diimplementasikan atau belum ada bukti. Gate spike (jika ada) menentukan apakah boleh mulai |
| `SELESAI` | Implementasi + verifikasi pada boundary relevan + bukti tertaut |
| `BLOCKED` | Ada `BLOCKER` terbuka (bagian 11); implementasi konsumen tidak boleh mulai |

Kolom **Gate** merujuk spike di bagian 2. Work package konsumen hanya boleh mulai bila gate berstatus `LULUS` atau `LULUS BERSYARAT` dengan semua `OBL` syaratnya dicatat di bagian 10. Kolom **Verifikasi** merujuk skenario E01–E12 (plan §9.2), lapisan test (plan §9.1), atau fixture profil (plan §8.3).

Prefix ID: `SP` spike, `DC` keputusan desain, `API` kontrak publik, `LC` lifecycle, `CF` config/default, `T` tool, `R` resource, `P` prompt, `PF` profil, `SEC` keamanan, `NF` non-functional, `E` end-to-end, `PK` packaging/release, `OB` kewajiban baru hasil spike.

## 2. Spike M0

Dijalankan 13 Oktober 2026 pada fixture create-adonisjs 3.4.0 (Core 7.6.0, Node 24.21.0, macOS arm64). Setiap laporan menyimpan command reproduksi dan raw evidence di `spikes/<id>/`. Konfirmasi independen oleh integration owner: S-A dan S-B dijalankan ulang dari clone baru dengan hasil sama (S-A exit 0, 16 response tool sukses dengan satu response per request, status 200/202/400/405/413/302 identik pada kedua kit; S-B production `/` 200, MCP 404, strategi unsafe `migration:status` exit 1, strategi safe exit 0). Review adversarial membuahkan 12 temuan; semuanya ditutup lewat putaran remediation yang tercatat di masing-masing laporan.

| ID | Spike | Status | Memblokir | Laporan |
| --- | --- | --- | --- | --- |
| SP-A | Transport SDK v2 di route Adonis (bodyparser, Shield, dua era protokol) | LULUS BERSYARAT | M1, M2 (WP-07, WP-08) | [S-A](./spikes/S-A.md) |
| SP-B | Production boot tanpa dev package | LULUS | M1 exit, WP-33, release | [S-B](./spikes/S-B.md) |
| SP-C | Capture log dan exception | LULUS BERSYARAT (opt-in instrumentation) | WP-10 | [S-C](./spikes/S-C.md) |
| SP-D | Introspeksi routes/middleware/container/events + HMR | LULUS BERSYARAT (inventory container parsial) | WP-11, WP-12, WP-14, WP-37 | [S-D](./spikes/S-D.md) |
| SP-E | Eval: import alias natural, console, timeout | LULUS BERSYARAT (flag diputuskan, B-01) | WP-28 | [S-E](./spikes/S-E.md) |
| SP-F | Auth token/session + CSRF + flash via loopback, termasuk guard tenant-aware | LULUS BERSYARAT | WP-20 | [S-F](./spikes/S-F.md) |
| SP-G | SQL read-only enforcement dan cancellation | LULUS BERSYARAT (subset terbatas; putaran 1 GAGAL) | WP-16 | [S-G](./spikes/S-G.md) |
| SP-H | Isolasi tenant konkuren | LULUS BERSYARAT | WP-18, WP-21 | [S-H](./spikes/S-H.md) |
| SP-I | Introspeksi Tuyau/Vine/Inertia/transformer/Edge | LULUS BERSYARAT | WP-23–WP-26 | [S-I](./spikes/S-I.md) |
| SP-J | Invocation Ace, termasuk di bawah HMR | LULUS BERSYARAT | WP-29 | [S-J](./spikes/S-J.md) |
| SP-K | Paket tenant/permission/queue konkret | LULUS BERSYARAT | WP-18, WP-27 | [S-K](./spikes/S-K.md) |

## 3. Keputusan desain yang menjadi kewajiban

| ID | Kewajiban | Sumber | Gate | WP | Verifikasi | Status |
| --- | --- | --- | --- | --- | --- | --- |
| DC-01 | `McpServer` per request dari factory; registry/buffer/cache milik app; handler bersama ditutup saat shutdown | Plan D01 | SP-A | WP-05, WP-07 | E01, E12; dua client konkuren | SELESAI (M2: `src/server.ts`, `src/handler.ts`; `endpoint.spec` 4 client konkuren dua era, SIGTERM menutup call in-flight, D36) |
| DC-02 | SDK v2 + Zod v4; tanpa shim API v1 | Plan D02 | SP-A | WP-01, WP-03 | build consumer tarball | TERBUKA |
| DC-03 | Default path `/__adonis/mcp`, nama client `adonis`, tanpa alias Tidewave | Plan D03 | — | WP-06, WP-35 | E10 custom path | TERBUKA |
| DC-04 | Production aman tanpa package: provider loading + config import kondisional; `app.inDev` defense-in-depth | Plan D04 | SP-B | WP-06, WP-33, WP-38 | E10 production prune | TERBUKA |
| DC-05 | Peer address dari socket; Host/Origin divalidasi terpisah; forwarded header tidak dipercaya | Plan D05 | SP-A | WP-08 | SEC-01–SEC-03 | SELESAI (M2: `src/guards/network.ts`, `network_guards.spec`, `endpoint.spec` LAN + `X-Forwarded-For`) |
| DC-06 | Origin absen diterima; `null`/malformed/opaque/foreign ditolak | Plan D06 | — | WP-08 | SEC-04 | SELESAI (M2: `network_guards.spec`, `endpoint.spec`) |
| DC-07 | `allowRemoteAccess` hanya membuka peer; Host/Origin tetap exact allowlist | Plan D07 | — | WP-08 | SEC-05 | SELESAI (M2: `network_guards.spec` "allowRemoteAccess opens the peer check only") |
| DC-08 | Timeout eval kooperatif, didokumentasikan bukan preemption | Plan D08 | SP-E | WP-28, WP-34 | E08 | TERBUKA |
| DC-09 | `await import('#models/user')` natural pada eval; tanpa chdir/regex rewrite | Plan D09, D26 | SP-E | WP-28 | E08 | TERBUKA |
| DC-10 | Read-only SQL ditegakkan DB/connection; statement filter hanya lapisan tambahan; tanpa fallback read-write | Plan D10 | SP-G | WP-16 | SEC-10–SEC-12 | SELESAI (M4: reader PostgreSQL READ ONLY + role SELECT-only, SQLite proses readonly; policy hanya lapisan tambahan; tanpa reader/driver capability `CAPABILITY_UNSUPPORTED`, tidak pernah fallback ke pool app; `database.spec`) |
| DC-11 | Tenant raw SQL tanpa boundary DB terbukti ditolak; bukan string matching | Plan D11 | SP-H | WP-18 | E06, SEC-13 | SELESAI (M4: `tenant` hanya untuk tabel FORCE RLS; tabel TenantScope tanpa RLS dan SQLite → `TENANT_SCOPE_REQUIRED`; `database.spec`) |
| DC-12 | Tenant `http_request` lewat middleware tenant app dengan mapping tepercaya | Plan D12 | SP-H | WP-21 | E06 | SELESAI (M5: kunci tenant di-lookup lalu dipetakan ke header resolver `X-Tenant-ID` yang dibaca middleware tenant app sebelum auth; header itu tidak dapat diisi caller; A/B konkuren dan anonymous-after-call; `http.spec`) |
| DC-13 | Evidence `runtime`/`generated`/`source` dipisahkan pada metadata | Plan D13 | SP-I | WP-11, WP-23–WP-25 | golden fixture introspeksi | TERBUKA |
| DC-14 | Hybrid ditentukan surface terkonfigurasi/teramati, bukan kehadiran package | Plan D14 | SP-I | WP-09, WP-21 | PF-06 | SELESAI (M5: kit hybrid Inertia React + route `/api` → `kind: hybrid`, default `null`, request tanpa surface ditolak; `http.spec`) |
| DC-15 | Origin binding hanya bila framework mengekspos bukti; selain itu `unknown` | Plan D15 | SP-D | WP-12 | E01 | SELESAI (M3: origin binding hanya dari trace `providerRegister` sinkron saat observasi gateway aktif; binding dari `boot()` dan tanpa observasi `origin: null`; `observability.spec`, `endpoint.spec` kit `api-bare`) |
| DC-16 | Package ekstensi bisa memberi definisi tanpa runtime import; helper di-lazy-import setelah guard | Plan D16 | — | WP-03, WP-05 | E07 | SELESAI (M2: provider ekstensi fixture memberi object literal, `zod`/`ToolError` di-import di dalam `boot()` setelah `hasBinding`; `endpoint.spec`) |
| DC-17 | Kredensial impersonation sementara via API nyata, cleanup `finally`, tanpa residu | Plan D17 | SP-F | WP-20 | E04 | SELESAI (M5: token dibuat guard dan dihapus per identifier di `finally` pada sukses/500/timeout/cancel; session cookie store tanpa record server; `http.spec`) |
| DC-18 | SQL default read-only; write opt-in ditandai mutating di annotations dan skill | Plan D18 | SP-G | WP-16, WP-34 | E03 | TERBUKA |
| DC-19 | Audit eval: status, durasi, call ID, excerpt ter-redaksi; tanpa kode penuh/secret | Plan D19 | SP-C | WP-28 | SEC-20 | TERBUKA |
| DC-20 | `tools.docs.include` default `['@adonisjs/*', '@rikology/*']` identik di semua contoh/stub | Plan D20 | — | WP-31, WP-33 | E11 | TERBUKA |
| DC-21 | Install production-safe: wrapper app-local `#providers/mcp_dev_provider`, config `import type` + `satisfies McpConfig`, deployment standalone sebagai release gate | Plan D21 | SP-B | WP-03, WP-06, WP-33, WP-38 | E10 | TERBUKA |
| DC-22 | Artefak app yang dimuat di production tidak meng-import package/zod saat runtime, termasuk `extraTools` | Plan D22 | — (turunan SP-B, belum diuji) | WP-03, WP-33 | E07, E10 | TERBUKA |
| DC-23 | Bridge transport: handler bersama, parsed body, `relayHeaders`, exemption Shield/Accept exact-path, limit 1 MiB eksplisit, normalisasi malformed body | Plan D23 | SP-A | WP-07, WP-08 | E01, E12 | SELESAI dengan perubahan D34 (M2: handler bersama + `relayHeaders`; endpoint sebagai server middleware sehingga parsed body dan exemption tidak diperlukan; SDK membaca body dengan limit 1 MiB, JSON rusak `-32700` tanpa echo; `endpoint.spec`) |
| DC-24 | Capture log/exception lewat instrumentasi opt-in yang dibuat configure; tidak diklaim zero-config | Plan D24 | SP-C | WP-10, WP-33, WP-35 | E02 | TERBUKA |
| DC-25 | Inventory container parsial berlabel; events persistent-only; cache tidak hanya invalidasi saat ready | Plan D25 | SP-D | WP-12, WP-14, WP-37 | E01, E09 | TERBUKA |
| DC-26 | Evaluator `vm` + callback importer framework; flag `--experimental-vm-modules` wajib (keputusan pengguna B-01); tanpa flag `CAPABILITY_UNSUPPORTED` | Plan D26 | SP-E | WP-28, WP-33, WP-35 | E08 | TERBUKA |
| DC-27 | Impersonation: token handle + delete `finally`; cookie `e:` ber-expiry deadline call; semantik tanpa residu + replay terbatas, bukan revocation | Plan D27 | SP-F | WP-20, WP-35 | E04, E06 | SELESAI untuk WP-20 (M5, D52: token handle + delete `finally`, cookie `e:` dengan expiry deadline dan rewrap setiap cookie `e:` response; `http.spec`); dokumentasi semantik replay tetap WP-35 |
| DC-28 | Executor SQL milik MCP: PG reader least-privilege + extended protocol + READ ONLY + AST; SQLite child readonly + SIGKILL deadline; tanpa reader PG → capability nonaktif | Plan D28 | SP-G | WP-16, WP-36 | E03, SEC-10–SEC-12 | SELESAI dengan perubahan D46–D47 (M4: koneksi reader per call ditutup alih-alih `DISCARD ALL` + reuse; SQLite diperiksa lewat program terkompilasi native, bukan `sqlite-parser`; `database.spec`, `sql_policy.spec`) |
| DC-29 | Raw SQL tenant hanya lewat FORCE RLS + reader NOBYPASSRLS + `set_config` parameterized milik MCP; tenant lookup/authorize sebelum run | Plan D29 | SP-H | WP-16, WP-18, WP-21 | E06, SEC-13 | SELESAI (M4: lookup resolver app sebelum `TenantService.run`, `app.tenant_id` diset MCP, setiap relasi harus FORCE RLS, role BYPASSRLS ditolak; `database.spec`. M5: mapping HTTP tenant lewat resolver tepercaya, D54; `http.spec`) |
| DC-30 | Sumber evidence introspeksi per artefak (Vine AST, Tuyau runtime vs type-only, Inertia TS AST, Edge mounted roots) | Plan D30 | SP-I | WP-23–WP-26 | golden fixture | TERBUKA |
| DC-31 | Ace subprocess + process group + watchdog independen parent; outcome unknown saat hard restart | Plan D31 | SP-J | WP-29, WP-38 | E08 | TERBUKA |
| DC-32 | Identitas paket opsional: tenant 1.0.2, `@adonisplus/permissions` 0.0.4 (privat), Bouncer 4 alternatif, queue 0.6.2 + boringnode 0.6.0 | Plan D32 | SP-K | WP-09, WP-18, WP-27 | PF-07 | TERBUKA |
| DC-33 | Dependency tambahan dengan alasan tercatat: parser SQL, TypeScript compiler milik app | Plan D33 | SP-G, SP-I | WP-01, WP-16, WP-24 | review lisensi | TERBUKA |

## 4. Kontrak publik dan lifecycle

| ID | Kewajiban | Sumber | Gate | WP | Verifikasi | Status |
| --- | --- | --- | --- | --- | --- | --- |
| API-01 | Config input parsial typed (`McpConfig`) → config resolved tervalidasi oleh provider; `config/mcp.ts` memakai `import type` + `satisfies`, bukan runtime `defineConfig` (D21); `projectEval: false` dan `tools.disabled` berlaku | Plan §4.3, D21; Design config | SP-B | WP-03 | unit config merge, E10 | TERBUKA |
| API-02 | `defineTool`: schema object Zod v4, nama snake_case, inferred input tanpa `any` publik | Plan §4.3 | SP-A | WP-03 | typecheck consumer tarball (M1: `verify:exports`, `tests/unit/define_tool.spec.ts`) | SELESAI |
| API-03 | `ToolContext`: app, config/profile, log/exception services, `callId`, signal, tenant per call; tanpa credential singleton | Plan §4.3 | SP-C, SP-H | WP-03, WP-05 | E07 | SELESAI (M4: `ToolContext.tenancy` — lookup + `run` per call, `null` tanpa integrasi tenant; consumer strict di `verify:exports`, pemakaian di `database.spec`) |
| API-04 | `available(ctx)` membedakan dependency absen vs integrasi rusak (diagnostic) | Plan §4.3 | SP-K | WP-09 | PF-01, PF-07 | SELESAI (M2: `src/server.ts` evaluasi per request, throw/invalid → `INTEGRATION_FAILED`; capability report `endpoint.spec`) |
| API-05 | `registry.tool/resource/prompt`: tabrakan gagal sebelum serving; `disable` deny-set independen urutan | Plan §4.3; Design plugin | — | WP-05 | E07 | SELESAI (M2: `src/registry.ts`, `registry.spec`, `endpoint.spec` duplikat gagal boot) |
| API-06 | `registry.extend`: urutan eksplisit, sekali per call, `next` tidak bisa dipanggil ulang, error tetap dinormalisasi | Plan §4.3 | — | WP-05 | E07 | SELESAI (M2: `src/invocation.ts`, `invocation.spec`, wrapper sekali per `callId` di `endpoint.spec`) |
| API-07 | Result sukses: text JSON terstruktur + `durationMs`, `truncated`, evidence/limitations | Plan §4.3 | — | WP-05, WP-07 | E01 | SELESAI (M2: `src/result.ts`, `invocation.spec`, `endpoint.spec`) |
| API-08 | Result gagal: `isError: true`, stable code, pesan ter-redaksi; error protokol tetap milik SDK | Plan §4.3 | SP-A | WP-07 | E12 | SELESAI (M2: `invocation.spec`, `fixture_fail` tanpa APP_KEY; error protokol `-32602`/`-32022`/`-32020`/`-32700` dari SDK di `endpoint.spec`) |
| API-09 | Annotations sesuai perilaku aktual; tool mutating tidak diberi `readOnlyHint` | Plan §4.3 | — | semua tool WP | review katalog | TERBUKA |
| API-10 | Error codes minimum: `DEPENDENCY_UNAVAILABLE`, `CAPABILITY_UNSUPPORTED`, `INPUT_INVALID`, `NOT_FOUND`, `READ_ONLY_VIOLATION`, `TENANT_SCOPE_REQUIRED`, `TIMEOUT`, `CANCELLED`, `EXECUTION_FAILED` | Plan §4.3 | — | WP-05 | unit + E02 | SELESAI (M5: `http_request` mengembalikan `INPUT_INVALID`, `NOT_FOUND`, `TENANT_SCOPE_REQUIRED`, `TIMEOUT`, `DEPENDENCY_UNAVAILABLE` sebagai `isError`; non-2xx app tetap hasil; `http.spec`, `endpoint.spec`) |
| API-11 | Exports `.`, `./configure`, `./types`, `./providers/mcp_provider` resolve dari tarball | Plan WP-02; Design exports | SP-B | WP-02 | `verify:exports`, `smoke:pack` | TERBUKA |
| API-12 | Optional peer tidak di-import eager pada public entry | Plan §4.1 | SP-B | WP-01–WP-03 | PF-01, production prune | TERBUKA |
| LC-01 | Register tanpa I/O/model import; `mcp.registry` tersedia untuk package lain saat `boot()` | Plan §4.2 | SP-D | WP-05, WP-06 | E07 | SELESAI (M2: `providers/mcp_provider.ts`; dua provider ekstensi register dari `boot()`) |
| LC-02 | Route MCP terdaftar sebelum router commit; urutan provider tidak mengubah builtin | Plan §4.2 | SP-D | WP-06 | dua urutan provider | SELESAI dengan perubahan D34 (M2: endpoint dipasang sebagai server middleware di `start()` sebelum server boot, gagal jelas bila router sudah commit; urutan provider dibalik memberi `tools/list` identik) |
| LC-03 | Profile/listener/registry snapshot difinalisasi setelah app siap; inspeksi tidak memulai watcher/worker | Plan §4.2 | SP-D | WP-05, WP-09 | E01 | TERBUKA |
| LC-04 | Registrasi setelah finalisasi ditolak jelas; HMR rebuild atomik; request berjalan memakai snapshot lama | Plan §4.2 | SP-D | WP-05, WP-37 | E09 | TERBUKA |
| LC-05 | Shutdown/HMR melepas listener, watcher, handler resources milik package saja; tidak menutup DB/logger/server app | Plan §4.2 | SP-C, SP-D | WP-06, WP-37 | E09, handle count | TERBUKA |
| LC-06 | Tidak ada cache-busting import ESM yang menumbuhkan memori | Plan §4.2 | SP-D | WP-14, WP-37 | E09 memory | TERBUKA |

## 5. Config dan default operasional

| ID | Kewajiban | Default | Gate | WP | Verifikasi | Status |
| --- | --- | --- | --- | --- | --- | --- |
| CF-01 | Endpoint dev-only, `enabled` kill switch, `allowRemoteAccess: false` | `/__adonis/mcp` | SP-B | WP-06 | PF-08 | SELESAI (M2: `endpoint.spec` disabled/test/console; M1 production prune) |
| CF-02 | Allowlist peer loopback (IPv4, IPv6, mapped); Host loopback + port aktual; Origin lokal exact | — | SP-A | WP-08 | SEC-01–SEC-05 | SELESAI (M2: `network_guards.spec`, `endpoint.spec`) |
| CF-03 | Eval timeout default/maks 30.000 ms; request tidak boleh melebihi config | 30.000 ms | SP-E | WP-28 | E08 | TERBUKA |
| CF-04 | SQL/model `readOnly: true`, `maxRows: 100`, `allowCrossTenant: false`; connection harus ada; PostgreSQL memerlukan connection reader least-privilege terkonfigurasi (D28) | — | SP-G | WP-15, WP-16 | E03 | SELESAI (M4: default + `tools.sql.timeout` 10.000 ms dan `tools.sql.readers` aditif; connection tak dikenal `INPUT_INVALID`; `define_config.spec`, `database.spec`) |
| CF-05 | Buffer 1.000 log / 100 exception + byte budget; tail default 100 | — | SP-C | WP-10 | ring wraparound | SELESAI (M3: default 1.000 log / 100 exception + `bufferBytes` 2 MiB / `exceptionBufferBytes` 1 MiB, entry dipendekkan ke 16/32 KiB, tail default 100; `ring_buffer.spec`, `capture.spec`) |
| CF-06 | Deadline HTTP/Ace 30.000 ms; output dibatasi; tanpa auto-retry mutating | 30.000 ms | SP-J | WP-19, WP-29 | E02, E08 | TERBUKA |
| CF-07 | Request maks 1 MiB, result maks 256 KiB, truncation JSON valid + flag | — | SP-A | WP-07, WP-08 | unit truncation | SELESAI (M2: 413 di `endpoint.spec`; truncation `invocation.spec`) |
| CF-08 | Docs: include D20, maks 5 snippet, cache lazy | — | — | WP-31 | E11 | TERBUKA |
| CF-09 | `extraTools: []`, `tools.disabled: []`; tool mutating bisa dimatikan | — | — | WP-05 | E07 | SELESAI (M2: `tools.disabled` dan `registry.disable()` sebelum/sesudah registrasi, `registry.spec`, `endpoint.spec`) |
| CF-10 | `allowedHosts`, `allowedOrigins`, mapping surface/tenant, byte limits minimal + terdokumentasi; tanpa wildcard jaringan | — | SP-A, SP-H | WP-08, WP-21 | SEC-05 | TERBUKA |

## 6. Tools (28)

| ID | Tool | Kontrak minimum | Gate | WP | Verifikasi | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T01 | `get_project_profile` | profile, surfaces, auth, packages, generated, capability reasons; installed vs active | SP-I, SP-K | WP-09 | E01, PF-01–PF-08 | TERBUKA |
| T02 | `get_routes` | filter; method, pattern, handler, middleware, name, domain, surface + evidence | SP-D | WP-11 | E01, E05 | TERBUKA |
| T03 | `get_middleware` | server/router/named stack dalam urutan | SP-D | WP-11 | E01 | SELESAI (M3: server stack berurutan termasuk middleware MCP berlabel, router stack diturunkan dari stack route ter-commit, named dengan jumlah route dan sumber export preload; `observability.spec`) |
| T04 | `get_logs` | tail/level/grep literal; redaction sebelum simpan | SP-C | WP-10 | E02 | SELESAI (M3 + M5: `http_request` mengembalikan hanya log request id hop-nya di tengah traffic gagal konkuren; `observability.spec`, `http.spec`) |
| T05 | `get_last_exceptions` | limit; message/stack/route/request ID, dedup | SP-C | WP-10 | E02 | SELESAI (M3 + M5: exception request call dengan status response; `observability.spec`, `http.spec`) |
| T06 | `get_container_bindings` | pattern; inventory parsial `source-declared+runtime-verified`, kind/origin bila teramati, coverage eksplisit; tanpa instantiate (D25) | SP-D | WP-12 | E01 | SELESAI (M3: lane `source-declared` + `runtime-observed`, verifikasi `hasBinding`, `coverage: partial`, `declaredUnavailable`, counter konstruksi 0; `observability.spec`, `endpoint.spec`) |
| T07 | `get_events` | event + persistent listener tanpa emit; once/wildcard dilabel tidak tercakup | SP-D | WP-12 | E01 | SELESAI (M3: listener inline/lazy/class dari map persisten, `once()` tidak tercantum dan dilabel, `transportListenerCount`, listener tidak berjalan; `observability.spec`) |
| T08 | `get_config` | dot key; subtree ter-redaksi, cycle/function aman | — | WP-13 | SEC-18 | SELESAI (M3: traversal own-data, key prototype ditolak, getter/config provider tidak dievaluasi, subtree sentinel ter-redaksi; `introspection.spec`, `redaction.spec`, `observability.spec`) |
| T09 | `get_env` | prefix; key + presence, tanpa nilai | — | WP-13 | SEC-19 | SELESAI (M3: schema `Env.create` dibaca via AST TypeScript app, key/tipe/optional/secret/presence tanpa nilai, filter prefix; `observability.spec`) |
| T10 | `get_models` | model/table/PK/connection/columns/relations/path dari scan model roots | SP-D | WP-14 | E03, E09 | SELESAI (M4: scan rekursif `app.modelsPath()` termasuk direktori kustom, model turunan, file non-model `skipped`, gagal import per file di `failures`, cache generation; `database.spec`) |
| T11 | `query_model` | predicate terstruktur, preload allowlist, scopes/serialization, limit, tenant | SP-H | WP-15, WP-18 | E03, E06 | SELESAI (M4: hook soft-delete/tenant, `serializeAs`, computed, preload tervalidasi + batas fan-out, `limit`/`hasMore`, tenant lookup; `database.spec`) |
| T12 | `execute_sql_query` | bindings/connection/tenant; rows/dialect/returned count/duration; DB enforcement | SP-G, SP-H | WP-16, WP-18 | E03, E06, SEC-10–SEC-13 | SELESAI (M4: `database.spec`, `sql_policy.spec`) |
| T13 | `get_migrations` | ran/pending/batch/file tanpa menjalankan migration | — | WP-17 | E03 | SELESAI (M4: status dari `sourceFiles` Lucid + tabel histori, tabel histori tidak dibuat bila absen; `database.spec`) |
| T14 | `diff_schema` | model vs DB physical columns; computed tidak dianggap missing | SP-G | WP-17 | E03 | SELESAI (M4: kolom hilang dari migration pending, kolom tak dideklarasikan, computed terpisah, tabel `schema.table` dan connection model; `database.spec`) |
| T15 | `http_request` | loopback nyata; method/path/body/headers/as/surface/tenant; safe headers; logs | SP-F, SP-H, SP-A | WP-19–WP-22 | E02, E04–E06 | SELESAI (M5, D51–D55: loopback, method/path/body/form/headers/as/surface/tenant/domain, header aman, body summary, validasi, log/exception; `http.spec`, `endpoint.spec`) |
| T16 | `get_validators` | field/rule/message/reference; dynamic → unknown | SP-I | WP-23 | golden fixture | TERBUKA |
| T17 | `get_inertia_pages` | route → component/prop evidence tanpa menjalankan controller | SP-I | WP-24 | PF-03, PF-04 | TERBUKA |
| T18 | `get_shared_props` | declared/observed shared props; lazy tidak dievaluasi | SP-I | WP-24 | PF-03 | TERBUKA |
| T19 | `get_transformers` | transformer + generated Data shape | SP-I | WP-24 | PF-03 | TERBUKA |
| T20 | `get_tuyau_schema` | typed routes/input/response; missing vs stale vs empty | SP-I | WP-25 | PF-02 | TERBUKA |
| T21 | `get_views` | template/component/slot/path dari view roots | SP-I | WP-26 | PF-05 | TERBUKA |
| T22 | `render_view` | view + JSON state → HTML terbatas via Edge nyata | SP-I | WP-26 | PF-05 | TERBUKA |
| T23 | `get_permissions` | metadata dari `@adonisplus/permissions` (`#start/permissions`) atau adapter Bouncer eksplisit (D32) | SP-K | WP-27 | PF-07 | TERBUKA |
| T24 | `get_queue_jobs` | jobs dari `queue.locations` + `Locator.get`, manual registration unknown; pending count publik, status lain adapter versi-terikat (D32) | SP-K | WP-27 | PF-07 | TERBUKA |
| T25 | `project_eval` | code/timeout/tenant; display/console/duration; audit; evaluator D26 | SP-E, SP-H | WP-28, WP-18 | E08, E06 | TERBUKA |
| T26 | `run_ace_command` | argv terstruktur, tanpa shell; stdout/stderr/exitCode/signal; watchdog process group (D31) | SP-J | WP-29 | E08 | TERBUKA |
| T27 | `get_source_location` | path/line terbukti; package exports; tanpa line karangan | SP-E | WP-30 | E11 | TERBUKA |
| T28 | `search_package_docs` | offline, maks 5 snippet + line range, include filter | — | WP-31 | E11 | TERBUKA |

## 7. Resources (5) dan prompts (2)

| ID | Identitas | Kontrak | Gate | WP | Verifikasi | Status |
| --- | --- | --- | --- | --- | --- | --- |
| R01 | `adonis://profile` | service sama dengan T01; selalu ada saat dev enabled | SP-A | WP-09, WP-32 | E01 | SELESAI (M2: `src/resources/profile.ts`; data identik dengan tool di dua era, `endpoint.spec`) |
| R02 | `adonis://routes` | route list tanpa filter, evidence domain/surface utuh | SP-D | WP-32 | E01 | SELESAI (M3: `adonis://routes` = `get_routes` tanpa filter, data identik; `observability.spec`) |
| R03 | `adonis://models` | ringkasan model; hanya bila Lucid aktif; cache sama dengan T10 | SP-D | WP-32 | E03 | SELESAI (M4: data identik dengan `get_models` tanpa filter, `DEPENDENCY_UNAVAILABLE` tanpa Lucid; `database.spec`, `endpoint.spec`) |
| R04 | `adonis://config/{key}` | subtree ter-redaksi; URI decoding tidak bypass policy | — | WP-32 | SEC-18 | SELESAI (M3: `adonis://config/{key}` memakai validasi key dan redaksi yang sama dengan `get_config`; key tak ada → resource error; `observability.spec`) |
| R05 | `adonis://package` | manifest + rc metadata aman; secret/script/URL tidak mentah | — | WP-32 | SEC-18 | TERBUKA |
| P01 | `debug_request` | profile → route → HTTP → exceptions/logs; tanpa side effect saat `prompts/get` | — | WP-32 | E01, E02 | TERBUKA |
| P02 | `add_feature` | bercabang per profil; hybrid menanyakan surface; hanya merujuk tool tersedia | SP-I | WP-32 | PF-01–PF-06 | TERBUKA |

## 8. Profil fixture

| ID | Fixture | Yang harus terbukti | Gate | Status |
| --- | --- | --- | --- | --- |
| PF-01 | API tanpa Lucid/auth/view | core tools aktif; DB/view/impersonation absen dengan alasan; app boot | SP-B | SELESAI untuk profile M2, tool database M4, dan impersonation M5 (kit `api-bare`: lima tool database + `adonis://models` `DEPENDENCY_UNAVAILABLE`; `http_request` disajikan, `as` `DEPENDENCY_UNAVAILABLE`; `endpoint.spec`); availability view dibuktikan ulang saat tool tersebut ada (M6) |
| PF-02 | API + Lucid + token auth + Tuyau | DB tools, JSON default, token cleanup | SP-F, SP-I | TERBUKA |
| PF-03 | Inertia React + session/Shield | page/shared/transformer, X-Inertia/version, flash, CSRF | SP-F, SP-I | TERBUKA |
| PF-04 | Inertia Vue | tanpa asumsi React | SP-I | TERBUKA |
| PF-05 | Edge + session | views/render, HTML bound, web guard, tanpa X-Inertia | SP-I | TERBUKA |
| PF-06 | Hybrid API + Inertia + domain routes | surface per route, tenant/domain mapping | SP-D, SP-H | TERBUKA |
| PF-07 | Tenant + permission + queue | positive adapter, isolasi dua tenant | SP-H, SP-K | TERBUKA |
| PF-08 | Config disabled / production | tanpa endpoint/listener/buffer/import failure | SP-B | SELESAI (M1 production prune `package_install.spec`; M2 `enabled: false` tanpa binding/endpoint, `endpoint.spec`). M3: `enabled: false` dan proses test tanpa subscriber/observer, production pruned dari app terinstrumentasi boot tanpa hooks (`observability.spec`) |

Adapter Inertia Svelte/Solid tidak boleh diklaim sebelum diuji (plan §8.3).

## 9. Keamanan, non-functional, end-to-end, packaging

### 9.1 Security invariants (plan §10)

| ID | Kewajiban | Gate | WP | Status |
| --- | --- | --- | --- | --- |
| SEC-01 | Route absen di production/disabled; loader aman walau module tidak terpasang | SP-B | WP-06, WP-38 | SELESAI (M1 production prune, M2 disabled/test/console); gate CI tetap OB-07/PK-02 |
| SEC-02 | Peer dari socket; uji XFF, `Forwarded`, trusted proxy, mapped IPv6, `::1` | SP-A | WP-08 | SELESAI (M2: `network_guards.spec`, LAN di `endpoint.spec`; guard tidak memakai `request.ip()` sehingga `trustProxy` tidak berpengaruh) |
| SEC-03 | Host menolak `localhost.evil.example`, userinfo, port malformed, duplikat, hostname resolve-loopback | — | WP-08 | SELESAI (M2: hanya nama `localhost` dan literal IP loopback diterima; `network_guards.spec`, `endpoint.spec`) |
| SEC-04 | Origin diparse sebagai URL; asing/`null`/mismatch port ditolak; absen boleh | — | WP-08 | SELESAI (M2: `network_guards.spec`, `endpoint.spec`) |
| SEC-05 | Remote opt-in tetap Host/Origin policy; bind `0.0.0.0` tidak membuka MCP | — | WP-08 | SELESAI (M2: `network_guards.spec`, bind `0.0.0.0` + akses IP LAN di `endpoint.spec`) |
| SEC-06 | Dokumentasi melarang exposure publik via proxy/tunnel | — | WP-35 | TERBUKA |
| SEC-07 | Pengecualian Shield hanya exact endpoint MCP, guard sebelum dispatch | SP-A | WP-08 | SELESAI dengan perubahan D34 (M2: tidak ada exemption Shield; hanya path persis yang dilayani middleware MCP, guard pertama; CSRF app tetap menolak POST tanpa token di `endpoint.spec`) |
| SEC-10 | Corpus SQL (komentar, multi-statement, CTE mutating, EXPLAIN ANALYZE, function side effect, PRAGMA, ATTACH/COPY/CALL) tidak menulis | SP-G | WP-16, WP-36 | SELESAI untuk corpus M4 (`database.spec` dua dialect + observer jumlah row/file/advisory lock, `sql_policy.spec`); perluasan adversarial WP-36 |
| SEC-11 | Construct yang tidak bisa dinyatakan aman ditolak dalam supported subset | SP-G | WP-16 | SELESAI (M4: node AST di luar allowlist, fungsi di luar daftar, grammar tak dikenal, virtual table/opcode tulis SQLite → `READ_ONLY_VIOLATION`; `sql_policy.spec`) |
| SEC-12 | Timeout, rollback, release connection, reset state pool pada success/error/cancel | SP-G | WP-16 | SELESAI (M4: PG `pg_cancel_backend` + ROLLBACK + tutup koneksi, tanpa koneksi `adonisjs-mcp%` tersisa, pool app tetap melayani; SQLite SIGKILL; `database.spec`) |
| SEC-13 | Raw SQL tenant: komentar/string/OR/UNION/join/schema/quoted identifier tidak menjadi bypass; shared-table tanpa RLS ditolak | SP-H | WP-18, WP-36 | SELESAI untuk corpus M4 (OR/komentar/UNION hanya baris tenant via RLS, join ke tabel tanpa RLS dan tabel TenantScope tanpa RLS ditolak, `set_config` ditolak; `database.spec`) |
| SEC-14 | `allowCrossTenant` eksplisit dan terlabel di output; `tenant` tidak memilih connection global diam-diam | SP-H | WP-18 | SELESAI (M4: tanpa opsi `TENANT_SCOPE_REQUIRED`; dengan opsi `crossTenant: true` + limitation; `database.spec`) |
| SEC-15 | Batas `query_model` read-only (hooks/serializer app tetap tepercaya) terdokumentasi | — | WP-15, WP-35 | TERBUKA |
| SEC-16 | HTTP hanya ke origin app; tanpa scheme/host/`//host`/port/unix/file; redirect manual; MCP path + alias encoded ditolak | SP-A | WP-19 | SELESAI (M5: path saja, alias MCP ter-encode/dot-segment/case/trailing slash, `//host`, URL absolut, backslash, domain tak terdaftar, header Host/forwarded ditolak; redirect lintas origin/ke MCP tidak diikuti; `http.spec`, unit `http.spec`) |
| SEC-17 | Impersonation lewat adapter asli; tanpa token permanen; `Authorization`/`Cookie`/`Set-Cookie` tidak bocor; tenant header internal tidak dipercaya | SP-F, SP-H | WP-20, WP-21 | SELESAI (M5: kredensial via guard app, token dihapus, cookie ber-expiry deadline; `Set-Cookie`/`Authorization` disembunyikan; echo header app tidak memuat bentuk kredensial yang di-mint; header tenant tidak diterima dari caller; `http.spec`) |
| SEC-18 | Redaction sebelum buffer dan setiap output (config/logs/errors/resources/HTTP/queue/docs); default-deny path sensitif | SP-C | WP-10, WP-13, WP-36 | TERBUKA |
| SEC-19 | `get_env` tanpa nilai; docs search tidak membaca `.env`; configure tidak mencetak `.env` | — | WP-13, WP-31, WP-33 | TERBUKA |
| SEC-20 | Data log/docs/model diperlakukan untrusted di skill; eval didokumentasikan sebagai trusted REPL | SP-E | WP-28, WP-34 | TERBUKA |
| SEC-21 | Source/doc traversal terbatas root app/package; source map tidak ditebak | — | WP-30, WP-31 | TERBUKA |
| SEC-22 | Ace argv terstruktur, deadline membunuh process milik tool saja | SP-J | WP-29 | TERBUKA |
| SEC-23 | `render_view` tidak diberi klaim read-only | SP-I | WP-26 | TERBUKA |

### 9.2 Non-functional (plan §9.5)

| ID | Kewajiban | WP | Status |
| --- | --- | --- | --- |
| NF-01 | Enumerasi ringan tidak memicu full scan/membuka DB tak perlu | WP-09, WP-14, WP-31 | TERBUKA |
| NF-02 | Log append O(1) bounded bytes; cache lazy berkunci generation | WP-10, WP-14, WP-31 | TERBUKA |
| NF-03 | Timeout satu tool tidak merusak request lain; tanpa auto-retry mutation | WP-07, WP-28, WP-29 | TERBUKA |
| NF-04 | Output limit sebelum materialisasi tak terbatas sejauh driver memungkinkan | WP-15, WP-16, WP-19 | TERBUKA |
| NF-05 | Ukur cold/warm latency, event-loop delay, memory, handles sebelum/sesudah traffic dan HMR | WP-37 | TERBUKA |
| NF-06 | Concurrent calls cepat/lambat + dua tenant; cleanup diperiksa | WP-37 | TERBUKA |

### 9.3 Skenario end-to-end (plan §9.2)

| ID | Skenario | Gate | Status |
| --- | --- | --- | --- |
| E01 | Basic runtime dua era → profile → routes → resources → prompt | SP-A, SP-D | SELESAI (M2 discovery/profile/prompt di `endpoint.spec`; M3 `get_routes` + `adonis://routes` di dua era, `observability.spec`) |
| E02 | Debug request: status, exception matching, log correlation | SP-C, SP-F | SELESAI (M5: request gagal lewat `http_request` → 500, exception cocok, log hanya request id call di tengah enam request gagal lain; `http.spec`) |
| E03 | Data semantics: scoped/soft-delete/serializeAs vs raw; schema diff; status tanpa migrasi | SP-G | SELESAI (M4: `database.spec`) |
| E04 | Auth: anonymous ditolak, `as` valid, invalid gagal, cleanup success/error/abort | SP-F | SELESAI (M5: anonymous 401/redirect login, `as` token/session valid, user/guard/model invalid gagal eksplisit, cleanup token sukses/500/timeout/cancel, tanpa identitas pada request berikutnya; `http.spec`) |
| E05 | Surface API JSON / Inertia / Edge, validation mapping, domain route | SP-F, SP-I | TERBUKA |
| E06 | Tenant concurrency model/eval/HTTP; missing/wrong tenant; raw SQL bypass ditolak | SP-H | TERBUKA |
| E07 | Extensibility: provider domain register, wrapper sekali, disable menang, duplicate gagal boot | — | SELESAI (M2: `endpoint.spec`) |
| E08 | Eval/Ace: alias import, service, console, timeout jujur; generator; nonzero exit | SP-E, SP-J | TERBUKA |
| E09 | Lifecycle: edit model/page, HMR/restart, metadata baru, shutdown bersih | SP-D, SP-I | TERBUKA |
| E10 | Install/production: configure 2x, custom path/port, tarball, production prune | SP-B | TERBUKA |
| E11 | Offline docs: network diblok, docs + source reference benar, non-allowlist tidak diindex | — | TERBUKA |
| E12 | Protocol eras: modern + legacy; invalid version/header/malformed JSON sesuai SDK | SP-A | SELESAI (M2: `endpoint.spec`) |

### 9.4 Packaging dan release (plan §9.4, §12)

| ID | Kewajiban | WP | Status |
| --- | --- | --- | --- |
| PK-01 | Manifest ESM, engines Node ≥24, MIT, tsdown + declarations, lint/format, Japa, `package-lock.json` | WP-01 | SELESAI (M1; matriks Node minimum tetap PK-07) |
| PK-02 | Script CI: `lint`, `typecheck`, `test`, `test:integration`, `test:security`, `build`, `verify:exports`, `smoke:pack`, `smoke:clients` | WP-01, WP-38 | TERBUKA |
| PK-03 | Configure idempotent: provider tidak ganda, config/skill tidak ditimpa, `.claude` tidak dibuat tanpa alasan, port/path tercermin | WP-33 | TERBUKA |
| PK-04 | Satu sumber English `SKILL.md` (npm + repo), conventions per profile, tanpa klaim hard timeout/sandbox | WP-34 | TERBUKA |
| PK-05 | README, config reference, compatibility, troubleshooting, changelog, recipes Claude Code/Cursor/VS Code/Zed yang diuji | WP-35 | TERBUKA |
| PK-06 | Tarball tanpa fixture DB/.env/log/coverage/test code; lisensi dependency direview | WP-38 | TERBUKA |
| PK-07 | Matriks Linux+macOS, Node minimum + Node 24 terkini, Core/Lucid min/current, SQLite + PostgreSQL | WP-38 | TERBUKA |
| PK-08 | Publish CI dengan provenance; post-publish install/connect/call di fixture bersih | WP-39 | TERBUKA |

## 10. Kewajiban baru hasil spike

Konsolidasi baris `OBL:` dari putaran final setiap laporan; OBL putaran awal yang digantikan putaran berikutnya tidak diulang. Rujukan WP yang salah pada laporan dikoreksi di sini (mis. evaluator milik WP-28, bukan WP-24). Setiap baris mengikat WP konsumennya dan harus punya bukti sebelum `SELESAI`.

| ID | Kewajiban | Asal | WP | Status |
| --- | --- | --- | --- | --- |
| OB-01 | Configure mengecualikan exact endpoint dari middleware app yang mengubah `Accept` (API kit `force_json_response_middleware`); tanpa itu legacy client gagal 406. Tidak menonaktifkan middleware global | S-A | WP-07, WP-08, WP-33 | SELESAI dengan perubahan D34 (M2: middleware MCP berjalan sebelum force-JSON sehingga exemption tidak diperlukan; client legacy lulus pada kit API tanpa perubahan middleware app) |
| OB-02 | Byte limit endpoint 1 MiB ditegakkan eksplisit; limit SDK tidak berlaku untuk parsed body dan limit bodyparser app bisa lebih besar | S-A | WP-08 | SELESAI (M2: SDK membaca body sendiri dengan `limits.maxRequestBytes`, bodyparser app tidak terlibat; 413 di `endpoint.spec`) |
| OB-03 | Malformed JSON ditolak bodyparser Adonis sebelum SDK (400, debug raw body); normalisasi + redaction endpoint ditetapkan, tidak diklaim milik SDK | S-A | WP-07, WP-08 | SELESAI dengan perubahan D34 (M2: bodyparser tidak melihat trafik MCP; SDK menjawab 400 `-32700` tanpa echo body, `endpoint.spec`) |
| OB-04 | Pertahankan Shield `exceptRoutes` exact, `relayHeaders()` sebelum bridge, `await` bridge, tanpa payload return; contract test `isPending`/`headersSent`/finalizer per versi http-server | S-A | WP-07, WP-38 | TERBUKA (M2: exemption Shield tidak lagi dipakai, D34; `relayHeaders` + `await` bridge dari middleware, satu response per request di `endpoint.spec`. Sisa: matriks versi http-server di WP-38) |
| OB-05 | Rc entry `{ file: () => import('#providers/mcp_dev_provider'), environment: ['web'] }` via `rcFile.addProvider`; wrapper app-local meng-import package hanya bila `app.inDev`; provider package tetap punya guard | S-B | WP-06, WP-33 | SELESAI (M1: `configure.ts`, `tests/integration/package_install.spec.ts`) |
| OB-06 | Stub config `import type { McpConfig }` + `satisfies McpConfig`; provider melakukan default/validation; tidak ada runtime import dev package dari config | S-B | WP-03, WP-33 | SELESAI (M1: `stubs/config/mcp.stub`, provider `register()`, `package_install.spec.ts`) |
| OB-07 | Release gate: tarball → `npm ci --omit=dev` → deployment standalone di luar ancestor `node_modules` → `/` 200, MCP 404, tanpa binding/listener/marker, `ace list` dan `migration:status` exit 0 | S-B | WP-38 | TERBUKA |
| OB-08 | Capture log lewat `hooks.streamWrite` logger config dan observer sekali di `HttpExceptionHandler.handle`, melalui gateway app-local dev-guarded yang dibuat configure; compose hook yang ada, output app tidak berubah | S-C | WP-10, WP-33 | TERBUKA |
| OB-09 | Capture wajib redaction pre-storage, batas bytes/count, fail-safe, detach saat shutdown/HMR, coverage named logger/existing hooks/worker transport/ignored exceptions/report-throw | S-C | WP-10, WP-36 | TERBUKA |
| OB-10 | Jangan klaim zero-config untuk log/exception; upstream observer API dicatat di dependency watch | S-C | WP-34, WP-35 | TERBUKA |
| OB-11 | Routes dibaca sesudah commit; provenance middleware global/group, handler anonim/lazy, dan named middleware tak terpakai berlabel partial/unknown | S-D | WP-11 | SELESAI (M3: route dibaca dari router ter-commit; handler anonim `name: null`, lazy dilaporkan specifier import; asal global/group dan named tak terpakai dilabel di `limitations`; `observability.spec`) |
| OB-12 | `get_events` menyatakan inventory persistent-map saja; once/wildcard tidak tercakup, total `listenerCount` boleh tanpa emit | S-D | WP-12 | SELESAI (M3: `coverage: persistent-listeners`, limitation once/onAny, `transportListenerCount` dan `totalTransportListeners` tanpa emit; `observability.spec`) |
| OB-13 | Cache metadata tidak hanya diinvalidasi di `ready`: controller hot-swap terjadi tanpa restart dan tanpa boot/ready ulang | S-D, S-E | WP-14, WP-24, WP-37 | TERBUKA |
| OB-14 | Inventory container: baseline augmentasi `ContainerBindings` + `hasBinding` tanpa instantiate; observasi awal opt-in di posisi provider pertama (codemod hanya append), origin hanya dari trace `providerRegister` sinkron; coverage dan gap pra-observasi dilabel | S-D | WP-12, WP-35 | SELESAI dengan perubahan D39 (M3: baseline deklarasi + `hasBinding`; observasi opt-in dimulai dari gateway saat config load, sebelum provider pertama, sehingga tidak butuh codemod reorder; origin hanya dari trace sinkron; gap pra-observasi dilabel; `observability.spec`) |
| OB-15 | Regression HMR: registrasi boot/start sebelum commit, hot-swap controller vs restart routes/model/provider, listener/handle count stabil | S-D | WP-04, WP-37 | TERBUKA |
| OB-16 | Evaluator memakai `importModuleDynamically` callback ke importer framework (`app.import`) dengan filename sintetis app root; regression fresh import, warm-cache control, identitas model/controller pada hot-swap same-PID, dari tarball terpasang | S-E | WP-28 | TERBUKA |
| OB-17 | API vm eksperimental diuji pada Node minimum/current dan Linux; tanpa flag → `CAPABILITY_UNSUPPORTED` eksplisit dengan remediasi, tanpa fallback regex | S-E | WP-28, WP-38 | TERBUKA |
| OB-18 | Dokumentasi: timeout kooperatif, late mutation setelah timeout, loop sinkron membekukan HTTP, capture console hanya leksikal, bukan sandbox | S-E | WP-28, WP-34, WP-35 | TERBUKA |
| OB-19 | Access token: simpan handle hasil create, `await delete` di `finally` (success/error/timeout/cancel); tenant-bound provider bila tenant aktif | S-F | WP-20 | SELESAI (M5: handle token hasil `guard.createToken` dihapus per identifier di `finally`; tenant-bound lewat `TenantService.run` dengan provider token tenant; `http.spec`) |
| OB-20 | Cookie session: payload `e:` lewat encryption service dengan purpose session-ID dan expiry terikat deadline absolut; setiap response/XSRF cookie di-rewrap; test versi-terikat format, purpose, `stringify:false`, Set-Cookie string/array | S-F | WP-20 | SELESAI dengan perubahan D52 (M5: header Cookie disusun tool, bukan `plainCookie`; data `e:` lewat encryption service purpose session-id + expiry deadline, id ditandatangani `CookieClient`; setiap cookie `e:` response di-rewrap; format diterima app nyata pada flow CSRF/validasi/auth; `http.spec`) |
| OB-21 | Semantik kredensial didokumentasikan: tanpa residu server + replay window terbatas, bukan revocation instan | S-F | WP-20, WP-35 | TERBUKA |
| OB-22 | Store session stateful (memory/file/redis) tidak diklaim sebelum bukti HTTP abort/finalization dan mitigasi write-after-destroy | S-F | WP-20 | SELESAI (M5: hanya store `cookie`; store lain `CAPABILITY_UNSUPPORTED` dengan alasan, tidak diklaim) |
| OB-23 | Guard/user/tenant membership divalidasi sebelum mint; jar/kredensial per call; `Authorization`/`Cookie`/`Set-Cookie` di-strip; scan log default | S-F | WP-19, WP-20, WP-22 | SELESAI (M5: guard/user/membership divalidasi sebelum mint; jar dan kredensial per call; `Authorization`/`Cookie`/`Set-Cookie` tidak dikembalikan; `http.spec`) |
| OB-24 | Inertia: kirim versi aktual, baca `inputErrorsBag`/props errors, pertahankan status redirect asli (302 teramati) | S-F | WP-21, WP-22 | SELESAI (M5: versi dari `InertiaManager` app → 200 bukan 409; errors dari props Inertia setelah redirect 302 asli; `http.spec`) |
| OB-25 | Mapping Host/header tenant dari config tepercaya, middleware tenant berjalan sebelum auth; mapping bukan otorisasi; domain route tidak diasumsikan jatuh ke root | S-F, S-H | WP-19, WP-21 | SELESAI (M5: mapping dari `config/tenancy.ts`, middleware tenant app sebelum auth, membership tetap dicek; `domain` wajib domain router terdaftar; `http.spec`) |
| OB-26 | Gate M5 mempertahankan corpus cross-tenant token/session, cleanup token success/error/abort, anonymous-after-call | S-F | WP-20, WP-21 | SELESAI (M5: corpus A/B token+session konkuren, user/tenant salah ditolak sebelum mint, cleanup token sukses/500/deadline, anonymous-after-call; `http.spec`) |
| OB-27 | PostgreSQL: reader dedicated NOSUPERUSER SELECT-only, `queryMode:'extended'` untuk setiap statement (`values: []` tidak cukup), `BEGIN READ ONLY`, AST single SELECT/WITH | S-G | WP-16 | SELESAI (M4: role superuser/punya hak tulis ditolak sebelum query; `database.spec`) |
| OB-28 | PostgreSQL deadline lewat control connection `pg_cancel_backend`, tunggu settlement, `ROLLBACK` lalu `DISCARD ALL`; tutup koneksi bila cleanup gagal; pool app tidak disentuh | S-G | WP-16 | SELESAI dengan perubahan D46 (M4: koneksi reader per call selalu ditutup sesudah ROLLBACK, sehingga sesi tidak pernah dipakai ulang; `database.spec`) |
| OB-29 | SQLite: child process dengan koneksi `readonly` + `fileMustExist`, `stmt.readonly` + AST single SELECT, deny ATTACH/VACUUM/PRAGMA/function/UDF; JS `loadExtension` tidak diekspos; deadline SIGKILL + await exit; in-memory ditolak | S-G | WP-16 | SELESAI dengan perubahan D47 (M4: AST JS diganti pemeriksaan program `EXPLAIN` native; `database.spec`) |
| OB-30 | AST policy dimatangkan: corpus regression keamanan, unknown node default-deny, boundary relation/view/operator, allowlist fungsi pure yang direview (aggregate/string/date) | S-G, S-H | WP-16, WP-18, WP-36 | SELESAI untuk WP-16/WP-18 (M4: `sql_policy.spec`, view/operator/fungsi milik database dinyatakan trusted di limitation); perluasan adversarial WP-36 |
| OB-31 | Kontrak SQL membedakan response timeout vs cancellation DB; error `TIMEOUT`/`CANCELLED` jujur; row/output bounds tetap | S-G | WP-16 | SELESAI (M4: pesan menyebut mekanisme pembatalan nyata; mode read-write SQLite menyatakan deadline tidak ditegakkan; `database.spec`) |
| OB-32 | Tenant di-lookup dan diotorisasi sebelum `TenantService.run`/`runWithTenant`; ID tidak dikenal error eksplisit | S-H, S-K | WP-18 | SELESAI (M4: lookup callback/allowlist resolver default, `NOT_FOUND` untuk kunci tak dikenal, resolver jwt `CAPABILITY_UNSUPPORTED`; `database.spec`) |
| OB-33 | Raw SQL tenant: shared-table tanpa RLS ditolak; jalur RLS memakai reader MCP + `set_config('app.tenant_id', $1, true)` parameterized milik MCP di tx READ ONLY + recipe OB-27/OB-28; executor package tenant tidak dipakai pada pool app | S-H | WP-16, WP-18 | SELESAI (M4: `database.spec`) |
| OB-34 | Strategi schema/database-per-tenant tidak didukung sampai ada adapter host dan bukti grants/isolasi/reset | S-H | WP-18 | SELESAI (M4: hanya tabel FORCE RLS yang diterima untuk `tenant`; strategi lain ditolak `TENANT_SCOPE_REQUIRED`) |
| OB-35 | Regression tenant eval (ALS, model query, concurrency A/B) diulang dengan evaluator final S-E | S-H, S-E | WP-18, WP-28 | TERBUKA |
| OB-36 | Vine: compiled AST `toJSON().schema` sebagai authority required/nullability/rules; JSON Schema hanya projection; regression nullable-required Vine 4.4.0; callback tidak dieksekusi | S-I | WP-23 | TERBUKA |
| OB-37 | Tuyau: route runtime dipisah dari shape type-only; missing/stale/filtered eksplisit; freshness shape butuh generation tracking | S-I | WP-25 | TERBUKA |
| OB-38 | Inertia: ekstraksi TypeScript AST terbatas untuk route/render/shared keys dengan location + completeness; dynamic/spread unknown; config v5 tanpa `sharedData`; controller/lazy props tidak dieksekusi | S-I | WP-24 | TERBUKA |
| OB-39 | Edge: mounted roots + scan realpath terbatas; render hanya nama ter-inventaris; konvensi component/slot source-only; peringatan helper executable | S-I | WP-26 | TERBUKA |
| OB-40 | Cache mengikuti source hash/generation; fixture di `/tmp` mengoreksi ignore Vite `**/tmp/**` | S-I | WP-04, WP-37 | TERBUKA |
| OB-41 | Ace: `spawn(process.execPath, ['ace.js', command, ...argv], { cwd: appRoot, shell: false })`; tanpa import console entrypoint, `process.chdir`, atau pewarisan `execArgv` buta | S-J | WP-29 | TERBUKA |
| OB-42 | Ace: env snapshot tanpa menampilkan secret, stdin tertutup; dokumentasi command interaktif unsupported dan exit 0 bukan bukti prompt selesai; console app baru tidak berbagi state HTTP | S-J | WP-29, WP-35 | TERBUKA |
| OB-43 | Ace: deadline pada process group (SIGTERM→SIGKILL) oleh watchdog independen parent (assembler mengirim SIGKILL ke HTTP child saat restart); exitCode nullable + signal; drain bounded 256 KiB | S-J | WP-29 | TERBUKA |
| OB-44 | Ace di bawah HMR: hard restart = outcome unknown, tanpa auto-retry; E08 mencakup generator HMR, held request, hard restart, cleanup, Linux | S-J | WP-29, WP-38 | TERBUKA |
| OB-45 | Permission: `@adonisplus/permissions` (plural) dari modul aplikasi `#start/permissions`; CI memerlukan akses Plus berlisensi; tanpa redistribusi; Bouncer adapter eksplisit, bukan pengganti diam-diam | S-K | WP-27, WP-38 | TERBUKA |
| OB-46 | Queue: pin `@adonisjs/queue@0.6.2` + `@boringnode/queue@0.6.0`; listing mengikuti semantik loader (glob relatif `process.cwd()`, URL `file://` mentah, nama `options.name` atau fallback `class.name`) + verifikasi identitas `Locator.get`; manual registration unknown; status non-pending lewat adapter versi-terikat | S-K | WP-27 | TERBUKA |
| OB-47 | Tenant memakai `TenantService.run(context, cb)` atau export standalone `runWithTenant`; method `TenantService.runWithTenant` tidak ada | S-K | WP-18 | SELESAI (M4: `src/tenant.ts` memanggil `run()` dari binding `tenant.service`; `database.spec`) |
| OB-48 | `extraTools` dan definisi tool app tidak boleh di-import saat runtime production (zod/package absen); bentuk lazy dibuktikan di WP-03 | Integrasi M0 | WP-03, WP-33 | SELESAI (M1: `ExtraToolLoader` + `loadExtraTools`; production prune dengan `() => import('#start/mcp_tools')` yang meng-import zod + package) |
| OB-49 | Configure menawarkan penambahan `--experimental-vm-modules` ke proses dev (mis. `NODE_OPTIONS` pada script `dev`) dengan konfirmasi, idempotent, tanpa mengubah diam-diam; README/skill menjelaskan flag, ExperimentalWarning, dan perilaku tanpa flag | B-01 | WP-28, WP-33, WP-34, WP-35 | TERBUKA |

## 11. Blocker dan keputusan terbuka

| ID | Blocker | Asal | Dampak | Opsi | Status |
| --- | --- | --- | --- | --- | --- |
| B-01 | Natural `import()` di eval untuk fresh controller/service dan identitas hot-swap hanya terbukti lewat callback importer framework yang memerlukan `--experimental-vm-modules`; main-context default loader gagal untuk fresh import | S-E putaran 2–3 | WP-28, T25, DC-09, DC-26, OB-16, OB-17, OB-35 | Pengguna memilih (a) pada 13 Oktober 2026: flag wajib pada proses dev, ditawarkan configure (OB-49), tanpa flag `CAPABILITY_UNSUPPORTED` + remediasi. Opsi (b) loader lain tanpa flag dan (c) helper import eksplisit tidak dipakai | DIPUTUSKAN |

Tidak ada blocker teknis yang terbuka. Syarat lisensi Plus (OB-45) adalah prasyarat release untuk positive test permission di CI, bukan blocker implementasi.

## 12. Perubahan cakupan dan koreksi klaim

Belum ada pengurangan cakupan. M0 tidak menghapus tool, resource, atau prompt. Keputusan pengguna yang sudah diperoleh: B-01 opsi (a) — `project_eval` mewajibkan `--experimental-vm-modules` pada proses dev (D26, OB-49), 13 Oktober 2026. Koreksi klaim desain berikut tercatat sebagai keputusan rencana D21–D33 (lihat plan §3.1) dan menunggu persetujuan pengguna bersama keputusan lain di bagian 3 plan:

- Log/exception capture memerlukan instrumentasi opt-in yang dibuat configure; klaim desain "tidak ada instrumentasi tambahan di kode user" tidak dapat dipenuhi dengan API publik Core 7.6 (D24).
- `get_container_bindings` mengeluarkan inventory parsial berlabel; daftar lengkap dan provider asal tidak tersedia tanpa API upstream (D25).
- `execute_sql_query` hanya menerima subset SELECT/WITH terbatas pada executor milik MCP; PostgreSQL membutuhkan reader role terkonfigurasi, SQLite in-memory tidak didukung (D28).
- Impersonation cookie session memberi replay window terbatas, bukan revocation instan (D27).
- Package permission adalah `@adonisplus/permissions` (privat, berlisensi), bukan `@adonisplus/permission`; queue memakai `@adonisjs/queue`, bukan `@rikology/adonisjs-queue` yang tidak terbit (D32).
- M2 (plan §3.2): endpoint MCP dipasang sebagai server middleware, bukan route (D34), sehingga configure tidak menulis exemption Shield/`Accept`; route app pada path MCP membuat endpoint melepaskan path dengan error log, bukan gagal boot (D35). Tidak ada fitur yang dihapus.
- M3 (plan §3.3): instrumentasi capture diekspor sebagai `@rikology/adonisjs-mcp/hooks` dan dipasang lewat gateway app-local (D38); observasi container dimulai dari gateway saat config load, bukan provider di posisi pertama (D39); resource `adonis://routes` dan `adonis://config/{key}` dibuat lebih awal dari WP-32 (D44). Tidak ada fitur yang dihapus.
- M4 (plan §3.4): executor PostgreSQL membuka koneksi reader per call dan menutupnya, bukan `DISCARD ALL` + reuse (D46); SQLite diperiksa lewat program terkompilasi (`EXPLAIN`), bukan `sqlite-parser` (D47); `tenant` pada raw SQL hanya untuk tabel FORCE RLS, tanpa tenant tabel tenant-scoped memerlukan `allowCrossTenant` (D48); desain "tolak query tanpa `WHERE tenant_id`" diganti boundary database (D11/D29). Opsi `explain` menggantikan teks `EXPLAIN` bebas. Tidak ada fitur yang dihapus.

## 13. Progres M1 (13 Oktober 2026)

M1 (WP-01–WP-04) diimplementasikan; bukti dijalankan pada macOS arm64, Node 24.21.0, npm 11.19.0: `npm run lint`, `npm run typecheck`, `npm test` (30 unit), `npm run test:integration` (11 integration, fixture nyata), `npm run verify:exports` (consumer strict dari tarball). Baris yang berpindah ke `SELESAI`: API-02, PK-01, OB-05, OB-06, OB-48.

Bukti parsial; baris tetap `TERBUKA` sampai WP konsumennya selesai:

| ID | Sudah terbukti di M1 | Sisa |
| --- | --- | --- |
| API-01 | Input parsial typed, default, merge array-replace, `projectEval: false`, validasi strict dengan path issue; provider memvalidasi di dev, test/production tidak memuat package | Efek `tools.disabled` pada registry (WP-05); E10 penuh (WP-33) |
| API-03 | Tipe `ToolContext` (`app`, `config`, `callId`, `signal`) | Profile/log/exception/tenant per call (WP-05, WP-09, WP-10, WP-18) |
| API-10 | Tipe `ToolErrorCode` sembilan kode + `ToolError` | Normalisasi ke result `isError` (WP-05, WP-07) |
| API-11 | Empat export resolve dari tarball untuk `tsc` strict (`skipLibCheck: false`) dan Node | `smoke:pack` (WP-38) |
| API-12 | Public entry tidak meng-import paket opsional; production prune boot tanpa package/zod | PF-01 dan adapter opsional (WP-09+) |
| DC-02 | Zod v4 + tuple SDK v2 terkunci di lockfile; tanpa shim v1 | Pemakaian SDK di transport (WP-07) |
| DC-21 / DC-22 | Configure membuat wrapper, config type-only, rc entry `['web']`; production standalone `/` 200, MCP 404, Ace `list`/`migration:status` exit 0 | Instrumentasi logger/exception production-safe (WP-33); gate CI (WP-38) |
| OB-07 | Skenario release gate dijalankan di integration test | Asersi binding/listener setelah ada (M2–M3); CI (WP-38) |
| OB-15 / OB-40 | Fixture factory mendukung runner `hmr` (`node ace serve --hmr`) dengan stop process group | Regression HMR (WP-37); koreksi ignore Vite `**/tmp/**` saat fixture kit Vite ditambahkan |
| PK-02 | Script `lint`, `typecheck`, `test`, `test:integration`, `build`, `verify:exports` | `test:security`, `smoke:pack`, `smoke:clients` (WP-38) |

## 14. Progres M2 (13 Oktober 2026)

M2 (WP-05–WP-09) diimplementasikan; bukti pada macOS arm64, Node 24.21.0, npm 11.19.0: `npm run lint`, `npm run typecheck`, `npm test` (55 unit), `npm run test:integration` (27 integration), `npm run verify:exports`. `endpoint.spec` = `tests/integration/endpoint.spec.ts`; `*.spec` unit ada di `tests/unit/`. Baris yang berpindah ke `SELESAI`: DC-01, DC-05, DC-06, DC-07, DC-16, DC-23, API-04–API-08, LC-01, LC-02, CF-01, CF-02, CF-07, CF-09, R01, PF-01 (profile), PF-08, SEC-01–SEC-05, SEC-07, E07, E12, OB-01–OB-03.

Bukti parsial; baris tetap `TERBUKA`:

| ID | Sudah terbukti di M2 | Sisa |
| --- | --- | --- |
| DC-03 | Default `/__adonis/mcp`, server MCP bernama `adonis`, custom path melayani hanya di path itu | Recipe client (WP-35), E10 penuh |
| DC-14 | Aturan hybrid = surface web (renderer aktif) + surface api; paket terpasang saja tidak cukup | Fixture hybrid PF-06 (WP-21) |
| API-03 | `ToolContext` membawa `profile()` lazy per request, `callId`, signal pembatalan client | Log/exception service (WP-10), tenant (WP-18) |
| API-10 | Kode stabil dinormalisasi ke `isError` (`EXECUTION_FAILED`, `CANCELLED`, kode `ToolError`) | E02 (WP-19–WP-22) |
| API-11 | Consumer strict memakai `ResourceDefinition`, `ProjectProfile`, `context.profile()` dari tarball | `smoke:pack` (WP-38) |
| API-12 | Profile meng-import paket opsional hanya lewat `app.import` setelah versi terpasang ditemukan; kit `api-bare` boot dan profile bersih | Adapter opsional M4–M6 |
| LC-03 | Snapshot registry final di `ready()`; profile lazy per request tanpa watcher/worker | Listener M3 |
| LC-04 | Registrasi setelah `ready()` melempar `RegistryClosedError` | Rebuild atomik saat HMR (WP-37); saat ini perubahan provider/`extraTools` memerlukan restart proses |
| LC-05 | Shutdown menutup handler MCP dan koneksi MCP in-flight saja (D36); exit 0 | HMR, listener, handle count (WP-37) |
| CF-10 | `allowedHosts`/`allowedOrigins` exact tanpa wildcard | Mapping surface/tenant (WP-21), dokumentasi (WP-35) |
| T01 | `get_project_profile` pada kit API dan `api-bare`: installed vs active, `active: null` tanpa sinyal, capability reasons | Kit Inertia/Edge/hybrid/tenant (PF-02–PF-07) |
| NF-03 | Client yang memutus koneksi membatalkan call-nya sendiri; client lain tetap dilayani | Timeout tool (WP-28, WP-29) |
| E01 | Dua era: discovery/initialize, `tools/list`, profile tool + resource, `prompts/get` | Routes tool/resource (M3) |
| OB-04 | `relayHeaders` + `await` bridge dari middleware; satu response per request | Matriks versi http-server (WP-38) |
| OB-07 | Production prune M1 tetap lulus dengan endpoint M2 terpasang | Asersi listener/buffer (M3), CI (WP-38) |

## 15. Progres M3 (13 Oktober 2026)

M3 (WP-10–WP-13) diimplementasikan; bukti pada macOS arm64, Node 24.21.0, npm 11.19.0: `npm run lint`, `npm run typecheck`, `npm test` (77 unit), `npm run test:integration` (35 integration), `npm run verify:exports` (consumer strict meng-import `./hooks`). `observability.spec` = `tests/integration/observability.spec.ts`. Baris yang berpindah ke `SELESAI`: DC-15, CF-05, T03, T06–T09, R02, R04, E01, OB-11, OB-12, OB-14 (dengan perubahan D39); PF-08 diperkuat dengan bukti M3.

Bukti parsial; baris tetap `TERBUKA`:

| ID | Sudah terbukti di M3 | Sisa |
| --- | --- | --- |
| DC-24 / OB-08 | Hooks `streamWrite`/`observeException` lewat gateway dev-guarded; output app tidak berubah (record tercetak sekali); production pruned boot | Configure menulis gateway + wiring logger/handler dan compose hook yang ada (WP-33); dokumentasi tanpa klaim zero-config (WP-35) |
| OB-09 | Redaction sebelum simpan, batas count/bytes/entry, parse dibatasi 64 KiB, subscriber gagal tidak merusak logging, detach + clear saat shutdown/`enabled: false` | Named logger lain, transport worker, exception ignored/`report()` throw, detach saat HMR (WP-36, WP-37) |
| DC-25 | Inventory container parsial berlabel; events persistent-only; metadata dibaca segar per request tanpa cache | Cache model/source berkunci generation (WP-14, WP-37) |
| API-03 | `ToolContext.logs`/`exceptions` per call (`null` tanpa hooks) | Tenant per call (WP-18) |
| LC-03 | Inspeksi tidak memulai watcher/worker; subscriber capture hanya in-process dan dilepas saat terminating | Regression HMR listener/handle (WP-37) |
| T02 | Method/pattern/params/name/domain, handler controller/closure, stack middleware berurutan dengan args, surface + sumbernya pada kit API | Surface Inertia/Edge/hybrid/domain (E05, WP-21) |
| T04 / T05 | Root/ctx/child sekali, korelasi request id dan call id, filter level/grep literal/cursor tanpa kehilangan urutan; exception dengan status response, route, request id, fingerprint/occurrences | Korelasi `http_request` ↔ log/exception (E02, WP-19–WP-22) |
| SEC-18 | Redaction pre-buffer log/exception; config/resource/route args ter-redaksi; sentinel env + literal tidak keluar dari 9 tool dan 4 resource di dua era | HTTP/queue/docs (WP-22, WP-27, WP-31), adversarial suite (WP-36) |
| SEC-19 | `get_env` hanya key/tipe/presence | Docs search tidak membaca `.env` (WP-31); configure tidak mencetak `.env` (WP-33) |
| NF-02 | Append log O(1) amortized dengan batas bytes dan slot dialokasikan bertahap | Cache lazy berkunci generation (WP-14, WP-31) |
| OB-07 | Production pruned dari app terinstrumentasi: hooks tidak dapat di-resolve, MCP 404, tanpa subscriber/observer | CI (WP-38) |

## 16. Progres M4 (13 Oktober 2026)

M4 (WP-14–WP-18) diimplementasikan; bukti pada macOS arm64, Node 24.21.0, npm 11.19.0, PostgreSQL 18.4 (cluster milik test), `@rikology/adonisjs-tenant` 1.0.2: `npm run lint`, `npm run typecheck`, `npm test` (130 unit), `npm run test:integration` (50 integration), `npm run verify:exports`. `database.spec` = `tests/integration/database.spec.ts`, `sql_policy.spec` = `tests/unit/sql_policy.spec.ts`. Baris yang berpindah ke `SELESAI`: DC-10, DC-11, DC-28 (perubahan D46–D47), DC-29 (WP-16/WP-18), API-03, CF-04, T10–T14, R03, E03, SEC-10–SEC-14 (corpus M4), OB-27–OB-34, OB-47; PF-01 diperkuat untuk tool database.

Bukti parsial; baris tetap `TERBUKA`:

| ID | Sudah terbukti di M4 | Sisa |
| --- | --- | --- |
| DC-18 | SQL default read-only; `readOnly: false` mengubah deskripsi dan annotations (`destructiveHint: true`) dan output `mode: 'read-write'` | Skill tidak mengklaim read-only setelah diubah (WP-34) |
| DC-25 / OB-13 | Katalog model di-cache per generation (daftar file, ukuran, mtime), dibangun ulang saat generation berubah, file yang berubah setelah proses mulai dilabel `changedSinceProcessStart` | Regression HMR/restart (WP-37) |
| DC-32 | Tenant 1.0.2 dipakai lewat binding `tenant.service` dan `config/tenancy.ts` | Permission/queue (WP-27) |
| DC-33 | `pgsql-ast-parser` ^12.0.1 (MIT; dependency `moo`, `nearley`) sebagai dependency runtime, dimuat lazy hanya untuk PostgreSQL | Review lisensi distribusi (WP-38) |
| LC-06 | Model di-import sekali lewat `app.import` tanpa query cache-busting | Regression memori HMR (WP-37) |
| NF-01 | `tools/list` dan availability tool database hanya membaca binding/config, tanpa scan model atau koneksi DB | Docs index (WP-31) |
| NF-02 | Cache model lazy berkunci generation | Docs index (WP-31) |
| NF-04 | PostgreSQL FETCH maksimal `maxRows + 1` dari cursor server; SQLite iterasi berhenti di `maxRows + 1` (query rekursif tak terbatas kembali cepat); `query_model` `limit + 1`, preload dibatasi per query relasi | HTTP streaming (WP-19); mode read-write memuat hasil penuh dari driver (dilabel) |
| SEC-15 | Deskripsi dan limitation `query_model` menyatakan hook/serializer app adalah kode tepercaya | README/API reference (WP-35) |
| E06 | Model query A/B konkuren terisolasi, tenant hilang/tak dikenal gagal, raw SQL OR/komentar/UNION dibatasi RLS | Eval (WP-28, OB-35) dan HTTP (WP-21) |
| PF-02 | Tool database dan schema tersedia pada kit API (Lucid SQLite) dan PostgreSQL | JSON default dan cleanup token (M5), Tuyau (WP-25) |
| PF-07 | Positive adapter tenant 1.0.2 (lookup allowlist header, TenantScope, RLS) | Permission + queue (WP-27) |

## 17. Progres M5 (13 Oktober 2026)

M5 (WP-19–WP-22) diimplementasikan; bukti pada macOS arm64, Node 24.21.0, npm 11.19.0, `@rikology/adonisjs-tenant` 1.0.2: `npm run lint`, `npm run typecheck`, `npm test` (145 unit), `npm run test:integration` (61 integration), `npm run verify:exports`. `http.spec` = `tests/integration/http.spec.ts` (kit baru `hybrid` dan kit API + tenant), unit `http.spec` = `tests/unit/http.spec.ts`. Baris yang berpindah ke `SELESAI`: DC-12, DC-14, DC-17, DC-27 (WP-20), DC-29 (lengkap), API-10, T04, T05, T15, SEC-16, SEC-17, E02, E04, OB-19, OB-20 (perubahan D52), OB-22 (tidak diklaim), OB-23–OB-26; PF-01 diperkuat untuk impersonation.

Bukti parsial; baris tetap `TERBUKA`:

| ID | Sudah terbukti di M5 | Sisa |
| --- | --- | --- |
| OB-21 | Limitation setiap call session menyatakan salinan cookie berlaku sampai deadline dan tidak di-revoke di server; token dinyatakan dihapus | README/API reference (WP-35) |
| CF-06 | Deadline HTTP `tools.http.timeout` 30.000 ms (input tidak boleh melebihi), body dibatasi `limits.maxResultBytes`, `TIMEOUT` tanpa retry | Ace (WP-29) |
| CF-10 | Config aditif `tools.http.tenantDomain` (host tanpa port, null default) untuk resolver subdomain | Dokumentasi (WP-35); gate integrasi resolver subdomain/path |
| T02 | Surface per route dipakai `http_request` dengan sumber `route-guard`/`config`/`inferred`/`default` | `get_routes` pada kit Inertia/Edge/hybrid (E05) |
| PF-02 | JSON default untuk surface api, cleanup token pada kit API (tenant) dan hybrid | Tuyau (WP-25) |
| PF-03 | Kit hybrid (Inertia React + session/Shield): `X-Inertia` + versi aktual, flash, CSRF, validasi | Introspeksi page/shared/transformer (WP-24) |
| PF-06 | Surface per route (guard, method, domain `api.*`), hybrid tanpa default meminta surface | Mapping tenant/domain pada kit hybrid yang sama |
| E05 | API JSON, page Inertia (component/props/version), outline HTML halaman Edge, validasi Inertia, domain route tidak jatuh ke root | Kit Edge-only (hypermedia) dan Inertia Vue (M6) |
| E06 | HTTP A/B konkuren lewat guard token dan session tenant-aware; tenant hilang/salah/membership ditolak | Eval (WP-28, OB-35) |
| SEC-18 | Output `http_request` diproyeksikan dengan kredensial yang di-mint dan nilai cookie jar sebagai secret tambahan | Queue/docs (WP-27, WP-31), adversarial suite (WP-36) |
| NF-03 | Timeout `http_request` tidak memengaruhi request lain; handler app tetap berjalan, tanpa retry | Eval/Ace (WP-28, WP-29) |
| NF-04 | Body response HTTP dibaca sampai `limits.maxResultBytes` lalu koneksi ditutup (4 MiB → 256 KiB, app tetap melayani) | Mode read-write SQL memuat hasil penuh dari driver (dilabel) |
