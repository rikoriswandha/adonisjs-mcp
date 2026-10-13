# S-I — Introspeksi artefak dan kesegaran HMR
Status: LULUS BERSYARAT
Tanggal: 2026-10-13

## Pertanyaan

Inspect generated Tuyau/data, Vine compiled schema, Inertia render, Edge views; ubah source via HMR. Lulus bila direct/static case menghasilkan evidence akurat, dynamic case jelas unknown, dan reload tidak stale. Controller **tidak** dieksekusi untuk menemukan props.

## Lingkungan

- macOS 27.0 arm64; `node v24.21.0`, npm 11.19.0.
- Fixture create-adonisjs 3.4.0: API, React/Inertia, dan hypermedia/Edge; SQLite fixture lokal. Tidak ada koneksi PostgreSQL/Redis atau perubahan base fixture.
- Run final: `/tmp/adonisjs-mcp-m0/s-i-{api,react,hypermedia}-1791855878707`.
- Port HTTP API 41160, React 41163, hypermedia 41166; Vite React 41164.
- Exact resolved versions dari `npm ls` dalam clone, disimpan lengkap pada `observations.json` (`kits.*.versions`):

| Package | API | React | Hypermedia |
| --- | --- | --- | --- |
| `@adonisjs/core` | 7.6.0 | 7.6.0 | 7.6.0 |
| `@adonisjs/assembler` | 8.5.2 | 8.5.2 | 8.5.2 |
| `@vinejs/vine` | 4.4.0 | 4.4.0 | 4.4.0 |
| `@tuyau/core` | 1.2.2 | 1.2.2 | tidak terpasang |
| `@adonisjs/inertia` | tidak terpasang | 5.0.1 | tidak terpasang |
| `edge.js` | 6.5.1 transitif Core | 6.5.1 | 6.5.1 |
| `@adonisjs/vite` | tidak terpasang | 6.0.3 | 6.0.3 |
| `@poppinss/ts-exec` | 1.5.0 | 1.5.0 | 1.5.0 |
| `hot-hook` | 1.0.0 | 1.0.0 | 1.0.0 |

`@adonisjs/http-transformers@2.3.1` teramati melalui `npm ls` React; TypeScript compiler 6.0.3 teramati oleh source probe; Vite 8.3.4 teramati pada startup log. MCP SDK tidak diperlukan: spike ini memeriksa API introspeksi, bukan transport S-A. Kehadiran Edge transitif di API/React bukan bukti surface hybrid.

## Skenario dan command

Dari root repository:

```sh
node spikes/s-i/run.mjs
```

Entry script membuat clone baru dengan suffix timestamp melalui `spikes/clone-fixture.sh`, memasang hanya specimen probe, menjalankan setiap app secara berurutan dengan `HOST=127.0.0.1 PORT=<port> NODE_ENV=development node ace serve --hmr`, lalu mematikan seluruh process group miliknya pada `finally`. React memakai proses Vite terpisah dengan command berikut di clone:

```sh
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 41164 --strictPort
```

Runner mengambil compiled validators/config/runtime PID, response Inertia, inventory/render Edge, snapshot source/hash/mtime semua `.adonisjs` files; mengubah validator, transformer, page, view; menambahkan page/transformer/route untuk memicu regeneration inventory. Sesudah server berhenti, runner mengganti registry sementara dengan snapshot lama untuk membuktikan stale detection, lalu memindahkan file sementara untuk membuktikan missing detection; keduanya dipulihkan.

Probe tambahan dapat diulang tanpa server dan tanpa mengeksekusi controller:

```sh
node spikes/s-i/vine.mjs /tmp/adonisjs-mcp-m0/s-i-api-1791855878707 spikes/s-i/vine-observations.json
node spikes/s-i/source.mjs /tmp/adonisjs-mcp-m0/s-i-react-1791855878707 spikes/s-i/source-observations.json
```

Runner juga memanggil kedua helper tersebut. `source.mjs` membaca AST dengan TypeScript compiler milik fixture; tidak import controller/middleware aplikasi. Specimen `pages_controller.ts` berisi static dan dynamic renders; route tersebut tidak direquest. Satu route callback probe `/__s_i_page` dirender untuk observasi protokol Inertia, bukan untuk discovery controller.

Bukti mentah: `spikes/s-i/observations.json`, `vine-observations.json`, `source-observations.json`; kegagalan percobaan awal dan log Vite yang stale disimpan pada `attempts.json`.

## Hasil teramati

✅ **Direct/static akurat:** compiled Vine AST mengandung field/rule/options, nested object, array wildcard, optional/nullable; source AST memetakan route literal ke page dan props literal tanpa eksekusi controller; mounted Edge views dan slot literal ditemukan.

✅ **Dynamic jelas unknown:** page dari `request.input('page')` menghasilkan `component:null, componentEvidence:"unknown-dynamic"`; spread props hanya menghasilkan known key `label`, completeness `partial`. Group/union menyimpan function refs, bukan penjelasan predicate; custom messages provider tanpa serializer tetap unknown.

✅ **Reload tidak stale:** ketiga server memberikan validator `min:3 → 7` dan transformer `{id:1,revision:"after",added:true}`; React/Vite mengembalikan page source `after`; generated page/data inventory mengenali file baru; Edge render berubah; route baru dan registry Tuyau diperbarui. Vite fixture `/tmp` membutuhkan penyesuaian ignore pattern, dijelaskan di bawah.

**Tuyau.** Hook `generateRegistry()` ada di `adonisrc.ts` API/React. Artefak berada di `.adonisjs/client/registry/`: `index.ts`, `schema.d.ts`, `tree.d.ts`. `index.ts` berisi nilai runtime setelah TypeScript stripping: methods, pattern, tokens. Ini bukan JSON schema request/response. Import dengan `--import=@poppinss/ts-exec` berhasil; import Node 24 native stripping juga berhasil saat eksperimen stale. Hasil runtime menunjukkan `types:{}` dan `$tree:{}`—placeholder, bukan shape sebenarnya. Request/query/response types ada di declaration `schema.d.ts`; tree types ada di `tree.d.ts`.

Setelah route `s_i.added` ditambahkan, HTTP `/__s_i_added` memberi 200 dan ketiga registry files berubah hash. Ketika snapshot registry lama sengaja dipasang setelah server dihentikan:

```json
{"runtimeRoutePreviouslyObserved":200,"generatedHasAdded":"false","result":"STALE"}
```

File yang dipindahkan sementara memberikan `missingDetection:"ENOENT"`. File existence saja tidak membuktikan freshness; bandingkan method/path/name dengan runtime route inventory, dengan memperhitungkan filter generator. Perubahan types membutuhkan source/dependency generation tracking, bukan perbandingan route names saja. Hypermedia tanpa Tuyau dilaporkan `absent-no-Tuyau-hook`, tidak diberi fake empty schema.

**VineJS.** Contoh direct `vine-observations.json`:

```json
{"fieldName":"value","allowNull":true,"isOptional":false}
{"ruleFnId":"ref://2","name":"minLength","implicit":false,"isAsync":false}
{"ref://2":{"validator":{"kind":"function","name":"minLength"},"options":{"min":3}}}
```

`toJSON()` mengembalikan compiled schema dan refs; refs mengandung function, sehingga tidak boleh diserialisasi dengan JSON biasa tanpa menandai bagian yang hilang. Probe mengganti functions dengan `{kind:"function",name:<nama>}`; tidak memanggilnya untuk introspeksi. `toJSONSchema()` tersedia pada schema langsung maupun compiled validator, tetapi bukan authority lengkap:

- **Bug/projection gap teramati pada kasus static nullable:** `rows[].value = vine.string().nullable()` menghasilkan JSON Schema object item dengan `required:[]`. Validasi aktual `rows:[{}]` gagal dengan `rule:"required",field:"rows.0.value"`. Compiled AST benar: `allowNull:true,isOptional:false`. Nullable bukan optional.
- Nested object/array, minLength/minimum/minItems dan optional ditemukan; required/nullability harus diambil dari compiled AST, bukan JSON Schema saja.
- `vine.group` dan conditional `vine.union` mengekspos branch schemas serta `conditionalFnRefId`/refs. JSON Schema hanya memberi alternatives; callback applicability, branch precedence, dan custom otherwise behavior tidak dapat dibuktikan dari JSON Schema. Contoh group input `{kind:"company",person:"not-company"}` benar-benar gagal required `company`.
- Custom rule `customAllowed` terdaftar pada compiled AST, dan actual validation memberi `CUSTOM_DENIED`. JSON Schema hanya menyimpan tipe string karena rule tidak menyediakan metadata `toJSONSchema`; arti rule tetap unknown.
- `SimpleMessagesProvider.toJSON()` memberi `{messages:{"title.minLength":"TITLE_TOO_SHORT"},fields:{title:"Judul"}}`; actual invalid title menghasilkan `TITLE_TOO_SHORT`. Custom provider `{getMessage(){...}}` tidak mempunyai `toJSON`; actual validation menghasilkan `DYNAMIC_minLength`, tetapi metadata message tetap `unknown-without-execution`.

**Inertia.** `indexPages({framework:'react'})` menghasilkan `.adonisjs/server/pages.d.ts` berisi `InertiaPages` dan `ExtractProps<typeof import(page)>`; ini type inventory, bukan runtime route→page map. Static source extraction yang teramati:

| Route | Component | Known props | Evidence |
| --- | --- | --- | --- |
| `/__s_i_page` | `s_i` | `label` | source literal, route callback |
| `/__s_i_static` | `s_i` | `label`, `count` | source literal, controller **tidak dieksekusi** |
| `/__s_i_dynamic` | unknown | `label`, lainnya unknown | source dynamic component/spread props |

Runtime Inertia response pada probe callback:

```json
{"status":200,"inertiaHeader":"true","versionHeader":null,"body":{"component":"s_i","version":"1","sharedProps":["errors","user","preferences"]}}
```

Excerpt di atas hanya memilih field; response lengkap ada di observations. Version normal berada dalam page body; jangan menganggap response sukses selalu membawa `X-Inertia-Version`. Source middleware menunjukkan header version pada 409 mismatch. `getVersion()` memakai manifest hash **di luar dev mode**; dev default `"1"`, sehingga tidak perlu menebak versi dari manifest build lama.

`config/inertia.ts` fixture berisi SSR `enabled:false`, `entrypoint:'inertia/ssr.tsx'`; tidak ada `sharedData`. Config type v5.0.1 juga tidak menyediakan sharedData. Shared keys berasal dari `InertiaMiddleware.share()`, bukan config: `errors,user,preferences`; flash bag `success,error`. AST dibaca tanpa memanggil method atau lazy values. Runtime page `sharedProps` menguatkan keys untuk **request itu saja**, bukan inventaris universal. Manager public API hanya factory `createForRequest`; tidak ada public global route/page registry pada contract yang diperiksa. Adapter React dibuktikan hook config dan page `.tsx`, bukan hanya package Inertia terpasang. Installed source mendukung `react` dan `vue3`; Vue live app tidak diuji, Svelte/Solid tidak dapat diklaim didukung oleh indexPages ini.

**Transformers / Data.** `.adonisjs/client/data.d.ts` berisi namespace `Data`, alias `InferData<ProbeTransformer>`, `InferVariants`, serta shared/flash type aliases. Tidak berisi shape JSON runtime dan tidak materialize semua field. Alias frontend fixture `@generated/*` mengarah ke `.adonisjs/client/`; file ini type-only. Perubahan transformer existing pada API tidak mengubah hash/mtime data.d.ts tetapi runtime transformer berubah: inference mengikuti source yang diimport, sehingga file generator yang sama bukan berarti stale. Menambah `added_transformer.ts` pada React mengubah data.d.ts dan menambahkan `AddedTransformer`. Probe mengeksekusi `toObject()` hanya pada transformer specimen miliknya untuk mengukur freshness; discovery shape transformer aplikasi tetap generated/type/source, bukan eksekusi arbitrary transformer.

**Edge.** `edge.loader.mounted` memberi disk `default` yang menunjuk `resources/views`; `edge.loader.templates` adalah raw registered templates dan hasilnya `[]`, **bukan** daftar file template yang mounted. Public loader tidak memberi exhaustive filesystem inventory/slot registry. Probe melakukan scan terbatas mounted roots dengan realpath containment, kemudian menandai convention `components/` dan membaca source slot literal `main,footer` pada `components/s_i.edge`. `$slots[expression]`, dynamic component targets dan composition tetap unknown.

Render template inventory `s_i` dengan JSON state `{greeting:'<JSON state>'}` memberi:

```text
<p>before &lt;JSON state&gt;</p>
<p>after &lt;JSON state&gt;</p>
```

Input view `../../.env` ditolak sebelum render: HTTP 400 `{"error":"VIEW_NOT_IN_INVENTORY"}`. Tidak ada arbitrary file read pada probe render. Template helpers/globals tetap executable trusted application code; escaping state bukan sandbox atau jaminan read-only.

**Tabel artefak → source kind → API/file → freshness:**

| Artefak | Source kind | API/file | Freshness teramati |
| --- | --- | --- | --- |
| Tuyau methods/path/tokens | generated runtime values | `registry/index.ts`, import TS stripping | Regenerated sesudah route change; old snapshot terdeteksi stale |
| Tuyau body/query/response/tree shapes | generated type-only | `schema.d.ts`, `tree.d.ts` | Declaration files regenerated; resolved shape butuh compiler/source tracking |
| Vine field/rule/nullability/options | runtime | compiled `toJSON()` + refs | `min:3→7` pada semua kit; PID berubah |
| Vine JSON Schema projection | runtime projection | `toJSONSchema()` | Fresh sesudah restart; tidak sound untuk required nullable/conditional/custom rules |
| Custom message maps | runtime, bila serializer tersedia | `SimpleMessagesProvider.toJSON()` | Teramati accurate; arbitrary provider unknown |
| Inertia page inventory | generated type-only | `.adonisjs/server/pages.d.ts`, `indexPages` | New page terdaftar; existing props diinfer dari source |
| Route→component/props | source | TS AST route + render calls | Source read baru; dynamic/spread explicit partial/unknown |
| Shared keys | source; runtime request-specific corroboration | middleware `share`/`flash`; page `sharedProps` | Lazy values tidak dievaluasi untuk discovery |
| Adapter/SSR | source + resolved config runtime | `adonisrc.ts`, `.tsx`, `config.get('inertia.ssr')` | React, SSR false pada run |
| Inertia asset version | runtime | `getVersion`, page object | Dev `1`; production manifest algorithm source-only, belum live diuji |
| Data/transformer inventory | generated type-only | `data.d.ts`, `InferData` aliases | Existing body change tidak rewrite; file add regenerate |
| Transformer specimen output | runtime execution specimen | `new ProbeTransformer(...).toObject()` | `before→after,added:true`; bukan discovery arbitrary app data |
| Edge mounted/raw-template metadata | runtime | loader `mounted`, `templates` | Dibaca per request |
| Edge file/component/slot inventory | source | scan realpath-mounted roots, slot literal source | Views dibaca fresh; dynamic slots unknown |
| Edge rendered HTML | runtime | `edge.render(inventoryName, JSON state)` | `before→after`; tidak membutuhkan restart khusus view |

HMR bukan janji same-process untuk semua source. PID `before→validator→transformer`: API `1799→1884→1994`, React `2423→2531→2659`, hypermedia `3035→3098→3161`. Hot-hook me-restart aplikasi saat dependency probe tidak mempunyai accept boundary. View edit sesudah transformer read tetap memberi PID 3161 dan HTML baru; cache Edge dev tidak aktif. Pages/data generated hashes berubah ketika file baru ditambahkan; route declarations/registry berubah ketika route ditambahkan.

**Percobaan gagal yang diperbaiki:** (1) X-Inertia-only request tidak menyalakan Vite; source fetch pertama gagal, runner kini menyalakan Vite eksplisit. (2) Hypermedia tidak punya alias `#transformers`; probe kini memakai relative import tanpa mengubah package.json. (3) Kit Vite memakai watch ignore `**/tmp/**`; semua source clone di `/private/tmp/...` terkena ignore. Vite tetap mengembalikan page `before` selama deadline 90 detik. Runner menghapus **hanya** ignore pattern tersebut pada disposable React clone; rerun final selesai 40.33 detik dan fresh. Base fixture tidak berubah.

Cleanup teramati: `lsof -nP -iTCP:41160-41179 -sTCP:LISTEN` tidak mengeluarkan listener (exit 1), sesudah run final. Tidak ada cluster atau proses probe tertinggal; clone dibiarkan untuk review.

## Referensi API/source

Path berikut relatif terhadap clone `node_modules/`, dengan version eksplisit. Public signature dan implementation detail dibedakan:

- **Public/documented:** `@tuyau/core@1.2.2/build/backend/generate_registry.d.ts:214-218`, assembler hook `generateRegistry`. **Internal implementation:** `build/backend/generate_registry.js:209-258,304-335`, pembagian runtime/types/tree dan routesScanned hook.
- **Public/documented:** `@vinejs/vine@4.4.0/build/src/vine/validator.d.ts:21,40,117-139`, schema/messagesProvider/tryValidate/toJSON/toJSONSchema; `build/src/messages_provider/simple_messages_provider.d.ts:64-72`, serializer message provider.
- **Public/documented:** `@vinejs/vine@4.4.0/build/src/schema/object/group_builder.d.ts:6-34`, group/if/else; `build/src/schema/union/builder.d.ts:4-31`, conditional union. `build/index.js:21-56` menjelaskan custom rule `toJSONSchema` metadata. **Internal implementation:** `build/index.js:744-750,2009-2010,3189-3191,5176-5177,6036-6044,6146-6163`, function refs, conditional projection, compiled schema clone dan cached JSON Schema.
- **Public/documented:** `@adonisjs/inertia@5.0.1/build/src/index_pages.d.ts:3-27`, `indexPages` dan dua framework; `build/src/inertia_middleware.d.ts:74-112`, share/flash; `build/src/types.d.ts:547-599`, config dan typed PageObject; `build/src/inertia_manager.d.ts:17-46`, request factory; `build/src/inertia.d.ts:160-170`, `getVersion`.
- **Internal implementation:** `@adonisjs/inertia@5.0.1/build/inertia-CUwopUPW.js:9-12,62-98`, generated pages index; `build/inertia_manager-CqPPQia8.js:1428-1464`, dev version/manifest/SSR; `build/src/inertia_middleware.js:98-115`, mismatch 409 version header.
- **Public hook, implementation detail:** `@adonisjs/core@7.6.0/build/index_entities-C517sTpx.js:64-76,123-140`, transformer/data/manifest generation; output declaration is generated evidence, bukan runtime API untuk shapes. **Public export:** `build/modules/transformers/main.d.ts:1` re-export HTTP transformers.
- **Public/documented:** `@adonisjs/http-transformers@2.3.1/build/src/base_transformer.d.ts:11-20,123-139`, specimen `toObject` pattern dan constructor.
- **Public/documented:** `edge.js@6.5.1/build/src/loader.d.ts:20-50`, mounted/raw templates; `build/src/edge/main.d.ts:23-27,140-147`, loader dan render. **Internal provider configuration:** `@adonisjs/core@7.6.0/build/providers/edge_provider.js:94-98`, app views mount/cache production-only.
- **Public/documented:** `@adonisjs/assembler@8.5.2/build/src/dev_server.d.ts:3-12,109-132`, HMR delegation dan dev-server lifecycle.
- **Public/documented:** TypeScript compiler AST API, https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API ; Vite server watcher, https://vite.dev/config/server-options.html#server-watch . Probe memakai TypeScript fixture 6.0.3 dan Vite 8.3.4.

## Keterbatasan

- Spike bukan implementasi package atau MCP transport; minimal routes dipasang hanya untuk mengukur runtime app nyata. Tidak ada permanent test suite.
- Source parser specimen hanya mendukung direct literal `inertia.render`, simple `router.get/post`, dan controller lazy import array. Aliases kompleks, helper wrappers, inherited/dynamic controllers, computed/spread keys, runtime `inertia.share`, dan middleware-computed keys tetap partial/unknown. Tidak ada klaim whole-program analysis.
- Exported validators milik probe dibaca melalui explicit imports; enumeration semua module validators aplikasi memerlukan bounded source/export discovery dan lazy loading. Import validator module tepercaya tetap dapat menjalankan side effect top-level; tidak ada sandbox.
- JSON Schema **tidak** menjamin accuracy seluruh required/rule semantics; custom rule bodies, conditional callbacks, dynamic enum/data, transforms dan custom provider message resolution bukan metadata statis yang bisa dibuktikan lengkap.
- Production build/manifest hashing, SSR aktif, Vue live kit, browser React refresh rendering, deletion/race handling, arbitrary custom Edge loaders dan registered in-memory templates tidak diuji. Yang diuji untuk page freshness adalah transformed JS dari Vite, bukan browser DOM.
- Source slots/components memakai static convention scan, bukan public semantic slot registry; layout composition/dynamic slot discovery tidak diklaim lengkap.
- Missing/stale simulation sesudah shutdown membuktikan deteksi disk snapshot vs route observation terakhir; tidak membuktikan atomic reload under concurrent calls atau semua type-shape stale cases.

## Keputusan dan dampak

- Plan criterion **direct/static evidence: LULUS**, menggunakan compiled Vine AST dan source/generated yang jujur; menolak JSON Schema sebagai satu-satunya authority.
- Plan criterion **dynamic unknown: LULUS**, dengan known keys/branches dan explicit partial/unknown, tanpa menjalankan controller untuk discovery.
- Plan criterion **reload tidak stale: LULUS BERSYARAT**, source/module restart dan generated inventory terbukti fresh; fixture di `/tmp` harus tidak terkena Vite ignore seluruh root. Probe tidak mengatasi stale cache dengan cache-busting ESM import.
- D13 dikukuhkan dan diperinci: tool results wajib mempertahankan source kind per fakta; `toJSONSchema()` bukan pengganti compiled metadata. D14 dikukuhkan: Edge transitif bukan hybrid. Tidak ada perubahan D01–D12/D15–D20 atau endpoint publik. Kontrak `get_validators`, `get_tuyau_schema`, `get_inertia_pages`, `get_shared_props`, `get_transformers`, `get_views` perlu completeness/evidence, bukan janji exhaustive runtime data yang tidak tersedia.
- Dampak ke WP-09 (profile/provenance), WP-21 (Inertia version/surface), WP-23 (compiled Vine), WP-24 (Inertia/shared/Data), WP-25 (Tuyau), WP-26 (Edge), WP-06/WP-37 (lifecycle/freshness): parser bounded, generated type evidence, source cache invalidation dan runtime/source provenance perlu regression acceptance sebelum milestone konsumen dinyatakan selesai.
- OBL: Gunakan compiled Vine AST untuk required/nullability/rule refs; tambahkan regression nullable-required di Vine 4.4.0, dan perlakukan JSON Schema sebagai projection yang bisa tidak lengkap. Version-pin/test interpreter AST; jangan memanggil callback/rule/provider untuk discovery.
- OBL: Pisahkan runtime route values Tuyau dari declaration-only types/Data/pages; laporkan missing/stale/filtered artifacts eksplisit. Type-shape freshness memerlukan source/dependency generation tracking atau compiler, bukan existence/mtime/route names saja.
- OBL: Sediakan bounded source AST extraction untuk static Inertia route/render/shared keys, dengan location dan completeness; custom/dynamic/spread cases unknown. Public config v5 tidak memiliki sharedData; jangan memanggil controller/share/lazy props untuk discovery.
- OBL: Cache metadata mengikuti source hash/generation dan app lifecycle; restart yang disediakan hot-hook adalah jalur yang sah. Fixture `/tmp` harus mengoreksi Vite ignore root; jangan memakai unbounded ESM query-string cache busting.
- OBL: Edge inventory menggabungkan public mounted/raw-template metadata dan bounded realpath source scan; render hanya exact inventoried names, label component/slot conventions source-only, dan pertahankan executable-helper warning.

Tidak ada BLOCKER untuk jalur direct/static yang diuji. Ketiadaan exhaustive metadata untuk kasus dynamic adalah batas evidence yang wajib diungkapkan, bukan alasan mengirim empty/fake results.
