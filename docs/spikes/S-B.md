# S-B — Production tanpa package development
Status: LULUS
Tanggal: 2026-10-13

## Pertanyaan

Build fixture, hilangkan dev dependencies, boot production web dan Ace. Lulus bila tidak ada import package/config yang gagal, tidak ada route/buffer MCP, dan aplikasi normal tetap jalan. Apakah registrasi provider `environment: ['web']` dan config yang mengimpor `defineConfig` cukup? Apakah solusi aman dapat dibuat melalui codemods assembler?

## Lingkungan

Pengamatan nyata pada macOS Darwin 27.0.0 arm64, Node `v24.21.0`, npm `11.19.0`. Fixture create-adonisjs `3.4.0`: API dan Inertia React; SQLite disposable yang sudah dimigrasikan. Tidak mengakses PostgreSQL/Redis pengguna. Port 41020–41025.

Exact resolved versions dari `npm ls @adonisjs/core @adonisjs/application @adonisjs/assembler @adonisjs/lucid @adonisjs/inertia @adonisjs/vite vite @rikology/adonisjs-mcp` di masing-masing clone:

| Package | API | React |
| --- | --- | --- |
| `@adonisjs/core` | 7.6.0 | 7.6.0 |
| `@adonisjs/application` | 9.1.0 | 9.1.0 |
| `@adonisjs/assembler` | 8.5.2 | 8.5.2 |
| `@adonisjs/lucid` | 22.4.2 | 22.4.2 |
| `@adonisjs/inertia` | tidak terpasang | 5.0.1 |
| `@adonisjs/vite` | tidak terpasang | 6.0.3 |
| `vite` | tidak terpasang | 8.3.4 |
| `@rikology/adonisjs-mcp` | 0.0.0-spike | 0.0.0-spike |

Stand-in ESM JS hanya identity config helper, provider route/buffer sentinel, configure hook, dan stubs; **bukan** implementasi MCP/SDK. Dependencies MCP SDK tidak dibutuhkan untuk pertanyaan package absence.

## Skenario dan command

Dari root repository, dengan base fixtures tersedia:

```sh
node spikes/s-b/run.mjs             # kedua kit, kedua strategi
node spikes/s-b/run.mjs api         # hanya API
```

Runner membuat clone baru `s-b-{unsafe|safe}-{api|react}-{timestamp}`, tidak mengubah base fixture. Setiap skenario menjalankan:

```sh
# cwd spikes/s-b/pkg
npm pack --pack-destination /tmp/adonisjs-mcp-m0
# cwd clone
npm install --save-dev --save-exact /tmp/adonisjs-mcp-m0/rikology-adonisjs-mcp-0.0.0-spike.tgz
SB_STRATEGY=unsafe node ace configure @rikology/adonisjs-mcp
# atau SB_STRATEGY=safe
node ace build
# cwd clone/build, sesudah menyalin .env dan SQLite fixture
npm ci --omit=dev
```

Setelah production install di `build/`, runner menyalin deployment menggunakan `cp -cR` ke sibling `{clone}-production`, **bukan** anak source tree. Ini mencegah ESM resolver menemukan dev package di `../node_modules`. Di deployment terisolasi:

```sh
NODE_ENV=production HOST=127.0.0.1 PORT=41022 node bin/server.js
NODE_ENV=production node ace list
NODE_ENV=production node ace migration:status
```

Runner menggunakan port berbeda untuk setiap HTTP instance; GET `/` lalu GET `/__adonis/mcp`. Development safe menggunakan `NODE_ENV=development HOST=127.0.0.1 PORT=<port> node --import=@poppinss/ts-exec bin/server.ts`. React menjalankan `npm exec vite build` terlebih dahulu agar direct dev server memiliki manifest tanpa menjalankan Vite watcher. `node ace build` tetap dijalankan sesudahnya untuk production build penuh.

Matrix process type dijalankan pada API safe clone:

```sh
NODE_ENV=development node --import=@poppinss/ts-exec environment-matrix.mjs
NODE_ENV=production node --import=@poppinss/ts-exec environment-matrix.mjs
NODE_ENV=test node --import=@poppinss/ts-exec environment-matrix.mjs
```

`environment-matrix.mjs` disalin dari `spikes/s-b/`; membuat/boot/terminate app nyata untuk `web`, `console`, `repl`, `test`, tanpa membuka listener. Probe independent missing provider di deployment unsafe:

```sh
node --input-type=module -e "await import('@rikology/adonisjs-mcp/providers/mcp_provider')"
```

Bukti tersimpan di `spikes/s-b/observed.json` (command exit/output, compiled files, respons HTTP; output Ace list diringkas menjadi nama/count dari JSON nyata), `environment-observed.json`, dan `provider-import-observed.json`. Output lengkap rerun berada di `/tmp/adonisjs-mcp-m0/s-b-observations.json`. Semua HTTP child dihentikan dalam `finally`; tidak ada watcher/cluster yang ditinggalkan.

## Hasil teramati

Strategi desain asli berhasil build, tetapi gagal setelah deployment benar-benar tidak memiliki dev package:

```text
PACKAGE_ABSENT true
SERVER production=true healthy=false exit=1
Error: Cannot find package '@rikology/adonisjs-mcp' imported from .../config/mcp.js
COMMAND node ace list EXIT 0
COMMAND node ace migration:status EXIT 1
Error: Cannot find package '@rikology/adonisjs-mcp' imported from .../config/mcp.js
```

Hasil identik pada API dan React. `ace list` bukan bukti boot: command tersebut tidak start app. Import provider independent juga exit 1 `ERR_MODULE_NOT_FOUND`; provider-only gate tidak menyelesaikan config import.

Strategi aman di kedua kit:

| Skenario | GET `/` | GET `/__adonis/mcp` | Package marker | Buffer | Ace list / migration:status |
| --- | --- | --- | --- | --- | --- |
| API dev safe | 200 JSON | 200 JSON | ada | true | tidak diuji pada dev |
| API production safe | 200 JSON | 404 JSON | tidak ada | false | 0 / 0 |
| React dev safe | 200 HTML | 200 JSON | ada | true | tidak diuji pada dev |
| React production safe | 200 HTML | 404 HTML | tidak ada | false | 0 / 0 |

```text
DONE: create config/mcp.ts
DONE: create providers/mcp_dev_provider.ts
DONE: update adonisrc.ts file
[ success ] build completed
SB_PACKAGE_MODULE_LOADED                              # development saja
SB_PACKAGE_BOOT {"environment":"web","inDev":true,"inProduction":false}
GET /__adonis/mcp 200 {"spike":"S-B","buffer":true}     # development
SB_OBSERVER {"environment":"web","inDev":false,"inProduction":true,"buffer":false}
GET / 200; GET /__adonis/mcp 404                        # production
SB_OBSERVER {"environment":"console","inDev":false,"inProduction":true,"buffer":false}
COMMAND node ace migration:status EXIT 0
```

API migration status menampilkan users dan access_tokens `completed`, batch 1; React users `completed`, batch 1. Semua empat production installs melaporkan package absent. Production safe tidak memuat marker module ataupun marker boot package. React production build mencakup Vite assets dan render Inertia/Edge normal.

`build/adonisrc.js` safe mempertahankan entry app-local (tidak mengimpor package langsung):

```js
{ file: () => import('#providers/mcp_dev_provider'), environment: ['web'] }
```

`build/config/mcp.js` safe menghapus `import type` dan `satisfies` seluruhnya:

```js
export default { enabled: true, path: '/__adonis/mcp', allowRemoteAccess: false };
```

`build/providers/mcp_dev_provider.js` mempertahankan conditional dynamic import dan memilih class kosong ketika production. Class kosong adalah non-MCP provider sentinel, bukan fake implementation: package module tidak diimpor, tidak ada register/boot/listener/buffer MCP.

Matrix setelah **boot** menunjukkan untuk keempat process types:

| NODE_ENV | inDev | inProduction | inTest |
| --- | --- | --- | --- |
| development | true | false | false |
| production | false | true | false |
| test | false | false | true |

`environment: ['web']` merupakan jenis proses, bukan environment deployment. HTTP = web; Ace = console; Ace repl mengubah process type menjadi repl sebelum boot; Japa runner = test. Menggunakan `environment: ['development']` bukan API yang valid. Pengamatan awal sebelum boot menghasilkan semua flags false karena NodeEnvManager belum diproses; probe final memakai boot setelah loading env, bukan menyimpulkan dari init saja.

- ✅ Tidak ada failing config/package import pada strategi aman: production web dan booting Ace di kedua kit sukses tanpa package.
- ✅ Route dan buffer MCP tidak ada: 404 dari app yang melayani `/` 200, observer binding false, module/boot marker tidak ada.
- ✅ App normal tetap berjalan: API JSON, React rendered HTML, SQLite migration status sukses.
- ✅ Konfigurasi sama tetap memuat provider di development: route 200, marker dan buffer true di kedua kit.
- ✅ Solusi dapat dibuat oleh codemods nyata: `node ace configure` menjalankan `updateRcFile`/`addProvider`/`makeUsingStub`; bukan edit manual rc/config.
- ❌ Strategi desain asli tidak aman: config import crash saat package absent; `web` tetap cocok pada production HTTP.

## Referensi API/source

Path berikut relatif terhadap clone `node_modules`; source implementation dipakai sebagai bukti semantik, bukan sebagai private import aplikasi.

- **Public/documented** `@adonisjs/core@7.6.0`: `build/modules/ace/codemods.d.ts:293` dan `build/modules/ace/codemods.js:527–546` — `makeUsingStub`, frontmatter destination dan generation. `build/commands/make/provider.js:66–82` — framework sendiri membuat provider stub lalu menambah rc entry.
- **Public/documented** `@adonisjs/assembler@8.5.2`: `build/src/code_transformer/rc_file_transformer.d.ts:3,49` — allowed environments `web|console|test|repl`, `addProvider(path, environments)`; `build/src/code_transformer/main.js:223–229,680–683` — rc mutation/save. `README.md:281–286` — documented updateRcFile/addProvider usage.
- **Public/documented** `@adonisjs/application@9.1.0`: `build/src/application.d.ts:138–146,317` — `inProduction`, `inDev`, `setEnvironment`. **Internal implementation evidence** `build/application-TLzZVFOE.js:2131–2162,2523–2524` — flags berdasarkan normalized NODE_ENV, diproses saat boot sebelum config/provider.
- **Public/documented service** `@adonisjs/core@7.6.0`: `build/services/app.js:1–2`, `build/services/app.d.ts:11–12` — app singleton. **Internal implementation evidence** `build/main-B2rXbPKm.js:395` — setApp saat createApp, sebelum provider module resolve. Wrapper hanya mengimpor public `@adonisjs/core/services/app`.
- **Public provider contract; internal implementation evidence** `@adonisjs/application@9.1.0`: `build/application-TLzZVFOE.js:1636–1638,1660–1688,1720–1728` — filter process type, default class export, instantiation dan lifecycle normal. Solusi tidak mengakses ProvidersManager atau replay lifecycle manual.
- **Public/documented Ignitor; internal process mapping evidence** `@adonisjs/core@7.6.0`: `build/ignitor-B4zotvea.js:23–24`; `build/main-B2rXbPKm.js:56,70–73,154–157,284–287` — console/repl/test/web mapping dan startApp behavior.
- **Public probe-only APIs** stand-in `@rikology/adonisjs-mcp@0.0.0-spike`: `providers/mcp_provider.js:4–10` — singleton/hasBinding/router route; `configure.js:3–11` — actual codemod calls. Tidak ada klaim API package final telah tersedia.

## Keterbatasan

Ini production absence/lifecycle spike, bukan transport, buffers sesungguhnya, HMR, atau seluruh tools MCP. Buffer sentinel membuktikan provider register tidak berjalan di production; tidak melakukan heap census. React diuji HTTP HTML render/build, bukan browser hydration. Matrix repl/test menggunakan Ignitor process type nyata, bukan interaksi REPL/Japa suite; mapping command diperkuat source framework. Standalone copy menggunakan APFS macOS `cp -cR`, sesuai environment tugas.

Percobaan awal menemukan tiga masalah fixture/probe yang diperbaiki, bukan diabaikan: configure hook harus dire-export dari root package (subpath configure saja tidak cukup); stand-in JS provider perlu `.d.ts` agar build strict sukses; direct React dev boot membutuhkan Vite manifest (`npm exec vite build`). `build/` yang berada di bawah source tree sempat false-positive boot melalui ancestor dev package: marker module terlihat walau package absent pada build/node_modules. Final evidence menggunakan sibling standalone deployment.

## Keputusan dan dampak

S-B **LULUS** untuk semua kriteria plan pada kedua kit dengan strategi aman; strategi desain asli **GAGAL**. D04 dipertegas menjadi app-local conditional module + config type-only/plain object. D01–D03 dan D05–D20 tidak berubah. Public `defineConfig` boleh tetap tersedia untuk konteks yang package-nya tersedia, tetapi installation stub production-safe **tidak** memanggilnya; config normalization/default/validation menjadi tanggung jawab provider saat development. D20 defaults harus tetap identik pada final schema/stub. Dampak pada WP fondasi/provider/configure dan WP-33/WP-38 release: implementasi final harus mempertahankan boundary yang telah dibuktikan; spike tidak dengan sendirinya meluluskan package yang belum diimplementasikan.

- OBL: Rc entry rekomendasi persis `{ file: () => import('#providers/mcp_dev_provider'), environment: ['web'] }`; configure memakai `rcFile.addProvider('#providers/mcp_dev_provider', ['web'])`, bukan direct package provider.
- OBL: Wrapper app-local rekomendasi persis `import app from '@adonisjs/core/services/app'; export default app.inDev ? (await import('@rikology/adonisjs-mcp/providers/mcp_provider')).default : class McpDisabledProvider {}`; buat lewat `makeUsingStub`; provider package tetap memiliki `app.inDev` guard defense-in-depth.
- OBL: Config stub rekomendasi `import type { McpConfig } from '@rikology/adonisjs-mcp'; export default { enabled: true, path: '/__adonis/mcp', allowRemoteAccess: false } satisfies McpConfig`; final exported input type harus menerima partial config dan provider melakukan resolution/default/validation (jangan runtime import defineConfig atau helper ekstra dari dev package).
- OBL: Release gate harus build tarball fixture, `npm ci --omit=dev`, lalu boot standalone di luar source ancestor node_modules; assert `/` 200, MCP 404, binding/listener tidak ada, marker module tidak ada, Ace list dan booting migration:status exit 0.

Tidak ada BLOCKER tersisa untuk S-B; release masih memerlukan implementasi final dan regression gate kewajiban di atas.
