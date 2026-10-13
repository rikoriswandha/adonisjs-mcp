# S-D — Introspeksi runtime dan lifecycle HMR
Status: LULUS BERSYARAT
Tanggal: 2026-10-13

## Pertanyaan
Inspect routes/middleware/container/events sesudah preload dan setelah HMR. Lulus bila data sesuai runtime, private/unknown metadata diberi label, dan route commit tidak terlambat.

## Lingkungan
Fixture API create-adonisjs 3.4.0, salinan disposable `/tmp/adonisjs-mcp-m0/s-d-api`; base tidak diubah. macOS 27.0 build 26A428 arm64; Node `v24.21.0`, npm `11.19.0` (command nyata `node --version && npm --version && sw_vers`). Port HTTP `41060`, HOST `127.0.0.1`.

Exact resolved versions dari `npm ls @adonisjs/core @adonisjs/http-server @adonisjs/fold @adonisjs/events @adonisjs/assembler hot-hook`:

```text
@adonisjs/core@7.6.0
@adonisjs/application@9.1.0
@adonisjs/http-server@9.3.1
@adonisjs/fold@11.1.0
@adonisjs/events@10.2.0
@adonisjs/assembler@8.5.2
hot-hook@1.0.0
@adonisjs/lucid@22.4.2
@adonisjs/auth@10.1.0
@adonisjs/session@8.1.0
@adonisjs/shield@9.0.0
@adonisjs/cors@3.0.0
@tuyau/core@1.2.2
@poppinss/middleware@3.2.7
```

Tidak memasang MCP SDK: eksperimen ini menguji API framework dan HMR, bukan transport S-A. Tidak membuka koneksi PostgreSQL/Redis atau menjalankan query model.

## Skenario dan command
`spikes/s-d/run.mjs` adalah entry sekaligus source probe minimum: membuat provider, controller, Lucid model, middleware, listener dan preload events pada clone. Tidak ada package implementation atau permanent test suite.

```sh
# Clone baru dengan suffix timestamp; membutuhkan base fixture yang sudah terpasang.
node spikes/s-d/run.mjs
# Atau gunakan clone disposable milik S-D (bukan base api/react/hypermedia):
spikes/clone-fixture.sh api s-d-review
node spikes/s-d/run.mjs /tmp/adonisjs-mcp-m0/s-d-review
# Command server yang dijalankan runner pada clone:
HOST=127.0.0.1 PORT=41060 node ace serve --hmr
```

Runner mencetak `VERSIONS`, `INITIAL`, `LIVE_*`, `HMR`, `RELOAD`, dan `SERVER_LOG`. Semua child process satu process group dihentikan dalam `finally` dengan SIGTERM lalu SIGKILL. Clone ditinggalkan untuk review. Parameter clone dapat dipakai ulang: provider/preload hanya dimasukkan sekali dan semua probe source di-reset sebelum run berikutnya. Jangan jalankan entry terhadap aplikasi pengguna; `start/routes.ts` sengaja diganti di clone.

Raw output final yang dipersistenkan: [`spikes/s-d/round1-output.txt`](../../spikes/s-d/round1-output.txt) (run final round 1, initial PID 91847) dan [`spikes/s-d/round2-output.txt`](../../spikes/s-d/round2-output.txt) (run final round 2, HTTP PID 3579). Keduanya disalin utuh dari capture command asli, bukan direkonstruksi dari ringkasan. Secret scan pada file evidence untuk APP_KEY, Bearer, Authorization/Cookie/Set-Cookie assignments serta literal password/token/secret assignments tidak menemukan match. Round 2 direproduksi dengan `node spikes/s-d/run2.mjs`.

Skenario: register binding/singleton/alias dengan counter constructor; route di provider boot/start; route closure dan lazy controller; group prefix/names/group middleware + per-route middleware; auth args `guards:['api']`; domain route; event inline, class tuple, lazy tuple, class event dengan dua listeners, ditambah `once` dan `onAny` sebagai kasus negatif kelengkapan. Tidak ada `emit` yang dipanggil oleh probe; class listener akan throw bila dieksekusi.

Runner mengedit controller (version 1→2), routes (menambah `sd.added`), model Lucid (static version 1→2), provider (comment), lalu routes tiga kali lagi. Snapshot mengukur lifecycle, PID, route metadata, registered event map, dan active handles. `process._getActiveHandles()` hanya diagnostic private di probe, bukan API package yang diusulkan.

## Hasil teramati
Run awal menemukan request domain dengan `fetch` + custom Host menghasilkan 404. Request diulang memakai `node:http.request` dengan header Host eksplisit; ini menghasilkan 200. Runner final memakai client tersebut. Tidak disimpulkan bahwa domain router rusak dari keterbatasan client pertama.

Output final nyata (PID khusus run ini):

```text
INITIAL pid=91847
register
boot:  commited=false routes=0
start: commited=false routes=0
ready: commited=true  routes=7
constructions=0
listenerCount=7
LIVE_BOOT {"phase":"boot"}
LIVE_START {"phase":"start"}
LIVE_ORDER {"order":["group","route"]}
LIVE_DOMAIN {"status":200,"body":"domain"}
LIVE_AUTH_STATUS 401
```

Metadata awal memuat `root` dan `sd.localhost`, route `sd.group.ordered` dengan pattern `/sd/group/ordered`, methods `GET,HEAD`. Stack route berurutan: bodyparser → session → Shield → initialize_auth → silent_auth → probe `{tag:'group'}` → probe `{tag:'route'}`. Protected route mengganti langkah terakhir dengan named `auth`, args `{guards:['api']}`. Stack server: force_json_response → container_bindings → CORS. Anonymous closure memiliki nama `null`, bukan nama controller yang direkayasa. Lazy controller payload memiliki `method:'index'`, `importExpression:"()=>import('../app/controllers/probe_controller.ts')"`, dan `name:''`; blank name tetap unknown.

Inventory event map: `sd:inline:1`, `sd:class:1`, `sd:lazy:1`, `ProbeEvent:2`. Tuple asli class/lazy dan method `handle` tersedia tanpa emit. **Map hanya berisi 5 listener**, sedangkan public `listenerCount()` melaporkan **7**: `once` dan wildcard tidak masuk map. Ini bukan daftar lengkap semua listener.

Container nyata:

```text
ownKeys=[]
known sd:binding=true sd:singleton=true sd:alias=true
constructions=0
prototype=[constructor,useEmitter,createResolver,hasBinding,hasAllBindings,
 make,call,alias,bind,bindValue,singleton,swap,restore,restoreAll,resolving,
 when,if,contextualBinding,conditionalBinding]
```

Tidak ada inventory getter. Map container memakai ECMAScript private fields `#bindings`, `#bindingValues`, `#aliases`; ordinary property reflection tidak bisa mengaksesnya. `hasBinding` membuktikan key yang sudah diketahui tanpa instantiation, tetapi tidak membedakan jenis registrasi atau provider asal.

| Edit | PID sebelum → sesudah | Lifecycle | Data sesudah |
| --- | --- | --- | --- |
| Controller | 91847 → 91847 | boot/ready tidak diulang | Response controller version=2; routes tetap 7 |
| start/routes.ts | 91847 → 92804 | register/boot/start/ready diulang | routes=8, `sd.added` muncul |
| Lucid model | 92804 → 92889 | semua diulang | modelVersion=2, added=true |
| Provider | 92889 → 93048 | semua diulang | routes=8, modelVersion=2 |
| routes reload 0/1/2 | 93173 / 93246 / 93322 | masing-masing seluruh lifecycle | map listener tetap 1/1/1/2, routes=8 |

Active handles pada snapshot sebelum/sesudah setiap edit dan tiga reload: `[Socket,Socket,Server,Socket]` (4). Tidak terlihat akumulasi map listener atau handles pada workload ini; process restart menghapus state lama. Ini bukan bukti tidak ada leak heap/transitive resources untuk workload lain.

- ✅ Data routes/domain/names/middleware args sesuai request runtime; controller hot swap menghasilkan version baru.
- ✅ Metadata private/unknown/partial ditandai: container, unused named middleware, anonymous/lazy names, once/wildcard listener.
- ✅ Route commit tidak terlambat: boot dan start route benar-benar dapat diminta; `ready` telah committed.
- ✅ Setelah HMR route addition segar; provider lifecycle rerun hanya pada process restart; mapped listeners/handles stabil selama tiga reload tambahan.
- ❌ Klaim desain daftar **semua** container binding/singleton/alias beserta provider asal belum dapat dipenuhi zero-config lewat API yang ada.
- ❌ Klaim daftar **semua** named middleware/semua event listeners tidak dapat dipenuhi dari registry runtime pusat; output harus partial eksplisit.

## Referensi API/source
Path berikut relatif terhadap clone; line source bukan dokumentasi package MCP. Public berarti API terlihat di declaration dengan komentar API; internal berarti implementation detail yang dibaca sebagai evidence, tidak disarankan diakses package.

| Metadata item | API dan sumber (versi; public/private) | Tersedia kapan | Perilaku HMR teramati |
| --- | --- | --- | --- |
| Route final + committed | `router.toJSON`, `router.commited`; public `node_modules/@adonisjs/http-server/build/src/router/main.d.ts:43,244` (9.3.1) | Final setelah HTTP server boot; observed ready=true, boot/start kosong | Routes edit restart; list baru langsung memiliki route tambahan |
| Nama/pattern/domain/method/handler | Route serialization, public `node_modules/@adonisjs/http-server/build/src/router/route.d.ts:197`; implementation `build/helpers-D-ryK4qq.js:539-552` (9.3.1, internal evidence) | Route committed | Controller function execution hot-swapped tanpa ulang boot; lazy identity bisa tetap blank |
| Per-route middleware + urutan | `RouteJSON.middleware.all`; public `node_modules/@poppinss/middleware/build/src/middleware.d.ts:12` (3.2.7); merge order internal `node_modules/@adonisjs/http-server/build/helpers-D-ryK4qq.js:513-523` (9.3.1) | Sesudah commit, mencakup global router + group + route | Snapshot segar setelah restart |
| Server middleware | Public `server.getMiddlewareList`, `node_modules/@adonisjs/http-server/build/src/server/main.d.ts:131` (9.3.1) | Sesudah kernel imported; ready observed | 3 middleware stabil |
| Router middleware terpisah | Public `router.use`, `node_modules/@adonisjs/http-server/build/src/router/main.d.ts:90` (9.3.1); tidak ada standalone getter | Combined stack route final tersedia; pemisahan global/group origin unknown | Fresh combined stack setelah restart |
| Semua named middleware | Public `router.named`, `node_modules/@adonisjs/http-server/build/src/router/main.d.ts:92-101` (9.3.1): collection **not registered anywhere** | Names/args hanya untuk middleware yang dipakai route; `unused` tidak muncul | Tidak dapat discovery unused melalui router registry |
| Container known key | Public `hasBinding` `node_modules/@adonisjs/fold/build/src/container.d.ts:92-93`; alias/bind/singleton declarations `:156-166,185-207,242-264` (11.1.0) | Setelah provider register; observed via request | Re-register saat restart; counter tetap 0 |
| Full container inventory/provenance | **Tidak tersedia**; internal `node_modules/@adonisjs/fold/build/index.js:309-316` (11.1.0) menyimpan ECMAScript private maps; provider asal unknown | Tidak tersedia pada lifecycle apa pun lewat API yang diamati | Tidak ada private-property adapter biasa yang bisa membaca `#` fields |
| Registered persistent events/listener identities | Public `emitter.eventsListeners`, `node_modules/@adonisjs/events/build/src/emitter.d.ts:13-22`; `listen :44`, class/lazy normalization internal `build/emitter-BaiN6nb0.js:121-153` (10.2.0) | Sesudah start/events preload; ready observed | Map count 5 stabil setelah restart |
| once / wildcard + total count | Public methods emitter; internal evidence `node_modules/@adonisjs/events/build/emitter-BaiN6nb0.js:159-170,245-246` (10.2.0) | once/wildcard tidak tersimpan di exposed map; total count=7 | Identity inventory partial; bukan hasil emit |
| Lifecycle preload ordering | Public lifecycle type `node_modules/@adonisjs/application/build/src/types.d.ts:386-390`; warmUp docs `build/src/application.d.ts:484-489` (9.1.0) | Provider start sebelum preloads | Routes/model/provider restart mengulang semua phase |
| Router commit boundary | Internal evidence `node_modules/@adonisjs/http-server/build/define_config-CthsZu7o.js:3315-3336,5406-5416` (9.3.1); commit public declaration `build/src/router/main.d.ts:193` | Server.boot commits sesudah app preload | Jangan commit manual di provider: akan membekukan route terlalu dini |
| HMR dispatch | Public tooling declaration `node_modules/@adonisjs/assembler/build/src/dev_server.d.ts:5-8`; internal dispatch evidence `build/index.js:1156-1195` (8.5.2) | `ace serve --hmr` | Behavior tergantung imported dependency graph, bukan janji semua model hot-swapped |
| Active handles | **Private diagnostic** Node `process._getActiveHandles()` | Selama snapshot HTTP | 4 setiap sample; tidak dipakai sebagai production API |

Node runner memakai public APIs `child_process.spawn/spawnSync`, filesystem promises, timers promises, HTTP request dan process.kill: [Node v24 docs](https://nodejs.org/docs/latest-v24.x/api/). Lucid `BaseModel` public import `@adonisjs/lucid/orm`: [Lucid models](https://lucid.adonisjs.com/docs/models). Auth middleware factory berasal dari fixture `start/kernel.ts:47-49`; option guards ditentukan fixture middleware, bukan deteksi auth melalui tebakan route prefix.

## Keterbatasan
Satu exact dependency tuple macOS API kit; tidak mengklaim minimum-version/Linux/React support. Controller memakai lazy tuple, bukan generated controllers barrel. Global router/group provenance tidak tersimpan sebagai field terpisah pada committed stack. Registry named yang tidak digunakan tidak dapat ditemukan runtime-only. Identitas function berasal runtime reference/`Function.toString`, tidak diparse untuk mengklaim resolved filesystem import path. Probe raw function source tidak layak diekspos tanpa redaction/output limit di package.

`eventsListeners` tidak menginventaris `once`/`onAny`; getter mengembalikan mutable Map dan hanya dibaca oleh probe. Tidak menguji event dispatch atau side effect listeners, karena requirement enumerasi tanpa emit. Count 7 hanya di initial snapshot; tabel HMR membandingkan exposed persistent map, bukan identity seluruh listener. Handles termasuk koneksi request snapshot, bukan benchmark heap/leak menyeluruh. Provider dapat diubah tanpa lifecycle rerun jika pengguna mengganti konfigurasi HMR; hasil di sini untuk graph fixture ini. Tidak ada MCP route, transport atau security gate yang diklaim telah diimplementasikan oleh spike ini.

## Keputusan dan dampak
Pass plan S-D dengan syarat output jujur partial; bukan pass seluruh janji desain original. D13 ditegaskan (runtime reference berbeda dari source-derived import identity). D15 ditegaskan (provider origin unknown); bahkan daftar full bindings tidak tersedia. D01–D12 dan D16–D20 tidak berubah oleh eksperimen ini. Kontrak §4.2 benar: daftarkan route pada boot/start, baca metadata final pada ready/lazy request, jangan memanggil router.commit sendiri. Manfaatkan process restart untuk invalidasi, bukan cache-busting import tambahan.

**Keputusan setelah putaran 2:** status tetap LULUS BERSYARAT, tetapi blocker container di bawah ditutup untuk kontrak inventory berguna dengan explicit partial coverage. Kombinasi source-declared + runtime-verified menjadi baseline tanpa monkey-patching; early public-method observation opt-in dapat menambahkan kind/alias/class dan provenance register yang benar-benar teramati. D15 kini membolehkan origin provider hanya dari public registration tracing, bukan asumsi stack; origin lainnya unknown. Upstream API diperlukan untuk kelengkapan absolut, bukan blocker baseline berlabel.

- OBL: WP introspection routes/middleware harus membaca snapshot sesudah commit dan memberi labels unknown/partial untuk asal global/group middleware, anonymous/lazy handler names, serta unused named middleware; jangan menganggap named registry tersedia.
- OBL: `get_events` harus menyatakan inventory `eventsListeners` hanya persistent registered map; once/wildcard tidak tercakup, sertakan limitation dan total listenerCount bila diperlukan tanpa emit.
- OBL: Cache metadata/controller-derived source tidak boleh hanya invalidasi di provider ready: controller hot swap tidak memanggil boot/ready. Gunakan fresh runtime reads atau mekanisme HMR version yang diuji sebelum caching source-derived data.
- OBL: Regression fixture WP-04/E09 harus menjaga boot/start registration before commit, controller hot swap, route/model/provider process restart, dan stable listener/handle counts pada version tuple yang didukung.
- Temuan BLOCKER historis putaran 1 (ditutup putaran 2 untuk kontrak partial): Full zero-config `get_container_bindings` tidak dapat dibuat dari Fold 11.1 public inventory API/private-property reflection. Putaran 2 di bawah membuktikan opsi discovery alternatif beserta batas cakupannya; tidak mengubah klaim ketiadaan public inventory getter.

## Putaran 2 — resolusi blocker

**Status putaran 2: LULUS BERSYARAT; tidak ada BLOCKER aktif untuk inventory berlabel partial.** Probe tambahan `spikes/s-d/run2.mjs`; command nyata `node spikes/s-d/run2.mjs`. Script meng-clone API baru dengan nama `s-d2-api-<timestamp>`, menjalankan HTTP direct entry di port 41061, dan menghentikan process group di `finally`. Tidak memodifikasi probe/hasil putaran 1. Dependency tuple sama; TypeScript AST berasal dev dependency fixture, bukan dependency runtime package yang sudah diputuskan.

Versi parser teramati dari `npm ls typescript` pada clone final: **typescript@6.0.3**, direct dev dependency dengan assembler/eslint memakai versi deduped yang sama.

### (a) Early public-method observation dan provenance

`InventoryProvider` ditempatkan FIRST pada `adonisrc.ts.providers`. Constructor menyimpan original methods dan memasang wrapper instance `bind`, `singleton`, `bindValue`, `alias`, `swap`. Wrapper memanggil original dengan `Reflect.apply(original,this,args)`, merekam hanya sesudah sukses, tidak memanggil factory. Ini **instrumentation terhadap public methods**, bukan official interceptor API framework. Shutdown melepas subscription dan mengembalikan method originals. Probe tidak membaca private `#` fields.

Provider asal didapat lewat exported public `tracingChannels.providerRegister.subscribe({start,end})` dari `@adonisjs/application`: callback start membawa `{provider}`; register bersifat synchronous. `origin` diisi nama class provider hanya selama scope register; caller stack disimpan sebagai bukti diagnostic terpisah, tidak dipakai otomatis menentukan provider. Constructor dan boot provider berada di luar scope tersebut dan benar-benar menghasilkan `origin:'unknown'`, walaupun stack menunjuk file GroundProvider.

Output final nyata, clone `/tmp/adonisjs-mcp-m0/s-d2-api-1791855915868`, PID 3579:

```text
CODEMOD_FIRST true
CODEMOD_TAIL true
records=38
kinds={bind:5,singleton:21,alias:8,bindValue:3,swap:1}
constructions=0
scopeChecks=[InventoryProvider,AppServiceProvider,HashServiceProvider,
 SessionProvider,ShieldProvider,DatabaseServiceProvider,CorsProvider,
 AuthProvider,GroundProvider]
sd2:first       bind       origin=InventoryProvider
sd2:declared    bind       origin=GroundProvider
sd2:singleton   singleton  origin=GroundProvider
sd2:value       bindValue  origin=GroundProvider
sd2:alias       alias      origin=GroundProvider target=sd2:singleton
class:BoundClass bind      origin=GroundProvider
class:BoundClass swap      origin=GroundProvider
sd2:constructor bindValue  origin=unknown
sd2:boot        bindValue  origin=unknown
```

Ground truth runtime `hasBinding`: app/config/logger dan kelima string key yang didaftarkan provider semuanya `true` dan recorded=true; `BoundClass` true dan recorded. Bindings Core mencakup class Application/Logger/Router/Server, named aliases, singleton hash/auth manager/Lucid dan class middleware. Counter factory bind/singleton tetap **0**. Satu class key dapat punya nama sama dengan class lain: display `class:Name` di probe bukan stable identifier yang boleh dipakai dedup production; simpan referensi class/key identity sebenarnya.

Untuk membuktikan celah sebelum observer, Ignitor `.tap(app => app.booting(...))` pada disposable `bin/server.ts` menambahkan `sd2:early` dan `sd2:earlyUndeclared` **sebelum provider constructors**. Keduanya `hasBinding=true`, tetapi observed=false. Pada fixture default app/config/logger tidak missed: semua didaftarkan AppServiceProvider sesudah observer. Tidak ada klaim bahwa Ignitor selalu mendaftarkan binding sebelum providers; skenario negatif explicit membuktikan bagaimana existing/user early bindings terlewat.

`make(UnboundClass)` berhasil menghasilkan instance, tetapi `hasBinding(UnboundClass)` sebelum **dan** sesudah tetap false. Class yang bisa di-auto-construct bukan registered binding; tidak seharusnya diinventaris sebagai singleton/bind. `swap` tercatat sebagai mutation/overlay, bukan overwrite jenis registrasi awal. Probe tidak menginstansiasi BoundClass.

Order codemod benar-benar dijalankan: `CodeTransformer` dari exported `@adonisjs/assembler/code_transformer`, URL cwd, `updateRcFile(rc => { rc.addProvider(existingObserver); rc.addProvider(newTail) })`. Existing first observer tidak dipindah dan entry baru ditambahkan. File hasil codemod dibaca lalu dikembalikan sebelum boot karena tail deliberately nonexistent. **addProvider tidak memiliki prepend API**: configure yang menambahkan observer baru secara biasa akan menaruhnya terakhir. Existing first position survive addProvider, tetapi user/preset/codemod lain dapat reorder. Configure harus memindahkan/menempatkan first secara eksplisit jika observation diaktifkan dan memberikan diagnostic bila terlambat.

Percobaan awal mengimpor CodeTransformer dari package root gagal `TypeError: CodeTransformer is not a constructor` sebelum server start. Diperbaiki memakai exported subpath dan `updateRcFile`, bukan akses private RcFileTransformer.

### (b) Declared-key discovery + runtime verification

Scanner memakai TypeScript AST pada `.d.ts` node_modules dan augmentation app source untuk mengumpulkan literal/identifier members interface `ContainerBindings` beserta file/line, termasuk interface baseline Core. Semua kandidat kemudian diuji public `hasBinding(key)` tanpa `make`. Output nyata:

```text
total=17 unique=17
verified=[auth.manager,ace,dumper,app,logger,config,emitter,encryption,hash,
 server,router,testUtils,lucid.db,sd2:declared,sd2:early]
absent=[repl,sd2:absent]
```

`repl` declared tetapi provider environment tidak aktif; tidak disajikan sebagai available binding. `sd2:absent` sengaja declared-only, terbukti false. `sd2:early` terlewat early observation tetapi dipulihkan scanner + verification. `sd2:earlyUndeclared` tetap tidak ditemukan oleh kedua discovery lanes walaupun ground-truth `hasBinding` true. Nama class constructor/symbol, undeclared dynamic keys, computed/mapped/extended interface members tidak otomatis menjadi literal-key candidates. Type declaration memberi availability candidate, **bukan** runtime kind/singleton/provider origin.

Evidence kandidat verified adalah **`source-declared+runtime-verified`**, origin unknown dan kind unknown bila tidak ada observed registration yang cocok. App declarations contoh berasal `app/probe_bindings.ts:1`; installed declarations berasal Core `node_modules/@adonisjs/core/build/src/types.d.ts:224-246`, Auth `node_modules/@adonisjs/auth/build/providers/auth_provider.d.ts:5`, Lucid `node_modules/@adonisjs/lucid/build/providers/database_provider.d.ts:25`. File/line adalah declaration source, bukan provider registration provenance.

### (c) Rekomendasi dan kontrak jujur

Baseline yang non-invasive: AST declaration discovery + `hasBinding` menghasilkan inventory berguna dari Core/Auth/Lucid/app declarations, dengan `coverage:'partial'`, evidence source-declared+runtime-verified, dan `origin:'unknown'`. Jangan menjalankan semua factories untuk menemukan types atau menerjemahkan TypeScript types menjadi jenis binding runtime.

Opt-in early observation menambah lane `runtime-observed-registration` untuk key/type/kind/alias target (termasuk class keys) dan `originEvidence:'provider-register-trace'` jika dalam synchronous register trace. Dedupe harus memakai real key identity; declared string alias digabung hanya dengan observed string key yang sama. Perubahan registration berikutnya harus dicatat sebagai update/overlay dan availability diverifikasi kembali. Caller stack dapat diberi `source-caller` evidence terpisah, bukan provider provenance yang dijamin.

| Metadata | API/source | Cakupan nyata / limitation |
| --- | --- | --- |
| Provenance synchronous register | Public `@adonisjs/application@9.1.0`, `build/index.d.ts:8`, `build/src/tracing_channels.d.ts:19-22`; internal evidence `build/application-TLzZVFOE.js:1729` traceSync | Semua observed register calls dikaitkan provider yang benar; constructor/boot unknown |
| Binding kind/alias/class | Public Fold methods; wrappers adalah opt-in instrumentation, bukan public registration hook | 38 successful method calls, no factory construction; early existing bindings terlewat |
| Codemod order | Public assembler 8.5.2 subpath `package.json:17`; `build/src/code_transformer/main.js:223-230,680-683` | Existing first survive addProvider; newly added provider appended, bukan prepended |
| Early app hook | Public application booting hook; fixture `bin/server.ts:32-36` | Registrasi sebelum provider observer terlewat, declared lane dapat recover hanya key yang declared |
| Source candidates | TypeScript public AST `createSourceFile`, `isInterfaceDeclaration`, `forEachChild`; [Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) | Literal keys saja; parser/context validation harus membatasi augmentation ke Core types module |
| Runtime verification | Fold11.1 public `build/src/container.d.ts:92-93` | hasBinding tidak instantiate dan tidak membedakan factory/value/alias/singleton |

Scope register global dalam probe cukup untuk sync trace yang dibuktikan; jangan perluas ke async boot/start dengan mutable global scope karena concurrency dapat salah atribusi. Constructor/provider module top-level registration, late delegates, aliases/class names collision, conditional/contextual bindings, resolver-local bindings, saved references to original methods, restore/restoreAll dan re-registration merupakan limitation instrumentation yang harus eksplisit. AST probe hanya mencari nama interface; implementasi package harus memvalidasi enclosing declaration module agar interface unrelated bernama sama tidak dianggap Core augmentation. Tidak mengklaim `get_container_bindings` telah diimplementasikan.

- OBL: Tetapkan inventory contract partial dengan per-item evidence, key identity/type, availability dan nullable/unknown kind/origin; pisahkan registered bindings dari auto-constructible classes.
- OBL: Gunakan source-declared+runtime-verified baseline; validasi augmentation module/context, dedupe candidate, filter absent bindings, serta jangan instantiate untuk enumerasi.
- OBL: Jika early observation dipilih, jadikan opt-in eksplisit, tempatkan observer sebelum provider lain, simpan/restore methods dan detach trace subscription; cek first-position dan label pre-observation gap.
- OBL: Atribusi provider hanya dari synchronous public register trace yang teramati; constructor/boot/late caller origin unknown, stack hanya source-caller diagnostic.
- OBL: Full completeness masih memerlukan upstream read-only inventory API untuk existing undeclared keys dan metadata yang tidak teramati; ini documented limitation, bukan BLOCKER bagi kontrak partial.
