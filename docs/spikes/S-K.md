# S-K — Identitas dan introspeksi tenant, permission, queue
Status: LULUS BERSYARAT
Tanggal: 2026-10-13

## Pertanyaan
Cari API aktual paket tenant, permission, queue yang disebut desain. Lulus bila nama package/version, binding, public API, dan fixture nyata ditetapkan; package/API tidak tersedia harus menjadi dependency blocker, bukan mock atau empty success.

## Lingkungan
- macOS 27.0, build 26A428, arm64; Node v24.21.0; npm 11.19.0.
- Fixture API create-adonisjs 3.4.0, SQLite; base tidak diubah. Clone awal `/tmp/adonisjs-mcp-m0/s-k-api`; clone fresh yang dibuktikan `/tmp/adonisjs-mcp-m0/s-k-api-1791855655276`.
- Exact resolved `npm ls`: `@adonisjs/core@7.6.0`, `@adonisjs/assembler@8.5.2`, `@adonisjs/auth@10.1.0`, `@adonisjs/lucid@22.4.2`, `@adonisjs/bouncer@4.0.1`, `@rikology/adonisjs-tenant@1.0.2`, `@adonisjs/queue@0.6.2`, `@boringnode/queue@0.6.0`, `@adonisplus/permissions@0.0.4`, `better-sqlite3@13.0.3`.
- HTTP `127.0.0.1:41200`, development; tidak menjalankan worker, Redis, PostgreSQL, scheduler, atau MCP SDK (tidak dibutuhkan untuk identitas API).

## Skenario dan command
Dari root repository:

```sh
# Clone fresh, install exact integrations, configure, boot HTTP, observe, terminate.
node spikes/s-k/run.mjs
# Atau ulangi pada clone milik spike ini saja:
node spikes/s-k/run.mjs /tmp/adonisjs-mcp-m0/s-k-api-1791855655276
```

Entry script memakai `spikes/clone-fixture.sh api s-k-api-<timestamp>`, memasang provider tenancy, Bouncer dan queue; membuat `config/tenancy.ts`, `config/queue.ts`, serta `start/permissions.ts` dari probe lokal. Server dijalankan dengan `node --import=@poppinss/ts-exec bin/server.ts`, `PORT=41200 HOST=127.0.0.1 NODE_ENV=development`. Runner memanggil GET `/s-k/observe`, menyimpan `s-k-observation.json` di clone, lalu SIGTERM dan fallback SIGKILL. Tidak ada proses yang ditinggalkan.

Probe queue menggunakan database adapter nyata. `QueueSchemaService.createJobsTable()` membuat schema pada SQLite disposable; dua baris fixture (pending dan failed) diinsert langsung melalui Knex sebelum observasi, **bukan dispatch**. `SentinelJob` diload otomatis oleh provider queue. Handler sentinel menaikkan counter dan throw bila dipanggil; counter teramati tetap nol. Tidak ada `Worker.start`, `dispatch`, `pop`, atau evaluasi policy/ability.

Metadata/package discovery yang benar-benar dijalankan:

```sh
npm view @rikology/adonisjs-tenant@1.0.2 version peerDependencies exports repository --json
npm view @adonisjs/queue@0.6.2 version peerDependencies peerDependenciesMeta dist-tags --json
npm view @nemoventures/adonis-jobs@2.2.1 version peerDependencies peerDependenciesMeta engines --json
npm view @rikology/adonisjs-queue --registry=https://registry.npmjs.org --json
npm view @adonisplus/permission --registry=https://registry.npmjs.org --json
npm view @adonisplus/permission --registry=https://plus.adonisjs.com/registry/ --json
npm view @adonisplus/permissions --registry=https://plus.adonisjs.com/registry/ --json
npm view @akago/adonisjs-pg-boss version peerDependencies dependencies repository --json
npm view pg-boss version engines --json
```

Install awal dengan `--registry=https://plus.adonisjs.com/registry/` pada semua dependencies gagal ERESOLVE (`@adonisjs/bouncer@undefined`): registry seluruh package diarahkan salah. Koreksi **scope saja** pada `.npmrc` clone:

```ini
@adonisplus:registry=https://plus.adonisjs.com/registry/
```

Lalu `npm install @adonisplus/permissions@0.0.4` sukses; fresh runner juga sukses. Tidak membaca/mengubah token global atau mencetak credential. Keberhasilan pada workstation ini tidak membuktikan registry terbuka untuk semua pengguna; dokumentasi resmi tetap mensyaratkan access token.

## Hasil teramati
Tabel acceptance utama:

| Domain | Package@version | Binding | Introspection API (public/private) | Backend requirement | Fixture proof |
| --- | --- | --- | --- | --- | --- |
| Tenant | `@rikology/adonisjs-tenant@1.0.2` | `tenant.service` → static class `TenantService` | Public `get`, `require`, `run`, `isActive`, `currentId`; standalone `runWithTenant` | Context/resolver tidak wajib DB; ORM Lucid + physical `tenant_id`; RLS executor PostgreSQL | binding true; export identity true; `run` menghasilkan context fixture; di luar context null |
| Permissions | `@adonisplus/permissions@0.0.4` (plural; private registry) | Tidak ada provider/binding package; exported application singleton `#start/permissions.permissions` | Public `Permissions.all/keys/active/abilities` | Master registry tidak memerlukan DB; role/user mixins memerlukan Lucid columns/pivot | 3 keys, 2 active, metadata inactive+alias nyata; boot HTTP berhasil |
| Abilities/policies alternatif | `@adonisjs/bouncer@4.0.1` | Tidak ada global binding `bouncer`; instance application/request | Public `bouncer.abilities`, `bouncer.policies`, builder `.abilities`; Object.keys tanpa execution | Tidak memerlukan DB untuk registry | 2 abilities, 1 lazy policy key, counter execution 0 |
| Queue terpilih | `@adonisjs/queue@0.6.2` → `@boringnode/queue@0.6.0` | `queue.manager` → `QueueManager` | Public `use().sizeOf(queue)`, `getJob(id,queue)`, `Locator.get(name)`; listing penuh **tidak tersedia**; ledger via opt-in wrapper `Locator.register` bukan API list; status aggregate memakai **internal physical schema** | Database: Lucid PostgreSQL/MySQL/SQLite; Redis optional; sync immediate execution tanpa store durable | auto-registered SentinelJob; pending 1; failed row status failed; counter 0; seluruh baris tidak berubah |

Excerpt output final:

```json
{
  "tenant": {"binding":true,"sameExport":true,"context":{"id":"fixture-tenant","name":"Fixture","slug":"fixture"},"outside":null,"runWithTenantMethod":"undefined"},
  "permission": {"globalBinding":false,"abilities":["viewInvoice","refundInvoice"],"policies":["InvoicePolicy"],"policyExecutions":0},
  "plusPermissions": {
    "keys":["invoice.view","invoice.refund","invoice.legacy"],
    "active":["invoice.view","invoice.refund"],
    "all":[
      {"key":"invoice.view","description":"View invoices","inactive":false,"aliases":[]},
      {"key":"invoice.refund","description":"Invoice refund","inactive":false,"aliases":[]},
      {"key":"invoice.legacy","description":"Invoice legacy","inactive":true,"aliases":["invoice.old"]}
    ],
    "abilities":["invoice.view","invoice.refund"]
  },
  "queue":{"binding":true,"registered":["SentinelJob"],"sentinelRegistered":true,"nativeList":"undefined","pendingTotal":1,"pendingDefault":1,"failed":"failed","stateCountsFromPhysicalSchema":[{"status":"failed","count":1},{"status":"pending","count":1}],"jobExecutions":0},
  "rowsUnchanged":true
}
```

`pendingTotal` adalah nama field probe, **bukan total semua queue**: source adapter menunjukkan `size()` sama dengan `sizeOf('default')`. Jangan mempertahankan nama misleading ini di kontrak MCP.

- ✅ Tenant: package/version, binding, config, tipe, resolver dan API hidup terbukti. Desain `TenantService.runWithTenant` salah: method bernama `run`; `runWithTenant` adalah standalone export.
- ✅ Permission: nama aktual plural diketahui, installed dan registry public dibaca tanpa menjalankan policy/ability. Bouncer juga positive fixture alternatif, bukan replacement RBAC yang diam-diam dianggap identik.
- ✅ Queue: package/version, binding, database driver, registered job nyata dan pending/state terbukti tanpa dispatch/execute; state snapshot sebelum/sesudah identik.
- ❌ Queue: zero-config native runtime **enumeration semua registered job** belum tersedia. `Locator` mempunyai `#registry`, public get/register/clear saja. Ledger probe adalah instrumentasi opt-in, tidak membuktikan late attach dapat menemukan job terdahulu.
- ❌ Nama `@adonisplus/permission` singular dan `@rikology/adonisjs-queue` tidak tersedia pada public npm; singular juga E404 pada Plus registry. Ini bukan alasan mengembalikan list kosong.

Alternatif yang diperiksa:

| Kandidat | Fakta metadata/source | Listing tanpa execution | Keputusan |
| --- | --- | --- | --- |
| `../adonisjs-auth` | Local manifest `@rikology/adonisjs-jwt@0.0.0`; JWT guard, token service, JWKS/transport, bukan permissions package | Tidak ada permission registry pada public exports/source yang diperiksa | Bukan target `get_permissions`; repo read-only |
| `@nemoventures/adonis-jobs@2.2.1` | peers Core ^7, Redis ^10, HTTP server ^8 atau ^9; BullMQ ^5.53.2 optional, Workbench/Pro/Prometheus optional; Node >=24 | Belum dibuktikan; memerlukan BullMQ/backend dan pemeriksaan registry package sendiri | Kandidat valid v7, tidak dipilih untuk fixture karena official queue menyediakan SQLite nyata tanpa external service |
| `@akago/adonisjs-pg-boss@1.1.1` | metadata dependency pg-boss ^12.11.1; repo akago-dev/adonisjs-pg-boss; tidak ada peer Core pada metadata hasil query | Belum dibuktikan; native pg-boss inspection bukan registry application job | Alternatif PG spesifik, membutuhkan fixture PG sebelum claim |
| `pg-boss@12.37.1` | Node >=22.12; library PostgreSQL, bukan Adonis provider | API/backend berbeda, tidak menjamin registry class aplikasi | Host-owned adapter mungkin; tidak diboot pada S-K |
| `henriquealbert/adonisjs-jobs` GitHub | README web: pg-boss, boot discovery, `job.raw` | Belum diperiksa source/runtime | Jangan menyamakan dengan npm `adonisjs-jobs@0.4.0`: metadata npm itu BullMQ, bukan pg-boss |

Queue official masih **experimental** menurut docs. Pin exact version; keberadaan v7 peer bukan sertifikasi semua backends.

## Referensi API/source
Semua path berikut relatif terhadap root clone (`node_modules/...`). Public artinya exported/documented contract; melihat implementasi public API tidak membuat API tersebut private.

- Tenant 1.0.2: `@rikology/adonisjs-tenant/build/providers/tenancy_provider.js:9-15,30-52` — binding/config lifecycle **public provider**, resolver mapping implementation internal. `build/index.js:15-19` — public exports/defineTenancyConfig. `build/src/types.d.ts:10-40,62-66` — public `TenantContext {id:string|number,name,slug}`, discriminated resolver config subdomain/header/jwt/path, TenancyConfig. `build/src/tenant_service.d.ts:9-29` — public static API. `build/src/resolvers/header_resolver.d.ts:6-19` — public lookup/map options. `build/src/tenant_database_executor.d.ts:10-19` — public PostgreSQL RLS executor, host-owned policy enforcement. `README.md:119-143,206-242` — DB requirements/escape hatches. [Repository](https://github.com/rikoriswandha/adonisjs-tenant), [npm](https://www.npmjs.com/package/@rikology/adonisjs-tenant).
- Tenant export subpaths metadata: `.`, `./configure`, `./types`, `./database`, `./middleware`, `./guards`, `./mixins`, `./resolvers`, `./extensions`, `./user_providers`, `./providers/tenancy_provider`; public types also `TenantResolverContract`, `TenantConfig`, `TenantUserProviderContract`, `TenantGuardFactory`, `TenancyConfig`.
- Permission 0.0.4: `@adonisplus/permissions/package.json:16-19` — public exports `.`, `/types`, `/configure`; **no provider**. `build/stubs/start/permissions.stub:4-13` — documented application registry convention. `build/index.d.ts:1-7`, `build/src/define_permissions.d.ts:8-22,51-63` — public classes/functions and enumeration. `build/src/types.d.ts:8-25` — public metadata schema. `build/index.js:330-343,412` — public query implementation; methods do not evaluate abilities. [Official registry installation](https://plus.adonisjs.com/docs/packages/installation), [announcement (historical singular name)](https://adonisjs.com/blog/introducing-persona-and-permission), [terms](https://plus.adonisjs.com/terms). Tidak menyalin source berlisensi privat ke repository.
- Bouncer 4.0.1: `@adonisjs/bouncer/build/src/bouncer.d.ts:63-88` — public instance registries; `build/src/abilities_builder.d.ts:14-21,34` — public builder. `build/providers/bouncer_provider.js:39-45` — provider hanya emitter/Edge, bukan global ability registry. [npm](https://www.npmjs.com/package/@adonisjs/bouncer).
- Queue 0.6.2: `@adonisjs/queue/build/index.js:9-14` — public reexports; `build/providers/queue_provider.js:16-49` — public provider lifecycle/binding, internal ordering reviewed. `build/src/drivers.js:18-40` — public Redis/database/sync factories. [Official queue docs](https://docs.adonisjs.com/guides/digging-deeper/queues), [repository](https://github.com/adonisjs/queue).
- Boringnode queue 0.6.0: `@boringnode/queue/build/index.d.ts:250-270,337-428` — public QueueManager.use and Locator contract. `build/job-C4oyCVxR.d.ts:949,1006-1013` — public Adapter.getJob/size/sizeOf. `build/src/drivers/knex_adapter.js:138-147,337-342` — implementation of public read APIs, confirms pending-only/default semantics. `build/index.js:720-751` — public QueueSchemaService creates **internal physical table layout**. `build/chunk-AHUVTAI7.js:31-46,66-78` — **private** #registry; public register wrapper observes boot loading, unsupported instrumentation seam rather than official observer API.
- Local JWT: `../adonisjs-auth/package.json:2-24`, `src/types.ts:70-95`, `src/define_config.ts:93-98` — read-only source/export evidence, not installed integration.
- Alternative metadata URLs: [BullMQ Adonis jobs](https://www.npmjs.com/package/@nemoventures/adonis-jobs), [repository](https://github.com/nemoengineering/adonis-jobs), [PG addon](https://www.npmjs.com/package/@akago/adonisjs-pg-boss), [pg-boss](https://www.npmjs.com/package/pg-boss), [other PG repository](https://github.com/henriquealbert/adonisjs-jobs). Metadata-only tidak diberi label runtime proof.

## Keterbatasan
- Tidak menguji tenant isolation/RLS/auth scope, host/header request mapping, worker execution, HMR, production absence, atau MCP protocol. S-H dan spike lain memiliki cakupan itu.
- `Permissions` adalah singleton aplikasi yang diimport dari path terkonfigurasi; package tidak memberi global binding/discovery. Import file terpercaya dapat menjalankan top-level code pengguna, meski `.all()` sendiri read-only.
- Bouncer instance `null` user cukup untuk registries; tidak melakukan authorization. Policy names diketahui tanpa memanggil lazy loader; nama actions pada policy dinamis tidak dibuktikan.
- Queue ledger dipasang **sebelum** provider loadJobs dan dipulihkan saat shutdown. Late attach, overwrites, clear, application-defined registrars dan HMR memerlukan desain/revalidation; jangan mengirim ledger probe sebagai implementasi package.
- Status count SQL terikat schema queue 0.6.0, bukan generic public queue list API. Hanya known-ID `getJob` dan pending queue count memiliki API publik terbukti.
- SQLite seeded records adalah data fixture fisik, bukan bukti bahwa dispatch, retry, worker, retention atau BullMQ/PG berjalan. Tidak menggunakan fake adapter.
- Runner mem-pin integrations tetapi inherited base dependency lock/transitive range dapat berubah; setiap run mencetak resolved versions. Scope registry instalasi pada workstation ini berhasil; access/license universal tidak dibuktikan.

## Keputusan dan dampak
Tenant lulus; permission dan queue **lulus bersyarat**. Permission fixture bergantung akses Plus berlisensi/credential CI yang sah. Queue configured-location jobs memiliki evidence **config-declared+runtime-verified**, tetapi manual registrations tetap unknown, dan count/filter `status` selain pending memerlukan adapter internal physical table layout yang version-gated. Public `sizeOf` pending dan known-ID `getJob` tidak membuktikan generic all-status enumeration. Putaran 2 menutup blocker Locator dalam supported scope; Putaran 3 memperbaiki cwd semantics. Bukan klaim seluruh private registry dapat dienumerasi atau kontrak `get_queue_jobs(status?)` selesai tanpa syarat.

Pilih adapter tenant 1.0.2, permission plural 0.0.4 + alternatif Bouncer 4.0.1, serta official queue 0.6.2 (SQLite fixture). Tidak mengubah D01–D20: memperjelas D13 evidence config-declared+runtime-verified, D15 binding yang benar-benar ada, D11/D12 tenant identity bukan security boundary. WP-18 memakai `TenantService.run`; WP-27 import registry permission aplikasi terpercaya dan scan **resolved queue.locations yang sama**, lalu verifikasi class identity melalui public `Locator.get`. Public contract `get_permissions` tidak boleh menyamakan ability names dengan RBAC grant user; `get_queue_jobs` harus membedakan configured/registered class, pending count dan persisted state, serta menyatakan manual registrations unknown.

- OBL: Koreksi optional package permission menjadi `@adonisplus/permissions`; resolve exported `permissions` pada configured application module (`#start/permissions` default), jangan mencari binding fiktif atau singular package.
- OBL: Permission fixture CI memerlukan akses/license Plus yang sah; jangan redistribusi package `UNLICENSED`/private atau menyalin source ke tarball MCP. Bouncer adalah alternatif explicit dengan capability/evidence berbeda, bukan pengganti RBAC diam-diam.
- OBL: Tenant adapter gunakan static `TenantService.run(context, callback)` atau standalone `runWithTenant`, bukan method `TenantService.runWithTenant`; authorization, tenant lookup dan DB enforcement tetap milik host/S-H.
- OBL: Queue adapter pin tuple `@adonisjs/queue@0.6.2` + `@boringnode/queue@0.6.0`, pisahkan pending `sizeOf(queue)` dari total/status counts; physical-schema adapter wajib version-gated dan evidence internal eksplisit.
- OBL: Listing queue dibatasi resolved `queue.locations`, verifikasi `Locator.get(name) === importedClass`, dan keluarkan evidence `config-declared+runtime-verified` beserta limitation manual registrations outside configured locations. Blocker Putaran 1 ditutup; native enumeration private registry tetap tidak tersedia.

## Putaran 2 — resolusi blocker

**Verdict: blocker Locator ditutup.** Semua convention/configuration-registered jobs pada fixture ditemukan memakai public config yang sama dan public per-name lookup, tanpa private-registry read atau registration wrapper sebagai dependency listing. Manual registrations di luar config adalah residual gap yang diberi label, bukan empty success atau klaim full coverage seluruh aplikasi.

### Jalur auto-registration sebenarnya

Tuple tidak berubah: Adonis queue 0.6.2 / boringnode queue 0.6.0. Source:

1. `node_modules/@adonisjs/queue/build/providers/queue_provider.js:19-33`: baca resolved `app.config.get('queue')`, init QueueManager dengan `autoLoadJobs:false`. Ini bukan convention directory hardcoded.
2. Provider `start()` pada proses non-console memanggil `QueueManager.loadJobs()` (`:40-45`); console tidak auto-load (`:41-42`). Directory datang dari config `locations`, bukan decorator atau import side effect yang otomatis mendaftarkan setiap class.
3. `node_modules/@boringnode/queue/build/chunk-AHUVTAI7.js:315,340-344`: simpan `config.locations ?? []`; `loadJobs` meneruskan patterns ke public `Locator.registerFromGlob`.
4. File sama `:29-30,66-79`: native Node `fs/promises.glob`, `path.resolve`, dynamic module import, ambil default export. Jika function, nama adalah `JobClass.options?.name || JobClass.name`; panggil public `this.register(name, JobClass)`. Package loader tidak membuktikan `extends Job` di cabang ini, jadi scan probe sengaja mengikuti predicate function yang sama.
5. `:44-46`: register menyimpan class ke **private** `#registry`. `:102-104` dan public declaration `build/index.d.ts:395-408` memberikan `Locator.get(name)` → class atau undefined. `getOrThrow` juga public (`:410-422`) tetapi probe memilih non-throw lookup.

### Reproduksi dan ground truth

```sh
node spikes/s-k/run.mjs
```

Fresh clone yang benar-benar dijalankan: `/tmp/adonisjs-mcp-m0/s-k-api-1791855874761`. Resolved versions sama dengan Putaran 1; HTTP port 41200. Runner terminates owned server sebelum exit 0.

Runner sekarang memasang:
- `app/jobs/sentinel_job.ts`: class `SentinelJob`, pada default convention directory.
- `custom_jobs/external_job.ts`: class `ExternalLocationJob`, di luar default directory; `static options.name = 'external.configured'`.
- `manual_jobs/manual_job.ts`: class `ManualJob`, **di luar seluruh configured globs**; explicit `Locator.register('manual.explicit', ManualJob)` saat preload.
- Public config `locations: ['./app/jobs/**/*.ts', './custom_jobs/**/*.ts']`.

Versi Putaran 2 `spikes/s-k/config_listing.ts` membaca resolved `app.config.get<string[]>('queue.locations', [])`, native glob dengan cwd app root dan `pathToFileURL`, menentukan name lalu **membandingkan identity** dengan `Locator.get(name)`. Ini hanya coincidentally sama dengan loader ketika cwd = app root; reviewer menemukan perbedaannya. Putaran 3 memperbaiki scanner agar mengikuti native glob cwd, `resolve(file)` dan raw `file://${absolutePath}` milik loader tepat. Scanner tidak memanggil loadJobs/register; rejected/non-function/import-error dilaporkan. Bukti Putaran 2 tetap valid untuk cwd = app root, bukan untuk arbitrary cwd.

Wrapper registration Putaran 1 tetap dipakai **hanya sebagai independent fixture ground truth** atas actual `register` calls sebelum provider auto-load. Listing tidak membaca ledger itu. Counter handler semua jobs tetap nol; abilities/policies juga tidak dieksekusi.

Excerpt aktual:

```json
{
  \"queueListing\": {
    \"locations\": [\"./app/jobs/**/*.ts\", \"./custom_jobs/**/*.ts\"],
    \"jobs\": [
      {\"name\":\"SentinelJob\",\"file\":\"app/jobs/sentinel_job.ts\",\"registered\":true,\"evidence\":\"config-declared+runtime-verified\"},
      {\"name\":\"external.configured\",\"file\":\"custom_jobs/external_job.ts\",\"registered\":true,\"evidence\":\"config-declared+runtime-verified\"}
    ],
    \"rejected\": [],
    \"coverage\": \"configured locations only; manual registrations outside locations are not enumerable\",
    \"publicLookup\": \"Locator.get(name)\",
    \"configuredNames\": [\"SentinelJob\", \"external.configured\"],
    \"groundTruth\": [\"SentinelJob\", \"external.configured\", \"manual.explicit\"],
    \"residualGroundTruth\": [\"manual.explicit\"],
    \"expectedConfiguredCoverage\": true,
    \"manualRegisteredLookup\": true
  },
  \"rowsUnchanged\": true
}
```

Output queue juga `jobExecutions:0`, `pendingDefault:1`, `failed:'failed'`; permission `policyExecutions:0`. Runner asserts configured coverage, empty rejected list, manual lookup identity true, exact residual `manual.explicit`, and unchanged **full persisted rows** setelah introspection.

- ✅ 2/2 config-declared jobs ditemukan dan class registration runtime diverifikasi, termasuk custom directory dan `options.name` override.
- ✅ Explicit manual registration nyata ada dan public per-name lookup membuktikannya tanpa instance/execute.
- ✅ Manual job tidak dipalsukan menjadi config-declared: listing melewatkannya dengan limitation eksplisit; fixture ground truth membuktikan tepat satu residual.
- ✅ Listing tidak memerlukan native list API, private property access, worker, dispatch atau policy execution.

### Batas kontrak dan obligation yang tersisa

Coverage seluruh convention/configured locations terbukti; **bukan** full native application registry. Adapter nyata tidak mengetahui nama manual residual secara otomatis (fixture mengetahui lewat independent test ledger), sehingga output wajib menyatakan `manualRegistrations: unknown/notEnumerated`; jangan mengembalikan residual count 0 karena tidak terdeteksi. Host dapat menyediakan explicit manual-job manifest bila membutuhkan coverage tambahan; per-name `Locator.get` memverifikasinya tanpa execute.

Import ulang file trusted dari config tidak mengeksekusi `Job.execute`, tetapi top-level module code masih trusted application code. File baru setelah boot yang belum terload akan menghasilkan `registered:false`; jangan register diam-diam demi introspection. Class dengan name collision harus identity-match, bukan hanya lookup non-null. Dynamic/manual registration dan deleted files bisa di luar scan; limitation ini harus tetap terlihat pada HMR/current-generation evidence.

- OBL: Gunakan resolved public config locations dan aturan loader `options.name || class.name`; identity-match `Locator.get`, report rejected/unregistered/collision cases, jangan memanggil loader yang mutates registry dari tool listing.
- OBL: Label coverage `configured locations` + evidence `config-declared+runtime-verified`; manual registrations di luar config **unknown/notEnumerated** kecuali host memberi manifest eksplisit yang diverifikasi per name.
- OBL: Cache/invalidation mengikuti generation app; import module adalah trusted-code boundary, tidak disebut pure sandbox atau handler execution. Registration ledger Putaran 1 hanya oracle fixture, bukan syarat zero-config listing adapter.


## Putaran 3 — review

Status akhir **LULUS BERSYARAT**, bukan lulus tanpa syarat. Tiga kondisi release/WP-27 yang harus tetap terlihat:
1. Permissions 0.0.4 berasal Plus private registry berlisensi. Install workstation teramati sukses, tetapi fixture CI memerlukan lawful access/credentials dan tidak boleh mendistribusikan package privat.
2. Public queue `sizeOf(queue)` menghitung pending saja; public `getJob(id,queue)` membaca known-ID state. Design `get_queue_jobs(status?)` membutuhkan enumeration/count status lain melalui adapter physical `queue_jobs` layout **internal** yang terikat boringnode 0.6.0, atau API upstream. Bukti satu failed row bukan generic public all-status API.
3. Config listing tidak mengetahui semua manual registrations. Output menyatakan manual outside configured locations unknown/notEnumerated; manifest host diperlukan untuk coverage tambahan.

### Koreksi semantics loader versus listing

Reviewer benar: loader boringnode 0.6.0 memakai `glob(pattern)` tanpa cwd override (`node_modules/@boringnode/queue/build/chunk-AHUVTAI7.js:66-70`), `resolve(file)` relatif `process.cwd()` (`:73`), lalu import raw ``file://${absolutePath}`` (`:74`). Putaran 2 memakai app-root cwd dan `pathToFileURL`, sehingga kesamaan belum terbukti bila cwd berbeda.

`spikes/s-k/config_listing.ts` sekarang memakai **persis** `glob(pattern)`, `resolve(file)` dan raw file URL. Tidak mengganti cwd, tidak menormalisasi ke app root dan tidak mencoba memperbaiki loader saat inspeksi. Output menyimpan `cwd` dan `appRoot`, supaya actual resolution boundary terlihat. Raw URL behavior/escaping limitations package ikut dipertahankan (path dengan `#`/`?` belum diuji; tidak mengklaim support). Kedua imports menggunakan module cache yang sama ketika path resolution sama.

### Command dan output teramati

```sh
node spikes/s-k/run.mjs /tmp/adonisjs-mcp-m0/s-k-api-1791855874761
node spikes/s-k/run.mjs /tmp/adonisjs-mcp-m0/s-k-api-1791855874761 --foreign-cwd
```

Mode kedua meluncurkan **actual HTTP server** dengan entrypoint absolute `.../bin/server.ts`, tetapi subprocess cwd `.../tmp/s-k-foreign-cwd`, bukan mengubah cwd selama request. App root tetap ditentukan entrypoint; globs queue tetap relatif cwd. Tidak ada worker/dispatch atau re-registration untuk menutup mismatch.

Normal cwd:
```json
{
  "cwd":"/private/tmp/adonisjs-mcp-m0/s-k-api-1791855874761",
  "appRoot":"/private/tmp/adonisjs-mcp-m0/s-k-api-1791855874761/",
  "configuredNames":["SentinelJob","external.configured"],
  "groundTruth":["SentinelJob","external.configured","manual.explicit"],
  "residualGroundTruth":["manual.explicit"],
  "expectedConfiguredCoverage":true
}
```

Foreign cwd: package sendiri mengeluarkan warning actual:
```text
No jobs found for locations: ./app/jobs/**/*.ts, ./custom_jobs/**/*.ts. Verify your glob patterns match your job files.
```
Listing dan registration ground truth:
```json
{
  "cwd":"/private/tmp/adonisjs-mcp-m0/s-k-api-1791855874761/tmp/s-k-foreign-cwd",
  "appRoot":"/private/tmp/adonisjs-mcp-m0/s-k-api-1791855874761/",
  "jobs":[],
  "rejected":[],
  "configuredNames":[],
  "groundTruth":["manual.explicit"],
  "residualGroundTruth":["manual.explicit"],
  "expectedConfiguredCoverage":false,
  "manualRegisteredLookup":true
}
```

Queue actual `sentinelRegistered:false` pada foreign cwd, true pada normal cwd. Jadi listing bukan fallback app-root yang mengklaim dua job terdaftar padahal loader tidak menemukannya. Empty configured list pada foreign cwd adalah actual loader result dengan cwd/coverage diagnostics, **bukan** klaim aplikasi tidak memiliki manual job.

- ✅ Normal cwd: package auto-loader dan config listing menemukan 2 configured jobs yang sama.
- ✅ Foreign cwd: package auto-loader menemukan 0 configured jobs; listing juga 0; satu manual registration tetap diketahui oleh fixture oracle/public lookup.
- ✅ Kedua skenario: `jobExecutions:0`, `policyExecutions:0`, persisted `rowsUnchanged:true`; owned servers berhenti, runner exit 0.

### Raw evidence dan secret scan

Artefak raw response disertakan di repository:
- `spikes/s-k/s-k-observation.json` — normal cwd, seluruh response observasi.
- `spikes/s-k/s-k-observation-foreign-cwd.json` — foreign cwd, seluruh response observasi.

Runner menulis response apa adanya ke kedua paths; tidak menyalin `.npmrc`, auth token, private package source, APP_KEY atau cookie. Secret scan kedua JSON dengan pattern `APP_KEY|_authToken|npm_[A-Za-z0-9]+|Bearer |password|cookie|secret|token|authorization|BEGIN .*PRIVATE KEY` (case-insensitive) menghasilkan **No matches found**. Root repository tidak memiliki git, jadi artefak ditambahkan sebagai file deliverable, bukan klaim git commit telah dibuat.

- OBL: Pertahankan LULUS BERSYARAT sampai CI Plus memiliki akses berlisensi sah dan adapter all-status physical schema version-gated dibuktikan untuk accepted `status` contract; jangan menyebut public pending API sebagai all-status API.
- OBL: Listing mengikuti **process.cwd loader semantics**, raw import URL dan `options.name || class.name`, serta mengeluarkan cwd/appRoot + coverage diagnostics. Manual registrations outside locations tetap unknown tanpa host manifest.

