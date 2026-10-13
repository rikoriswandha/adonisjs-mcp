# S-E — Eval natural dengan referrer aplikasi
Status: LULUS BERSYARAT
Tanggal: 2026-10-13

## Pertanyaan

Eval natural `await import('#models/user')`, resolve service, return BigInt, async delay, dan synchronous blocking di child fixture: apakah alias merujuk module instance aplikasi yang sama, console terisolasi, dan cooperative timeout tidak diklaim sebagai hard kill?

## Lingkungan

- macOS 27.0, build 26A428, arm64; Node **v24.21.0**; npm 11.19.0 (baseline lingkungan).
- Fixture API create-adonisjs 3.4.0, clone `/tmp/adonisjs-mcp-m0/s-e-api` (canonical `/private/tmp/...`), SQLite fixture saja. Base fixture tidak diubah.
- `npm ls @adonisjs/core @adonisjs/application @adonisjs/repl @adonisjs/lucid @adonisjs/assembler @poppinss/ts-exec hot-hook` menghasilkan: Core **7.6.0**, Application **9.1.0**, REPL **5.0.0**, Lucid **22.4.2**, Assembler **8.5.2**, ts-exec **1.5.0**, hot-hook **1.0.0**. `npm ls @adonisjs/fold` menghasilkan **11.1.0**.
- Server nyata `node ace serve --hmr`, HOST `127.0.0.1`; port 41080 untuk kandidat/operasi/HMR, 41081 untuk blocking child, 41082 dialokasikan REPL.
- Evaluator benar-benar terletak di **`node_modules/@spike/eval/evaluator.mjs`**, dengan package.json ESM sendiri. Route app-side mengimpor `User` secara statis untuk pembanding identitas. Tidak memakai regex rewriting, chdir, module copy, cache-busting URL, atau MCP SDK: spike ini menguji evaluator, bukan transport S-A.

## Skenario dan command

Dari repo root:

```sh
# Default membuat clone baru, menyalin probe, lalu menjalankan seluruh skenario.
node spikes/s-e/run.mjs

# Command yang benar-benar dijalankan (tiga iterasi penyempurnaan kandidat).
node spikes/s-e/run.mjs /tmp/adonisjs-mcp-m0/s-e-api
```

Entry script menerima **clone disposable**, bukan base fixture. File probe: `spikes/s-e/evaluator.mjs`, `spikes/s-e/routes.ts`, `spikes/s-e/run.mjs`. Runner memasang package referrer, route `/__spike/eval` dan `/__spike/state`, serta marker `before/after` pada model clone. Ia menjalankan kandidat tanpa flag, kandidat dengan `NODE_OPTIONS=--experimental-vm-modules`, kemudian seluruh operasi kandidat terpilih **tanpa flag**. HTTP driving memakai GET query payload agar tidak mengubah Shield/bodyparser.

Kode alias sama untuk semua kandidat:

```js
const { default: User } = await import('#models/user')
return { same: User === appUser, marker: User.spikeMarker }
```

Kandidat `*-default` memakai `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`; `*-root-default` juga menetapkan `filename = app.makePath('eval-call.mjs')` (filename sintetis, tidak membuat file di app). `*-app` memakai callback nyata `(specifier) => app.import(specifier)`. Runner menginjeksi `app`, `appUser`, local `console`, dan `signal` sebagai parameter, bukan global patch.

Model diedit saat server hidup dan runner menunggu marker baru; PID dicatat untuk membedakan HMR dengan restart. REPL dijalankan sebagai proses terpisah, natural import diketik ke stdin, lalu `.exit`. Runner final mengisolasi HOME REPL ke `<clone>/spike-home` untuk menghindari history pengguna. Synchronous infinite loop hanya dikirim ke child 41081; runner eksternal mencoba HTTP dengan deadline 500 ms lalu membunuh process group miliknya. Semua server/process group yang dimulai dihentikan dengan SIGTERM dan fallback SIGKILL; tidak ada PostgreSQL/Redis yang dimulai.

## Hasil teramati

Matriks natural import, hasil tiga eksekusi konsisten:

| Kandidat | Tanpa flag VM | Dengan flag VM | Referrer / identitas |
| --- | --- | --- | --- |
| `new AsyncFunction` | `ERR_PACKAGE_IMPORT_NOT_DEFINED` | Sama | `node_modules/@spike/eval/evaluator.mjs`, bukan app |
| `vm.compileFunction`, tanpa callback | `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` | Sama | Tidak ada loader |
| `compileFunction` / `Script`, default loader, filename package | `ERR_PACKAGE_IMPORT_NOT_DEFINED` | Sama | `node_modules/@spike/eval/eval-call.mjs` |
| `compileFunction` / `Script`, default loader, filename app root | `{ same: true, marker: 'before' }` | Sama | App package.json imports; instance identik |
| `compileFunction` / `Script`, callback `app.import` | `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG` | `{ same: true, marker: 'before' }` | Framework app importer; instance identik |
| `SourceTextModule`, callback `app.import` | `vm.SourceTextModule is not a constructor` | `{ same: true, marker: 'before' }` | Framework app importer; instance identik |

Error AsyncFunction menyebut secara eksplisit:

```text
Package import specifier "#models/user" is not defined in package
/private/tmp/adonisjs-mcp-m0/s-e-api/node_modules/@spike/eval/package.json
imported from .../node_modules/@spike/eval/evaluator.mjs
```

Operasi kandidat terpilih `compile-root-default`, tanpa flag, PID 86862:

```text
router: 'Router'
bigint: 42n
map: Map(1) { 'answer' => 42n }
model: User { ... '$attributes': { email: 'probe@example.invalid' },
  '$isPersisted': false, '$isLocal': true, email: 'probe@example.invalid' }

B: logs=[{level:'log',text:'B start'},{level:'error',text:'B end'}]
A: logs=[{level:'log',text:'A start'},{level:'warn',text:'A end'}]

TIMEOUT: Cooperative wait expired; execution NOT stopped
POST_TIMEOUT {"completions":[{"callId":"late","aborted":true}],"marker":"before","pid":86862}
COOPERATED {"completions":[{"callId":"late","aborted":true},{"callId":"cooperating","cooperated":true}],"marker":"before","pid":86862}
```

Timeout 30 ms selesai sebelum delay non-kooperatif 200 ms; mutation ke `completions` **tetap terjadi setelah response timeout**. Contoh yang mendengarkan signal membatalkan timer-nya sendiri dan menghasilkan `cooperated:true`. Timer/signal bukan preemption.

```text
HMR: before.pid=86862, after.pid=86976, restarted=true
after: completions=[], marker='after'
compile-root-default: { same: true, marker: 'after' }, pid=86976

REPL_NATURAL User after true
REPL_EXIT 0

BLOCKING_CHILD_PRE {"completions":[],"marker":"after","pid":87235}
BLOCKING_HTTP_FROZEN TimeoutError
EXTERNAL_WATCHDOG_KILLED_CHILD
BLOCK_EVAL_EXTERNAL_DEADLINE TypeError
```

Edit model **memicu restart proses**, bukan reload model in-place dalam fixture ini. Module instance evaluator tetap sama dengan app-side import **di proses baru**; tidak ada klaim object identity lintas proses. REPL membuktikan natural import dan repeat-import identity di proses REPL; ia tidak berbagi instance dengan proses HTTP.

- ✅ Alias natural resolve ke app dan `User === appUser` dengan default loader + filename app root, termasuk sesudah perubahan model/restart.
- ✅ Service `await app.container.make('router')` resolve router nyata; BigInt, Map, dan Lucid instance tampil lewat `util.inspect`.
- ✅ Dua eval concurrent overlap (delay A 90 ms, B 20 ms), output B selesai lebih dulu; tiap hasil hanya memuat console call miliknya, tanpa patch global console.
- ✅ Cooperative timeout dijelaskan sebagai batas menunggu; bukti mutation sesudah timeout dan pembatalan hanya oleh kode yang mendengarkan signal.
- ✅ Infinite loop membekukan HTTP child sekalipun timeout eval 30 ms; watchdog eksternal diperlukan dan menghentikan child.
- ❌ Implementasi desain `AsyncFunction` dari installed package tidak memenuhi alias acceptance.

## Referensi API/source

Semua path `node_modules/...` relatif terhadap clone fixture.

- **Public/documented, experimental**: Node v24.21.0 [VM dynamic import compilation APIs](https://nodejs.org/docs/latest-v24.x/api/vm.html#support-of-dynamic-import-in-compilation-apis), khusus [default main-context loader](https://nodejs.org/docs/latest-v24.x/api/vm.html#when-importmoduledynamically-is-vmconstantsuse_main_context_default_loader). Dokumentasi menyatakan resolver memakai `filename` (absolute path atau URL), module cache digunakan ulang, dan VM bukan security mechanism. Ini API loader nyata; filename app root menentukan parent/referrer tanpa rewriting kode.
- **Public/documented, experimental**: [vm.compileFunction](https://nodejs.org/docs/latest-v24.x/api/vm.html#vmcompilefunctioncode-params-options), [vm.Script](https://nodejs.org/docs/latest-v24.x/api/vm.html#class-vmscript), [vm.SourceTextModule](https://nodejs.org/docs/latest-v24.x/api/vm.html#class-vmsourcetextmodule). [Function callback](https://nodejs.org/docs/latest-v24.x/api/vm.html#when-importmoduledynamically-is-a-function) memerlukan `--experimental-vm-modules`; default-loader constant tidak memerlukannya pada versi teruji.
- **Public/documented**: Application 9.1.0 `node_modules/@adonisjs/application/build/src/application.d.ts:760–780` mendefinisikan `app.import`/`importDefault`; implementasi `build/application-TLzZVFOE.js:2976–2978` memanggil importer aplikasi. `bin/server.ts:19–32` fixture memasang importer dari module app, sehingga aliases memakai scope app.
- **Public/documented**: `app.makePath` adalah application path helper; [Application service](https://docs.adonisjs.com/guides/fundamentals/application-service). Path helper dipakai hanya untuk filename sintetis, bukan membuat file atau mengganti cwd.
- **Public/documented**: Fold 11.1.0 `node_modules/@adonisjs/fold/build/src/container.d.ts:114–128` (`container.make`); Core 7.6.0 `node_modules/@adonisjs/core/build/services/router.js:8–9` menunjukkan service publik memakai binding router yang sama. Route publik [routing](https://docs.adonisjs.com/guides/basics/routing).
- **Public command, internal implementation evidence**: Core 7.6.0 `node_modules/@adonisjs/core/build/commands/repl.js:36–40` menjalankan REPL binding. **Internal/private, bukan API evaluator publik**: REPL 5.0.0 `node_modules/@adonisjs/repl/build/index.js:100–104` (`#eval`) dan `:171–198` (wiring Node REPL) meneruskan evaluasi ke Node REPL, `useGlobal:true`, bukan resolver AsyncFunction tersendiri. [Node REPL](https://nodejs.org/docs/latest-v24.x/api/repl.html) adalah public/documented dan mendukung top-level await/dynamic import.
- **Internal implementation evidence, bukan API evaluator untuk diandalkan**: Core 7.6.0 `node_modules/@adonisjs/core/build/providers/repl_provider.js:62–65,82–94` memasang history dan helpers `importDefault`, `make`, `loadApp`. `importDefault` meneruskan ke `app.importDefault`, bukan regex rewriting natural import.
- **Public/documented**: [util.inspect](https://nodejs.org/docs/latest-v24.x/api/util.html#utilinspectobject-options), [util.format](https://nodejs.org/docs/latest-v24.x/api/util.html#utilformatformat-args), [AbortSignal.timeout](https://nodejs.org/docs/latest-v24.x/api/globals.html#static-method-abortsignaltimeoutdelay), [child_process.spawn](https://nodejs.org/docs/latest-v24.x/api/child_process.html#child_processspawncommand-args-options), [process.kill](https://nodejs.org/docs/latest-v24.x/api/process.html#processkillpid-signal). Console lokal adalah lexical parameter, bukan penggunaan private hook console.

## Keterbatasan

- Hasil hanya untuk Node 24.21.0/macOS dan exact dependency tuple di atas; default-loader import API berstatus experimental walau tidak membutuhkan flag. Minimum Node 24.0.0/Linux belum dibuktikan.
- HMR model menghasilkan restart; review putaran 2 di bawah membuktikan controller hot replacement pada PID yang sama. Tidak menambahkan cache-busting URL milik package; versioning hot-hook adalah milik loader framework.
- Capture hanya lexical `console.log/warn/error` kode evaluasi; imported modules yang memakai global console/logger, `globalThis.console`, atau child process tidak diklaim tertangkap. Arbitrary trusted code dapat sengaja menghindari capture.
- Lucid model adalah instance nyata **belum dipersist**, bukan query fixture DB. Scope spike display/service/import tidak memerlukan mutation database.
- `util.inspect` bukan JSON serialization dan bukan redaction. Package akhir masih memerlukan bounded output/error normalization; probe sengaja tidak mengimplementasikan package atau transport.
- REPL menjalankan proses console terpisah; tidak digunakan sebagai server evaluator dan tidak membuktikan sharing state HTTP. Runner final mengisolasi HOME; run awal tidak mengubah konfigurasi user, dan pencarian marker probe pada history user tidak menemukan entry probe.
- Tidak menetapkan `vm.Script.runInThisContext({ timeout })`; script hanya menghasilkan async function dan tidak dapat menjamin kill async continuations. Tidak ada klaim hard timeout/sandbox.

## Keputusan dan dampak

Plan S-E **lulus bersyarat dengan callback framework + flag VM**. Pilihan awal default main-context loader tanpa flag hanya lulus alias model yang telah diimpor app-side; **pilihan awal ini dibatalkan oleh putaran 2**, karena alias controller gagal `ERR_MODULE_NOT_FOUND` bahkan sebelum hot-swap. Pilihan final: `vm.compileFunction` dengan parameter lexical per call, callback `importModuleDynamically: (specifier) => app.import(specifier)`, dan startup flag **`--experimental-vm-modules`**. Natural syntax/public `code` tidak berubah; app importer meneruskan resolution ke loader ts-exec/hot-hook aplikasi.

Callback `app.import` pada compileFunction/Script dan SourceTextModule telah menghasilkan model identity dan controller generation terbaru yang sama dengan router pada PID tetap. `node ace repl` menunjukkan natural import tersedia, namun bukan drop-in isolated concurrent evaluator. Default main-context loader tidak boleh dijadikan fallback karena kasus controller gagal; melihat hasil model saja tidak cukup untuk mengklaim loader chain lengkap.

- **D09**: asumsi AsyncFunction ditolak oleh bukti; ganti mekanisme evaluator, tanpa perubahan input `code` atau natural import public contract.
- **D08**: dipertahankan dan diperkuat: timeout = cooperative wait/cancellation signal, bukan hard kill. Synchronous loop membekukan aplikasi.
- **D19**: tetap berlaku; probe tidak menambahkan audit code logging. S-E tidak membuktikan redaction/audit buffer.
- **Public contracts §4.3/WP-28**: inject `signal` dan lexical console; return display inspeksi + structured status; late work harus dinyatakan eksplisit. Lifecycle §4.2 mengikuti restart maupun hot replacement nyata.
- OBL: WP-28 harus memakai callback `app.import` + `--experimental-vm-modules`, mempertahankan natural import dan equality tests model/controller dari installed tarball; jangan fallback ke AsyncFunction/default loader yang tidak memenuhi kasus controller.
- OBL: Uji experimental VM callback pada Node minimum/current dan Linux; dokumentasikan startup flag, status experimental, dan fail eksplisit bila runtime tidak mendukungnya, tanpa regex rewrite/fallback diam-diam.
- OBL: WP-28/WP-36 harus menjelaskan cooperative timeout, kemungkinan late mutation/event-loop freeze, serta capture hanya lexical console eval; jangan menjanjikan imported-module/global-console capture atau sandbox.
- OBL: Regression HMR harus membedakan restart PID versus hot replacement; bandingkan module dengan app/router generation yang sama, gunakan importer framework tanpa package-owned cache-busting URL atau cache per-call yang tumbuh tanpa batas.

BLOCKER: Jalur natural import controller yang teruji memerlukan startup flag `--experimental-vm-modules`. Opsi konkret: terima requirement flag pada configure/docs dev app, atau prove alternatif real-loader API tanpa flag sebelum mengklaim zero-config. Default main-context loader bukan solusi umum yang terverifikasi.

## Putaran 2 — review

Koreksi review: seluruh rujukan work package evaluator diganti menjadi **WP-28** (WP-24 adalah Inertia/transformers); source private REPL diberi label internal/private. Evidence putaran 1 dipertahankan, tetapi kesimpulan default loader tanpa flag dikoreksi setelah menguji alias selain model statis.

Command observed: `node spikes/s-e/run.mjs` (dua fresh clones). Raw stdout, identity matrix, versions, console/timeout/HMR/REPL/blocking results disimpan sebagai **`spikes/s-e/observations-round2.txt`** dan **`spikes/s-e/observations-round2-callback.txt`**. Kedua run exit 0. Secret scan regex untuk APP_KEY, bearer credentials, Cookie/Set-Cookie headers, dan assignment password/secret/token **tidak menemukan matches**; raw output tetap memuat nama kolom `password` saja, bukan nilainya. HOME REPL terisolasi dalam clone pada kedua run ini. Semua process groups dihentikan runner.

Controller probe `spikes/s-e/controller.ts` dipasang ke `app/controllers/spike_eval_controller.ts`; route lazy menjalankan method `handle`. Method menyimpan **class yang benar-benar dieksekusi router** ke object app; eval membandingkannya dengan imported default class (`sameAsRouter`) dan membaca exported `import.meta.url`.

```text
# Default main-context loader, tanpa flag (clone ...1791856854117):
CONTROLLER_BEFORE marker=controller-before, ?hot-hook=0, pid=14855
compile-root-default: ERR_MODULE_NOT_FOUND (.../app/controllers/spike_eval_controller.js)
CONTROLLER_AFTER marker=controller-after, ?hot-hook=1, pid=14855, samePid=true
compile-root-default: ERR_MODULE_NOT_FOUND (.../app/controllers/spike_eval_controller.js)
script-root-default: ERR_MODULE_NOT_FOUND (.../app/controllers/spike_eval_controller.js)

# Callback app.import, dengan flag:
CALLBACK_CONTROLLER_BEFORE marker=controller-before, ?hot-hook=0, pid=14746
compile-app: marker=controller-before, ?hot-hook=0, sameAsRouter=true, pid=14746
CALLBACK_CONTROLLER_AFTER marker=controller-after, ?hot-hook=1, pid=14746, samePid=true
compile-app: marker=controller-after, ?hot-hook=1, sameAsRouter=true, pid=14746
script-app: marker=controller-after, ?hot-hook=1, sameAsRouter=true, pid=14746
source-app: marker=controller-after, ?hot-hook=1, sameAsRouter=true, pid=14746
```

- ✅ Controller benar-benar hot-swapped **dalam proses yang sama**, bukan restart; callback framework mendapatkan class yang identik dengan class router pada generation 0 dan 1.
- ❌ Default main-context loader dengan filename app root bukan solusi universal: model statis lulus, controller alias tidak dapat dimuat sebelum/sesudah hot-swap. Bukti ini adalah failure resolution, bukan stale-module observation.
- ✅ Solusi non-regex yang terbukti: callback `app.import`, memanfaatkan importer dan loader framework; package tidak membuat random URL/query per call atau menyimpan module namespace cache sendiri.

Mekanisme **observed**: URL yang dikembalikan controller/router dan evaluator berubah dari `...?hot-hook=0` ke `...?hot-hook=1`. **Internal/source evidence, bukan API yang boleh dipanggil package**: hot-hook 1.0.0 `node_modules/hot-hook/build/src/loader.js:206–212` membersihkan version query parent lalu meneruskan `nextResolve`; `:233–253` memeriksa dynamic import boundary; `:261–265` menambah `hot-hook=<dependency version>`. `node_modules/hot-hook/build/src/dependency_tree.js:89–91` menaikkan version pada invalidation. Callback framework mempertahankan mekanisme itu; default loader hasil di atas tidak cukup membuktikan ts-exec remapping untuk fresh controller alias. Penyebab internal lengkap perbedaan loader default belum ditrace, sehingga tidak dinyatakan sebagai fakta.

Dampak final: **D09 tetap natural syntax tetapi requirement startup flag menjadi keputusan publik eksplisit**. Bounded solution berarti tidak menambahkan cache/query generation milik evaluator; version retention framework mengikuti lifecycle dev app, bukan jaminan seluruh Node ESM cache bounded. Callback tidak menjanjikan hard timeout dan tidak mengubah D08. Hasil operational isolation/timeout dari putaran 1 callback serta putaran 2 default-loader tetap valid untuk mekanisme lexical-console/signal; controller generation kini secara khusus terbukti pada callback framework.

## Putaran 3 — referrer TS

Hipotesis diuji tanpa VM flag di server `node ace serve --hmr`, evaluator tetap package terpasang: mengganti filename sintetis `.mjs` menjadi **`<appRoot>/eval-call.ts`** dan **`<appRoot>/start/__mcp_eval__.ts`**. Kedua path hanya metadata VM, tidak dibuat di filesystem. Command observed: `node spikes/s-e/run.mjs` dua fresh clones; raw stdout lengkap ada di `spikes/s-e/observations-round3.txt` dan `spikes/s-e/observations-round3-warm.txt`, keduanya exit 0. Secret scan yang sama dengan putaran 2 tidak menemukan matches. Process groups berhenti di `finally`; base fixture tetap tidak diubah.

**Source membantah parent-extension hypothesis**: ts-exec 1.5.0 `node_modules/@poppinss/ts-exec/build/index.js:156–188` resolve hook tidak mengecek suffix `context.parentURL`. `:158–162` mengecek suffix **specifier yang diimpor**, bukan referrer, untuk aturan `rewriteRelativeImportExtensions`. `:167–182` mencoba `.js→.ts/.tsx` bila `nextResolve` melempar `ERR_MODULE_NOT_FOUND` dengan local `error.url`; `:230` memasang synchronous `registerHooks({resolve, load})`. Ini **internal implementation evidence**, bukan API resolver yang package harus panggil langsung.

Hasil **kedua** TS filenames identik sebelum dan sesudah hot-swap:

| Import natural | Sebelum hot-swap | Sesudah hot-swap |
| --- | --- | --- |
| `#models/user` | `same:true`, marker `before` | `same:true`, marker `before` (model belum diedit) |
| `#controllers/spike_eval_controller` | `ERR_MODULE_NOT_FOUND` pada `.js` | Error sama; tidak mendapat class router |
| `#services/spike_eval_service` (fresh TS service) | `ERR_MODULE_NOT_FOUND` pada `.js` | Error sama |
| Relative `./app/controllers/spike_eval_controller.js` dari root / `../app/controllers/...js` dari start | `ERR_MODULE_NOT_FOUND` | Error sama |
| Package `luxon` | `{ package:'luxon', year:2026 }` | Hasil sama |

```text
# observations-round3.txt:
CONTROLLER_BEFORE: controller-before, ?hot-hook=0, pid=19410
compile-root-ts-default / compile-start-ts-default:
  ERR_MODULE_NOT_FOUND .../app/controllers/spike_eval_controller.js
CONTROLLER_AFTER: controller-after, ?hot-hook=1, pid=19410, samePid=true
compile-root-ts-default / compile-start-ts-default:
  ERR_MODULE_NOT_FOUND .../app/controllers/spike_eval_controller.js
```

**Mengapa model `.mjs` putaran 1 berhasil?** Model sudah diimpor app-side sebelum eval. Eksperimen kontrol memperkuat penjelasan warm resolution/module cache, bukan suffix parent: fresh service awalnya gagal untuk `.mjs` dan kedua `.ts` filenames; setelah **`await app.import('#services/spike_eval_service')`** pada proses yang sama (tanpa VM flag), default loader `.mjs` dan `.ts` sama-sama berhasil mengembalikan namespace service URL `...?hot-hook=0`. Kode tidak mengubah filesystem service, filename eval, atau import syntax di antara kegagalan dan keberhasilan.

```text
# observations-round3-warm.txt, pid=21774:
framework-warm (AsyncFunction menjalankan app.import): fresh-service, ...spike_eval_service.ts?hot-hook=0
mjs-after-warm (natural import/default loader): fresh-service, URL yang sama
ts-after-warm (natural import/default loader): fresh-service, URL yang sama
```

Referensi cache **public/documented**: [Node VM default-loader caveats](https://nodejs.org/docs/latest-v24.x/api/vm.html#when-importmoduledynamically-is-vmconstantsuse_main_context_default_loader) menjelaskan caching module yang dimuat. **Internal/source evidence** Node 24.21.0 [ESM loader](https://github.com/nodejs/node/blob/v24.21.0/lib/internal/modules/esm/loader.js#L703-L713) memiliki resolve cache, [resolve hook chain](https://github.com/nodejs/node/blob/v24.21.0/lib/internal/modules/esm/loader.js#L685-L693) mencatat loader-worker route dan TODO synchronous hooks, dan [VM routing](https://github.com/nodejs/node/blob/v24.21.0/lib/internal/modules/esm/utils.js#L249-L275) meneruskan default VM import ke cascaded loader. Warm-dependent success adalah **observed**; cache/hook-layer mana yang tepat menyumbang reuse adalah **[INFERENCE]** dan belum diinstrumentasi. Tidak mengklaim `.mjs` melewati complete fresh-module ts-exec pipeline atau bahwa sekadar warm semua modules akan aman untuk HMR.

- ❌ TS synthetic referrer tidak memperbaiki controller/service/relative imports; tidak ada post-hot-swap identity yang dapat diklaim untuk default loader.
- ✅ Router tetap hot-swapped di PID sama; callback framework + flag juga kembali lulus controller identity pada generation baru dalam raw run putaran 3.
- ✅ Package import biasa dan model yang telah dimuat bekerja, tetapi tidak cukup untuk acceptance arbitrary project imports.

**Keputusan/Status/OBL tidak berubah dari putaran 2**: LULUS BERSYARAT dengan callback `app.import` + `--experimental-vm-modules`; BLOCKER startup flag tetap aktif jika zero-config tanpa flag menjadi syarat. Jangan memakai mass preload sebagai fallback: controller generation dan fresh imports harus benar secara natural melalui loader, bukan hasil warm-cache kebetulan. Tambahkan kedua TS-referrer negative cases dan fresh-service/warmed-service kontrol pada regression WP-28.
