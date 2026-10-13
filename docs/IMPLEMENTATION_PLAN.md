# Implementation Plan — @rikology/adonisjs-mcp

Tanggal: 13 Oktober 2026  
Status: M0 (spike dan obligation ledger), M1 (fondasi package dan fixture, §6.1), M2 (registry, provider, transport, security boundary, §6.2), M3 (runtime observability dan metadata dasar, §6.3), M4 (Lucid, SQL, schema, tenant foundation, §6.4), M5 (HTTP nyata, impersonation, surface routing, §6.5), dan M6 (introspeksi framework dan optional integrations, §6.6) selesai; M7 belum dimulai
Sumber kebutuhan: [DESIGN.md](./DESIGN.md)  
Obligation ledger: [OBLIGATION_LEDGER.md](./OBLIGATION_LEDGER.md); bukti spike: [spikes/](./spikes/)  
Target deliverable: package npm `@rikology/adonisjs-mcp@0.1.0`, MIT, untuk aplikasi AdonisJS v7 dalam development.

## 1. Baseline, hasil akhir, dan cara memakai rencana

Repository saat penyusunan hanya berisi `docs/DESIGN.md`. Belum ada `package.json`, source package, fixture aplikasi, test runner, CI, atau artefak build. Semua path source, script, dan kontrak implementasi di bawah merupakan **target**, bukan kemampuan yang sudah tersedia.

Setelah M0, repository juga berisi laporan spike `docs/spikes/S-A.md`–`S-K.md`, probe dan raw evidence yang dapat dijalankan ulang di `spikes/`, script fixture `spikes/create-fixtures.sh` dan `spikes/clone-fixture.sh` (aplikasi disposable di `/tmp/adonisjs-mcp-m0`), serta `docs/OBLIGATION_LEDGER.md`. Probe spike bukan source package dan tidak boleh disalin menjadi implementasi tanpa review WP terkait.

Rencana ini mempertahankan cakupan desain: MCP embedded pada proses aplikasi, satu endpoint HTTP, tanpa UI, tool runtime generik dan spesifik AdonisJS, profil API/Inertia/Edge/hybrid, registry ekstensi, tenant awareness, resources, prompts, configure hook, dan skill agent. Seluruh 28 tool yang disebut desain masuk matriks delivery; tool kondisional bukan alasan menghapus implementasinya dari release.

Urutan baca:

1. Bagian 2–4: keputusan, koreksi desain, dan kontrak yang harus dibekukan.
2. Bagian 5: spike untuk asumsi framework yang belum terbukti.
3. Bagian 6–7: milestone, work package, dan dependensi.
4. Bagian 8–10: cakupan fitur, test matrix, dan security invariants.
5. Bagian 11–13: risiko, release, dan pekerjaan pertama.

**Definition of done proyek:** tarball terpasang pada fixture aplikasi bersih; configure dapat dijalankan ulang; client MCP sungguhan membaca state aplikasi yang hidup; seluruh fitur kondisional bekerja pada fixture yang sesuai; production boot tetap berhasil setelah dev dependencies dihilangkan; tidak ada klaim keamanan atau introspeksi yang melampaui bukti.

### Batas cakupan

Dalam cakupan:

- Development lokal; remote development sebagai opt-in berisiko dan terdokumentasi.
- Node.js yang memenuhi minimum AdonisJS v7; ESM TypeScript; Japa; tsdown dan declaration build.
- Tools, resources, prompts, registrasi ekstensi eksplisit, serta dokumentasi client dan agent.
- Adapter untuk paket opsional yang benar-benar dipakai desain; tanpa memuat paket tersebut jika tidak ada.
- SQLite dan PostgreSQL sebagai baseline uji database; dukungan dialect lain hanya boleh diklaim setelah adapter dan gate-nya lulus.

Di luar cakupan release ini:

- Production endpoint, hosted MCP multi-user, OAuth server, atau pengelolaan identitas MCP.
- UI/dashboard, browser automation, stdio yang mem-boot salinan aplikasi, marketplace, auto-discovery plugin.
- Streaming log/subscription jangka panjang, durable task engine, telemetry eksternal, remote documentation search.
- Sandbox aman untuk arbitrary JavaScript, hard timeout kode in-process, atau jaminan rollback semua side effect.
- Menebak schema lengkap dari kode dinamis tanpa bukti, atau mengklaim semua queue/auth/tenant adapter kompatibel.

Pembatasan dialect/adapter adalah batas **klaim kompatibilitas**, bukan penghapusan lima tool database maupun tool opsional dari target implementasi. Perluasan matriks mengikuti bukti, bukan nama package saja.

## 2. Baseline dependency dan fakta eksternal

### 2.1 Hasil verifikasi saat penyusunan

| Komponen | Bukti yang diperiksa | Konsekuensi rencana |
| --- | --- | --- |
| AdonisJS Core | Metadata npm `7.6.0`, engine `node >=24.0.0` [S1] | Node 24 menjadi baseline; range peer awal `^7.0.0` harus diuji pada versi minimum dan versi terkini sebelum diklaim |
| Lucid | Metadata npm `22.4.2`, engine Node 24, peer Core v7 [S2] | Lucid `^22.0.0` optional peer; impor lazy; test kompatibilitas minimum/current |
| MCP SDK v1 | Metadata `@modelcontextprotocol/sdk@1.32.1`; Zod `^3.25` atau `^4.0`; README menyatakan maintenance line [S3][S4] | Klaim desain “SDK v1 hanya Zod v3, pin ^3.23” tidak dipakai |
| MCP SDK v2 | `@modelcontextprotocol/server@2.3.1`, dependency Zod `^4.2.0` [S5] | Pilih v2 untuk proyek baru; gunakan schema object, bukan menyalin raw-shape API v1 |
| Node adapter MCP | `@modelcontextprotocol/node@2.1.1`, peer server `^2.3.0` [S6] | Versi package adapter dan server tidak harus identik; lock tuple yang benar-benar kompatibel |
| HTTP SDK v2 | `createMcpHandler(factory)` mendukung modern protocol dan legacy stateless; Node bridge `toNodeHandler` [S7][S8] | Jadikan ini kandidat utama spike transport; jangan merakit protokol sendiri |
| MCP protocol | Revisi `2026-07-28` memakai metadata per request; berbeda dari handshake revisi 2025 [S9][S10] | Test kedua era; upgrade dependency tidak otomatis mengaktifkan protokol modern |
| Provider AdonisJS | `register → boot → start → preload → ready`; environment `web` adalah jenis proses [S11] | Jangan membaca route final saat boot, atau menganggap `web` berarti development |

Metadata registry dan dokumentasi bukan bukti integrasi runtime. Exact lockfile, import API, bodyparser bridge, dan perilaku client harus dibuktikan pada M0–M2. Versi di atas adalah snapshot, bukan instruksi memakai `latest` pada setiap build.

### 2.2 Pilihan implementasi awal

- Runtime dependencies: `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `zod`; dependency tambahan hanya jika spike membuktikan kebutuhan dan alasan dicatat.
- Dev dependency MCP client untuk smoke/protocol tests; jangan kirim client SDK dalam runtime package.
- Core required peer; Lucid, auth, Inertia, Edge, Tuyau, tenant, permission, dan queue memakai optional integration sesuai API yang diverifikasi. Paket yang diimpor langsung harus dideklarasikan langsung, tidak mengandalkan dependency transitif.
- Lock package manager npm untuk single-package repository, satu `package-lock.json`; fixture memakai tarball lokal, bukan workspace alias yang menutupi masalah publish.
- Runtime package tidak menambahkan framework HTTP kedua. Node adapter boleh membawa dependency transitifnya; Adonis tetap pemilik port dan lifecycle.
- Lisensi package MIT; inventaris lisensi dependency SDK v2 yang berbeda disertakan saat review distribusi.

### 2.3 Tuple yang terverifikasi M0

Diamati pada fixture create-adonisjs 3.4.0 (kit API, Inertia React, hypermedia), Node 24.21.0, npm 11.19.0, macOS 27 arm64. Ini tuple bukti spike, belum matriks kompatibilitas release (Linux, Node minimum, dan Core/Lucid minimum tetap kewajiban WP-38).

| Area | Versi teramati | Spike |
| --- | --- | --- |
| Core / application / http-server / bodyparser / Shield | 7.6.0 / 9.1.0 / 9.3.1 / 11.0.4 / 9.0.0 | S-A, S-B |
| fold / events / logger / ace / assembler / hot-hook / ts-exec | 11.1.0 / 10.2.0 / 7.1.1 / 14.1.1 / 8.5.2 / 1.0.0 / 1.5.0 | S-C, S-D, S-J |
| Lucid / Knex / pg / better-sqlite3 / PostgreSQL | 22.4.2 / 3.3.0 / 8.16.3 / 13.0.3 / 18.4 | S-G, S-H |
| auth / session / Inertia / Vine / Tuyau / Edge / http-transformers / TypeScript | 10.1.0 / 8.1.0 / 5.0.1 / 4.4.0 / 1.2.2 / 6.5.1 / 2.3.1 / 6.0.3 | S-F, S-I |
| MCP server / node adapter / client / Zod | 2.3.1 / 2.1.1 / 2.3.1 / 4.6.7 — tuple kompatibel tanpa override | S-A |
| Tenant / permissions / Bouncer / queue / boringnode queue | `@rikology/adonisjs-tenant` 1.0.2 / `@adonisplus/permissions` 0.0.4 / 4.0.1 / `@adonisjs/queue` 0.6.2 / 0.6.0 | S-H, S-K |
| Parser SQL (kandidat) | `pgsql-ast-parser` 12.0.1, `sqlite-parser` 1.0.1 | S-G |

## 3. Keputusan dan koreksi eksplisit terhadap desain

Bagian ini adalah keputusan awal rencana, **bukan persetujuan pengguna yang sudah diperoleh**. `DESIGN.md` tetap sumber kebutuhan asli dan tidak diubah diam-diam. Jika spike memaksa perubahan kontrak publik, perbarui bagian ini sebelum implementasi konsumen.

| ID | Ketegangan/asumsi dalam desain | Keputusan implementasi |
| --- | --- | --- |
| D01 | Satu `McpServer` saat boot bertentangan dengan server per request | Registry, buffers, dan cache dimiliki aplikasi; `McpServer` dibuat per request oleh factory. HTTP handler bersama ditutup saat shutdown, bukan setiap response |
| D02 | Contoh SDK v1 dan Zod v3 sudah tertinggal | Baseline SDK v2 + Zod v4; factory dual-era dari SDK. Tidak membuat compatibility shim API v1 milik package |
| D03 | Default path `/tidewave/mcp` bertentangan dengan contoh | Satu default `/__adonis/mcp`; identitas client `adonis`; tidak menyediakan alias Tidewave |
| D04 | `devDependencies` + provider environment `web` dianggap cukup untuk production | Uji production install tanpa package. Conditional provider loading **dan** config import harus aman; `app.inDev` juga diperiksa sebagai defense-in-depth |
| D05 | `request.ip()` dapat dipengaruhi trusted proxy | Gunakan socket remote address; validasi Host dan Origin secara terpisah; jangan percaya forwarded headers untuk otorisasi |
| D06 | `Origin: null` dianggap aman | Origin tidak ada diterima untuk native MCP client; literal `null`, malformed, opaque, dan foreign origin ditolak secara default |
| D07 | `allowRemoteAccess` melewati semua proteksi | Flag hanya membuka pembatasan peer address; Host/Origin tetap exact allowlist. Tunnel/proxy tidak boleh membuat endpoint terbuka ke jaringan tak tepercaya |
| D08 | `AbortSignal.timeout` dianggap dapat menghentikan arbitrary eval | Timeout eval kooperatif/batas menunggu, bukan preemption. Kode sinkron dapat membekukan app; side effect yang sudah berjalan tidak otomatis batal |
| D09 | `AsyncFunction` + app root dianggap otomatis menyelesaikan `import('#models/user')` | Natural dynamic import adalah acceptance requirement yang harus dibuktikan; `process.chdir` atau regex rewrite bukan solusi resolver |
| D10 | Prefix `SELECT/WITH/EXPLAIN/PRAGMA` dianggap menjamin read-only | Enforce batas baca di database/connection; pembatas statement hanya lapisan tambahan. Tolak operasi yang tidak bisa dibuktikan aman; tanpa fallback diam-diam ke read-write |
| D11 | Kehadiran `WHERE tenant_id` dianggap menjamin isolasi | Tidak memakai string matching sebagai tenant enforcement. Raw SQL tenant memerlukan boundary DB yang terbukti; jika tidak ada, default tolak dan arahkan ke `query_model` |
| D12 | Tenant AsyncLocalStorage dianggap terbawa lewat HTTP loopback | `http_request` harus masuk lewat middleware tenant aplikasi dengan host/header mapping yang dipercaya; ALS caller tidak menyeberangi socket |
| D13 | Semua metadata diklaim berasal dari runtime | Pisahkan `runtime`, `generated`, dan `source` evidence. Pemetaan Inertia, transformer, Vine, dan Tuyau tidak boleh dipresentasikan sebagai observasi request bila hanya analisis file |
| D14 | Inertia terpasang + Edge tersedia berarti hybrid | Kehadiran package hanya sinyal. Hybrid berarti beberapa surface yang dikonfigurasi/teramati; dependency Edge transitif tidak cukup |
| D15 | Daftar binding pasti memiliki provider asal | Keluarkan origin hanya bila framework mengekspos bukti; selain itu `unknown`. Jangan membuat provenance palsu |
| D16 | Optional peer mengimpor `defineTool` tetapi diklaim type-only | Package ekstensi boleh memberi object yang memenuhi exported type tanpa runtime import; jika memakai helper, lazy import sesudah guard MCP tersedia |
| D17 | Token auth “sementara di memori” berlaku untuk semua guard | Guard dapat menulis token/session ke store. Buat kredensial sementara lewat API nyata, cleanup di `finally`, dan buktikan tidak ada residu |
| D18 | SQL read-only bisa `false`, tetapi skill menyebut selalu read-only | Default read-only. Opt-in write mode ditandai jelas sebagai mutating; skill dan annotations tidak boleh mengklaim aman setelah diubah |
| D19 | Full code eval masuk log buffer | Audit event menyimpan status, durasi, call ID, dan excerpt ter-redaksi; kode penuh/secret tidak disimpan otomatis |
| D20 | `tools.docs.include` berbeda antara contoh dan tabel | Default `['@adonisjs/*', '@rikology/*']`; user dapat mempersempit. Semua config contoh dan stub harus identik semantiknya |

Tidak adanya auth MCP adalah keputusan trust model lokal, bukan bukti bahwa localhost aman dari semua proses/browser. Origin guard tidak mengautentikasi proses lokal. Pengguna yang menyalakan remote access harus menyediakan boundary jaringan tepercaya di luar package.

### 3.1 Keputusan hasil M0

Keputusan berikut berasal dari bukti spike dan memperbarui baris D01–D20 yang disebut. Statusnya sama dengan tabel di atas: keputusan rencana, belum persetujuan pengguna — kecuali D26, yang disetujui pengguna pada 13 Oktober 2026 (ledger B-01, opsi a).

| ID | Bukti | Keputusan | Mengubah |
| --- | --- | --- | --- |
| D21 | S-B | Install production-safe: rc entry `{ file: () => import('#providers/mcp_dev_provider'), environment: ['web'] }` lewat `rcFile.addProvider`; wrapper app-local meng-import provider package hanya bila `app.inDev`; `config/mcp.ts` memakai `import type { McpConfig }` + `satisfies McpConfig` dan provider melakukan default/validation. Strategi desain (provider package langsung + `defineConfig` runtime di config) membuat production `migration:status` dan boot gagal setelah `npm ci --omit=dev`. Release gate memakai deployment standalone di luar ancestor `node_modules` karena build bersarang memberi false positive | D04, API `defineConfig` di config stub |
| D22 | S-B (turunan) | Semua file app yang dimuat di production (config, logger, exception handler, definisi `extraTools`) tidak boleh meng-import package MCP atau `zod` saat runtime; bentuk lazy `extraTools` dibuktikan di WP-03 | D16, `extraTools` desain |
| D23 | S-A | Satu `createMcpHandler(factory)` + `toNodeHandler` per app, ditutup lewat `app.terminating`; route memanggil `relayHeaders()` lalu `await bridge(req, res, ctx.request.body())` tanpa payload lain. Shield `csrf.exceptRoutes` exact path; middleware app yang mengubah `Accept` dikecualikan exact path; limit 1 MiB ditegakkan endpoint; malformed JSON ditolak bodyparser (400) sehingga normalisasi/redaction milik package. Era modern `2026-07-28` dan legacy `2025-11-25` lulus dengan client resmi | D01, D02, CF payload |
| D24 | S-C | Capture log/exception adalah instrumentasi opt-in yang dibuat configure: `hooks.streamWrite` pada logger config dan observer sekali di `HttpExceptionHandler.handle`, lewat gateway app-local dev-guarded yang lolos production prune. Tidak diklaim zero-config; Core 7.6 tidak punya observer publik untuk record log atau error+ctx | Prinsip desain "tanpa instrumentasi" |
| D25 | S-D | `get_container_bindings` = inventory parsial: baseline augmentasi `ContainerBindings` + `hasBinding` tanpa instantiate; observasi awal opt-in di posisi provider pertama dengan origin dari trace `providerRegister`; coverage dan origin `unknown` eksplisit. `get_events` hanya persistent listeners. Controller hot-swap terjadi tanpa restart, sehingga cache tidak boleh hanya diinvalidasi saat `ready` | D15 |
| D26 | S-E; keputusan pengguna B-01 | Evaluator `vm` dengan `importModuleDynamically` callback ke importer framework (`app.import`) dan filename sintetis di app root; satu-satunya mekanisme teramati yang menyelesaikan fresh import controller/service dan identitas hot-swap. **Disetujui:** `--experimental-vm-modules` wajib pada proses dev; configure menawarkan penambahannya (mis. `NODE_OPTIONS` pada script `dev`) dengan konfirmasi, tidak diam-diam; tanpa flag tool mengembalikan `CAPABILITY_UNSUPPORTED` + remediasi. `AsyncFunction` dari package referrer dan main-context default loader gagal. D08 terkonfirmasi: mutation tetap terjadi setelah timeout, loop sinkron membekukan HTTP | D09 (mekanisme; sintaks natural tetap) |
| D27 | S-F | Impersonation: access token dibuat lewat provider nyata (tenant-bound bila tenant aktif) dan dihapus di `finally`; cookie session dicetak sebagai payload terenkripsi ber-expiry terikat deadline call, response cookie di-rewrap, jar dibuang. Semantik = tanpa residu server + replay window terbatas, bukan revocation instan. Guard/user/tenant divalidasi sebelum mint; store session stateful belum didukung sampai dibuktikan | D17 |
| D28 | S-G | Executor SQL milik MCP, tidak menyentuh pool app. PostgreSQL: reader dedicated least-privilege, `queryMode: 'extended'` untuk setiap statement, `BEGIN READ ONLY`, AST single SELECT/WITH dengan fungsi default-deny (allowlist fungsi pure direview di WP-16), deadline via `pg_cancel_backend` dari control connection, `ROLLBACK` + `DISCARD ALL`. Tanpa reader terkonfigurasi, capability nonaktif dengan alasan. SQLite: child process `readonly` + `fileMustExist`, `stmt.readonly` + AST, deny ATTACH/VACUUM/PRAGMA/extension, deadline SIGKILL; in-memory tidak didukung. Prefix filter putaran 1 terbukti bisa dibobol (`COMMIT; DELETE` menghapus data) | D10, D18, CF SQL |
| D29 | S-H | Raw SQL tenant: shared-table tanpa RLS ditolak; dengan FORCE RLS milik host + reader NOBYPASSRLS, MCP sendiri menetapkan `set_config('app.tenant_id', $1, true)` parameterized lalu menjalankan recipe D28. Executor package tenant tidak dipakai di pool app. Tenant di-lookup/diotorisasi sebelum `TenantService.run`; HTTP memakai mapping Host/header tepercaya ke middleware tenant sebelum auth. Schema/database-per-tenant belum didukung | D11, D12 |
| D30 | S-I | Sumber evidence: Vine compiled AST sebagai authority (JSON Schema Vine 4.4.0 salah untuk nullable-required); Tuyau runtime hanya route, shape bersifat type-only; Inertia route/page/shared keys dari TypeScript AST terbatas (compiler milik app); Edge dari mounted roots + scan realpath terbatas. Dynamic case `unknown` | D13, D14 |
| D31 | S-J | Ace lewat subprocess `spawn(process.execPath, ['ace.js', ...], { cwd: appRoot, shell: false })`, stdin tertutup, process group + watchdog independen parent (assembler 8.5.2 mengirim SIGKILL ke HTTP child saat restart). Hard restart = outcome unknown, tanpa auto-retry. In-process `ace.exec` ditolak karena stdout/env bocor antar request | CF Ace |
| D32 | S-K | Paket konkret: tenant `@rikology/adonisjs-tenant` 1.0.2 (`tenant.service`, `TenantService.run`/`runWithTenant`); permission `@adonisplus/permissions` 0.0.4 dari registry privat Plus (modul `#start/permissions`); Bouncer 4 adapter alternatif eksplisit; queue `@adonisjs/queue` 0.6.2 + `@boringnode/queue` 0.6.0 dengan listing via `queue.locations` mengikuti semantik loader | Nama paket di desain |
| D33 | S-G, S-I | Dependency tambahan beralasan: parser SQL dialect-aware (kandidat `pgsql-ast-parser`; `sqlite-parser` 1.0.1 berumur dan perlu evaluasi ulang di WP-16) dan TypeScript compiler yang di-resolve dari app (optional) untuk ekstraksi source | §2.2 |

### 3.2 Keputusan hasil M2

Keputusan implementasi M2, dengan bukti di §6.2. Statusnya keputusan rencana, belum persetujuan pengguna.

| ID | Bukti | Keputusan | Mengubah |
| --- | --- | --- | --- |
| D34 | `tests/integration/endpoint.spec.ts` | Endpoint dipasang sebagai **server middleware pertama** (`server.use` di `start()` provider, sebelum `server.boot()`), bukan route. Middleware hanya mengambil request dengan `request.url()` persis `config.path`; request lain diteruskan tanpa perubahan. Guard berjalan paling awal; bodyparser, session, Shield (CSRF), dan middleware `Accept` app tidak pernah melihat trafik MCP, sehingga tidak perlu exemption `csrf.exceptRoutes` maupun pengecualian force-JSON. SDK membaca body sendiri dengan `maxRequestBodySize = limits.maxRequestBytes` (413), menjawab JSON rusak dengan JSON-RPC `-32700` tanpa echo body, dan content type non-JSON dengan 415. CSRF app tetap aktif untuk semua route lain | D23, OB-01–OB-04, WP-08 "route-local Shield handling", WP-33 (exemption tidak lagi diperlukan) |
| D35 | idem | Route app pada path MCP tidak di-shadow: saat `ready()` provider memeriksa `router.match` untuk semua method; bila ada, endpoint melepaskan path (request diteruskan ke route app) dan mencatat error berisi path dan method. Gagal boot tidak dipakai karena error di `ready()` terjadi setelah server listening dan tidak menghentikan proses | WP-06 "route name/path conflict handling" |
| D36 | idem | Shutdown: provider mendaftarkan `app.terminating` di `ready()`, setelah hook close HTTP server milik Core, sehingga hook MCP berjalan lebih dulu (urutan terbalik) dan exchange MCP yang masih terbuka tidak menahan `server.close()`. Exchange modern dibatalkan lewat `handler.close()`; koneksi legacy yang tersisa di-destroy | D23 (penutupan handler) |
| D37 | idem | Profile: `active` hanya dari sinyal runtime terverifikasi (binding container string/kelas yang diimpor lewat `app.import`, flag `app.usingEdgeJS`/`usingVineJS`); paket tanpa sinyal (Tuyau, Transmit, permissions, Bouncer) melaporkan `active: null`, bukan `false`. `kind` hybrid hanya bila surface web (renderer Inertia/Edge aktif) dan surface api (config, route `/api`/domain `api.*`) sama-sama ada. Profile dihitung lazy, paling banyak sekali per request MCP (`AvailabilityContext.profile()`), dan `available()` dievaluasi per request; `available()` yang throw atau mengembalikan nilai invalid menjadi `INTEGRATION_FAILED` | §4.5, D14 |

### 3.3 Keputusan hasil M3

Keputusan implementasi M3, dengan bukti di §6.3. Statusnya keputusan rencana, belum persetujuan pengguna.

| ID | Bukti | Keputusan | Mengubah |
| --- | --- | --- | --- |
| D38 | `tests/integration/observability.spec.ts` | Instrumentasi opt-in diekspor sebagai `@rikology/adonisjs-mcp/hooks` (`streamWrite`, `observeException`, `observeContainer`, `instrumentationStatus`). Gateway app-local `start/mcp_dev_hooks.ts` meng-import modul itu hanya bila `app.inDev`; `config/logger.ts` memakai `hooks: { streamWrite }`, `HttpExceptionHandler.handle()` memanggil `observeException(error, ctx)` sekali. Hook hanya meneruskan ke subscriber modul `gateway`; tanpa subscriber (console, `enabled: false`, sesudah shutdown) hook hanya menghitung dan tidak menyimpan data. Codemod configure untuk gateway tetap WP-33 | D24, OB-08 |
| D39 | idem | Observasi container dimulai dari gateway saat config dimuat (sebelum provider mana pun `register()`), bukan dari provider di posisi pertama: config diproses sebelum `providersManager.register()` di Application 9.1, sehingga tidak perlu codemod reorder (`addProvider` hanya append). Hanya proses `web`; `enabled: false` dan shutdown mengembalikan method container dan melepas trace `providerRegister` | OB-14 (posisi observer) |
| D40 | idem | Buffer log/exception dibuat dan di-subscribe setiap kali provider aktif (dev, `web`, `enabled`), dimiliki provider, dilepas dan dikosongkan saat terminating/route conflict. Availability `get_logs`/`get_last_exceptions` dan `ToolContext.logs`/`exceptions` dihitung per request dari `instrumentationStatus().hooksLoaded`; tanpa hooks tool tidak disajikan (`CAPABILITY_UNSUPPORTED` dengan langkah wiring) | §4.3 `ToolContext`, API-03 |
| D41 | idem, `tests/unit/capture.spec.ts` | Config aditif `tools.logs.bufferBytes` (default 2 MiB) dan `exceptionBufferBytes` (default 1 MiB), 64 KiB–256 MiB; count dibatasi 100.000 log / 10.000 exception. Entry log maksimal 16 KiB, exception 32 KiB (dipendekkan, bukan ditolak); baris log > 64 KiB tidak di-parse dan dicatat sebagai placeholder berukuran. Cursor `afterSeq` mengembalikan entry tertua sesudah cursor dengan `hasMore`/`missed`, sehingga burst tidak terlewat diam-diam | CF-05, §4.4 |
| D42 | idem | Korelasi: `requestId` hanya dari binding `request_id` milik `ctx.logger` (root logger tidak direkayasa); `callId` dari `AsyncLocalStorage` yang membungkus wrapper + handler tool dan pembacaan resource, sehingga traffic HTTP konkuren tidak pernah diatribusikan ke call. Exception di-dedup per objek error; status diisi dari response saat `finish` | §8.1 `get_logs`/`get_last_exceptions` |
| D43 | idem | Router stack `get_middleware` diturunkan dari middleware `global` terdepan pada stack route yang ter-commit (Router tidak mengekspos `router.use()`); named middleware tak terpakai hanya dari export `middleware` modul preload, dan factory hanya dipanggil bila source-nya identik dengan factory `router.named()` milik framework | OB-11 |
| D44 | idem | Resource `adonis://routes` dan `adonis://config/{key}` dibuat di M3 dari service yang sama dengan tool; WP-32 tinggal memverifikasi konsistensi lintas resource. Redaksi data terstruktur (`project()`): key sensitif (termasuk sufiks angka), nilai env rahasia, kredensial URL; getter, `toJSON`, config provider lazy, dan instance kelas tidak dievaluasi | §8.2, SEC-18 |

### 3.4 Keputusan hasil M4

Keputusan implementasi M4, dengan bukti di §6.4. Statusnya keputusan rencana, belum persetujuan pengguna.

| ID | Bukti | Keputusan | Mengubah |
| --- | --- | --- | --- |
| D45 | `tests/unit/define_config.spec.ts` | Config aditif `tools.sql.timeout` (default dan batas atas 10.000 ms, input per call tidak boleh melebihi) dan `tools.sql.readers` (per nama connection Lucid: `{ user, password?, host?, port?, database?, ssl? }` yang mewarisi host/port/database dari connection, atau `{ connectionString }`); `maxRows` dibatasi 10.000. Dependency runtime `pgsql-ast-parser` ^12.0.1 (MIT) dimuat lazy hanya untuk PostgreSQL; `pg` dan `better-sqlite3` diambil dari aplikasi, bukan dependency package | §4.4, D33 |
| D46 | `tests/integration/database.spec.ts` | Reader PostgreSQL: koneksi `pg.Client` baru per call (`application_name` `adonisjs-mcp-reader`), cek role setiap call (superuser, hak INSERT/UPDATE/DELETE/TRUNCATE pada relasi non-sistem, BYPASSRLS untuk tenant) sebelum `BEGIN READ ONLY`; `statement_timeout` transaksi = sisa deadline + 1 detik sebagai backstop; query berjalan sebagai `DECLARE … NO SCROLL CURSOR` + `FETCH maxRows + 1` sehingga server tidak mematerialisasi lebih untuk client; semua statement `queryMode: 'extended'`. Deadline/cancel memakai control connection `pg_cancel_backend`, menunggu settlement, `ROLLBACK`, lalu koneksi selalu ditutup (sesi tidak pernah dipakai ulang, lebih kuat dari `DISCARD ALL` + reuse). `EXPLAIN` hanya lewat opsi `explain` (tanpa ANALYZE), teks `EXPLAIN` bebas tetap ditolak policy | D28, OB-28 |
| D47 | idem, `tests/unit/sql_policy.spec.ts` | SQLite: proses anak per call (`build/src/database/sqlite_reader.js`, env tanpa variabel app, IPC JSON) membuka file `readonly` + `fileMustExist` dengan `better-sqlite3` milik app. Policy native, bukan `sqlite-parser` 1.0.1: kata kunci awal SELECT/WITH/VALUES (klasifikasi), `prepare` satu statement, `stmt.readonly && stmt.reader`, lalu program `EXPLAIN` menolak opcode tulis/schema/session/virtual table dan fungsi di luar allowlist; tabel yang dibaca diturunkan dari root page `OpenRead`. Dua fase (analisis → otorisasi tenant di parent → eksekusi); deadline SIGKILL diukur dari spawn dan exit selalu ditunggu. In-memory, URI, dan driver tanpa `better-sqlite3` tidak didukung | D28, D33, OB-29 |
| D48 | `tests/integration/database.spec.ts` | Tenant (`@rikology/adonisjs-tenant`, binding `tenant.service`): `ToolContext.tenancy` (`resolve`, `run`) dibuat bila binding ada. Kunci tenant di-lookup lewat resolver default `config/tenancy.ts` — callback `lookup` tepercaya atau allowlist `tenants` (slug = kunci); kunci tak dikenal `NOT_FOUND`, resolver jwt `CAPABILITY_UNSUPPORTED`. `query_model` menjalankan `Model.query()` di dalam `TenantService.run`; model TenantScope tanpa tenant `TENANT_SCOPE_REQUIRED`, atau `withoutTenantScope()` berlabel bila `allowCrossTenant`; preload relasi tenant-scoped lintas tenant ditolak. Raw SQL dengan `tenant`: hanya PostgreSQL read-only, `app.tenant_id` diset MCP lewat statement terparameter, setiap relasi yang disebut harus tabel dengan RLS enabled + forced (view/tabel tanpa FORCE → `TENANT_SCOPE_REQUIRED`). Tanpa `tenant`: tabel model TenantScope dan tabel ber-RLS adalah data tenant → `TENANT_SCOPE_REQUIRED` kecuali `allowCrossTenant` (output `crossTenant: true`). Mode read-write dengan integrasi tenant aktif memerlukan `allowCrossTenant` dan menolak `tenant` | D11, D12 (sebagian), D29, OB-32–OB-34 |
| D49 | idem | Katalog model: scan rekursif `app.modelsPath()` (menghormati `directories.models`), import realpath lewat `app.import`, export yang mewarisi `BaseModel` milik app; id = path relatif tanpa ekstensi (`#export` untuk named export). Cache per generation (path, ukuran, mtime); modul ESM tidak pernah di-import ulang dengan suffix cache-busting, file yang berubah setelah proses mulai dilabel `changedSinceProcessStart`. `query_model`: kolom properti atau fisik divalidasi terhadap `$columnsDefinitions`, relasi preload bertingkat (maks 4) divalidasi, `limit + 1` untuk `hasMore`, preload dibatasi `maxRows + 1` per query relasi dan truncation dilabel, `serialize` (default) atau `toObject()` | D25, OB-13 (sebagian) |
| D50 | idem | `get_migrations` tidak memakai `MigrationRunner#getList()` (membuat tabel histori bila absen): file dari `sourceFiles()` Lucid dengan path/naturalSort connection, histori dibaca hanya bila tabel ada; status `migrated`/`pending`/`corrupt`. `diff_schema` membandingkan `columnName` model dengan `columnsInfo` Lucid (termasuk tabel `schema.table`), computed dipisah, tabel tanpa model dilaporkan, ringkasan migrasi disertakan | §8.1 |

### 3.5 Keputusan hasil M5

Keputusan implementasi M5, dengan bukti di §6.5. Statusnya keputusan rencana, belum persetujuan pengguna.

| ID | Bukti | Keputusan | Mengubah |
| --- | --- | --- | --- |
| D51 | `tests/integration/http.spec.ts`, `tests/unit/http.spec.ts` | Transport `http_request`: satu exchange `node:http` per hop dengan koneksi baru (`agent: false`, tanpa pool bersama) ke alamat socket server app (bind wildcard → loopback keluarga yang sama; HTTPS/pipe → `CAPABILITY_UNSUPPORTED`), `Host` eksplisit (fetch tidak mengizinkan). Input hanya path (+query): skema, `//host`, backslash, whitespace, karakter kontrol, fragment ditolak; path dinormalisasi `URL` dan dibandingkan dengan path MCP setelah decode berulang, resolusi dot-segment, slash ganda, dan lower-case. Header `X-Request-Id: mcp-<callId>-<hop>` (dipakai `request.id()` dan `ctx.logger`) mengorelasikan log/exception; header rekursi tetap dikirim. Redirect tidak diikuti kecuali `followRedirects` (maks 5, origin sama persis, divalidasi ulang per hop; 301/302 POST → GET, 303 → GET, 307/308 mempertahankan method/body). Body response dibaca sampai `limits.maxResultBytes`, lalu koneksi ditutup dan ditandai `truncated`. Deadline `tools.http.timeout` (input tidak boleh melebihi); `TIMEOUT`/`CANCELLED` menyatakan handler app tetap berjalan dan tidak ada retry | OB-23, SEC-16, CF-06 |
| D52 | idem | Impersonation memakai `authManager.createAuthenticatorClient()` (API client Japa) untuk instance guard; driver `access_tokens` dan `session` saja. Model user = `as.model` atau satu-satunya model katalog yang berbentuk untuk guard (static token provider dengan `tokenableModel` model itu, atau `findForAuth`); guard sendiri memverifikasi model saat mint. User di-lookup sebelum mint (`find`; tenant: `findForAuth([pk], id)` tenant auth finder di dalam `TenantService.run` atau model TenantScope; selain itu `CAPABILITY_UNSUPPORTED`; model user tenant-bound tanpa `tenant` → `TENANT_SCOPE_REQUIRED`). Token: `guard.createToken(user, ['*'], { expiresIn: deadline + 1 s, name })` dalam context tenant, dihapus per identifier lewat token provider model (type cocok) di `finally`. Session: hanya store `cookie`; nilai dari `authenticateAsClient` (+ `csrf-secret`), cookie id ditandatangani `CookieClient`, cookie data `e:` dengan purpose session id dan expiry tertanam di deadline; setiap cookie `e:` dari response di-rewrap dengan sisa umur, yang tak dapat didekripsi dibuang; jar dibuang di akhir call. CSRF mengikuti resep plugin Shield (`csrf` di-resolve lewat Shield): default untuk surface web dengan method tak aman, opt-in `csrf: true` untuk api, `csrf: false` untuk mengamati penolakan. Identitas yang benar-benar dipakai app dilaporkan dari event auth app yang difilter per request id | D17, D27, OB-19–OB-23 |
| D53 | idem | Surface: `surface` eksplisit → `as.guard` (via `profile.surfaces.*.guard`, lalu driver: session → web bila ada, lainnya → api) → guard di argumen `middleware.auth({ guards })` route yang cocok (`router.match` dengan method, domain, param) → prefix config → inferensi `/api`/`api.*` → route `auth` tanpa guard memakai guard default → default surface. Input eksplisit yang bertentangan dan hybrid tanpa default ditolak `INPUT_INVALID`. API mengirim `Accept: application/json` tanpa header Inertia; web Inertia mengirim `X-Inertia` + `X-Inertia-Version` dari `InertiaManager` app (lewat `HttpContextFactory` framework); web Edge `Accept: text/html` | §4.5, D14, OB-24 |
| D54 | idem | Mapping tenant HTTP dari resolver default `config/tenancy.ts`: header (nama header resolver, nilai = kunci yang sudah di-lookup; header itu tidak boleh diisi lewat `headers`), subdomain (config aditif `tools.http.tenantDomain` → `Host: <kunci>.<tenantDomain>:<port>`), path (segmen pertama wajib sama dengan kunci); jwt/kustom `CAPABILITY_UNSUPPORTED`. `domain` wajib cocok dengan domain route yang terdaftar di router; route domain tidak jatuh ke root. Mapping hanya memilih tenant, membership tetap diperiksa sebelum mint dan oleh guard app | D12, D29, OB-25 |
| D55 | idem | Hasil: header response tanpa `set-cookie`/`authorization`, perubahan jar hanya nama cookie, body `json`/`inertia`/`html` (outline regex: title, heading, form + nama field, link, teks)/`text`/`binary`, validasi dari JSON 422 `errors` atau props Inertia `errors`, log/exception per request id hop. Seluruh data diproyeksikan dengan `Redactor.withSecrets` (kredensial yang di-mint dan nilai cookie jar) plus kata kunci sensitif HTTP, sehingga echo header app pun ter-redaksi. Response non-2xx adalah hasil; kegagalan jaringan `EXECUTION_FAILED` | WP-22, SEC-17, SEC-18 |

### 3.6 Keputusan hasil M6

Keputusan implementasi M6, dengan bukti di §6.6. Statusnya keputusan rencana, belum persetujuan pengguna.

| ID | Bukti | Keputusan | Mengubah |
| --- | --- | --- | --- |
| D56 | `tests/integration/validators.spec.ts` | `get_validators`: export modul di `app.validatorsPath()` (rekursif) yang `instanceof VineValidator` milik app (di-import lewat `app.import`) adalah validator; selain itu diabaikan, gagal import per file di `failures`. Authority = AST terkompilasi `toJSON()`: path titik/`*`, `optional`/`nullable` dari `isOptional`/`allowNull`, rule berurutan dengan opsi ter-redaksi (fungsi → `{ kind: 'function', name }`). Rule built-in hanya bila teks definisi fungsinya identik dengan source entry `@vinejs/vine` yang terpasang (bukan allowlist nama; rule kustom bernama `minLength` tetap `meaning: 'unknown'`). Cabang group/union dan `otherwise` dilaporkan dengan referensi + nama callback, `executed: false`. Messages hanya dari `toJSON()` provider; lainnya `unknown`. `toJSONSchema()` tidak dikeluarkan (proyeksi salah untuk nullable-required, OB-36). Lokasi export dari AST TypeScript app | D30, OB-36 |
| D57 | `tests/integration/inertia.spec.ts`, `http.spec.ts` | `get_inertia_pages`: inventaris page = file `inertia/pages` (source) + kunci `InertiaPages` di `.adonisjs/server/pages.d.ts` (generated); selisihnya dilaporkan (stale/missing). Route → render tanpa eksekusi: handler controller lazy di-resolve lewat `imports` package.json (termasuk indireksi `#generated/controllers`) lalu method dibaca dari AST; closure dicocokkan dengan teks fungsinya di graph import preload (≤ 500 file); macro `renderInertia` dipetakan dari AST `router.on(...)` dengan prefix group dan domain. Komponen non-literal `dynamic`, props spread/computed `partial`. `get_shared_props` membaca `share`/`flash` dari subclass `BaseInertiaMiddleware` yang benar-benar terpasang di stack runtime, dengan jenis wrapper (`always`/`optional`/`defer`/`merge`); Inertia v5 tanpa `sharedData`. `get_transformers` dari source `app.transformersPath()` + alias `Data` di `data.d.ts`; transformer tidak di-import. Surface `http_request`: route yang handler-nya me-render komponen Inertia literal menjadi `web` (`route-render`) setelah guard route dan sebelum prefix/inferensi (aturan desain ke-4, tertunda sejak M5) | D13, D14, D53, OB-38 |
| D58 | `tests/integration/tuyau.spec.ts` | `get_tuyau_schema` membaca AST `registry/index.ts` (tidak di-import), teks tipe `schema.d.ts` per route (maks 4.096 karakter, `typeOnly: true`), dan hook `generateRegistry` di `adonisrc.ts`. Kesegaran dibandingkan dengan route runtime bernama di semua domain (nama, method, pattern): `missing` (artefak/hook absen) / `stale` / `fresh-routes`; opsi generator membuat perbandingan `filtered/unknown`. Kesegaran bentuk tipe tidak pernah diklaim (`typeShapesVerified: false`) | D30, OB-37 |
| D59 | `tests/integration/edge.spec.ts` | Edge: singleton default `edge.js` milik app (instance yang dipakai `HttpContext.view`, dibuktikan lewat helper global yang sama). Inventaris file = scan terbatas berbasis realpath atas `loader.mounted` (symlink keluar root dilewati dan dihitung) + `loader.templates`; keanggotaan dan nama tag component dari `loader.listComponents()` (runtime); slot dari referensi literal `$slots.x` (source), `$slots[expr]` → `partial`/`unknown`. `render_view` hanya untuk nama yang ada di inventaris saat itu, sebelum file apa pun dibaca; HTML dipotong pada `limits.maxResultBytes` di batas UTF-8; error template `EXECUTION_FAILED` ter-redaksi dengan lokasi. Annotation tidak read-only; state request (`request`, `auth`, `csrf`, `@vite` dev) tidak tersedia | D30, OB-39, SEC-23 |
| D60 | `tests/integration/authz_queue.spec.ts` | `get_permissions`: dua adapter terpisah — `@adonisplus/permissions` dari export `permissions` modul `#start/permissions` (`all`/`active`/`keys`), dan Bouncer dari export `#abilities/main` yang berbentuk ability (`allowGuest`, `original`, `execute`; tidak dipanggil) + kunci `policies` `#policies/main` dengan specifier lazy (loader tidak dipanggil). Bukan keputusan otorisasi. `get_queue_jobs`: listing mengikuti loader 0.6.0 (`glob` relatif `process.cwd()`, `resolve`, URL `file://` mentah, `options.name || class.name`) + identitas `Locator.get`; registrasi manual `not-enumerable`. Pending dari `sizeOf(queue)` publik. Status/row hanya bila `@adonisjs/queue` 0.6.2 + `@boringnode/queue` 0.6.0, adapter `instanceof KnexAdapter`, dan `config/queue.ts` statis tanpa perubahan sejak start (koneksi/tabel dibaca dari AST): SELECT terbatas (`limit` ≤ 100) lewat koneksi Lucid app, payload ter-redaksi; selain itu bagian status `CAPABILITY_UNSUPPORTED` | D32, OB-45, OB-46 |

## 4. Arsitektur dan kontrak yang dibekukan sebelum ekspansi fitur

### 4.1 Ownership modul

| Modul target | Tanggung jawab | Batas impor dan lifecycle |
| --- | --- | --- |
| `index.ts`, `src/types.ts`, `src/define_config.ts`, `src/define_tool.ts` | Public API, config resolution, typed definition | Tidak mengimpor optional runtime package secara eager |
| `providers/mcp_provider.ts` | Dev gate, register service, route, startup/shutdown | Tidak mengandung logika query/tool; tidak membuka port sendiri |
| `src/registry.ts` | Tool/resource/prompt/extension definitions | Tidak memiliki transport/session; satu registry per app |
| `src/server.ts`, `src/handler.ts` | Server factory dan Adonis–SDK bridge | Satu factory snapshot per request, shutdown handler dimiliki provider |
| `src/guards/` | Peer address, Host, Origin, recursion guard | Dieksekusi sebelum handler/tool; tidak bergantung pada auth aplikasi |
| `src/profile.ts` | Capability detection dan surface metadata | Resolusi lazy setelah boot/preloads; availability dan diagnostics eksplisit |
| `src/buffers/` | Ring buffer log dan exception | Batas count dan bytes; attach/detach idempotent; tidak mengganti logger aplikasi |
| `src/tools/{runtime,http,database,app,inertia,api,edge,auth}/` | Implementasi 28 tool | Menggunakan services/adapters bersama, bukan instance MCP langsung |
| `src/adapters/`, `src/tenant.ts` | Seam framework yang terbukti perlu | Modul konkret per integrasi; bukan generic plugin framework kedua |
| `src/http/` | Target loopback, client HTTP, cookie jar, adapter auth/session/CSRF, surface, ringkasan response untuk `http_request` (M5) | Kredensial, jar, dan listener event auth per call; tidak ada state credential di level modul |
| `src/resources/`, `src/prompts/` | Read-only projections dan prompt templates | Reuse service yang sama dengan tools; tidak menggandakan query/redaction |
| `configure.ts`, `stubs/`, `skills/adonisjs-mcp/` | Installation experience | Satu sumber skill; stub distribusi dihasilkan dari sumber itu saat build |
| `tests/`, `tests/fixtures/`, `bin/test.ts` | Contract, integration, live HTTP fixture | Semua state sementara; dilarang memakai database development pengguna |

### 4.2 Lifecycle

1. **Register:** bila dev/aktif, register `mcp.registry` dan dependency factories; tanpa I/O atau model import. Binding augmentation tersedia melalui export tipe.
2. **Boot/start:** resolve config, tambah builtin definitions saat `boot()`, muat `extraTools` dan pasang endpoint sebagai server middleware saat `start()` sebelum HTTP server boot (D34). Package lain boleh register saat `boot()`; urutan provider tidak boleh menentukan apakah builtin terhapus/terduplikasi.
3. **Ready/lazy first call:** ambil profile dari app yang sudah siap, attach listener yang memerlukan server aktif, finalisasi immutable registry snapshot. Development inspection/codegen tidak boleh memulai watcher atau worker.
4. **Per request:** guards → body/protocol validation → factory server → registry snapshot → validated handler → bounded/redacted result. Versi protokol dan status JSON-RPC dikelola SDK.
5. **Shutdown/HMR:** detach listener dan watcher, tutup handler-owned resources, batalkan operasi yang mendukung signal, kosongkan buffer/cache milik instance. Tidak menutup DB pool, logger, atau server milik aplikasi.

Registrasi setelah registry difinalisasi ditolak dengan pesan yang jelas. HMR rebuild registry secara atomik; request yang sedang berlangsung menyelesaikan snapshot lama tanpa menerima setengah definisi baru. Bila framework melakukan process restart, manfaatkan restart tersebut; jangan menambahkan cache-busting ESM import yang menumbuhkan memori tanpa batas.

### 4.3 Public API dan hasil tool

Kontrak yang harus ditetapkan pada M1–M2:

- `defineConfig`: input parsial typed → config resolved tervalidasi, merge nested values konsisten; `projectEval: false` dan `tools.disabled` tetap berlaku.
- `defineTool`: schema object Zod v4, nama snake_case yang konsisten, deskripsi menyebut running AdonisJS app, inferred input tanpa `any` pada API publik.
- `ToolContext`: `app`, resolved config/profile, log/exception services, `callId`, cancellation signal, dan tenant context per panggilan; tidak menyimpan credential HTTP pada singleton.
- `available(ctx)`: capability metadata dihitung dari package **dan** binding aktif; dependency absen berbeda dari integrasi rusak. Integrasi rusak menghasilkan diagnostic, bukan seolah package tidak terpasang.
- `registry.tool/resource/prompt`: tabrakan identitas gagal sebelum serving; `disable(name)` adalah deny-set independen urutan register.
- `registry.extend`: urutan wrapper eksplisit, sekali per call, `next` tidak boleh dipanggil berulang; exception tetap melewati normalisasi/redaction.
- Result sukses: MCP text content yang berisi JSON terstruktur untuk data; eval boleh memiliki display `util.inspect` untuk BigInt/Map/model. Sertakan metadata `durationMs`, `truncated`, serta evidence/limitations bila relevan.
- Result gagal pada eksekusi tool: `isError: true`, stable code, pesan ter-redaksi, detail aman. Error protokol/malformed input tetap milik SDK, tidak diubah seluruhnya menjadi HTTP 200.
- Annotations `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` sesuai perilaku aktual. Annotation bukan enforcement; `project_eval`, `run_ace_command`, `http_request`, dan `render_view` dapat memiliki side effect.
- Stable tool error codes minimum: `DEPENDENCY_UNAVAILABLE`, `CAPABILITY_UNSUPPORTED`, `INPUT_INVALID`, `NOT_FOUND`, `READ_ONLY_VIOLATION`, `TENANT_SCOPE_REQUIRED`, `TIMEOUT`, `CANCELLED`, `EXECUTION_FAILED`.

Resource yang tidak tersedia mengikuti resource error contract SDK. Prompt hanya menyusun instruksi/messages; `prompts/get` tidak menjalankan eval, query, atau HTTP request diam-diam.

### 4.4 Default operasional yang diusulkan

Nilai berikut perlu diwujudkan sebagai typed config, tests boundary, dan dokumentasi yang sama; bukan angka benchmark yang sudah terbukti.

| Area | Default / batas awal |
| --- | --- |
| Endpoint | `/__adonis/mcp`, aktif hanya dev, remote access `false` |
| Network allowlist | Peer `127.0.0.1`, `::1`, mapped loopback; Host localhost/loopback dengan actual listening port; Origin lokal exact-origin saja, tanpa literal `null` |
| Eval | timeout default dan maksimum default 30.000 ms; user config boleh mengubah batas; request tidak boleh melebihi config |
| SQL/model | `readOnly: true`, `maxRows: 100`, `allowCrossTenant: false`; nama connection harus ada pada config aplikasi |
| Logs/exceptions | 1.000 log / 100 exception; byte budget juga dibatasi; default tail log 100 |
| HTTP/Ace | deadline default 30.000 ms; output dibatasi; tidak ada automatic retry operasi mutating |
| Payload/output | request maksimum 1 MiB, result maksimum 256 KiB; pemotongan mempertahankan JSON valid dan menandai truncation |
| Documentation | include dua scope pada D20; maksimum 5 snippet, file/line references, cache lazy |
| Ekstensi | `extraTools: []`, `tools.disabled: []`; mutating tool dapat dimatikan melalui deny-set |

Config tambahan seperti `allowedHosts`, `allowedOrigins`, mapping surface/tenant, dan byte limits harus minimal dan terdokumentasi. Tidak ada wildcard allowlist jaringan bawaan. Ring buffer tidak boleh tumbuh karena satu entry sangat besar.

### 4.5 Profile dan evidence

`ProjectProfile` perlu memperluas bentuk desain dengan:

- `kind`, optional Inertia adapter/SSR, `surfaces`, nullable default guard, installed/active packages, generated artifacts.
- Daftar capability dengan alasan enabled/disabled/unsupported, agar agent tahu mengapa tool tidak muncul.
- Source evidence untuk inferensi surface; `unknown` jika belum dapat ditentukan.
- Surface `web` juga menyimpan renderer `inertia` atau `edge`; web tidak selalu berarti mengirim `X-Inertia`.

Precedence `http_request`: explicit `surface` → explicit `as.guard` yang valid → route metadata yang terbukti → mapping config → inferensi prefix/domain → configured default. Input eksplisit yang konflik harus ditolak, bukan dipilih diam-diam. Matching mempertimbangkan method, domain, dynamic params, dan urutan router; bukan sekadar `startsWith('/api')`.

## 5. M0 — spike dan obligation ledger

Spike harus memakai aplikasi AdonisJS nyata yang dapat dibuang. Bukti minimum: versi dependency, command/scenario, hasil teramati, API/source reference, limitation, serta keputusan pass/fail. Saat dokumen disusun, semua spike **belum dijalankan**; hasil eksekusi 13 Oktober 2026 ada di 5.1.

| ID | Pertanyaan dan eksperimen | Lulus bila | Bila gagal / dampak |
| --- | --- | --- | --- |
| S-A | Pasang SDK v2 factory/Node adapter di route Adonis dengan bodyparser dan Shield aktif; jalankan modern + legacy client | Tools/list dan call memberi satu response; notifications benar; tidak ada body dibaca dua kali, double-send, atau CSRF redirect | Pilih parsed-body bridge yang didukung SDK atau pengecualian bodyparser khusus path; jangan mematikan bodyparser/Shield global. Memblokir M2 |
| S-B | Build fixture, hilangkan dev dependencies, boot production web dan Ace | Tidak ada import package/config yang gagal, tidak ada route/buffer MCP, aplikasi normal tetap jalan | Ubah conditional provider loader dan config stub; environment `web` saja tidak diterima. Memblokir release |
| S-C | Tulis log root/child logger dan exception yang ditangani custom handler; request konkuren | Log normal tetap keluar sekali, buffer berisi event benar, exception tidak tergandakan, detach berhasil | Gunakan extension point yang terdokumentasi; jika tidak ada, catat kebutuhan upstream/opt-in instrumentation dan jangan klaim zero-config sudah tercapai |
| S-D | Inspect routes/middleware/container/events sesudah preload dan setelah HMR | Data sesuai runtime, private/unknown metadata diberi label, route commit tidak terlambat | Adapter versi-terikat dengan tests atau keluaran partial eksplisit; provenance yang tidak tersedia tetap unknown |
| S-E | Eval natural `await import('#models/user')`, resolve service, return BigInt, async delay, synchronous blocking di child fixture | Alias merujuk module instance app yang sama; console terisolasi; cooperative timeout tidak diklaim hard kill | Pakai evaluator/repl resolver framework yang nyata. Perubahan API import memerlukan keputusan eksplisit, bukan regex rewrite |
| S-F | Auth access-token/session + CSRF + validation flash melalui loopback HTTP | Identitas target benar, normal middleware tetap berlaku, session/token bersih setelah sukses/gagal/timeout | Implement adapter guard yang dibuktikan; unsupported guard ditolak, tidak fallback anonymous saat `as` diminta |
| S-G | Query PostgreSQL/SQLite dengan CTE mutating, multi-statement, PRAGMA write, EXPLAIN ANALYZE, cancellation | Mode default tidak dapat mengubah data melalui query yang diizinkan; state pool pulih setelah error/cancel | Perketat statement subset dan boundary DB; dialect tanpa enforcement ditolak. Memblokir SQL default aman |
| S-H | Dua tenant konkuren: model, raw SQL, eval, HTTP; termasuk host/domain routing | Context tidak bocor; wrong/missing tenant gagal; raw SQL tidak lolos hanya karena ada teks `tenant_id` | Raw SQL diblok pada shared-table tenant tanpa enforcement DB; mapping HTTP harus terverifikasi. Tidak menghapus tool tenant lain |
| S-I | Inspect generated Tuyau/data, Vine compiled schema, Inertia render, Edge views; ubah source via HMR | Direct/static case menghasilkan evidence akurat; dynamic case jelas unknown; reload tidak stale | Source fallback terlabel, adapter API resmi, atau dependency blocker tercatat; jangan mengeksekusi controller untuk “menemukan” props |
| S-J | Panggil Ace lewat programmatic API atau `spawn(process.execPath, argv, { shell: false })`; command generator dan command gagal | Cwd app benar, stdout/stderr terisolasi, exit code nyata, no prompt hang, app HTTP tetap hidup | Utamakan subprocess tanpa shell untuk isolasi; dokumentasikan bahwa command tidak berbagi state in-memory HTTP |
| S-K | Cari API aktual paket tenant, permission, queue yang disebut desain | Nama package/version, binding, public API, dan fixture nyata ditetapkan | Paket/API tidak tersedia adalah dependency blocker, bukan izin mengirim mock/empty list sebagai implementasi |

M0 tidak harus menjalankan semua spike secara serial. S-A/S-B wajib sebelum fondasi dikunci; spike lain dapat berjalan sebagai research lane setelah fixture dasar ada, tetapi wajib selesai sebelum work package konsumennya.

Jika solusi membutuhkan instrumentasi user, dependency parser baru, atau mengubah public behavior desain, catat alasan dan konsekuensinya. Jangan menandai requirement selesai hanya karena tool mengembalikan `unsupported` untuk seluruh kasus.

### 5.1 Hasil M0

Semua spike dijalankan pada fixture disposable dari `spikes/create-fixtures.sh` (create-adonisjs 3.4.0) dan clone per spike (`spikes/clone-fixture.sh`). Laporan berada di `docs/spikes/<ID>.md`, probe + raw evidence di `spikes/<id>/`. Integration owner menjalankan ulang S-A dan S-B dari clone baru dengan hasil identik. Review adversarial atas seluruh laporan menghasilkan 12 temuan (1 P1, 6 P2, 5 P3); semuanya ditutup melalui putaran remediation di laporan terkait (wiring production-safe S-C, rekonsiliasi S-G/S-H, guard tenant-aware S-F, hot-swap S-E, Ace di bawah HMR S-J, semantik loader S-K, raw evidence yang hilang).

| ID | Status | Bukti utama | Keputusan |
| --- | --- | --- | --- |
| S-A | LULUS BERSYARAT | Client resmi era modern dan legacy pada kit API dan React: setiap tools/list dan tools/call satu response, notification 202, GET/DELETE 405, body >1 MiB 413, Shield tetap memblokir route app; force-JSON middleware API kit memicu 406 legacy tanpa exemption | D23 |
| S-B | LULUS | Strategi desain gagal setelah `npm ci --omit=dev`; wrapper app-local + config type-only: production `/` 200, MCP 404, Ace `list`/`migration:status` exit 0; dev tetap memuat route | D21, D22 |
| S-C | LULUS BERSYARAT | 24 request konkuren: log stdout tepat sekali, buffer benar per request ID, exception sekali; detach bersih; wiring dev-guarded lolos production prune | D24 |
| S-D | LULUS BERSYARAT | Route final tersedia saat `ready`, middleware/args sesuai HTTP nyata; container `#` private tak bisa dienumerasi, inventory parsial terlabel; controller hot-swap tanpa restart | D25 |
| S-E | LULUS BERSYARAT | Callback `app.import` + flag: identitas model/controller sama dengan router termasuk setelah hot-swap; default loader gagal fresh import; timeout kooperatif terbukti tidak membatalkan mutation | D26 (flag disetujui) |
| S-F | LULUS BERSYARAT | Token 0→0 pada success/500/timeout/abort; CSRF/flash Inertia nyata; cookie ber-expiry ditolak setelah deadline; guard tenant-aware A/A 200, A/B ditolak sebelum mint | D27 |
| S-G | LULUS BERSYARAT | Putaran 1 GAGAL (`COMMIT; DELETE` menghapus row, SQLite `VACUUM INTO`/ATTACH menulis file); putaran 2 recipe reader + extended protocol + AST + SIGKILL child menutup seluruh corpus teramati | D28 |
| S-H | LULUS BERSYARAT | Model/ALS A/B terisolasi; raw SQL SQLite bocor lewat OR/UNION; FORCE RLS + recipe D28 hanya menampilkan tenant target, `set_config` ditolak AST; mapping Host/header nyata | D29 |
| S-I | LULUS BERSYARAT | Vine AST akurat, JSON Schema Vine salah untuk nullable-required; Inertia/Edge static case akurat tanpa mengeksekusi controller; HMR fresh lewat restart framework | D30 |
| S-J | LULUS BERSYARAT | Subprocess: cwd, exit code, stdout/stderr, no-hang, truncation, kill tree; di bawah HMR generator aman, hard restart memutus response dan butuh watchdog | D31 |
| S-K | LULUS BERSYARAT | Tenant, `@adonisplus/permissions` (privat), Bouncer, dan queue terpasang dan dienumerasi tanpa eksekusi policy/job; listing queue mengikuti semantik loader | D32 |

Kewajiban turunan (OB-01–OB-49) tercatat di [OBLIGATION_LEDGER.md](./OBLIGATION_LEDGER.md). Prasyarat M1 (S-A dan S-B memiliki jalur solusi terverifikasi) terpenuhi. Keputusan B-01 sudah diambil (flag `--experimental-vm-modules` wajib untuk `project_eval`); tidak ada blocker terbuka.

## 6. Milestone dan work package

Semua checkbox belum selesai. Tiap work package harus memiliki implementation, behavioral checks pada boundary yang relevan, dan bukti smoke. “Typecheck hijau” tidak menggantikan live scenario.

### M1 — Package foundation dan fixture

Prasyarat: keputusan dependency serta S-A/S-B memiliki jalur solusi yang terverifikasi.

| ID | Pekerjaan dan artefak | Acceptance criteria |
| --- | --- | --- |
| WP-01 | Manifest ESM, engines, MIT license, tsconfig, tsdown, lint/format, Japa runner, lockfile | Install reproducible pada Node minimum; dependency optional tidak wajib terpasang; compile menghasilkan JS + declarations |
| WP-02 | Export `.`, `./configure`, `./types`, `./providers/mcp_provider`; `stubs/main.ts`; package files allowlist | Consumer TypeScript dari tarball dapat resolve seluruh public exports; tidak bergantung source/test files repo |
| WP-03 | `defineConfig`, resolved config, input validation, registry types, `defineTool`, container augmentation | Config merge/false/disabled semantics benar; schema inference benar pada consumer; config invalid gagal dengan pesan actionable |
| WP-04 | Fixture app factory, port dinamis, temporary SQLite/Postgres, log capture, SDK client helper | Start/stop app nyata dapat diulang; environment development/test/production dibedakan eksplisit; tidak ada akses DB pengguna |

**Exit gate M1:** tarball awal bisa diimpor fixture; production config/provider strategy sudah diprove; belum mengklaim tools lengkap.

#### 6.1 Hasil M1 (13 Oktober 2026)

Exit gate M1 terpenuhi pada macOS arm64, Node 24.21.0, npm 11.19.0: tarball hasil `npm pack` terpasang sebagai devDependency di fixture API, `node ace configure` dua kali idempotent, development memuat provider package (config invalid menggagalkan boot dengan pesan berpath), proses `test` dan deployment production standalone hasil `npm ci --omit=dev` boot tanpa package maupun `zod` (`/` 200, endpoint MCP 404, `ace list`/`migration:status` exit 0). Belum ada route MCP, registry, atau tool; itu M2.

| WP | Artefak | Bukti |
| --- | --- | --- |
| WP-01 | `package.json` (ESM, `node >=24`, MIT, deps `@modelcontextprotocol/server` ^2.3.1, `@modelcontextprotocol/node` ^2.1.1, `zod` ^4.6.7; peer `@adonisjs/core` ^7, optional `@adonisjs/assembler` ^8), `package-lock.json`, `tsconfig*.json`, tsdown (JS + copy stubs) + `tsc` declarations, ESLint/Prettier AdonisJS, Japa (`bin/test.ts`, suite `unit`/`integration`), `LICENSE.md` | `npm run lint`, `npm run typecheck`, `npm run build` |
| WP-02 | Exports `.`, `./configure`, `./types`, `./providers/mcp_provider`; `stubs/main.ts`, `stubs/config/mcp.stub`, `stubs/providers/mcp_dev_provider.stub`; `files: ["build"]` | `npm run verify:exports`: isi tarball hanya build output + stubs; consumer `tsc` strict `skipLibCheck: false` dan import Node seluruh export |
| WP-03 | `src/types.ts` (config input/resolved, `ToolDefinition`, `ToolContext`, `ToolOutput`, `Availability`, `ToolErrorCode`, resource/prompt/registry types, augmentasi `ContainerBindings['mcp.registry']`), `src/define_config.ts`, `src/define_tool.ts` (`defineTool`, `loadExtraTools`), `src/errors.ts`, `providers/mcp_provider.ts`, `configure.ts` | `tests/unit/define_config.spec.ts`, `tests/unit/define_tool.spec.ts` (30 test); inferensi dan augmentasi diperiksa consumer `verify:exports` |
| WP-04 | `tests/fixtures/apps/api` (kit API create-adonisjs 3.4.0 + koneksi `pg` via `DB_CONNECTION` + route probe `/__fixture/environment`), `tests/helpers/` (fixture factory, log capture, owned PostgreSQL, MCP client, pack) | `tests/integration/fixture_app.spec.ts`, `tests/integration/package_install.spec.ts` (11 test) |

Keputusan implementasi M1 (keputusan rencana, belum persetujuan pengguna):

- Kontrak config dibekukan untuk key di §4.4 dan desain: `enabled`, `path`, `allowRemoteAccess`, `allowedHosts`, `allowedOrigins`, `limits.{maxRequestBytes,maxResultBytes}`, `profile.surfaces.{web,api,default}`, `tools.{disabled,projectEval,sql,logs,docs,http,ace}`, `extraTools`. Key tidak dikenal ditolak (strict) dengan path; array mengganti default; `projectEval.timeout` adalah default sekaligus batas atas. Byte budget log ditambahkan aditif di WP-10.
- `extraTools` hanya menerima loader lazy `() => import('…')` (D22); definisi eager tidak didukung karena config dimuat di production.
- `defineConfig` tetap export publik untuk konteks yang package-nya terpasang, tetapi stub memakai `satisfies McpConfig`; provider memanggil resolver yang sama di `register()` hanya saat `app.inDev`.
- `available()` mengembalikan `{ available: true }` atau `{ available: false, code, reason }` dengan code `DEPENDENCY_UNAVAILABLE`, `CAPABILITY_UNSUPPORTED`, atau `INTEGRATION_FAILED` (integrasi rusak, API-04).
- Configure M1 hanya menulis surface D21 (config, wrapper, rc entry) dan gagal jelas bila alias `#providers/*` tidak ada. Instrumentasi log, flag eval, skill, dan next steps tetap WP-33. Sejak D34 (M2) configure tidak perlu menulis exemption Shield/`Accept`.
- Fixture berada di luar repository (`$TMPDIR/adonisjs-mcp-fixtures` atau `ADONISJS_MCP_FIXTURE_ROOT`) karena ancestor `node_modules` menutupi package absen (S-B). Dependency template di-cache per hash lockfile lalu di-clone copy-on-write. Proses fixture hanya mewarisi environment allowlist (tanpa `DATABASE_URL`, `PG*`, `NODE_OPTIONS`, `npm_config_*`) dan selalu memakai `NODE_ENV` eksplisit.
- PostgreSQL test selalu cluster milik test (`initdb` + `pg_ctl` di direktori sementara, 127.0.0.1, port bebas, dihapus setelahnya); binary dicari lewat `ADONISJS_MCP_PG_BIN`, `pg_config`, lalu lokasi umum. Tanpa binary, test gagal dengan pesan, tidak pernah fallback ke server yang sudah ada.
- Kit fixture: API (M1) dan `api-bare` (M2, tanpa Lucid/auth/session/Shield/Vine/Tuyau/Edge, untuk PF-01). Kit Inertia/Edge/hybrid/tenant ditambahkan bersama WP konsumennya; kit Vite wajib mengoreksi ignore `**/tmp/**` (OB-40).

### M2 — Registry, provider, transport, security boundary

Prasyarat: M1, S-A, S-B.

| ID | Pekerjaan dan artefak | Acceptance criteria |
| --- | --- | --- |
| WP-05 | `mcp.registry`, tool/resource/prompt registration, extensions, deny-set, snapshot finalization | Collision gagal; disable bekerja sebelum/sesudah registration; dua provider dengan urutan berbeda memberi hasil sama |
| WP-06 | Provider lifecycle, dev gate, route name/path conflict handling, idempotent shutdown | Disabled/production tidak menginstrumentasi app; web route terdaftar sebelum commit; console tidak memulai MCP |
| WP-07 | SDK server factory dan Adonis handler, modern + legacy stateless, response ownership | Dua client konkuren tidak berbagi transport; HTTP/protocol errors benar; disconnect/close tidak merusak client lain |
| WP-08 | Socket/Host/Origin guards, payload limit, MCP recursion guard, route-local Shield handling | Spoofed forwarded headers tidak membuka akses; foreign/null Origin ditolak; GET/DELETE 405 dengan Allow; app CSRF tetap aktif |
| WP-09 | `detectProfile`, `get_project_profile`, `adonis://profile`, capability diagnostics | API fixture tanpa Lucid/Edge/auth tetap boot; profile tidak membuat klaim optional integration palsu |

**Exit gate M2:** client nyata connect/discover, list tools, call `get_project_profile`, read profile resource; malformed/hostile requests ditolak. Gunakan tool nyata ini sebagai vertical slice; `ping` dummy tidak menjadi deliverable permanen.

#### 6.2 Hasil M2 (13 Oktober 2026)

Exit gate M2 terpenuhi pada macOS arm64, Node 24.21.0, npm 11.19.0, tuple §2.3: tarball terpasang di kit API (force-JSON middleware, bodyparser, Shield dengan CSRF **diaktifkan**) dan di kit `api-bare` baru (tanpa Lucid/auth/session/Shield/Vine/Tuyau/Edge). Client resmi era modern (`2026-07-28`) dan legacy (`2025-11-25`) melakukan discovery/initialize, `tools/list`, `tools/call get_project_profile`, `resources/read adonis://profile`, resource template, dan `prompts/get`; request hostile/malformed ditolak sebelum SDK atau oleh SDK sesuai kepemilikannya. Arsitektur endpoint berubah dari route ke server middleware (D34–D37).

| WP | Artefak | Bukti |
| --- | --- | --- |
| WP-05 | `src/registry.ts` (`DefinitionRegistry`, `RegistrySnapshot`, validasi resource/prompt), `src/errors.ts` (`RegistryClosedError`), `src/invocation.ts` (wrapper `extend` sekali per call, normalisasi error), `src/result.ts` (JSON-safe + truncation), `src/redaction.ts` (baseline env-secret/URL credential/bearer/`oat_`) | `tests/unit/registry.spec.ts`, `tests/unit/invocation.spec.ts`; integrasi: dua provider ekstensi dengan urutan dibalik memberi `tools/list` identik, tool `disable()` sebelum registrasi dan `tools.disabled` sesudahnya tidak disajikan, nama duplikat menggagalkan boot, wrapper tercatat tepat sekali per `callId` |
| WP-06 | `providers/mcp_provider.ts` (register: validasi + binding hanya pada proses `web` development dengan `enabled`; boot: builtin; start: `extraTools` + mount; ready: finalisasi, conflict check, hook terminating) | Integrasi: `enabled: false`, proses `NODE_ENV=test`, dan perintah console (`list:routes` dengan entry rc diperluas ke `console`) tidak membind `mcp.registry` dan endpoint 404; route app `GET /__adonis/mcp` tetap dilayani app sementara endpoint mencatat error; custom path melayani hanya di path itu; SIGTERM dengan call modern + legacy in-flight 30 detik selesai < 10 detik dengan exit 0 |
| WP-07 | `src/server.ts` (`McpServer` per request, availability per request, profile lazy, resource template, prompt), `src/handler.ts` (`createMcpHandler` + `toNodeHandler` bersama, middleware, close) | Integrasi: 4 client konkuren (2 per era) menerima nilainya sendiri dengan `callId` berbeda; client modern yang memutus koneksi membatalkan signal tool-nya sendiri (`FIXTURE_ECHO_ABORTED`) dan client kedua era tetap dilayani; JSON rusak 400 `-32700` tanpa echo body, body > 1 MiB 413, `text/plain` 415; dari SDK: header modern tanpa envelope 400 `-32602`, revisi tidak didukung 400 `-32022`, mismatch versi atau method header/body 400 `-32020` |
| WP-08 | `src/guards/network.ts` (peer socket, Host tunggal + port aktual, Origin exact, header rekursi `x-adonisjs-mcp-call`), 405 + `Allow: POST` | `tests/unit/network_guards.spec.ts`; integrasi: request kontrol 200 dengan body yang sama, sedangkan Host asing/rebinding/port lain/userinfo/duplikat/absen, Origin `null`/asing/port lain, override Host via `X-Forwarded-Host`/`Forwarded`, dan header rekursi 403; GET/DELETE/PUT/OPTIONS 405 `Allow: POST`; app bind `0.0.0.0` diakses lewat IP LAN dengan `X-Forwarded-For: 127.0.0.1` tetap 403 sementara `/` app 200; POST route app tanpa token CSRF tetap ditolak Shield |
| WP-09 | `src/profile.ts` (`detectProfile`), `src/tools/app/get_project_profile.ts`, `src/resources/profile.ts`, tipe `ProjectProfile`/`PackageReport`/`CapabilityReport`, `AvailabilityContext.profile()` | Integrasi kit API: Lucid/auth/session/Shield/Vine aktif dengan versi dan deklarasi, Tuyau terpasang `active: null`, auth `guards: ['api','web']` default `api`, surface api prefix `/api`, generated controllers/registry ada, capability `served`/`disabled`/`unavailable` (`DEPENDENCY_UNAVAILABLE` vs `INTEGRATION_FAILED`); tool dan resource memberi data identik. Kit `api-bare`: semua paket opsional `version: null`, `active: false`, tanpa `error`, auth/inertia/web `null`, tanpa limitation |

Jumlah test setelah M2: 55 unit, 27 integration (termasuk 11 dari M1); `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:integration`, dan `npm run verify:exports` (consumer strict memakai `ResourceDefinition` + `ProjectProfile`, runtime check gating environment provider) lulus.

Batas yang tetap terbuka setelah M2:

- Aturan profile Inertia/Edge/hybrid (renderer, adapter, SSR, hybrid tanpa default) sudah diimplementasikan tetapi belum diuji dengan fixture kit yang sesuai (WP-21, M6). Redaction M2 adalah baseline untuk pesan error; kebijakan config/log/HTTP milik M3/M5.
- Rebuild registry atomik saat HMR tidak diimplementasikan: provider tidak dijalankan ulang oleh hot-hook, perubahan provider/`extraTools` memerlukan restart proses (LC-04, WP-37).

### M3 — Runtime observability dan metadata dasar

Prasyarat: M2, S-C, S-D.

| ID | Pekerjaan dan artefak | Acceptance criteria |
| --- | --- | --- |
| WP-10 | Log/exception bounded buffers, redaction, request/call correlation, attach/detach | Root dan child logs tertangkap sekali; error request dapat ditemukan; concurrent traffic tidak salah diklaim berasal dari satu call |
| WP-11 | `get_routes`, `get_middleware`, route surface evidence | Method/domain/group/named middleware dan order benar pada fixture; dynamic/anonymous handler tidak ditebak |
| WP-12 | `get_container_bindings`, `get_events` | Daftar mengikuti runtime tanpa instantiate semua services atau menjalankan listener; origin unknown diberi label |
| WP-13 | `get_config`, `get_env` | Resolved values ter-redaksi recursive; env hanya key/presence, tidak nilainya; tidak men-dump seluruh `process.env` |

**Exit gate M3:** request fixture sukses dan gagal muncul sebagai route/log/exception yang benar; sentinel secret tidak keluar dari tools maupun resource projection.

#### 6.3 Hasil M3 (13 Oktober 2026)

Exit gate M3 terpenuhi pada macOS arm64, Node 24.21.0, npm 11.19.0, tuple §2.3. Kit API diinstrumentasi lewat gateway dev (D38) dan diberi route probe, binding container, listener event, named middleware tak terpakai, serta sentinel secret (`FIXTURE_SENTINEL_SECRET` di `.env`, literal `password`/kredensial URL di `config/sentinel.ts`). Dua belas request sukses, empat request gagal, satu route tak dikenal, dan satu tool call yang menulis log berjalan konkuren; client resmi kemudian membaca route, log, dan exception yang tepat. Sentinel tidak muncul di output kesembilan tool maupun di resource `adonis://profile`, `adonis://routes`, `adonis://config/sentinel`, dan `adonis://config/app` pada kedua era protokol, sementara aplikasi sendiri tetap mencetaknya di stdout. Temuan review adversarial (cursor `afterSeq` melompati burst, capture bergantung pada urutan load hooks, key bersufiks angka tidak ter-mask, field `__proto__`, alokasi ring berdasarkan count, biaya parse 1 MiB, grep atas teks JSON-escaped, `./hooks` tidak diperiksa `verify:exports`) sudah diperbaiki dan diuji.

| WP | Artefak | Bukti |
| --- | --- | --- |
| WP-10 | `hooks.ts` (export `./hooks`), `src/buffers/{gateway,ring_buffer,log_capture,exception_capture}.ts`, `src/call_scope.ts`, `src/tools/runtime/{get_logs,get_last_exceptions,capture_source}.ts`, config `tools.logs.bufferBytes`/`exceptionBufferBytes`, `ToolContext.logs`/`exceptions` | `tests/unit/{ring_buffer,capture}.spec.ts`; integrasi: setiap record root/ctx/child tepat sekali di buffer dan sekali di stdout; `get_logs({ requestId })` hanya record ctx/child request itu; `get_logs({ callId })` hanya record yang ditulis di dalam call, traffic HTTP `callId: null`; empat exception dengan status 500 dari response, route `/__fixture/fail/:id`, request id, pesan ter-redaksi, `occurrences` 4; route tak dikenal 404 `E_ROUTE_NOT_FOUND` tanpa route |
| WP-11 | `src/introspection/{routes,references}.ts`, `src/tools/app/{get_routes,get_middleware}.ts`, resource `adonis://routes` | Integrasi: route API dengan nama `profile.profile.show`, handler `#controllers/profile_controller#show`, stack bodyparser → session → Shield → initialize_auth → silent_auth → named `auth`, surface api `inferred`; route `/` closure `name: null`, surface `default`; server stack diawali middleware MCP lalu force_json → container_bindings → CORS; router stack diturunkan; named `auth` dipakai 2 route dan `fixtureUnused` 0 route dari export preload; resource identik dengan tool tanpa filter |
| WP-12 | `src/introspection/{container,container_observer,events,typescript}.ts`, `src/tools/app/{get_container_bindings,get_events}.ts` | Integrasi: `coverage: 'partial'`; singleton/bind/alias/bindValue dengan origin `FixtureBindingsProvider`/`DatabaseServiceProvider`/`McpProvider` dari trace `providerRegister`, binding yang dibuat di `boot()` origin `null`, key deklarasi tanpa binding di `declaredUnavailable`, counter konstruksi factory tetap 0; tanpa observasi (kit `api-bare`, `endpoint.spec`) kind/origin `null` dengan evidence `source-declared`+`runtime-verified`. Event: listener inline bernama dan lazy `#listeners/fixture_listener#handle`, event `once()` tidak terdaftar, listener tidak pernah berjalan |
| WP-13 | `src/introspection/{config,env}.ts`, `src/tools/app/{get_config,get_env}.ts`, resource `adonis://config/{key}`, `project()`/`isSensitiveKey()` di `src/redaction.ts` | `tests/unit/{redaction,introspection}.spec.ts`; integrasi: `database.connection` = `sqlite`, subtree sentinel ter-redaksi (key sensitif, nilai env rahasia di key netral, password URL), `__proto__` → `INPUT_INVALID`, key tak ada → `NOT_FOUND` (resource: error protokol); `get_env` membaca schema `start/env.ts`: tipe, optional, secret, presence, tanpa nilai |

PF-08 tetap terjaga: dengan `enabled: false` hooks termuat tetapi subscriber 0/0 dan observer container nonaktif; proses `NODE_ENV=test` tanpa subscriber; deployment production pruned dari app yang diinstrumentasi boot, route sukses/gagal ditangani handler app, log app tercetak sekali, hooks tidak dapat di-resolve, endpoint 404. Jumlah test setelah M3: 77 unit, 35 integration; `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:integration`, dan `npm run verify:exports` (consumer strict meng-import `./hooks` dan `ToolContext.logs`) lulus.

Batas yang tetap terbuka setelah M3:

- Configure belum menulis gateway, wiring logger, dan observer handler (WP-33); fixture memasangnya lewat helper test `instrumentCapture` dengan bentuk yang sama.
- Capture hanya mencakup logger yang memakai `hooks.streamWrite`; named logger lain, transport worker, exception di luar HTTP, dan `report()` yang throw sebelum `handle()` tidak tercakup dan dilabel di output tool. Korelasi `http_request` ↔ log (E02) menunggu M5.
- Inventory container tetap parsial: registrasi sebelum gateway berjalan dan key tanpa deklarasi yang tidak teramati tidak dapat ditemukan; deklarasi butuh `typescript` di app. Event `once()`/`onAny()` hanya terlihat dari jumlah listener transport.
- Metadata dibaca segar setiap request (tanpa cache); regression HMR/restart (OB-13, OB-15) tetap WP-37.

### M4 — Lucid, SQL, schema, dan tenant foundation

Prasyarat: M2; S-G, S-H, S-K untuk boundary terkait. Redaction/correlation dari M3 dipakai sebelum gate final M4.

| ID | Pekerjaan dan artefak | Acceptance criteria |
| --- | --- | --- |
| WP-14 | Model discovery recursive, import/boot model, metadata kolom/relasi, cache generation | Custom model path dan inherited model bekerja; file non-model diabaikan; failure import dilaporkan per file, bukan empty success |
| WP-15 | `query_model`: safe structured predicates, preload allowlist, ordering, limit, serialization | Scope/soft-delete/serializeAs dipertahankan; unknown model/column/relation gagal; relation fan-out dan result bytes dibatasi |
| WP-16 | `execute_sql_query`: connection/dialect adapter, bindings, DB-enforced read mode, output bounds | Malicious statement corpus tidak menulis pada default mode; read-write opt-in jelas; cancellation tidak merusak pool |
| WP-17 | `get_migrations`, `diff_schema`: migration metadata dan dialect introspection | Tidak menjalankan migration; physical columns, custom table/schema/connection benar; computed property tidak dianggap missing column |
| WP-18 | Tenant adapter shared: resolution/context, raw SQL policy, two-tenant concurrency | Model query dan eval context terisolasi; raw SQL yang tidak bisa dibuktikan scoped ditolak; cross-tenant override eksplisit terlabel |

**Exit gate M4:** agen bisa membedakan “data yang dilihat model” dan “data fisik DB”, tanpa melewati tenant boundary secara diam-diam. Jalankan SQLite dan PostgreSQL nyata; laporan unsupported dialect bukan hasil kosong.

#### 6.4 Hasil M4 (13 Oktober 2026)

Exit gate M4 terpenuhi pada macOS arm64, Node 24.21.0, npm 11.19.0, tuple §2.3, PostgreSQL 18.4 (cluster milik test) dan `@rikology/adonisjs-tenant` 1.0.2. Pada kit API (SQLite) dengan model blog di subdirektori — soft-delete lewat hook `before find/fetch`, kolom `serializeAs: null`, computed, relasi, model turunan bertabel kustom — client resmi membandingkan `query_model` (dua post yang terlihat app, tanpa kolom rahasia, dengan `excerpt`) dengan `execute_sql_query` (tiga baris fisik termasuk yang ter-soft-delete dan kolom rahasia), dan `diff_schema` menemukan kolom dari migration pending tanpa ada migration yang berjalan. Pada kit API + PostgreSQL + tenant, enam call `query_model` A/B konkuren dari dua era hanya melihat tenant masing-masing, raw SQL tenant dengan OR/komentar/UNION hanya mengembalikan baris tenant karena FORCE RLS, dan setiap jalur tenant yang tidak bisa dibuktikan (tabel tanpa RLS, tabel TenantScope tanpa RLS, SQLite, tanpa tenant) gagal eksplisit. Dialect/connection yang tidak didukung (PostgreSQL tanpa reader, role superuser/punya hak tulis/BYPASSRLS) memberi `CAPABILITY_UNSUPPORTED` dengan remediasi, bukan hasil kosong.

| WP | Artefak | Bukti |
| --- | --- | --- |
| WP-14 | `src/database/{lucid,models}.ts`, `src/tools/database/get_models.ts`, resource `adonis://models` | Integrasi: model `user`, `blog/post`, `blog/comment`, `blog/featured_post` (extends `blog/post`, tabel `posts`); kolom properti/fisik/`serializeAs`, computed, relasi dengan key ter-resolve dan `relatedModelId`; `app/models/helpers.ts` di `skipped`, `app/models/broken.ts` di `failures` dengan pesan error; direktori kustom `app/tenancy_models` lewat `directories.models`; `tenantScoped` untuk TenantScope; file yang di-touch setelah start dilabel; resource identik dengan tool |
| WP-15 | `src/tools/database/query_model.ts` | Integrasi: hook soft-delete dan hook model turunan berlaku, `secretNote` tersembunyi pada `serialize` dan terlihat pada `serialize: false`, `where`/`filters`/`orderBy`/`limit`/`hasMore`, preload `comments` + `author` dengan truncation `comments` (8 komentar, `maxRows` 5), password user tidak ter-serialize; model/kolom/relasi tak dikenal dan `limit` > `maxRows` `INPUT_INVALID`, `tenant` tanpa integrasi `CAPABILITY_UNSUPPORTED` |
| WP-16 | `src/database/{postgres_policy,postgres_parser,postgres_reader,sqlite_policy,sqlite_reader,sqlite_executor,raw_sql}.ts`, `src/tools/database/execute_sql_query.ts`, entry tsdown `build/src/database/sqlite_reader.js` | `tests/unit/sql_policy.spec.ts` (corpus izin/tolak PostgreSQL, opcode/fungsi SQLite); integrasi SQLite: 14 statement tulis/side effect (DELETE terselubung, multi-statement, CTE+DELETE, PRAGMA tulis/`query_only=OFF`, ATTACH, VACUUM INTO, `load_extension`, `pragma_table_info`, DROP) ditolak, jumlah row tetap dan file ATTACH/VACUUM tidak tercipta; query rekursif tak terbatas mengembalikan 5 baris + `hasMore`; query miliaran langkah `TIMEOUT` < 5 detik lewat SIGKILL sementara `/` app 200. PostgreSQL: `COMMIT; DELETE`, DELETE, CTE mutating, `pg_advisory_lock`, `nextval`, `pg_sleep`, `FOR UPDATE`, COPY PROGRAM ditolak; jumlah row dan advisory lock tetap 0; `generate_series` 200 juta baris kembali 5 baris; deadline 300 ms `TIMEOUT` lewat `pg_cancel_backend` dengan app tetap 200, pool app melayani `query_model`, dan tidak ada koneksi `adonisjs-mcp%` tersisa; `explain`. Read-write: annotations `destructiveHint: true`, deskripsi mutating, UPDATE `affectedRows: 1` |
| WP-17 | `src/database/schema.ts`, `src/tools/database/{get_migrations,diff_schema}.ts` | Integrasi SQLite: 3 migrated + 1 pending dengan file/batch; connection `fresh` tanpa tabel histori tetap `tableExists: false` setelah dua call; `diff_schema` `published_at` missing, `legacy_flag` undeclared, `excerpt` computed, `user` in-sync, tabel tanpa model. PostgreSQL: semua migrated, model in-sync; model `audit.entries` pada connection `pg_noreader` hanya muncul di diff connection itu |
| WP-18 | `src/tenant.ts`, `ToolContext.tenancy`, kebijakan tenant di `query_model` dan `raw_sql.ts` | Integrasi PostgreSQL: lookup allowlist header, `zzz` `NOT_FOUND`, isolasi A/B konkuren, RLS corpus, `set_config` override ditolak sebelum DB, join ke tabel tanpa RLS ditolak dengan nama tabel, `allowCrossTenant: true` memberi `crossTenant: true` + limitation (model 3 baris lintas tenant; tabel RLS tanpa tenant 0 baris) |

Jumlah test setelah M4: 130 unit, 50 integration; `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:integration`, dan `npm run verify:exports` (consumer strict memakai `ToolContext.tenancy`, `TenantIdentity`, `tools.sql.readers`) lulus. Kit `api-bare` membuktikan kelima tool database dan `adonis://models` tidak disajikan dengan `DEPENDENCY_UNAVAILABLE`.

Batas yang tetap terbuka setelah M4:

- Isolasi tenant pada eval (OB-35) menunggu `project_eval` (WP-28); mapping tenant HTTP menunggu WP-21.
- Matriks kompatibilitas hanya SQLite file (`better-sqlite3`) dan PostgreSQL dengan reader; MySQL/MSSQL/Oracle, SQLite in-memory/URI, dan strategi schema/database-per-tenant ditolak eksplisit. Query model dan introspeksi schema berjalan lewat Lucid untuk dialect lain tetapi belum diuji.
- View, operator, dan fungsi yang didefinisikan di database aplikasi adalah kode tepercaya; notasi atribut PostgreSQL (`t.fungsi`) dan cast ke tipe buatan pengguna tidak terlihat oleh policy AST (D46, perluasan adversarial WP-36). Hook dan serializer model tetap kode app (SEC-15, dokumentasi WP-35).
- Mode read-write berjalan di pool aplikasi tanpa batas materialisasi dan tanpa deadline pada SQLite (dilabel di output).
- Model yang berubah tanpa restart tetap versi lama di proses (dilabel); regression HMR/restart tetap WP-37.

### M5 — HTTP nyata, impersonation, dan surface routing

Prasyarat: M3–M4, S-F, S-H.

| ID | Pekerjaan dan artefak | Acceptance criteria |
| --- | --- | --- |
| WP-19 | `http_request` loopback, method/path/body/headers, actual server address, manual redirects, bounded streaming response | Tidak menerima arbitrary destination; tidak bisa memanggil MCP path lewat encoding/redirect; ordinary app middleware benar-benar dijalankan |
| WP-20 | Session/token guard adapters, credential lifetime, CSRF, flash, cleanup | `as` memakai user/guard yang diminta; protected request dan validation failure benar; tidak ada token/session residual |
| WP-21 | Surface matching API/Inertia/Edge/hybrid, Inertia version, domain/tenant request mapping | Route sama pada domain/method berbeda mendapat mode benar; explicit override tervalidasi; API tidak menerima header Inertia tanpa alasan |
| WP-22 | HTTP result: status, safe headers, body summary, request-linked logs/exceptions | Non-2xx app response tetap hasil HTTP yang dapat dianalisis; network failure menjadi tool error; auth/cookie header tidak bocor |

**Exit gate M5:** reproduce request tenant A sebagai user A melalui HTTP, cocokkan hasil dengan request langsung pada fixture, lalu buktikan tidak ada state auth/tenant yang tertinggal pada request berikutnya.

#### 6.5 Hasil M5 (13 Oktober 2026)

Exit gate M5 terpenuhi pada macOS arm64, Node 24.21.0, npm 11.19.0, tuple §2.3 dan `@rikology/adonisjs-tenant` 1.0.2. Pada kit API dengan guard token dan session tenant-aware (membership pivot, resolver header, middleware tenant sebelum auth), request langsung — login tenant A sebagai user A, lalu `GET /tenant/notes` dengan bearer token — dan `http_request({ path: '/tenant/notes', as: { userId: 1 }, tenant: 'a' })` memberi status dan body identik (`{ user: 1, tenant: 'a', notes: ['A-private'] }`); event auth app mencatat guard `api` berhasil untuk user 1 pada request id milik call; jumlah token kembali ke nilai sebelum call; request berikutnya tanpa kredensial memberi `{ api: false, web: false, tenant: null }`, dan `http_request` tenant A tanpa `as` mendapat 401. Arsitektur dan keputusan: D51–D55.

| WP | Artefak | Bukti |
| --- | --- | --- |
| WP-19 | `src/http/{target,client}.ts`, `src/tools/http/http_request.ts` | `tests/unit/http.spec.ts` (alias path MCP, redirect lintas origin, header milik tool, bind wildcard). Integrasi kit hybrid: 14 bentuk destination/path/header terlarang `INPUT_INVALID` sebelum request; redirect app ke `/__adonis/mcp`, `/__adonis/%6Dcp`, dan `http://evil.test` tidak diikuti dengan satu request id; redirect same-origin diikuti hanya dengan `followRedirects`; body 4 MiB dipotong pada 256 KiB dan app tetap melayani; middleware app (bodyparser, session, Shield, auth, Inertia) berjalan nyata |
| WP-20 | `src/http/{auth,session,cookie_jar}.ts` | Token `api`: sukses, 500, `TIMEOUT` (300 ms pada handler 3 detik), dan pembatalan client menyisakan 0 token; user 99 `NOT_FOUND`, guard tak dikenal dan model tak dikenal `INPUT_INVALID`, anonymous 401. Session `web` (cookie store): POST dengan CSRF minted + validasi gagal → 302 → halaman Inertia dengan `errors.title`; POST valid → flash `success`; `csrf: false` → 302 + `E_BAD_CSRF_TOKEN`; anonymous → `/login`; request berikutnya tanpa `as` tidak membawa identitas. Echo header app tidak memuat bentuk kredensial yang di-mint (bearer, cookie `e:`/`s:`). Tenant: user A + tenant B dan user tanpa membership `NOT_FOUND`, tanpa `tenant` `TENANT_SCOPE_REQUIRED`, token tenant-bound terhapus setelah 500 dan deadline |
| WP-21 | `src/http/surface.ts`, `tenantRequestMapping()` di `src/tenant.ts`, config `tools.http.tenantDomain` | Profile kit hybrid `kind: 'hybrid'`, web renderer `inertia`, api prefix `/api`, tanpa default. `/` tanpa `surface` ditolak; `/status` root → page Inertia `home` status 200 dengan versi dari `InertiaManager` app (bukan 409), `/status` dengan `domain: 'API.fixture.test'` → JSON domain `api.*`; `GET /__fixture/reports` → web (guard route `web`), `POST` path sama → api (guard `api`) tanpa CSRF; `surface: 'api'` + `as.guard: 'web'` `INPUT_INVALID`; echo API tanpa header Inertia, echo web dengan `X-Inertia-Version` yang sama. Delapan call A/B konkuren (dua era, token dan session) masing-masing hanya melihat data tenantnya |
| WP-22 | `src/http/summary.ts`, `Redactor.withSecrets` | Header response tanpa `set-cookie`, body `inertia`/`json`/`html`/`text`, validasi dari props Inertia, outline HTML (title ber-entity, heading, form + nama field termasuk `_csrf` tanpa nilai, link, tanpa script). E02: request `/__fixture/fail/mine` di tengah enam request gagal lain mengembalikan 500, satu exception `Fixture failure mine`, dan hanya log request id call itu. Kit `api-bare`: `http_request` disajikan, GET `/` 200, `as` `DEPENDENCY_UNAVAILABLE` |

Jumlah test setelah M5: 145 unit, 61 integration; `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:integration`, dan `npm run verify:exports` (consumer strict memakai `tools.http.tenantDomain`) lulus. Kit fixture baru `tests/fixtures/apps/hybrid` (Inertia React create-adonisjs 3.4.0 + guard token, route API/domain/Edge fixture; ignore Vite `**/tmp/**` sudah ada di kit). Harness: helper `waitForMcp` menunggu log `MCP endpoint ready` sebelum client terhubung (endpoint menjawab 503 antara listen HTTP dan `ready()` provider; teramati sebagai flake saat mesin sibuk), dan assertion log production M3 menunggu barisnya alih-alih mengambil sampel sekali.

Batas yang tetap terbuka setelah M5:

- Impersonation hanya driver `access_tokens` dan `session` dengan store `cookie`; store stateful (memory/file/redis/database), basic auth, dan guard kustom `CAPABILITY_UNSUPPORTED` (OB-22). Salinan cookie yang di-mint tetap berlaku sampai deadline call; bukan revocation instan (OB-21, dokumentasi WP-35).
- Model user diturunkan dari bentuk model (static token provider atau `findForAuth`) dan diverifikasi guard saat mint; provider user non-Lucid tidak didukung. Membership tenant hanya untuk tenant auth finder dan model TenantScope.
- Fixture Edge-only (hypermedia) belum ada: header `Accept: text/html` untuk renderer Edge diuji unit, outline HTML diuji pada halaman Edge di kit hybrid (PF-05, M6). Resolver tenant subdomain/path diimplementasikan tetapi gate integrasi hanya resolver header.
- Surface dari `inertia.render` di handler (aturan desain ke-4) menunggu `get_inertia_pages` (WP-24); route `auth` tanpa argumen guard memakai guard default sebagai inferensi berlabel.
- Handler app tetap berjalan setelah `TIMEOUT`/`CANCELLED`; log yang ditulis app sesudah response selesai tidak ikut hasil call.

### M6 — Introspeksi framework dan optional integrations

Prasyarat: M3, S-I, S-K; metadata services dari M4–M5 digunakan saat diperlukan.

| ID | Pekerjaan dan artefak | Acceptance criteria |
| --- | --- | --- |
| WP-23 | `get_validators`: discover exported Vine validators, representasi field/rule/message | Direct supported schema benar; conditional/custom rules diberi reference/unknown, tidak dipanggil untuk menebak kontrak |
| WP-24 | `get_inertia_pages`, `get_shared_props`, `get_transformers` | Route/page direct mapping dan generated Data shape benar; lazy shared props tidak dieksekusi sembarang; context-dependent output terlabel |
| WP-25 | `get_tuyau_schema` | Membaca artifact registry/types app yang ada; membedakan stale/missing artifact; tidak mengklaim TypeScript shape selalu ada pada runtime JS |
| WP-26 | `get_views`, `render_view` | Template/component/slot discovery akurat untuk supported case; render JSON state menggunakan Edge nyata tanpa mengambil arbitrary file di luar view roots |
| WP-27 | `get_permissions`, `get_queue_jobs` | Adapter permission/queue yang dipilih S-K membaca registration/state nyata; list tanpa dispatch job atau mengeksekusi policy pengguna |

**Exit gate M6:** empat profile fixture menampilkan tool set yang tepat; setiap optional adapter punya positive integration test, bukan hanya test “package absen”. React/Vue dan adapter lain pada type desain diuji sesuai klaim; bila adapter belum teruji, nyatakan batas kompatibilitas secara eksplisit sebelum release.

#### 6.6 Hasil M6 (13 Oktober 2026)

Exit gate M6 terpenuhi pada macOS arm64, Node 24.21.0, npm 11.19.0, tuple §2.3. Kit fixture baru: `edge` (hypermedia create-adonisjs 3.4.0) dan `vue` (Inertia Vue create-adonisjs 3.4.0), keduanya pristine selain nama package. Dengan tarball dan config kosong, lima kit menyajikan tool framework yang tepat dan alasan untuk sisanya (`profiles.spec`, `endpoint.spec`):

| Tool | `api-bare` | `api` | `hybrid` (React) | `edge` | `vue` |
| --- | --- | --- | --- | --- | --- |
| `get_validators` | DEPENDENCY_UNAVAILABLE | served | served | served | served |
| `get_inertia_pages`, `get_shared_props` | DEPENDENCY_UNAVAILABLE | DEPENDENCY_UNAVAILABLE | served | DEPENDENCY_UNAVAILABLE | served |
| `get_transformers` | served | served | served | served | served |
| `get_tuyau_schema` | DEPENDENCY_UNAVAILABLE | served | served | DEPENDENCY_UNAVAILABLE | served |
| `get_views`, `render_view` | DEPENDENCY_UNAVAILABLE | DEPENDENCY_UNAVAILABLE | served | served | served |
| `get_permissions`, `get_queue_jobs` | DEPENDENCY_UNAVAILABLE | DEPENDENCY_UNAVAILABLE | DEPENDENCY_UNAVAILABLE | DEPENDENCY_UNAVAILABLE | DEPENDENCY_UNAVAILABLE |

Profile: `api` → `kind: 'api'`; `hybrid` → `hybrid`, renderer `inertia`, adapter `react`; `edge` → `edge`, renderer `edge`, `inertia: null`; `vue` → `inertia`, adapter `vue`. Setiap adapter opsional punya positive test pada fixture nyata (permission dan queue dipasang saat setup).

| WP | Artefak | Bukti |
| --- | --- | --- |
| WP-23 | `src/introspection/validators.ts`, `src/tools/app/get_validators.ts` | Kit API dengan validator fixture: export bawaan kit, object bersarang + array object dengan `nullable()` dilaporkan `nullable: true, optional: false` (regresi OB-36), opsi rule, bentuk `vine.create`/`vine.compile`, group if/else, union kondisional, rule kustom bernama sama dengan rule bawaan → `unknown`, `SimpleMessagesProvider` terserialisasi, provider dinamis `unknown`, rule `unique` (callback database); counter callback tetap 0. File yang throw saat import di `failures`, file tanpa validator diabaikan, file yang diubah setelah start dilabel. Dua era protokol |
| WP-24 | `src/introspection/inertia.ts`, `src/tools/app/get_inertia.ts`, perubahan `src/http/surface.ts` dan `http_request` | Kit `hybrid` (React) dan `vue`: render controller statis (komponen + props literal), komponen dinamis + props spread (`partial`), closure literal, `renderInertia` di group ber-prefix, page baru di luar `pages.d.ts` (stale), artefak generated/direktori absen dibedakan dari kosong; shared props kit (`errors`, `user`, `preferences` dengan `always`; flash `success`, `error`); transformer kit + transformer baru yang belum ada di `data.d.ts`; counter membuktikan controller/share/flash tidak berjalan. Vue: page `.vue`, tanpa asumsi React. `http_request` `/` tanpa `surface` → `web` (`route-render`); route tanpa bukti render/guard (`/__fixture/whoami`) tetap ditolak `INPUT_INVALID` |
| WP-25 | `src/introspection/tuyau.ts`, `src/tools/app/get_tuyau_schema.ts` | Kit API: runner langsung (tanpa hook init) setelah route bernama ditambahkan → `stale` dengan route di `missingFromRegistry`, teks tipe generated untuk route ber-validator; runner `node ace serve --hmr` meregenerasi registry → route baru ada dan `fresh-routes`; artefak dihapus → `missing` (bukan registry kosong); opsi generator statis/dinamis; kit `edge` tanpa Tuyau `DEPENDENCY_UNAVAILABLE` |
| WP-26 | `src/introspection/views.ts`, `src/tools/edge/{get_views,render_view}.ts` | Kit `edge`: component dengan slot bernama, slot dinamis, view bersarang, disk kedua, template in-memory, symlink ke luar root dilewati dan dihitung; render dengan state ter-escape (`<b>` → `&lt;b&gt;`), nama traversal ditolak tanpa membaca file sentinel, output besar dipotong, template yang throw `EXECUTION_FAILED`, helper global ber-counter membuktikan render menjalankan kode app (batas side effect yang didokumentasikan). PF-05: profile `edge`, `http_request` mengirim `Accept: text/html,application/xhtml+xml` tanpa `X-Inertia`, outline HTML, `as: { userId }` guard session `web`. Kit `hybrid` mendaftar `inertia_layout` |
| WP-27 | `src/tools/app/{get_permissions,get_queue_jobs}.ts`, `src/introspection/queue_database.ts` | Kit API + `@adonisplus/permissions@0.0.4` (registry Plus, `.npmrc` scope fixture), `@adonisjs/bouncer@4.0.1`, `@adonisjs/queue@0.6.2` + `@boringnode/queue@0.6.0` (driver database SQLite, tabel kustom): kunci/aktif/inaktif+alias permission persis, ability dan policy lazy Bouncer; job di direktori default dan lokasi kustom dengan `options.name` terdaftar dan identitasnya terverifikasi, registrasi manual tidak didaftar (`not-enumerable`), job baru setelah start `registered: false`, export non-fungsi di `rejected`; pending per queue, row pending/failed dengan payload sentinel ter-redaksi; counter job/ability/policy 0 dan seluruh row tidak berubah; config dinamis/berubah dan driver `sync` → status `CAPABILITY_UNSUPPORTED`, pending tetap dari API publik. Dua era protokol |

Jumlah test setelah M6: 146 unit, 88 integration; `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:integration`, dan `npm run verify:exports` lulus. Lima lane dikerjakan paralel di git worktree terpisah lalu digabung; regresi M1–M5 dijalankan ulang dalam satu suite.

Item terbuka M5 yang ditutup di M6: fixture Edge-only (PF-05) dan surface dari `inertia.render` di handler (aturan desain ke-4).

Batas yang tetap terbuka setelah M6:

- Adapter Inertia yang teruji hanya React dan Vue; Svelte/Solid tidak diklaim. Ekstraksi bersifat statis dan terbatas: alias receiver selain `inertia`/`ctx.inertia`, wrapper helper, controller turunan/dinamis, `inertia.share()` di luar middleware, dan props hasil komputasi tetap `unknown`/`partial`. Bentuk props page tidak diekstrak dari komponen; hanya referensi deklarasi generated.
- Validator yang tidak di-export dari direktori validators (inline di route/controller) tidak ditemukan; import modul menjalankan kode top-level app. Arti rule kustom dan penerapan cabang kondisional tetap `unknown`.
- Kesegaran bentuk tipe Tuyau dan `Data` tidak diverifikasi (butuh pelacakan generation source, WP-37); status `fresh-routes` hanya tentang himpunan route.
- Slot/component Edge adalah konvensi source; komposisi layout dan slot dinamis tidak lengkap. Render bukan sandbox; state per-request tidak tersedia.
- Queue: hanya driver database pada tuple 0.6.2/0.6.0 dengan `config/queue.ts` statis yang punya status di luar pending; Redis tidak diuji. Registrasi manual di luar `locations` tidak dapat dienumerasi. Permission Plus memerlukan akses registry berlisensi untuk positive test (CI: OB-45, WP-38). Profile tetap melaporkan `active: null` untuk permissions dan Bouncer (tanpa sinyal runtime terverifikasi).
- Cache metadata tidak dipakai (dibaca segar per call); regresi HMR/restart lintas tool tetap WP-37 (OB-13, OB-40).

### M7 — Eval, Ace, source resolution, documentation search

Prasyarat: M3–M4 untuk execution context; S-E dan S-J. Source/docs lane dapat mulai setelah M2.

| ID | Pekerjaan dan artefak | Acceptance criteria |
| --- | --- | --- |
| WP-28 | `project_eval`: app-scoped resolver, injected console/db/container/signal, result display, audit | Natural alias import benar; concurrent console tidak bercampur; async timeout terlabel; mutation capability jujur; no global console patch |
| WP-29 | `run_ace_command`: structured args/flags, isolated invocation, timeout/process cleanup, output limit | Tidak ada shell interpolation; generator benar-benar membuat file fixture; failing command menghasilkan exit code nyata; interactive command tidak menggantung |
| WP-30 | `get_source_location`: app imports, local path, package exports, source mappings | `.ts` source dilaporkan jika dapat dibuktikan; external/built-only package tetap path yang benar; tidak mengarang line number |
| WP-31 | `search_package_docs`: offline bounded index, README/types/JSDoc, ranking, cache | Maksimal 5 snippet dengan line range benar; scoped package/symlink resolution bekerja; include filter dipatuhi; network tidak dipakai |

**Exit gate M7:** tool eval mengakses service/model app yang sedang hidup; Ace menghasilkan artefak nyata tanpa merusak HTTP process; source/docs lookup mengarah ke file installed app, bukan dependency package MCP sendiri.

### M8 — Resources, prompts, configure, skill, dan client integration

Prasyarat: kontrak tool M3–M7 stabil.

| ID | Pekerjaan dan artefak | Acceptance criteria |
| --- | --- | --- |
| WP-32 | Semua resource dan `debug_request`/`add_feature` prompts | Tools/resources konsisten pada data/redaction/availability; prompt per profile hanya merujuk tools tersedia; hybrid menanyakan surface |
| WP-33 | Configure codemods + config stub + conditional provider/config safety + next steps | Rerun tidak menduplikasi provider atau menimpa config/skill; `.claude` absent tidak dibuat tanpa alasan; custom port/path tercermin |
| WP-34 | Satu sumber English `SKILL.md`, paket npm dan installer repo | Versi npm dan repo sama; conventions mengikuti profile, bukan selalu Inertia; tidak menyebut timeout sebagai hard safety |
| WP-35 | README, API/config reference, troubleshooting, compatibility, changelog, client recipes | Claude Code, Cursor, VS Code, Zed punya instruksi sesuai versi yang diuji; nama `adonis`, bukan `tidewave`; tidak mengklaim semua client mendukung konfigurasi sama |

**Exit gate M8:** install tarball → configure → dev boot → connect client → jalankan `debug_request`/`add_feature` workflow pada app contoh; bukan hanya melihat status “connected”.

### M9 — Hardening, compatibility, packaging, release

Prasyarat: seluruh milestone dan spike terkait selesai.

| ID | Pekerjaan dan artefak | Acceptance criteria |
| --- | --- | --- |
| WP-36 | Adversarial suite: network, SQL, tenant, SSRF, secrets, concurrency, cancellation | Semua negative cases pada bagian 10 lulus; blocker keamanan tidak diubah menjadi skipped test |
| WP-37 | Full fixture matrix, HMR/restart, benchmark/capacity smoke | Tidak ada stale metadata yang diklaim fresh, listener leak, duplicate log, cross-call contamination, atau unbounded payload |
| WP-38 | CI gates, pack/install smoke, production prune, dependency/license review | Pipeline menguji tarball yang akan dipublish; build production tanpa dev package lolos; OS/Node matrix sesuai klaim |
| WP-39 | Release `0.1.0`, npm public provenance, tag, release notes, post-publish smoke | Artefak publik sama dengan artefak verified; fresh consumer resolve exports, configure, connect dan call tool nyata |

**Exit gate M9:** tidak ada requirement desain yang hanya diwakili stub, mock, empty list, atau unsupported untuk semua kasus. Keterbatasan yang memang inheren dicatat sebagai keterbatasan, bukan disembunyikan.

## 7. Dependensi dan strategi eksekusi

```mermaid
flowchart TD
  M0[M0 Spike dan keputusan] --> M1[M1 Fondasi dan fixture]
  M1 --> M2[M2 Registry dan transport]
  M2 --> M3[M3 Observability]
  M2 --> M4[M4 Database dan tenant]
  M3 --> M5[M5 HTTP dan auth]
  M4 --> M5
  M3 --> M6[M6 Introspeksi framework]
  M3 --> M7[M7 Eval Ace source docs]
  M4 --> M7
  M5 --> M8[M8 Resources prompts configure]
  M6 --> M8
  M7 --> M8
  M8 --> M9[M9 Hardening dan release]
```

Graph menunjukkan dependensi utama; spike dan shared-service prerequisite pada tiap milestone tetap mengikat. M4 boleh dikembangkan bersamaan M3, tetapi gate M4 menunggu redaction/correlation M3. Route/surface metadata M5 menjadi input final M6 bila diperlukan.

Pembagian pekerjaan setelah M2:

- **Integration owner:** public types/config, registry, provider/handler, fixture lifecycle, dependency lockfile, merge dan acceptance gate.
- **Runtime lane:** M3 lalu eval/Ace pada M7.
- **Database lane:** M4 termasuk tenant enforcement.
- **Framework lane:** M6; koordinasi kontrak route evidence dengan M3/M5.
- **HTTP lane:** M5 setelah route/tenant/auth prerequisites siap.
- **Packaging lane:** source/docs search dan draft configure/docs setelah public API stabil; final consumer smoke tetap M8–M9.

Jangan membagi pekerjaan per tool terlalu dini. Shared contracts, error envelope, redaction, lifecycle, fixture, dan optional-import policy harus satu keputusan. Independent work boleh paralel; build/typecheck/full tests dijalankan terintegrasi setelah satu wave perubahan stabil.

Tidak menetapkan tanggal selesai sebelum S-A–S-K memberi hasil. Risiko terbesar bukan jumlah tool, tetapi API framework yang tidak tersedia dan kontrak keamanan yang tidak dapat dijamin oleh strategi awal. Estimasi jadwal dibuat setelah M0 dengan memisahkan implementasi, review, dan smoke tiap work package.

## 8. Matriks cakupan fitur dan kontrak minimum

### 8.1 Seluruh tool desain

Semua input bersifat validated structured input. `tenant`, `surface`, dan opsi auth hanya tersedia bila integrasinya aktif; user request yang meminta capability absen gagal eksplisit.

| Tool | Input/hasil minimum | Sumber dan batas penting | Delivery |
| --- | --- | --- | --- |
| `get_project_profile` | profile, surfaces, auth, packages, generated, capability reasons | Installed vs active dibedakan; default guard boleh tidak ada | WP-09 |
| `get_routes` | filter pattern/method; method, pattern, handler, middleware, name, domain, surface | Router committed; handler anonim dan inferred surface terlabel | WP-11 |
| `get_middleware` | server/router/named stack dalam urutan | Metadata runtime, bukan eksekusi middleware | WP-11 |
| `get_logs` | tail/level/grep; bounded entries | Grep literal; redaction sebelum simpan; cursor/correlation tidak kehilangan urutan | WP-10 |
| `get_last_exceptions` | limit; message/stack/route/request ID | Exception yang ditangani framework; stack sanitized dan dedup | WP-10 |
| `get_container_bindings` | pattern; binding/singleton/origin jika tersedia | Tidak instantiate seluruh container untuk introspeksi | WP-12 |
| `get_events` | event dan listener | List tidak emit; dynamic registrations disertakan bila teramati | WP-12 |
| `get_config` | dot key; resolved redacted subtree | Cycle/function/class aman diserialisasi; prototype traversal ditolak | WP-13 |
| `get_env` | prefix; declared key dan presence | Bukan dump env value; declaration yang tidak dapat diekstrak terlabel | WP-13 |
| `get_models` | name; model/table/primary key/connection/columns/relations/path | Scan app model roots, bukan registry global fiktif | WP-14 |
| `query_model` | model, where, whereNull, preload, orderBy, limit, serialize, tenant | Model scopes/serialization; identifiers dan relations tervalidasi | WP-15, WP-18 |
| `execute_sql_query` | query/bindings/connection/tenant; rows/dialect/returned count/duration | DB enforcement; row count berarti returned count kecuali total benar-benar diketahui | WP-16, WP-18 |
| `get_migrations` | connection; ran/pending/batch/file | Status dari runner/history; tidak menjalankan up/down | WP-17 |
| `diff_schema` | connection; model/DB column differences | Physical names, missing table, generated/computed distinctions; bukan auto-migration | WP-17 |
| `http_request` | method/path/body/headers/as/surface/tenant; status/safe headers/body/logs | Real local HTTP; bukan arbitrary URL client; mutation-capable | WP-19–WP-22 |
| `get_validators` | name; field/rule/custom message/reference | Supported compiled/generated/source schema; custom/dynamic rule unknown | WP-23 |
| `get_inertia_pages` | route; route→component/prop evidence | Tidak menjalankan controller; dynamic render diberi limitation | WP-24 |
| `get_shared_props` | declared/observed shared prop metadata | Lazy/private request-specific props tidak dievaluasi tanpa context | WP-24 |
| `get_transformers` | transformer dan generated Data shape | TS type-only data berasal artifact/source, bukan object runtime palsu | WP-24 |
| `get_tuyau_schema` | typed routes/input/response shape yang tersedia | Tuyau artifact/version readiness; missing vs empty dibedakan | WP-25 |
| `get_views` | template/component/slot/path | Root view resolver yang terkonfigurasi, bukan arbitrary filesystem scan | WP-26 |
| `render_view` | view + JSON state; bounded HTML | Edge nyata; tidak dibuka sebagai browser content; helpers dapat punya side effect | WP-26 |
| `get_permissions` | registered permission/ability metadata | Adapter `@adonisplus/permission` atau API konkret yang disetujui; tidak memutuskan otorisasi user tanpa context | WP-27 |
| `get_queue_jobs` | status; registered jobs dan bounded queue state | Exact backend dipilih S-K; payload sensitif ter-redaksi; tidak enqueue/retry/delete | WP-27 |
| `project_eval` | code/timeout/tenant; display value/captured console/duration | App live; arbitrary side effect; cooperative cancellation saja | WP-28, WP-18 |
| `run_ace_command` | command/args/flags; stdout/stderr/exit code | Tanpa shell; process isolation; generator/migration dapat menulis | WP-29 |
| `get_source_location` | reference; path/line jika diketahui | App-relative resolution dan package exports; path existence diverifikasi | WP-30 |
| `search_package_docs` | query/packages; maksimum 5 snippets | Offline installed docs/types/JSDoc, file dan line range | WP-31 |

### 8.2 Resources dan prompts

| Identitas | Kontrak | Availability / acceptance |
| --- | --- | --- |
| `adonis://profile` | Data service yang sama dengan `get_project_profile` | Selalu pada dev enabled; reasons jelas |
| `adonis://routes` | Route list tanpa filter | Tidak kehilangan domain/surface evidence |
| `adonis://models` | Ringkasan model | Hanya jika Lucid aktif; source/model cache yang sama |
| `adonis://config/{key}` | Resolved subtree ter-redaksi | URI decoding tervalidasi; tidak dapat bypass key policy |
| `adonis://package` | Package manifest dan resolved rc metadata yang aman | Credentials/secret scripts/URL tidak dikeluarkan mentah; dynamic functions bukan string source |
| `debug_request` | Messages untuk profile→route→HTTP→exceptions/logs | Tidak otomatis membuat side effect; as/tenant eksplisit |
| `add_feature` | API: validator/controller/route/test; Inertia: tambah page/transformer; Edge: template | Hybrid menentukan web/api/keduanya; referensi Flow hanya jika tersedia; generated aliases dicek profile |

### 8.3 Profile acceptance matrix

| Fixture | Tools/profile behavior yang harus terbukti |
| --- | --- |
| API tanpa Lucid/auth/view | Core tools aktif; database/view/impersonation capability absen dengan alasan; app tetap boot |
| API + Lucid + token auth + Tuyau | DB tools dan schema tersedia; JSON request default; cleanup token terbukti |
| Inertia React + session/Shield | Inertia page/shared/transformer introspection, X-Inertia/version, validation flash, CSRF |
| Inertia Vue | Metadata dan HTTP behavior tidak mengasumsikan file/adapter React |
| Edge + session | Views/render, HTML output bound, web guard, no X-Inertia default |
| Hybrid API + Inertia, termasuk domain routes | Per-route surface override dan tenant/domain mapping benar |
| Tenant + permission + queue | Positive adapter behavior, two-tenant isolation, optional package availability |
| Config disabled / production | Tidak ada endpoint, listener, buffer aktif, atau optional import failure |

Svelte/Solid tercantum pada tipe desain tetapi dukungan actual Inertia adapter harus dikonfirmasi M0/M6. Jangan menerbitkan klaim four-adapter support hanya karena union type memuat empat string. Hasil M6: React (kit `hybrid`) dan Vue (kit `vue`) teruji; Svelte/Solid tidak diklaim (§6.6).

## 9. Strategi pengujian dan smoke

### 9.1 Lapisan verifikasi

1. **Unit boundary:** guards, config merge, registry collision/order/disable, redaction, truncation, query input validation, surface precedence, ring-buffer wraparound.
2. **Framework integration:** app nyata dengan providers/preloads, model discovery, metadata, DB transactions, session/token APIs, logger/exception seams. Mock hanya pada boundary eksternal yang tidak menjadi objek klaim.
3. **Live HTTP:** start dev app di port bebas dan gunakan official MCP client terhadap endpoint nyata; tool HTTP memanggil app yang sama melalui socket.
4. **Consumer tarball:** `npm pack` → install pada fixture baru → configure → boot → client call. Membuktikan exports, stubs, assets, declarations, optional peers.
5. **Production absence:** build configured app; install production-only; boot web dan Ace tanpa package MCP. Periksa health biasa dan absennya MCP, bukan hanya 404 dari app yang gagal boot.
6. **Client smoke:** Claude Code minimal satu full workflow, kemudian Cursor/VS Code/Zed pada versi yang akan disebut didukung. Status connected saja tidak cukup.

### 9.2 Skenario end-to-end wajib

- **E01 — Basic runtime:** discovery/initialize sesuai era → tools/list → get profile → routes → profile/routes resource → prompt retrieval.
- **E02 — Debug request:** hit endpoint error melalui `http_request`; hasil punya status benar, exception matching, dan log correlation tanpa log request tetangga.
- **E03 — Data semantics:** model soft-deleted/scoped/serializeAs dibandingkan raw rows; schema diff menemukan migration belum diterapkan; tool status tidak menerapkan migration.
- **E04 — Auth:** anonymous protected route ditolak; as user valid diterima; user invalid/guard unsupported gagal eksplisit; session/token bersih pada success/error/abort.
- **E05 — Surface:** API JSON, Inertia component/props/version, Edge HTML; validation error mapping tetap akurat; domain-bound route tidak salah host.
- **E06 — Tenant concurrency:** tenant A/B mengakses model/eval/HTTP secara bersamaan; missing/wrong tenant dan raw SQL bypass ditolak sesuai policy.
- **E07 — Extensibility:** provider domain register tool/resource/prompt, wrapper dipanggil sekali, config disable menang, duplicate name gagal boot.
- **E08 — Eval/Ace:** import alias natural, resolve service, isolated console, async timeout yang jujur; Ace generator menulis file temp dan nonzero command error terlapor.
- **E09 — Lifecycle:** edit/add/delete model/page, HMR atau restart; client request berikutnya membaca metadata baru; shutdown melepas resources package.
- **E10 — Install and production:** configure dua kali tanpa menimpa perubahan user; custom path/port; tarball consumer; production prune tanpa missing module.
- **E11 — Offline docs:** blok akses network; search installed docs dan source reference tetap benar; package non-allowlist tidak diindex.
- **E12 — Protocol eras:** modern per-request metadata dan legacy initialize keduanya sukses; invalid version/header mismatch/malformed JSON diuji sesuai SDK; tidak mengimplementasikan rules era lama untuk era baru.

### 9.3 Infrastruktur test yang harus dibuat

- Temporary app directory dan unique database/schema untuk setiap run; cleanup hanya resource yang dibuat run tersebut.
- PostgreSQL credential fixture bukan dev credential; fail closed bila env menunjuk target yang tidak dikenal.
- Production fixture benar-benar `NODE_ENV=production`; fixture dev MCP sengaja `NODE_ENV=development`, walau dikendalikan runner test.
- Synchronous infinite-loop eval hanya pada subprocess disposable dengan watchdog luar; jangan membekukan runner utama untuk menguji klaim timeout.
- Clock terkontrol untuk buffer ordering bila perlu; assertions perilaku bukan snapshot wording atau source-code matching.
- Jangan menambahkan permanent test untuk salinan konstanta, mock echo, atau “tidak throw” tanpa hasil observable.
- Golden fixture untuk direct/dynamic introspection, auth cleanup, SQL attack corpus, dan two-tenant overlap dipelihara sebagai regression evidence.

### 9.4 Command contract CI yang direncanakan

Command contract CI (WP-01/WP-38). Sejak M1 tersedia `lint`, `typecheck`, `test` (suite unit), `test:integration` (build + suite integration dengan fixture nyata), `build`, dan `verify:exports`; `test:security`, `smoke:pack`, dan `smoke:clients` masih deliverable WP-38:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:security
npm run build
npm run verify:exports
npm run smoke:pack
npm run smoke:clients
```

`smoke:pack` mencakup tarball install, configure idempotency, live app/client, serta production prune. `smoke:clients` menjalankan client SDK dua era secara otomatis; GUI/editor clients memakai evidence manual terpisah bila automation belum tersedia. Release tidak boleh mengklaim manual gate sudah dilakukan hanya karena script exit 0.

Matriks minimal: Linux dan macOS untuk path/ESM/lifecycle; Node minimum yang dideklarasikan dan patch Node 24 terkini; Core/Lucid minimum/current; SQLite dan PostgreSQL. Dependency upgrade menjalankan matrix yang sama sebelum lockfile diterima.

### 9.5 Non-functional acceptance

- Enumerasi ringan tidak memicu full model/docs scan atau membuka DB yang tidak diperlukan.
- Log append O(1) dengan bounded bytes; docs/model cache lazy, keyed pada app/version/generation yang benar.
- Satu tool timeout tidak merusak transport/request lain. Tidak ada auto-retry mutation setelah timeout yang hasil side effect-nya tidak diketahui.
- Output limit diterapkan sebelum materialisasi tanpa batas sejauh driver/API memungkinkan; sekadar `rows.slice()` setelah memuat seluruh tabel tidak cukup.
- Ukur cold/warm latency, event-loop delay, retained memory, dan active handles sebelum/sesudah traffic serta HMR; simpan environment dan workload bersama angka. Tidak memakai klaim desain “sekitar 1 detik” sebagai hasil benchmark.
- Ulangi concurrent calls dengan tool cepat/lambat dan dua tenant; periksa cleanup, bukan hanya throughput.

## 10. Security invariants dan negative cases

### 10.1 Jaringan dan endpoint

- Route tidak ada di production dan mode disabled; provider/config loader tetap aman walau module tidak terpasang.
- Alamat peer berasal socket. Test `X-Forwarded-For`, `Forwarded`, trusted proxy, IPv4-mapped IPv6, dan IPv6 loopback.
- Host tidak menerima `localhost.evil.example`, userinfo URL, malformed port, duplicate ambiguity, atau hostname arbitrer yang resolve ke loopback.
- Origin diparse sebagai URL, bukan prefix string. Origin asing, `null`, dan mismatch port gagal; missing Origin boleh untuk native client.
- Remote opt-in tetap memerlukan Host/Origin policy. Server app yang bind `0.0.0.0` tidak otomatis membuka endpoint MCP.
- Reverse proxy/tunnel dapat menyamarkan peer menjadi localhost; dokumentasi melarang public exposure dan mewajibkan auth/network boundary di depan proxy jika remote dipakai.
- Jangan mengecualikan semua route dari Shield; pengecualian MCP scoped ke exact configured endpoint dan dilindungi guard sebelum dispatch.

### 10.2 SQL dan tenant

- Uji komentar/nested comments, multiple statements, mutating CTE, EXPLAIN ANALYZE mutating query, SELECT side-effecting functions, write PRAGMA, ATTACH/COPY/procedure calls yang relevan dialect.
- DB read-only transaction tidak menjamin semua function bebas side effect; SQL policy harus menolak construct yang tidak dapat dinyatakan aman dalam supported subset.
- Statement timeout, transaction rollback, connection release, dan reset state pool diuji pada success/error/cancel.
- Raw SQL tenant bukan ORM scope. `tenant_id` pada komentar, string, subquery tak relevan, OR tautology, UNION, joins, schema override, dan identifier quoted tidak boleh menjadi bypass.
- Untuk shared-table tenant tanpa RLS/role enforcement yang terbukti, default `execute_sql_query` ditolak. `query_model` tetap jalan melalui API scope tenant yang nyata.
- `allowCrossTenant: true` adalah keputusan eksplisit operator; output menunjukkan scope/cross-tenant status. `tenant` tidak boleh diam-diam memilih connection global.
- `query_model` read-only berarti package tidak membuat mutation query; app-defined hooks/computed serializers tetap kode tepercaya yang dapat memiliki side effect. Batas ini didokumentasikan, bukan dianggap sandbox.

### 10.3 HTTP dan impersonation

- Hanya origin server aplikasi yang dipercaya; user tidak mengirim scheme/host arbitrary, `//host`, alternate port, atau unix/file URL.
- Redirect default tidak otomatis diikuti. Jika follow didukung, setiap hop divalidasi dan tidak meneruskan credential ke destination baru.
- MCP path dan bentuk encoded/normalized alias ditolak; header recursion adalah defense tambahan, bukan satu-satunya batas.
- Host untuk domain routes dipilih dari mapping config tepercaya; user tidak bisa memakai Host untuk mengirim credential ke service lain.
- Session/cookie/CSRF dipakai melalui adapter asli; tidak mematikan middleware auth untuk memenuhi `as`.
- Jangan membuat token permanen, menampilkan `Authorization`/`Cookie`/`Set-Cookie`, atau menghapus session/token yang bukan milik tool.
- Context tenant pada outgoing HTTP diterjemahkan ke mekanisme tenant app yang telah diverifikasi; jangan menerima privileged internal header yang bisa dipalsukan client eksternal.

### 10.4 Data, source, dan executable tools

- Redaction dipakai sebelum penyimpanan buffers serta sebelum output config/logs/errors/resources/HTTP/queue/docs. Sentinel secrets dari fixture tidak boleh muncul pada jalur-jalur yang dijanjikan ter-redaksi.
- Config default-deny untuk path/value sensitif; key-name regex saja tidak dianggap menjamin seluruh secret ter-mask. Unknown object bisa ditolak/diringkas ketimbang diserialisasi mentah.
- Tidak membaca `.env` values melalui docs search; `get_env` hanya declaration/presence. Configure boleh membaca port tanpa mencetak isi `.env`.
- Log/docs/model data adalah untrusted content bagi agent; skill memperlakukan teks tersebut sebagai data, bukan instruksi yang mengubah aturan tool.
- Source/doc traversal memakai resolved app/package roots; jangan scan seluruh filesystem. Source map yang tidak ada tidak ditebak.
- Eval setara trusted development REPL: bisa membaca secret, menulis file/DB, dan membuat network call. Redaction bukan jaminan terhadap eval berbahaya. Tool description dan README menyatakan batas ini.
- Ace memakai argv terstruktur, bukan shell command string; tidak `exec` interpolation. Deadline membunuh process milik tool saja; generator output hanya pada app root fixture/target yang dipilih.
- `render_view` dapat memanggil helper aplikasi. Jangan beri read-only safety claim hanya karena outputnya HTML.

## 11. Risiko, keputusan terbuka, dan dependency watch

| Risiko | Dampak | Mitigasi / owner | Gate |
| --- | --- | --- | --- |
| Production config masih mengimpor dev package | App production gagal boot | Conditional loader/config, tarball production fixture; integration owner | S-B, WP-33, WP-38 |
| Bridge bodyparser/Shield/response ownership salah | MCP tidak connect atau response corrupt | Real HTTP dual-era spike; integration owner | S-A, WP-07–WP-08 |
| Logger/exception API tidak mengekspos hook lengkap | Janji zero-instrumentation tidak tercapai | Proof public seam; catat dependency blocker, jangan monkey-patch broad internals tanpa contract tests; runtime lane | S-C, WP-10 |
| SQL read-only dan tenant enforcement palsu | Data berubah/bocor | Database-enforced boundary, supported subset, fail closed; DB lane | S-G–S-H, WP-16–WP-18 |
| Auth/session API hanya cocok di test plugin | Impersonation salah atau credential leak | Adapter versioned public API dan cleanup tests; HTTP lane | S-F, WP-20 |
| Eval natural import/hard timeout tidak sesuai asumsi | Tool menyesatkan atau membekukan app | Resolver spike; timeout limitations; no sandbox claim; runtime lane | S-E, WP-28 |
| Type/source introspection dinamis | Agent mengambil keputusan dari schema palsu | Evidence kind/limitations, supported cases, fixture dynamic cases; framework lane | S-I, WP-23–WP-25 |
| HMR tidak membuang ESM cache | Metadata stale/memory leak | Ikuti lifecycle framework; restart bila perlu, no unbounded query-suffix imports; integration owner | S-D, WP-37 |
| Paket tenant/permission/queue berbeda dari asumsi | Tool optional tidak pernah usable | Exact package/version fixture wajib sebelum delivery; framework/DB lane | S-K, WP-27 |
| Remote access tanpa auth | Arbitrary code execution lewat jaringan | Opt-in warning, exact allowlist, external network/auth boundary; security reviewer | WP-08, WP-36 |
| SDK/protocol/client bergerak cepat | Wire behavior incompatibility | Locked tuple dan dua-era client matrix; integration owner | WP-07, WP-35, WP-38 |
| Evaluator memerlukan API `vm` eksperimental + `--experimental-vm-modules` (M0, flag disetujui) | `project_eval` tidak tersedia tanpa flag atau rusak saat Node berubah | Configure menawarkan flag (OB-49); version gate Node minimum/current; `CAPABILITY_UNSUPPORTED` eksplisit; runtime lane | S-E, WP-28, WP-33, WP-38 |
| Permission Plus privat dan berlisensi (M0) | Positive test CI tidak bisa dijalankan tanpa akses sah | Credential CI legal, tanpa redistribusi; Bouncer adapter terpisah; framework lane | S-K, WP-27, WP-38 |
| Parser SQL JS bukan grammar native; `sqlite-parser` 1.0.1 berumur (M0) | Celah policy SQL atau false reject | DB enforcement primer, unknown node deny, corpus regression; SQLite memakai program terkompilasi native sejak M4 (D47), parser JS hanya untuk PostgreSQL; DB lane | S-G, WP-16, WP-36 |
| Assembler mengirim SIGKILL ke HTTP child saat restart (M0) | Child Ace/SQL milik tool yatim, response hilang | Watchdog independen parent, outcome unknown tanpa retry; runtime lane | S-J, WP-29, WP-37 |
| Instrumentasi opt-in mengubah file app (logger, exception handler, middleware) (M0) | Configure merusak kustomisasi user atau production import | Codemod idempotent, gateway dev-guarded, production prune gate; integration owner | S-B, S-C, WP-33, WP-38 |

Dependency watch saat upgrade:

- SDK server/node/client dan Zod: import surface, schema conversion, result error handling, cancellation, supported protocol versions.
- Core/http-server/bodyparser/Shield: response ownership, route commit, lifecycle inspect vs run, trusted proxy.
- Lucid/Knex/driver: model boot metadata, result shape, cancellation, migration APIs, connection read-only state.
- Auth/session: `authenticateAsClient` contract, token persistence, session store API, flash/CSRF.
- Inertia/Tuyau/Vine/transformers: generated artifact locations dan exported introspection API, bukan private field asumsi.
- Tenant/permission/queue: binding identity, context propagation, connection mapping, payload visibility.
- Node `vm` dynamic import (`importModuleDynamically`, `USE_MAIN_CONTEXT_DEFAULT_LOADER`, status flag `--experimental-vm-modules`), `hot-hook` version query, dan `@poppinss/ts-exec` resolve hook.
- `pg` `queryMode`, `pgsql-ast-parser`/parser SQLite, `better-sqlite3` readonly/`stmt.readonly`/`loadExtension`.
- Logger `hooks.streamWrite`, exception handler `handle`, `tracingChannels.providerRegister`, assembler restart signal.

Jika dependency API belum tersedia, hasil pekerjaan adalah blocker dengan bukti dan opsi konkret. Release lengkap menunggu solusi atau perubahan cakupan yang disetujui secara eksplisit; tidak ada “unsupported” universal yang disamarkan sebagai selesai.

## 12. Packaging, dokumentasi, dan release checklist

### Artefak publik

- `build/` JS ESM + `.d.ts` yang konsisten dengan exports.
- Configure hook, stubs root dan config/skill stub yang benar-benar masuk tarball.
- Sumber English `skills/adonisjs-mcp/SKILL.md` untuk instalasi repo.
- README: install sebagai devDependency, configure, client recipes, all config keys, tool/resource/prompt catalogue, custom tool/provider example, compatibility, security limits, troubleshooting.
- Changelog dan MIT license; reference keputusan desain yang dikoreksi pada bagian 3 dokumen ini.
- Tidak memasukkan fixture DB, `.env`, log, coverage, temporary scripts, client credentials, atau test-only dependency code.

### Release gates

- [ ] S-A–S-K memiliki hasil nyata dan tidak ada blocker terbuka pada fitur yang diklaim.
- [ ] WP-01–WP-39 selesai beserta evidence; matriks 28 tool, 5 resource, 2 prompt tercakup.
- [ ] Positive optional-integration tests tersedia; tidak hanya absence tests.
- [ ] E01–E12 lulus pada fixture terkait dan protokol yang diklaim.
- [ ] Core/Lucid version range dan adapter compatibility cocok dengan matrix, bukan asumsi semver.
- [ ] Security review tidak memiliki unresolved data-write, tenant-leak, SSRF, remote-exposure, atau secret-output blocker.
- [ ] HMR/restart/close smoke tidak meninggalkan listeners/processes/session/token milik tool.
- [ ] Tarball consumer, configure rerun, dan production-pruned app boot lulus.
- [ ] Client recipes sudah dipakai pada versi client yang disebut; unsupported recipe tidak dipromosikan sebagai supported.
- [ ] Skill dan docs tidak mengklaim hard timeout, safe sandbox, global model registry, atau full dynamic schema inference.
- [ ] Publish melalui CI tepercaya dengan provenance; release artifact dan tag cocok dengan build yang diverifikasi.
- [ ] Post-publish install/connect/call pada fixture bersih lulus sebelum mengumumkan release.

Bila post-publish smoke gagal, hentikan promosi dan terbitkan perbaikan versi baru atau deprecate versi rusak sesuai kebijakan npm; jangan mengubah tag/artefak lama diam-diam.

## 13. Langkah eksekusi pertama

1. ~~Buat fixture spike minimal dengan tuple SDK/Core yang dipilih~~ — selesai di M0 (`spikes/`, tuple §2.3). Manifest package tetap pekerjaan WP-01.
2. ~~Buktikan S-A dan S-B~~ — selesai di M0 (§5.1).
3. ~~Bekukan public schema/config/result/error contracts dan lifecycle registry~~ — selesai di M1–M2 (§6.1, §6.2, D34–D37).
4. ~~Bangun vertical slice M2 dengan `get_project_profile` dan `adonis://profile` sebagai fitur nyata~~ — selesai (§6.2).
5. ~~Jalankan spike log/auth/SQL/tenant/eval/introspection yang tersisa~~ — selesai di M0; B-01 diputuskan (opsi a).
6. ~~Eksekusi M3, M4, M5, dan M6~~ — selesai (§6.3, §6.4, §6.5, §6.6). Eksekusi M7–M8 sesuai dependensi, tutup dengan M9. Jangan memindahkan risiko keamanan ke akhir hanya karena tool sudah tampak bekerja.

Pada penyusunan awal, dokumen ini tidak menyatakan spike, tests, atau smoke runtime telah lulus. Sejak M0, hasil spike pada §5.1 berasal dari eksekusi nyata dengan bukti di `docs/spikes/` dan `spikes/`; itu bukti kelayakan pendekatan, bukan bukti implementasi package. Sejak M1, tests dan smoke package mencakup fondasi (§6.1); sejak M2 juga endpoint MCP, registry, guard, dan satu tool + satu resource nyata (§6.2); sejak M3 juga capture log/exception opt-in, delapan tool observability/metadata, dan resource routes/config (§6.3); sejak M4 juga lima tool database, resource models, dan integrasi tenant (§6.4); sejak M5 juga `http_request` dengan impersonation, CSRF, surface routing, dan mapping tenant (§6.5); sejak M6 juga sembilan tool introspeksi framework dan integrasi opsional (§6.6). Tool M7 belum ada.

## 14. Referensi

Sumber eksternal diperiksa 13 Oktober 2026. Endpoint `latest` dan branch dokumentasi dapat berubah; saat M0 catat exact version/commit pada evidence implementasi.

- **[S1]** [Metadata npm @adonisjs/core](https://registry.npmjs.org/@adonisjs/core/latest).
- **[S2]** [Metadata npm @adonisjs/lucid](https://registry.npmjs.org/@adonisjs/lucid/latest).
- **[S3]** [Metadata npm SDK MCP v1](https://registry.npmjs.org/@modelcontextprotocol/sdk/latest).
- **[S4]** [README resmi SDK v1.x](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/README.md).
- **[S5]** [Metadata npm MCP server v2](https://registry.npmjs.org/@modelcontextprotocol/server/latest).
- **[S6]** [Metadata npm MCP Node adapter](https://registry.npmjs.org/@modelcontextprotocol/node/latest).
- **[S7]** [Panduan upgrade SDK v1 ke v2](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2).
- **[S8]** [Dukungan protocol revision 2026-07-28 pada SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md).
- **[S9]** [MCP 2026-07-28: transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports).
- **[S10]** [MCP 2026-07-28: Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).
- **[S11]** [AdonisJS service providers dan lifecycle](https://docs.adonisjs.com/guides/concepts/service-providers).
- **[S12]** [MCP 2025-11-25: transport untuk legacy compatibility](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
