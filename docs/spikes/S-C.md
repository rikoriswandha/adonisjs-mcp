# S-C — Capture log dan exception tanpa mengganti output
Status: LULUS BERSYARAT
Tanggal: 2026-10-13

## Pertanyaan

Tulis log root/child logger dan exception yang ditangani custom handler; request konkuren. Lulus bila log normal tetap keluar sekali, buffer berisi event benar, exception tidak tergandakan, detach berhasil. Jika tidak ada extension point zero-config, dokumentasikan opt-in instrumentation/upstream need, bukan klaim zero-config.

## Lingkungan

- macOS 27.0, build 26A428, arm64; Node v24.21.0; npm 11.19.0.
- API kit create-adonisjs 3.4.0, fixture disposable hasil clone APFS. Base fixture tidak diubah.
- Run final: `/tmp/adonisjs-mcp-m0/s-c-api-88647`; HTTP `127.0.0.1:41040`; `NODE_ENV=development`.
- Exact resolved `npm ls @adonisjs/core @adonisjs/logger @adonisjs/http-server pino`: Core **7.6.0**, logger **7.1.1**, http-server **9.3.1**, Pino **10.4.0**. Fixture juga memakai auth 10.1.0, Lucid 22.4.2, session 8.1.0, Shield 9.0.0, CORS 3.0.0, bodyparser 11.0.4, Tuyau 1.2.2.
- Tidak memasang SDK MCP: spike ini hanya menguji capture dalam app, bukan transport/protokol yang menjadi S-A. Tidak ada source package M1+.

## Skenario dan command

Dari root repository:

```sh
node spikes/s-c/run.mjs
```

Runner menjalankan `bash spikes/clone-fixture.sh api s-c-api-<pid>`, menyalin `capture.ts` dan `provider.ts` ke clone, serta menginstrumentasi **clone saja**:

1. Menambah provider ke `adonisrc.ts`.
2. Menambah `hooks: { streamWrite }` pada logger default, mempertahankan `destination`, `transport`, level, dan semua output yang sudah ada.
3. Menambah `observeException(error, ctx)` hanya ke custom `handle()`. Custom handler mengirim JSON status 500 dengan request ID; custom `report()` menulis log custom lalu tetap memanggil `super.report()`. Ini handler nyata, bukan mock.
4. Menjalankan `node --import=@poppinss/ts-exec bin/server.ts` dengan port 41040.
5. Mengirim 24 GET `/probe/work/:id` secara `Promise.all`; setiap request menulis root, ctx logger, child ctx logger. Delapan request melempar Error dan ditangani custom handler.
6. Membaca state; memeriksa setiap pasangan id/event tepat satu dan semua ctx/child/custom-report/exception request ID cocok response. Root logger sengaja tidak mempunyai request ID: tidak direkayasa lewat ALS.
7. Memanggil `/probe/detach`, mengirim request error ke-25 (`id=30`), memeriksa output tetap ada tetapi buffer tidak berubah dan subscriber kosong.
8. SIGTERM; menunggu exit, memeriksa `shutdown()` provider berjalan. Fallback SIGKILL hanya untuk proses milik runner jika graceful shutdown melewati 5 detik.
9. Proses disposable terpisah mengisi ring untuk membuktikan batas count, bytes, eviction, dan oversized-entry rejection.

Runner mengassert stdout setiap id/event, bukan hanya total. Log lengkap tersimpan dalam clone pada `s-c-stdout.log` dan `s-c-stderr.log`. Tidak mencetak APP_KEY, cookie, atau credential. Semua proses yang dimulai runner final sudah berhenti.

## Hasil teramati

Output run final:

```text
OBSERVATIONS {"concurrentRequests":24,"probeLogRecords":80,"exceptions":8,"custom":{"reports":8,"handles":8},"requestCorrelation":true,"diagnosticCount":8,"diagnosticKeys":[],"detachStopsCapture":true,"subscribersAfterDetach":[0,0],"diagnosticSubscribersAfterDetach":false,"bytes":26105,"dropped":0}
STDOUT_OBSERVATIONS {"probeLines":84,"expected":84,"once":true,"providerShutdown":true,"processStopped":true}
BOUNDS_OBSERVATIONS {"countLimit":128,"initialEvictions":72,"bytes":32272,"retained":16,"oversizedDropped":true}
```

- ✅ **Log normal sekali:** 24 × 3 = 72 log request/child/root sebelum detach; 3 log lagi sesudah detach. Setiap event/id tepat satu di stdout. Custom report masing-masing satu: 8 sebelum dan 1 sesudah detach. Total `probe:true` 84. Log dari `super.report()` adalah event terpisah yang sengaja dibuat app, bukan duplikasi capture; output aslinya tetap dipertahankan.
- ✅ **Buffer benar:** 80 event bertanda probe sebelum detach (72 normal + 8 custom report), setiap id/event tepat satu. Default report dan startup juga melewati hook; filter `probe:true` hanya memisahkan workload terukur. Semua ctx/child/exception terkorrelasi ke request yang benar. Root record tidak memiliki request ID, sesuai perilaku API.
- ✅ **Exception tidak tergandakan:** 8 exception records, walaupun custom `report()` dan custom `handle()` masing-masing dijalankan 8 kali dan report juga memanggil base report. Capture berada pada satu seam `handle()`, bukan ekstraksi setiap log error atau capture report+handle bersamaan.
- ✅ **Detach:** attach/detach dipanggil dua kali (idempotent); subscriber 0/0; diagnostic subscription dilepas (`hasSubscribers=false`); request id=30 tetap logging dan ditangani tetapi snapshots buffer sama persis. SIGTERM menjalankan provider shutdown, proses berhenti.
- ✅ **Bounded buffer:** 200 entry kecil menyisakan 128 dan 72 eviction; entry lebih besar menyebabkan byte eviction hingga 32.272 byte/16 entries; satu entry >32 KiB dibuang tanpa mengubah isi. Slot eviction dibersihkan agar object lama tidak tertahan. Byte limit mengukur serialized payload, bukan total heap overhead.
- ❌ **Zero-config:** tidak dibuktikan. Jalur public yang berhasil memerlukan instrumentation config logger dan handler app. Diagnostic exception start memang terbit 8 kali, tetapi payload memiliki **nol keys**: tidak menyediakan error atau ctx.

## Referensi API/source

Semua `node_modules/...` di bawah relatif terhadap clone run final, bukan source package proyek.

| API/kandidat | Reference exact/version | Klasifikasi dan evaluasi |
| --- | --- | --- |
| Logger configuration menerima Pino options dan destination | `node_modules/@adonisjs/logger/build/src/types.d.ts:10-18` (7.1.1) | **Public types**. Memungkinkan opt-in `hooks.streamWrite`; tidak menyediakan observer setter sesudah logger dibuat. |
| `hooks.streamWrite` | `node_modules/pino/docs/api.md:356-402` (10.4.0) | **Public/documented, diuji live**. String JSON final termasuk bindings/serialization. Hook synchronous, mengembalikan string asli sehingga tidak mengubah output. Tidak ada method public untuk memasang hook baru pada instance root sesudah creation. |
| Logger constructor/destination precedence | `node_modules/@adonisjs/logger/build/logger-DFa9WtFu.js:8-14,34-39` (7.1.1) | **Internal implementation evidence**. Destination yang disediakan mengalahkan config transport. Fixture dev menggunakan sync destination: sekadar menambah transport target tidak efektif pada konfigurasi ini. Probe tidak mengubah pilihan destination. |
| `multistream` + `.add()` | `node_modules/@adonisjs/logger/build/index.js:90` (7.1.1), `node_modules/pino/docs/api.md:1415-1443,1531-1547` (10.4.0) | **Public/documented, source-evaluated, tidak diuji live**. Bisa menambah stream ke multistream yang app sengaja simpan sejak configuration. Bukan attach zero-config ke arbitrary existing destination. Interface public ini tidak mendokumentasikan remove; gunakan subscriber gateway untuk detach tanpa menutup stream app. |
| Transport targets | `node_modules/@adonisjs/logger/build/index.js:4-9,39-40` (7.1.1), `node_modules/pino/docs/transports.md:16-18,25-51` (10.4.0) | **Public/documented, source-evaluated, tidak diuji live**. Memerlukan config; worker thread tidak berbagi ring singleton main-thread. Perlu bridge tambahan; tidak dipilih untuk ring in-process. |
| `logMethod`, `onChild` | `node_modules/pino/docs/api.md:363-384,625-634` (10.4.0) | **Public/documented, source-evaluated, tidak diuji live**. Keduanya creation-time configuration. `logMethod` menangkap args sebelum serialization; harus meneruskan method tepat sekali. `onChild` hanya child creation, bukan record stream. `streamWrite` lebih langsung untuk final JSON. |
| Underlying `logger.pino` | `node_modules/@adonisjs/logger/build/src/logger.d.ts:25-34` (7.1.1) | **Public typed property**. Akses instance tidak sama dengan adanya public add-observer API. Mengubah symbol state bukan kontrak logger Adonis. |
| Pino symbols | `node_modules/pino/docs/api.md:1509-1519` (10.4.0) | **Documented integration escape hatch atas non-public state**. Dapat melakukan proxy state tetapi bukan observer public stabil; memerlukan version-bound/private adapter dan menyelesaikan child lama. Tidak dipakai atau diklaim teruji. |
| `ctx.logger` request binding | `node_modules/@adonisjs/http-server/build/define_config-CthsZu7o.js:5483-5484` (9.3.1) | **Internal source evidence untuk public behavior**, diuji live: child memiliki `request_id`. |
| Custom exception `report`/`handle` | `node_modules/@adonisjs/http-server/build/index.js:295-337` (9.3.1); fixture `app/exceptions/handler.ts:15-26` sebelum instrumentation | **Public override seam**, diuji live. Base report bisa menyaring report atau memanggil self-report; log saja bukan inventory lengkap exception. Observer di handle mempertahankan custom behavior dan menangkap sekali. |
| Error handler registration dan resolution | `node_modules/@adonisjs/http-server/build/src/server/main.d.ts:73` dan `build/define_config-CthsZu7o.js:5420-5423` (9.3.1) | `server.errorHandler()` **public**; resolved handler field **private**. Replacing handler registration dapat menimpa handler user, bukan observer transparan. Container swap membutuhkan identitas class handler app sebelum boot dan delegasi override; tidak ada generic public handler-discovery+observer seam yang ditemukan. Tidak diuji/dipilih. |
| Error handler diagnostics | `node_modules/@adonisjs/http-server/build/helpers-D-ryK4qq.js:106-108`, `build/define_config-CthsZu7o.js:5276-5278`, `build/src/tracing_channels.d.ts:12-14` (9.3.1) | **Internal/source-inspected channel**, diuji via Node public diagnostics API. `tracePromise` diberi context `void 0`; start payload kosong. Bukan solusi capture error+ctx. Ada ketidaksamaan colon/dot pada declaration vs runtime, maka jangan mengandalkan string declaration. |
| Subscribe/unsubscribe dan `hasSubscribers` | https://nodejs.org/docs/latest-v24.x/api/diagnostics_channel.html#channelunsubscribeonmessage | **Public/documented Node API**; dipakai hanya untuk memverifikasi diagnostic candidate dan leak cleanup. |
| Provider shutdown | `node_modules/@adonisjs/application/build/src/types.d.ts:399-408` (Core dependency; Core 7.6.0) | **Public lifecycle contract**, diuji live dengan SIGTERM. |
| Core logger reexport/syncDestination | `node_modules/@adonisjs/core/build/modules/logger.js:1-3` (7.6.0) | **Public exports**, fixture original tetap dipertahankan. |

## Keterbatasan

- Tidak ada klaim universal bahwa semua kemungkinan zero-config mustahil; hasil yang dibuktikan: exported/documented seams yang dievaluasi tidak memberi provider attach record observer setelah creation dan diagnostic exception tidak membawa error/context. Private patch tidak dipakai.
- Hook logger hanya berlaku pada logger yang dikonfigurasi. `logger.use('other')`/logger independen memerlukan instrumentation tersendiri. Disabled/below-level records memang tidak ditulis dan bukan captured event.
- Probe bekerja dalam satu proses, direct HTTP startup, tanpa HMR, worker thread transport, cluster, multiple named loggers, atau React fixture. Shutdown terbukti sesudah explicit detach; shutdown hook memanggil detach ulang secara idempotent.
- Exceptions ketika `report()` sendiri throw dapat masuk fallback handler sebelum custom handle; exception self-handle/ignored-report/validation tidak diberi skenario tambahan. Seam handle tidak mengamati uncaught exception global di luar HTTP.
- Ring memakai 128 entries dan 32 KiB untuk eksperimen, bukan default produk 1000 log/100 exception. Budget ini serialized bytes; transient JSON allocation/heap overhead tidak dibenchmark. Batas allocation sebelum serialization dan truncation aman tetap pekerjaan implementasi.
- Probe tidak mengimplementasikan redaction produk, API MCP, stack projection, atau correlation ALS root logger. Workload tidak mengandung secret. JSON parsing dilakukan hook synchronous; implementation produk wajib fail-safe supaya kegagalan capture tidak merusak logging app.
- `streamWrite` tetap terpasang sesudah detach tetapi tidak memiliki subscriber; tidak menutup destination/logger milik app. Hook gateway adalah opt-in instrumentation yang persisten, bukan listener bocor.

## Keputusan dan dampak

Semua empat acceptance criterion S-C **lulus dengan instrumentation**: normal output sekali, buffer/correlation benar, satu exception per handled failure, detach. Status keseluruhan **LULUS BERSYARAT**, karena zero-config attach contoh DESIGN belum terpenuhi.

Pilih **public Pino `hooks.streamWrite` pada config logger + public custom handler `handle()` seam**, keduanya melalui **app-local dev-guarded gateway** yang dibuktikan pada putaran 2. Provider mengelola subscriber/ring dan detach, tidak mengganti output app. Jangan mengumpulkan exception dari log error karena custom+base reporting dapat menghasilkan dua record sah untuk satu exception. Jangan mengklaim diagnostic handler dapat membaca error/ctx saat payload kosong. Static capture import putaran 1 hanya probe, bukan rekomendasi stub produksi.

D01 (buffer ownership aplikasi), D13 (evidence labeling), D19 (tidak menyimpan kode eval penuh) tetap berlaku. D01–D20 lainnya tidak berubah. Kontrak §4.1/§4.2 `attach/detach` perlu dibedakan: capture subscription dapat zero-config setelah gateway diinstrumentasi, **pemasangan gateway sendiri opt-in**. WP-06 lifecycle, WP-10 buffers/correlation, WP-22 HTTP-linked logs/exceptions, dan configure harus mengikuti keputusan ini; tidak mengunci private patch ke implementasi.

- OBL: Configure harus menghasilkan app-local `start/mcp_dev_hooks.ts` dengan conditional `app.inDev` dynamic import hooks package; config logger dan exception handler hanya mengimpor gateway app-local. Pertahankan identity stream hook dan inert exception observer di non-dev. Production absence gate jalur ini sudah lulus putaran 2; final package tetap wajib menjalankannya dari tarball release.
- OBL: Tambahkan opt-in observer tepat satu kali di custom HttpExceptionHandler.handle sebelum delegasi/response; jangan mengganti report/handle user atau mencapture report dan handle sekaligus. Tetapkan coverage jika report throw atau handler fallback.
- OBL: Jika zero-config tetap requirement wajib, ajukan upstream public record observer/add-remove destination dan error-handler event dengan error+ctx, atau putuskan version-bound private adapter dengan child/HMR regression gates; jangan menyebut jalur opt-in ini zero-config.
- OBL: Implementasi produk harus redact sebelum penyimpanan, membatasi bytes/count termasuk oversized/transient serialization, fail-safe terhadap capture failure, melepas subscriber saat shutdown/HMR, serta menguji existing hooks, named loggers, worker transports, dan ignored/self-reported exceptions.

## Putaran 2 — wiring production-safe

**Hasil: LULUS untuk production absence dan capture development.** Status S-C tetap LULUS BERSYARAT hanya karena opt-in instrumentation, bukan karena blocker produksi.

Reviewer P1 benar: static runtime import package dev-only dari logger config/handler akan merusak production sesudah omit-dev. Putaran 1 tidak membuktikan production safety. Putaran 2 menggunakan gateway app-local yang dapat dihasilkan configure:

```ts
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'

// Static package import tidak aman: package tidak ada pada production install.
const hooks = app.inDev ? await import('@rikology/adonisjs-mcp/hooks') : undefined
export const streamWrite = hooks?.streamWrite ?? ((line: string) => line)
export const observeException = hooks?.observeException ?? ((_error: unknown, _ctx: HttpContext) => {})
```

File nyata `spikes/s-c/mcp_dev_hooks.ts` juga mengekspor counter custom hanya untuk pengukuran spike. `config/logger.ts` dan `app/exceptions/handler.ts` hanya static-import gateway ini. Provider app-local terpisah memuat probe provider hanya saat `app.inDev`; provider probe boleh static-import package hooks karena module tersebut tidak di-load pada produksi. No-op non-dev di sini memang perilaku instrumentation disabled, **bukan fallback palsu untuk capture aktif**.

`app` tersedia saat config-load, bukan asumsi: jalur development berhasil menangkap, jalur production dengan package absen berhasil boot. Source pendukung Core 7.6.0 `node_modules/@adonisjs/core/build/main-B2rXbPKm.js:395` menetapkan app singleton pada createApp; Application 9.1.0 `node_modules/@adonisjs/application/build/application-TLzZVFOE.js:2523-2524` memproses normalized NODE_ENV **sebelum** config load; `:2131-2152` mengimplementasikan public `app.inDev`. Source ini **internal evidence**, app singleton service dan `inDev` adalah **public API**. Karena itu gateway tidak perlu raw `process.env.NODE_ENV` check yang dapat berbeda dari normalized framework environment.

Reproduce:

```sh
node spikes/s-c/run.mjs --production-safe
```

Runner membuat stand-in `@rikology/adonisjs-mcp@0.0.0-spike-sc` dari `spikes/s-c/pkg/package.json`, `hooks.d.ts`, serta probe `capture.ts` yang di-strip menjadi JS di direktori disposable; `npm pack --silent` lalu install tarball sebagai exact **devDependency**. Ini stand-in boundary release, bukan implementasi package final. Tidak mengedit S-B atau tarball miliknya. Exact `npm ls @rikology/adonisjs-mcp @adonisjs/application` menunjukkan versi 0.0.0-spike-sc dan 9.1.0; tuple framework/Pino tetap sama seperti putaran 1.

Urutan production nyata dalam `round2.mjs`:

```sh
node ace build
# cwd clone/build:
npm ci --omit=dev
# copy ke sibling di /tmp, BUKAN di bawah source ancestor:
cp -cR /tmp/adonisjs-mcp-m0/s-c-api-17464/build /tmp/adonisjs-mcp-m0/s-c-api-17464-standalone
# deploy .env dan salinan DB SQLite fixture disposable ke standalone/tmp/db.sqlite3
# cwd standalone:
NODE_ENV=production HOST=127.0.0.1 PORT=41041 node bin/server.js
NODE_ENV=production node ace migration:status
```

DB yang disalin hanya fixture temporary; tidak mengakses database pengguna. `.env` tidak di-commit sebagai evidence. Package resolution diperiksa di sibling dengan `import.meta.resolve('@rikology/adonisjs-mcp/hooks')` dan gagal `ERR_MODULE_NOT_FOUND`; tidak tertipu ancestor `node_modules`. Source akhir `/tmp/adonisjs-mcp-m0/s-c-api-17464`, sibling `/tmp/adonisjs-mcp-m0/s-c-api-17464-standalone`.

Output final:

```text
OBSERVATIONS {"concurrentRequests":24,"probeLogRecords":80,"exceptions":8,"custom":{"reports":8,"handles":8},"requestCorrelation":true,"diagnosticCount":8,"diagnosticKeys":[],"detachStopsCapture":true,"subscribersAfterDetach":[0,0],"diagnosticSubscribersAfterDetach":false,"bytes":26105,"dropped":0}
STDOUT_OBSERVATIONS {"probeLines":84,"expected":84,"once":true,"providerShutdown":true,"processStopped":true}
[ success ] build completed
added 371 packages in 2s
PACKAGE_ABSENT ERR_MODULE_NOT_FOUND
HTTP {"rootStatus":200,"root":{"hello":"world"},"errorStatus":500,"errorBody":{"error":"production-probe-error","request_id":"46b677a1-49db-42a6-8621-e51a6b208f74"},"normalLogStatus":200,"captureRouteStatus":404}
MIGRATION_EXIT 0
PRODUCTION_OBSERVATIONS {"root200":true,"customError500":true,"logOnce":true,"packageAbsent":true,"captureRouteAbsent":true,"providerNotLoaded":true,"migrationExit":0,"processStopped":true}
```

- ✅ Dev gateway: count/correlation/exception/detach identik dengan putaran 1, 24 requests dan 8 exception, 84 stdout probe lines.
- ✅ Build strict TypeScript sukses; `npm ci --omit=dev` sukses; stand-in tidak bisa di-resolve dari sibling standalone.
- ✅ Production `/` 200; `/production/error` ditangani custom handler dengan 500 dan request ID; `/production/log` 200 dan log normal tepat satu; `/probe/state` 404.
- ✅ Custom report production satu event untuk error dan satu untuk missing route, masing-masing legitimate. Base report error `production-probe-error` juga tepat satu. Capture provider tidak berjalan (`SC_SHUTDOWN` tidak ada); stdout asli tetap ada.
- ✅ Ace `migration:status` exit 0, kedua migrations fixture completed. Proses dev dan production sudah berhenti melalui SIGTERM.
- ✅ Reviewer P2: raw observed stdout/stderr/procedure dan JSON ringkas kini disimpan pada `spikes/s-c/evidence/`. Scan lima raw files terhadap APP_KEY/password/secret/token sentinel dari `.env` dan structured sensitive keys menghasilkan **0 matches**. JSON summary hanya berisi hasil terukur, path disposable, dan scan counts.

Evidence permanen: `dev-stdout.log`, `dev-stderr.log`, `production-stdout.log`, `production-stderr.log`, `production-procedure.log`, `observations.json`. Runner otomatis men-scan raw stdout/stderr sebelum menulis; procedure log berisi command outputs tanpa env values dan juga telah di-scan pada final run.

Percobaan awal putaran 2 juga menemukan dua kesalahan harness: custom handler probe selalu status 500 sehingga missing route bukan 404; diperbaiki mempertahankan `error.status ?? 500`. Ace standalone gagal karena build tidak membawa direktori SQLite `tmp`; diperbaiki deploy salinan DB fixture temporary. Tidak disembunyikan sebagai pass; hanya run final di atas meluluskan prosedur.

Keputusan D04 sekarang konsisten dengan S-B: **tidak ada runtime package import unconditional dari config/handler app**. Gateway app-local dan dev-provider guard harus dibuat configure; package hooks tetap opt-in. D01–D03 dan D05–D20 tidak berubah. OBL production wiring sebelumnya sudah mempunyai bukti solusi, tetapi final release wajib mempertahankan regression gate tarball/omit-dev/sibling. Tidak ada BLOCKER tersisa untuk wiring production-safe.
