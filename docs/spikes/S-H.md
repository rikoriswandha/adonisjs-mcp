# S-H — Isolasi tenant konkuren dan batas raw SQL
Status: LULUS BERSYARAT
Tanggal: 2026-10-13

## Pertanyaan

Dua tenant konkuren: model, raw SQL, eval, HTTP; termasuk host/domain routing. Apakah context tidak bocor, wrong/missing tenant gagal, dan raw SQL tidak lolos hanya karena ada teks `tenant_id`?

## Lingkungan

Fixture API kit create-adonisjs 3.4.0; clone `/tmp/adonisjs-mcp-m0/s-h-api`, bukan base fixture. Node `v24.21.0`, npm `11.19.0`, `Darwin 27.0.0 arm64`. Hasil nyata `npm ls` di clone:

```text
@rikology/adonisjs-tenant@1.0.2
@adonisjs/core@7.6.0
@adonisjs/lucid@22.4.2
@adonisjs/auth@10.1.0
@adonisjs/assembler@8.5.2
@poppinss/ts-exec@1.5.0
better-sqlite3@13.0.3
pg@8.16.3
```

PostgreSQL `18.4 (Homebrew)` dari `/opt/homebrew/opt/postgresql@18/bin`, cluster throwaway dengan role `sh_reader LOGIN NOSUPERUSER NOBYPASSRLS`. App memakai SQLite untuk model/shared-table dan connection Lucid `tenant_pg` untuk RLS. Server development direct boot (tanpa HMR) di `127.0.0.1:41140` dan `41141`; PG hanya `127.0.0.1:55442`. Tidak ada koneksi ke 5432/6379. Tidak memakai MCP SDK karena spike ini meneliti tenant boundary, bukan transport.

## Skenario dan command

Jalankan dari root repository:

```sh
# Clone baru dengan nama s-h-api-<timestamp>, install package published, configure,
# boot dua app secara berurutan, run skenario, assert observasi, stop semua proses.
node spikes/s-h/run.mjs

# Command yang benar-benar dijalankan untuk hasil laporan ini:
node spikes/s-h/run.mjs /tmp/adonisjs-mcp-m0/s-h-api
```

Argumen opsional harus clone disposable di `/tmp/adonisjs-mcp-m0/`; jangan menunjuk base `api`. Runner menerapkan `tenancy.ts`, `database.ts`, `probe_post.ts`, dan `routes.ts` pada clone; membuat PG cluster unik; menerapkan `rls.sql`; menyimpan output lengkap di `<clone>/s-h-observations.json`. Salinan output run final putaran 1 tersimpan di `spikes/s-h/observed.json`; putaran 2 di `spikes/s-h/observations.json`. Base fixture tidak disentuh. Tidak membuat implementasi MCP atau permanent test suite.

Command utama di runner:

```sh
npm install @rikology/adonisjs-tenant@1.0.2 pg@8.16.3
ADONISJS_TENANT_TENANT_ID_TYPE=integer ADONISJS_TENANT_USER_ID_TYPE=integer node ace configure @rikology/adonisjs-tenant
npm ls @rikology/adonisjs-tenant @adonisjs/core @adonisjs/lucid @adonisjs/auth @adonisjs/assembler @poppinss/ts-exec better-sqlite3 pg
# Runner menjalankan command ini dua kali dengan PORT=41140/41141 dan
# SH_RESOLVER=header/subdomain, HOST=127.0.0.1, NODE_ENV=development:
node --import=@poppinss/ts-exec bin/server.ts
```

Fixture membuat dua identitas tenant nyata dari allowlist resolver: `a` dan `b`; tabel `sh_posts` memuat `(id=1, tenant_id=a, title=A private, overlap=7)` dan `(id=2, tenant_id=b, title=B private, overlap=7)`. Shared value `overlap=7` memastikan filter aplikasi yang sama tidak memilih tenant secara kebetulan. Tidak membuat tenant provisioning model; package memang tidak menyediakan provisioning.

Skenario A/B memakai `Promise.all`, delay 20/1 ms, query model, `AsyncFunction` dengan await timer 15 ms + promise, raw SQL, dan HTTP loopback dari dalam handler app. Header mode memetakan `X-Tenant-ID`; host mode memakai `a.tenants.test`/`b.tenants.test` melalui `node:http.request` ke socket loopback, bukan DNS remote. Domain routes eksplisit dipasang untuk `/identity`, `/domain`, dan `/no-middleware`; middleware tenant hanya pada dua route pertama. Wrong/missing mapping diuji melalui `/identity`.

RLS fixture milik host menggunakan `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy `tenant_id = nullif(current_setting('app.tenant_id', true), '')`, dan hanya grant SELECT. `TenantDatabaseExecutor` memakai transaction client yang sama untuk empat query corpus, bukan `db.rawQuery` global di dalam callback.

## Hasil teramati

Run final exit 0; excerpt output asli:

```text
[ success ] @rikology/adonisjs-tenant configured successfully!
PASS header: model/eval isolation, raw SQL bypasses, loopback mapping/fail-closed, forced PostgreSQL RLS and reset
PASS subdomain: model/eval isolation, raw SQL bypasses, loopback mapping/fail-closed, forced PostgreSQL RLS and reset
waiting for server to shut down.... done
server stopped
```

✅ **Context tidak bocor:** kedua resolver menghasilkan A `model:["a"], evalIds:["a","a"], after:"a"` dan B `model:["b"], evalIds:["b","b"], after:"b"`. `outsideBefore`, `outsideAfter`, `outsideFinal` semuanya `null`. Binding `tenant.service` ada dan identik dengan export `TenantService`.

✅ **Missing tenant fail-closed pada scoped model:** `modelMissing:{ok:false,code:"E_TENANT_NOT_RESOLVED"}`. Executor RLS tanpa context memberi kode yang sama.

✅ **Wrong/missing tenant HTTP gagal eksplisit:** untuk A dan B pada kedua resolver, `socketMissing` dan `socketWrong` berstatus `404`, body `"Tenant not found"`.

✅ **ALS tidak menyeberangi socket:** request `/no-middleware` dari context A/B menghasilkan `200,{"alsTenant":null}` walaupun mapped Host/header diberikan. Middleware diperlukan.

✅ **Host/header mapping dan domain routing benar:** `socketMapped` memberi `200,{"middlewareTenant":"a","alsTenant":"a","rows":["a"]}` untuk A, analog B. `socketMappedOther` dari caller A memberi tenant B dan sebaliknya: request resolver, bukan ALS caller, menentukan tenant. `/domain` pada kedua domain memberi tenant sesuai Host.

❌ **Package bukan enforcement raw SQL shared-table:** di context A maupun B, `db.rawQuery` membocorkan `["a","b"]` untuk semua bentuk berikut (query benar `WHERE tenant_id = ?` hanya mengembalikan tenant yang dipilih):

```sql
SELECT * FROM sh_posts WHERE tenant_id = ? OR 1=1 ORDER BY id;
SELECT * FROM sh_posts /* WHERE tenant_id = 'a' */ ORDER BY id;
SELECT * FROM sh_posts WHERE tenant_id = ? UNION SELECT * FROM sh_posts ORDER BY id;
```

✅ **Boundary FORCE RLS host membatasi corpus predicate bypass:** melalui executor + role non-bypass, seluruh empat query menghasilkan hanya `["a"]` untuk A dan `["b"]` untuk B. Session output `current_user:"sh_reader", setting:"a"/"b"`. Sesudah transaksi, `rlsOutside:[]` dan `rlsPoolSetting:[{"setting":null}]`. Error `42P01` pada tabel nonexistent di A tidak merusak operasi berikutnya: `rlsAfterError:["b"]`.

❌ **RLS berbasis GUC ini bukan izin arbitrary SELECT:** dalam executor tenant A, `SELECT set_config('app.tenant_id', 'b', true)` lalu `SELECT * FROM sh_posts` menghasilkan `rlsContextOverride:{"alsTenant":"a","rows":["b"]}`. ALS tetap benar; setting DB dapat diganti oleh SQL yang diizinkan role ini. Jadi package + contoh RLS saja tidak membuktikan safe generic SQL.

❌ **Programmatic API tidak memvalidasi tenant unknown:** `TenantService.run({id:'unknown',...})` menghasilkan `unknownProgrammatic:{"active":"unknown","rows":[]}`, bukan error. API ini menerima identitas yang sudah dipercaya; resolver/adapter harus melakukan lookup/authorization lebih dahulu. Missing context berbeda dari identitas unknown.

Run awal dihentikan oleh timeout command 300 s sebelum diagnosis tampil; runner sekarang memiliki fetch deadline dan shutdown SIGKILL fallback. Percobaan berikutnya mengungkap placeholder `?` di komentar yang dihitung Knex walau tidak dieksekusi SQL; probe diperbaiki menjadi literal komentar. Percobaan host pertama memakai Node fetch dan mapping tidak mencapai server; diganti `node:http.request`. Percobaan domain berikutnya mengungkap root route tidak otomatis tersedia pada domain yang sudah mempunyai group routing; probe sekarang memasang route pada kedua domain secara eksplisit. Semua kasus final memakai setup yang dijelaskan di atas.

Semua proses app dan PG dihentikan; `lsof -nP -iTCP:41140 -iTCP:41141 -iTCP:55442 -sTCP:LISTEN` setelah run tidak menemukan listener. Cluster timeout pertama juga distop dan dihapus; cluster final dihapus runner. Clone dipertahankan untuk review.

## Referensi API/source

Semua path berikut relatif terhadap clone. Package published, bukan local source `../adonisjs-tenant`.

| API / fakta yang dipakai | Referensi dan klasifikasi |
| --- | --- |
| Configure hook, env identifier type, provider/named middleware/config stub | **Public/documented**: `node_modules/@rikology/adonisjs-tenant/README.md:5-55` (1.0.2); **internal implementation evidence**: `build/configure-CCw-EAFc.js:49-62,98-128` |
| `defineTenancyConfig`, root exports `TenantService`, `runWithTenant`, `getTenantContext` | **Public/documented**: tenant README `:19-41,145-155,226-235` (1.0.2) |
| Binding `tenant.service`, provider resolver names/config | **Internal source evidence**: tenant `build/providers/tenancy_provider.js:9-15,30-52` (1.0.2); binding dipanggil melalui public container API dan dibuktikan runtime |
| `TenantService.run/get/require/currentId` | **Public API**, source evidence tenant `build/authenticator-CXdtQWvk.js:11-41` (1.0.2) |
| AsyncLocalStorage `storage.run`, propagation wrapper | **Internal source evidence**: tenant `build/tenant_context-iB4Yz-Lv.js:1-18` (1.0.2). Tidak mengimpor chunk private dari probe |
| `TenantScope(BaseModel)`, `tenant_id`, find/fetch/paginate hooks, escape hatches | **Public/documented**: tenant README `:117-143`; **internal implementation evidence**: `build/tenant_scope-Djq6Nwcm.js:33-38,76-140` (1.0.2) |
| Named `TenantMiddleware`, `ctx.tenant`, failOnMissing | **Public/documented**: tenant README `:43,77-90`; source `build/src/middleware/tenant_middleware.js:22-37` (1.0.2) |
| Header/subdomain resolver lookup | **Public/documented**: tenant README `:57-73`; source `build/path_resolver-AqE_tt6j.js:6-49` (1.0.2). JWT/path tersedia juga; JWT hanya decode, bukan signature verification (`:53-94`) |
| `TenantDatabaseExecutor.run`, same transaction, transaction-local GUC | **Public/documented**: tenant README `:206-224`; public subpath `build/src/tenant_database_executor.js:9-18`, type `build/src/tenant_database_executor.d.ts:6-19` (1.0.2) |
| Lucid `db.rawQuery`, `.connection`, `.table().insert`, transactions, model `.query`, BaseModel/column | **Public/documented**: [Raw queries](https://docs.adonisjs.com/guides/database/raw-query-builder), [Models](https://docs.adonisjs.com/guides/database/lucid), [Transactions](https://docs.adonisjs.com/guides/database/transactions); source `node_modules/@adonisjs/lucid/build/src/database/main.js:71-101,148-149,174-181` (22.4.2) |
| Router `.get/.domain/.use`, named middleware, HttpContext | **Public/documented**: [Routing](https://docs.adonisjs.com/guides/basics/routing), [Middleware](https://docs.adonisjs.com/guides/basics/middleware), [HTTP context](https://docs.adonisjs.com/guides/concepts/http-context) (Core 7.6.0) |
| `app.container.hasBinding/make` | **Public/documented**: [Dependency injection](https://docs.adonisjs.com/guides/concepts/dependency-injection) (Core 7.6.0); no direct private map access |
| Node request, subprocess, timers, promises, ALS | **Public/documented**: [HTTP request](https://nodejs.org/docs/latest-v24.x/api/http.html#httprequestoptions-callback), [child_process](https://nodejs.org/docs/latest-v24.x/api/child_process.html), [timers](https://nodejs.org/docs/latest-v24.x/api/timers.html), [Async context](https://nodejs.org/docs/latest-v24.x/api/async_context.html), [Promise.withResolvers](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/withResolvers) |
| Eval-like `AsyncFunction` | **Public/documented**: [AsyncFunction constructor](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncFunction/AsyncFunction). Bukan sandbox |
| PG RLS policy, FORCE, role, current_setting/set_config | **Public/documented**: [PostgreSQL 18 row security](https://www.postgresql.org/docs/18/ddl-rowsecurity.html), [CREATE ROLE](https://www.postgresql.org/docs/18/sql-createrole.html), [configuration functions](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-ADMIN-SET) |

API strategi yang ditemukan: **shared-table `tenant_id` opt-in model mixin**; **PG RLS executor opt-in**, policies/roles milik host. Tidak ada built-in schema search_path strategy, per-tenant database selector, provisioning, atau migration RLS otomatis pada public export/config yang diperiksa. Ini inventory public package 1.0.2, bukan klaim bahwa app tidak dapat membangun strategi sendiri.

## Keterbatasan

- Dua tenant dan finite interleaving, bukan stress test/HMR atau seluruh Lucid relations/mutations. Query plain structured predicate diuji; mixin punya escape hatch unrestricted, sehingga eval/app code tetap trusted.
- RLS diuji dengan policy host buatan spike, bukan konfigurasi default package. Mode read-only/cancellation seluruh SQL adalah S-G; spike ini tidak mengklaim arbitrary SQL aman.
- Schema/database-per-tenant tidak tersedia sebagai strategi package 1.0.2 dan tidak diimplementasikan sendiri dalam spike. Rekomendasi di bawah adalah requirement, bukan bukti runtime strategi tersebut.
- JWT/path resolver hanya source inventory; tidak dijalankan. Host/header lookup bukan user authorization; mengirim identitas valid B dari caller A memang menghasilkan B. Wrong berarti ID/Host unknown, bukan bukti denial membership pengguna terhadap tenant yang valid.
- Tenant provisioning/membership migration generated configure tidak dijalankan: tabel fixture tenant-scoped dibuat langsung, dan Auth tetap configured/booted tanpa menguji tenant-aware login (S-F/S-K).
- Tidak memasang MCP endpoint/tools: penolakan raw SQL sebagai policy MCP dan lookup input programmatic masih obligation M4. File probe sengaja menampilkan bypass, bukan solusi production atau fake integration.
- Run no-argument memakai clone baru; hasil yang diamati memakai argumen clone eksplisit. Runner hanya mendukung Homebrew PG path pada lingkungan ini; environment/package resolution berikutnya dicetak ulang oleh runner.

## Keputusan dan dampak

**Per kriteria plan:** context no-leak **lulus** (model/eval/HTTP); wrong/missing HTTP dan missing scoped model **lulus**; unknown programmatic **gagal otomatis, wajib lookup adapter**; raw SQL hanya berdasarkan teks **gagal sebagai enforcement, keputusan D11 dikonfirmasi dengan bypass nyata**. Status M0 **LULUS BERSYARAT**: API integrasi nyata diketahui, tetapi tidak ada izin mengaktifkan default generic raw SQL dengan package/context saja.
Putaran 2 di bawah menutup dua gap review dengan hasil nyata: evaluator terpilih S-E membawa tenant context/model instance yang benar, dan recipe dedicated PostgreSQL reader S-G digabung dengan RLS serta tenant setting milik adapter. Status tetap **LULUS BERSYARAT**, karena subset AST probe belum menjadi validator production.

D11 diperkuat: bahkan label “RLS tersedia” tidak cukup jika caller SQL dapat mengubah identity GUC. D12 dikonfirmasi: caller ALS tidak melewati socket, mapping app middleware harus dipercaya/terverifikasi. Tidak ada perubahan D01–D10/D13–D20. `ToolContext` tenant harus berasal dari lookup/authorization per call; `TENANT_SCOPE_REQUIRED` tetap error untuk operasi raw tanpa boundary. WP-18/WP-21/WP-36 membutuhkan adapter resolution dan negative corpus ini; WP-16 memakai keputusan S-G untuk read-only safe subset, bukan regex `WHERE tenant_id`.

Policy yang direkomendasikan per strategi:

| Strategi | Default raw-SQL policy |
| --- | --- |
| Shared-table hanya TenantScope/ALS | **Tolak** raw SQL tenant secara default; arahkan `query_model` lewat TenantScope. `allowCrossTenant:true` hanya keputusan operator eksplisit, hasil ditandai cross-tenant |
| Shared-table PG FORCE RLS + executor | **Tetap tolak generic SQL**; putaran 2 membuktikan subset terbatas melalui **MCP-owned dedicated pg reader**, bukan transaction executor app pool. Adapter menetapkan GUC dengan trusted parameterized extended statement di READ ONLY tx; user SQL melewati AST deny function/role/multi-statement, forced extended protocol, external deadline, ROLLBACK + DISCARD ALL. Enable hanya bila policies/least privilege/trusted relations/subset terbukti; executor package sendiri tidak memenuhi recipe |
| Schema-per-tenant host-owned | **Unsupported/default tolak** sampai grants membatasi schema lain. `search_path` saja tidak cukup: qualified schema/SET bypass. Tidak fallback ke connection global; perlu bukti role permissions dan reset pool |
| Database-per-tenant host-owned | **Unsupported/default tolak** sampai trusted lookup memilih connection tenant dan credential tidak dapat membaca DB tenant lain. Tidak menerima connection arbitrer atau fallback global; butuh bukti nyata sebelum enable |

- OBL: WP-18 harus lookup dan authorize identitas tenant sebelum `runWithTenant`/`TenantService.run`; unknown ID ditolak eksplisit, bukan context palsu dengan empty result.
- OBL: WP-16/WP-18 harus menolak raw SQL shared-table tanpa boundary DB; kehadiran `tenant_id` pada predicate/comment/UNION bukan enforcement.
- OBL: RLS berbasis `app.tenant_id` harus memakai MCP-owned dedicated reader recipe S-G + trusted adapter tenant setting, AST deny functions/role/multi-statement, forced extended protocol, READ ONLY, external cancellation, ROLLBACK + DISCARD ALL; jangan memakai executor Lucid app pool atau mengklaim executor saja aman.
- OBL: WP-19/WP-21 harus memakai trusted Host/header mapping melalui middleware aplikasi; Node HTTP Host override harus diuji, dan domain route matching tidak boleh diasumsikan jatuh ke root routes.
- OBL: Schema/database-per-tenant memerlukan adapter host + bukti grants/connection isolation/reset sebelum raw SQL enabled; package 1.0.2 tidak menyediakan strategi itu.

Tidak ada BLOCKER dependency untuk model/eval/HTTP. Generic tenant SQL pada setup yang diuji sengaja tidak mendapat klaim aman; pilihan konkret adalah default deny atau boundary/SQL subset terverifikasi di atas, bukan package upstream mock/fallback.

## Putaran 2 — rekonsiliasi review

**P2-a dan P2-b terselesaikan dengan observasi integrasi, bukan penggantian scope.** Putaran 1 tetap menyimpan bukti bypass unrestricted executor. Putaran 2 memilih recipe M4 yang tidak menggunakan executor tersebut. Command aktual:

```sh
node spikes/s-h/run.mjs /tmp/adonisjs-mcp-m0/s-h-api
```

Runner sekarang memasang `pgsql-ast-parser@12.0.1` (terlihat pada `npm ls`), menyalin `round2.ts` ke `start/round2.ts`, dan memasang `evaluator_round2.mjs` sebagai `node_modules/@sh/tenant-evaluator/index.mjs` pada clone. Tidak mengubah paket tenant, S-E, atau S-G. Dua putaran observasi pada kedua resolver dipersist ke **`spikes/s-h/observations.json`**, bukan hanya ke `/tmp`; runner menyimpan seluruh response JSON sebelum assertions.

### P2-a — dedicated reader + tenant RLS

`new pg.Client` per tenant adalah reader yang dimiliki probe sebagai calon ownership MCP, **bukan** `db.connection(...).transaction()` dan bukan client dari pool Lucid. Role `sh_reader` memiliki SELECT pada satu trusted base table dan `NOSUPERUSER NOBYPASSRLS`. Control cancellation adalah Client terpisah dengan role least-privilege yang sama, bukan memakai pool app/superuser.

Urutan nyata per statement (termasuk setiap read tanpa bindings):

1. Parse seluruh input (`parse`, bukan parseFirst); exactly-one read-select/union root; recursive allowlist known typed AST nodes/operator/relasi, function/mutation/role/unknown grammar ditolak.
2. Dedicated reader: `{text:'BEGIN READ ONLY', values:[], queryMode:'extended'}`.
3. **Adapter trusted**, bukan user statement: `{text:"SELECT set_config('app.tenant_id', $1, true)", values:[resolvedTenant.id], queryMode:'extended'}`. Snapshot DB membuktikan readonly=`on` dan tenant A/B benar.
4. Hanya input ALLOW dikirim: `{text:userSQL, values:bindings, queryMode:'extended'}`. Timer eksternal reader deadline 300 ms memakai control `pg_cancel_backend(readerPid)`.
5. Clear timer, await cancellation bila terjadi, `ROLLBACK`, kemudian `DISCARD ALL` **di luar transaksi**, seluruhnya pada reader sendiri.
6. Snapshot reader reset + operasi berikutnya; reader akhirnya `.end()`. Tidak ada user statement/set/reset/cleanup yang dikirim ke app pool.

Source-backed extended protocol dipaksakan bahkan values kosong. Hasil `submitted:[]` pada DENY membedakan penolakan sebelum DB dari query yang benar-benar dieksekusi; bukan empty result sebagai keberhasilan.

| Corpus user SQL | Policy/hasil A | Policy/hasil B |
| --- | --- | --- |
| SELECT plain (tanpa predicate tenant) | ALLOW, hanya A | ALLOW, hanya B |
| WHERE tenant_id = $1 | ALLOW, hanya A | ALLOW, hanya B |
| WHERE tenant_id = $1 OR 1=1 | ALLOW, hanya A | ALLOW, hanya B |
| komentar WHERE tenant_id = 'a' | ALLOW, hanya A | ALLOW, hanya B |
| WHERE tenant_id = $1 UNION SELECT semua baris | ALLOW, hanya A | ALLOW, hanya B |
| SELECT set_config('app.tenant_id','b',true) | DENY `unsupported AST node call`; submitted=[] | DENY; submitted=[] |
| SET ROLE postgres | Parser fail-closed; submitted=[] | Parser fail-closed; submitted=[] |
| SELECT; set_config; SELECT | DENY `exactly one statement required`; submitted=[] | DENY; submitted=[] |
| SELECT pg_sleep(30) | DENY `call`; submitted=[] | DENY `call`; submitted=[] |

✅ **Combined boundary:** seluruh statement ALLOW di kedua reader benar-benar dieksekusi dan hanya memuat row tenant target. OR/comment/UNION dibatasi oleh FORCE RLS, bukan string matching. Seluruh function/role/multi-statement yang diminta review ditolak sebelum DB.

✅ **Tenant setting inside READ ONLY terbukti bekerja:** setiap `txState` memuat `readonly:"on", tenant:"a"/"b"`; parameter setting diambil dari `TenantService.require()`, bukan teks user SQL.

✅ **External deadline + recovery:** trusted fault injection `SELECT pg_sleep(30)` sengaja melewati AST policy hanya untuk menguji cancellation, bukan user statement yang diizinkan. Dengan tenant GUC aktif di READ ONLY tx, cancellation 100 ms memberi `canceling statement due to user request`: header A/B **104/103 ms**, subdomain A/B **103/104 ms**. Setelah cancellation + rollback/discard, observer menunjukkan `state:"idle", xact_start:null` dan reader memberi `healthy:42`.

✅ **Cleanup normal/denied:** setiap snapshot setelah statement menunjukkan `readonly:"off", tenant:null, application:"", timeout:"0"`. Dedicated reader A/B masih terpisah pada proses backend dan tidak berbagi app backend.

✅ **App pool tidak direkonfigurasi/di-reset/dipakai user SQL:** hanya dibaca snapshot observasional before/after. Header app PID **16980 → 16980**, dedicated readers **16983/16984**; subdomain app PID **17041 → 17041**, readers **17044/17045**. Semua app fields identik before/after: `application:"", timeout:"0", readonly:"off", tenant:null`. Tidak menjalankan DISCARD ALL, set_config, transaction, cancellation atau user corpus pada app pool pada putaran 2.

**Executor package reusable? Tidak secara langsung untuk recipe ini.** Public `TenantDatabaseExecutor.run()` (1.0.2 `build/src/tenant_database_executor.js:13-18`) memanggil `database.transaction(...)` Lucid dan `trx.rawQuery("SELECT set_config(..., ?, true)")`, tanpa kontrol public READ ONLY/extended-protocol/deadline/session discard. Membuat wrapper yang mengimplementasikan seluruh recipe pada contract `transaction/rawQuery` tetap berarti MCP mengimplementasikan ownership/DB executor sendiri; reuse wrapper tersebut tidak menghilangkan tanggung jawab. Solusi terpilih: reuse **public tenant resolution/context**, tetapi MCP memiliki pg reader/transaction/setup/SQL validation/deadline/reset sendiri, mengikuti S-G.

### P2-b — evaluator terpilih S-E di bawah node_modules

File evaluator hosted benar-benar:

```text
file:///private/tmp/adonisjs-mcp-m0/s-h-api/node_modules/@sh/tenant-evaluator/index.mjs
```

`vm.compileFunction` memakai filename `/private/tmp/adonisjs-mcp-m0/s-h-api/eval-call.mjs` dan `importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER` seperti kandidat terpilih S-E. Eval code melakukan natural `await import('@rikology/adonisjs-tenant')`, `await import('#models/probe_post')`, dan import timer promises; delay A/B **25/1 ms** memaksa interleaving. Query real `Model.query().where('overlap',7)` berada **di dalam eval**, bukan proxy query sebelum/selepas evaluator.

✅ Hasil eval A: `{"before":"a","after":"a","sameModel":true,"tenants":["a"]}`.

✅ Hasil eval B: `{"before":"b","after":"b","sameModel":true,"tenants":["b"]}`.

✅ `sameModel:true` membuktikan natural import mengembalikan instance model app yang sama; root package tenant yang diimpor eval membaca context ALS yang sama. Sesudah kedua callback, `outsideTenant:null`.

Output asli run final:

```text
ExperimentalWarning: vm.USE_MAIN_CONTEXT_DEFAULT_LOADER is an experimental feature and might change at any time
PASS round2 header: app-root vm evaluator ALS/import/model identity; dedicated READ ONLY + RLS + AST + extended protocol; deadline/reset; app pool unchanged
PASS round2 subdomain: app-root vm evaluator ALS/import/model identity; dedicated READ ONLY + RLS + AST + extended protocol; deadline/reset; app pool unchanged
waiting for server to shut down.... done
server stopped
```

Node vm tetap **experimental**, bukan sandbox atau hard JS preemption. Source/refs tambahan:

- **Public/documented**, Node 24 [vm.compileFunction](https://nodejs.org/docs/latest-v24.x/api/vm.html#vmcompilefunctioncode-params-options), [USE_MAIN_CONTEXT_DEFAULT_LOADER](https://nodejs.org/docs/latest-v24.x/api/vm.html#vmconstantsuse_main_context_default_loader); `spikes/s-h/evaluator_round2.mjs:1-13` adalah probe minimum resolver S-E, bukan framework internal.
- **Public API dengan internal source evidence**, pg 8.16.3 `node_modules/pg/lib/query.js:14-19,35-57`: `queryMode:'extended'` menyebabkan preparation walau values kosong; [node-postgres query config](https://node-postgres.com/apis/client).
- **Public/documented**, pgsql-ast-parser 12.0.1 `parse`: [package API](https://www.npmjs.com/package/pgsql-ast-parser), `node_modules/pgsql-ast-parser/parser.d.ts:19-23`; unknown grammar gagal tertutup. Pure JS AST bukan PostgreSQL native grammar/security proof lengkap.
- **Public/documented**, PostgreSQL 18 [READ ONLY](https://www.postgresql.org/docs/18/sql-set-transaction.html), [DISCARD ALL](https://www.postgresql.org/docs/18/sql-discard.html), [pg_cancel_backend](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL). Tidak ada dependency/private API baru pada tenant package.

**Secret scan artifact:** regex `APP_KEY|Authorization|Cookie|Bearer|password|secret|[A-Za-z0-9+_-]{40,}={0,2}` case-insensitive pada `spikes/s-h/observations.json` menghasilkan **No matches found**. Scan awal yang memasukkan `/` juga hanya menemukan app-root/tmp evaluator paths, bukan credentials. Artifact tidak merekam `.env`, APP_KEY, auth headers atau cookies. Semua reader/control Client ditutup, server app distop, PG cluster distop/dihapus runner; pemeriksaan listener 41140/41141/55442 setelah run kosong.

**Keputusan final putaran 2:** P2-a **lulus untuk subset corpus teramati**, P2-b **lulus**. D11/D12 tetap; update ownership WP-16/WP-18 mengikuti dedicated SQL reader S-G, bukan app pool executor. Rekomendasi raw SQL shared-table tanpa RLS tetap deny. Shared-table RLS dapat mendukung supported subset dengan combined recipe, **tidak** melegalkan arbitrary SQL atau app-defined view/operator/function behavior. Schema/database strategies tetap belum terbukti.

- OBL: WP-16/WP-18 harus memakai MCP-owned dedicated pg reader + least-privilege/control connection, trusted parameterized tenant setup dalam READ ONLY tx, forced extended setiap user statement, AST allowlist, external deadline, ROLLBACK + DISCARD ALL; close/discard connection jika cleanup gagal.
- OBL: WP-18 harus reuse tenant public lookup/context, bukan menjalankan tenant package executor pada pool app untuk MCP SQL; kebijakan relation/view/operator/unknown AST memerlukan security regression sebelum release.
- OBL: Tenant eval integration memakai evaluator final S-E, dengan concurrency/natural-import/model-instance tests; experimental loader tetap version-tested, bukan sandbox. Catatan integrasi: putaran ini memakai main-context default loader, sedangkan S-E putaran 2–3 menunjukkan loader itu gagal untuk fresh import controller/service; propagasi ALS di atas tidak bergantung pada loader, tetapi regression tenant eval wajib diulang dengan mekanisme `app.import` callback S-E.

Tidak ada BLOCKER teknis baru pada recipe subset yang diuji. Obligation lookup/authorization, trusted HTTP mapping, dan strategi schema/database putaran 1 tetap berlaku.
