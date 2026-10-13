# Desain @rikology/adonisjs-mcp — MCP runtime untuk AdonisJS v7

Oct 13, 2026 · @Riko

## Tujuan dan prinsip

`@rikology/adonisjs-mcp` membuat coding agent (Claude Code, Cursor, dll.) bisa bicara langsung dengan aplikasi AdonisJS yang sedang berjalan, bukan hanya membaca file. Tidewave (Phoenix/Rails) adalah inspirasi awalnya; targetnya lebih jauh: tool yang tahu IoC container, Lucid, VineJS, Inertia, ace, dan paket @rikology lain. MCP server hidup di dalam proses app, di endpoint `http://localhost:3333/__adonis/mcp` (path bisa diganti).

Prinsip yang mengikat semua keputusan di bawah:

- **Dev-only.** Provider hanya mendaftarkan route saat `app.inDev` benar. Di production package tidak pernah ter-load; dipasang sebagai `devDependencies` saja.
- **Localhost-only.** Hanya menerima koneksi dari `127.0.0.1`/`::1` kecuali `allowRemoteAccess: true` di config.
- **Tanpa autentikasi.** Agen jalan di mesin yang sama; auth MCP justru bikin client error.
- **Runtime, bukan statis.** Semua tool membaca state dari IoC container yang hidup: Lucid model yang ter-register, router yang sudah di-commit, koneksi DB yang aktif, logger yang sedang menulis.
- **Satu package, tanpa UI.** Package ini server + tools saja. Browser tooling dan UI inspeksi di luar scope v1.
- **Mengikuti konvensi @rikology.** `node ace configure`, stub untuk `config/mcp.ts`, provider di `providers/`, types di `src/types.ts`.

**Posisi terhadap AdonisJS Plus / Flow.** [Flow AI](https://plus.adonisjs.com/flow) (bagian dari AdonisJS Plus, $149/tahun) adalah *context engineering*: cookbook statis per versi package (`.flow/docs`), skill konvensi, dan alur plan-first (`.flow/changes/<nama>/brief.md`, `blueprint.md`, `assert.md`). Tidak ada komponen runtime; agen tetap menebak state app dari file. Package ini mengisi sisi yang satunya: Flow memberi tahu agen *cara* menulis Adonis, MCP memberi tahu *keadaan* app saat ini (model, route, data, error). Keduanya saling melengkapi, dan `SKILL.md` di package ini harus memakai istilah yang sama dengan Flow (`node ace make:page`, `#generated/controllers`, `@generated/data`, `<Form route>`) agar agen yang memakai keduanya tidak bingung. Dua tool tambahan karena fitur v7 yang Flow andalkan: `get_transformers` (shape `Data.<Resource>` dari `@generated/data`) dan `get_permissions` (`start/permissions.ts` dari `@adonisplus/permission`, `available()` hanya jika terpasang).

## Arsitektur

Semua request masuk lewat satu route yang didaftarkan provider di `boot()`, lalu diteruskan ke `StreamableHTTPServerTransport` dari SDK resmi. Tidak ada proses terpisah, tidak ada port tambahan.

&#91;embedded content: arsitektur · satu route, satu transport, satu McpServer, lima sumber runtime\]

McpServer dibuat sekali saat boot dan memegang referensi ke `app`; setiap tool hanya butuh `app.container.make(...)` untuk menjangkau Lucid, router, atau logger.

**Keputusan transport.** Pakai mode *stateless* (`sessionIdGenerator: undefined`): satu transport baru per request, tidak perlu menyimpan sesi, HMR/restart dev server tidak merusak koneksi agen. Trade-off: notifikasi server-ke-client (mis. `logging/message`) tidak tersedia; untuk v1 cukup, karena `get_logs` sudah pull-based.

**Kenapa bukan stdio.** Tidewave sengaja hidup *di dalam* app agar punya akses ke state runtime. Proses stdio terpisah harus mem-boot app sendiri dan tidak melihat request/log yang sedang terjadi.

## Struktur package

Layout mengikuti `@rikology/adonisjs-tenant` (tsdown, `stubs/main.ts`, `configure.ts`, provider di `providers/`), supaya tooling dan release flow bisa dicopy apa adanya.

```
@rikology/adonisjs-mcp/
├── index.ts                      # re-export defineConfig, defineTool, types
├── configure.ts                  # node ace configure
├── providers/
│   └── mcp_provider.ts           # register + boot (dev only)
├── src/
│   ├── define_config.ts          # defineConfig() + default
│   ├── define_tool.ts            # helper + validasi ToolDefinition
│   ├── types.ts                  # McpConfig, ToolContext, ToolDefinition, ProjectProfile
│   ├── profile.ts                # detectProfile(): kind, surfaces, auth, packages
│   ├── registry.ts               # binding 'mcp.registry': tool/resource/prompt/extend/disable
│   ├── server.ts                 # buat McpServer per request, daftarkan dari registry
│   ├── handler.ts                # HttpContext -> StreamableHTTPServerTransport
│   ├── guards/
│   │   └── localhost.ts          # cek remoteAddress + Origin
│   ├── buffers/
│   │   ├── log_buffer.ts         # ring buffer untuk get_logs
│   │   └── exception_buffer.ts   # ring buffer untuk get_last_exceptions
│   ├── tenant.ts                 # deteksi adonisjs-tenant, wrapper runWithTenant
│   ├── tools/
│   │   ├── runtime/              # project_eval, get_logs, get_source_location, search_package_docs
│   │   ├── http/                 # http_request, get_routes, get_middleware, get_last_exceptions
│   │   ├── database/             # execute_sql_query, query_model, get_models, get_migrations, diff_schema
│   │   ├── app/                  # get_project_profile, get_container_bindings, get_config, get_env, get_events, run_ace_command
│   │   ├── inertia/              # get_inertia_pages, get_shared_props, get_transformers  (profil inertia/hybrid)
│   │   ├── api/                  # get_tuyau_schema                                       (jika Tuyau ada)
│   │   ├── edge/                 # get_views, render_view                                  (profil edge/hybrid)
│   │   └── auth/                 # get_validators, get_permissions
│   ├── resources/                # adonis://profile, routes, models, config, package
│   └── prompts/                  # debug_request, add_feature
├── stubs/
│   ├── main.ts                   # export stubsRoot
│   ├── config/mcp.stub
│   └── skills/adonisjs-mcp/SKILL.md.stub
├── skills/adonisjs-mcp/SKILL.md  # sumber untuk npx skills add
├── bin/test.ts
└── tests/
    ├── tools/*.spec.ts
    ├── profile.spec.ts
    └── handler.spec.ts
```

**Exports di `package.json`** (tiap entry juga masuk `tsdown.entry`):

| Export | File | Dipakai oleh |
| --- | --- | --- |
| `.` | `index.ts` | `config/mcp.ts` (`defineConfig`) |
| `./configure` | `configure.ts` | `node ace configure` |
| `./types` | `src/types.ts` | user yang menulis tool kustom |
| `./providers/mcp_provider` | `providers/mcp_provider.ts` | `adonisrc.ts` |

**Dependencies:**

| Package | Jenis | Catatan |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | dependency | `McpServer`, `StreamableHTTPServerTransport`, `zod` schema |
| `zod` | dependency | input schema tool; SDK v1 masih butuh zod v3 — pin `^3.23` |
| `@adonisjs/core` | peer `^7.0.0` | router, container, logger |
| `@adonisjs/lucid` | peer `^22.0.0`, optional | `execute_sql_query` dan `get_models` tidak terdaftar jika tidak ada |
| `@adonisjs/assembler` | devDependency | HMR hook (opsional) |

Tidak ada dependency runtime lain. Package ini dipasang user sebagai `devDependencies`. Lisensi MIT. @adonisjs/auth juga peer opsional: tanpanya http\_request tetap ada, hanya opsi as yang hilang.

## Provider, config, dan configure

Provider punya satu tugas: kalau `app.inDev`, pasang log buffer dan daftarkan route. Semua yang lain lazy.

```ts
// providers/mcp_provider.ts
import type { ApplicationService } from '@adonisjs/core/types'
import { LogBuffer } from '../src/log_buffer.js'
import { handleMcpRequest } from '../src/handler.js'

export default class McpProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton(LogBuffer, () => new LogBuffer(1000))
  }

  async boot() {
    if (!this.app.inDev) return
    const config = this.app.config.get<McpConfig>('mcp')
    if (!config.enabled) return

    const router = await this.app.container.make('router')
    const logBuffer = await this.app.container.make(LogBuffer)
    logBuffer.attach(await this.app.container.make('logger'))

    router
      .any(config.path, (ctx) => handleMcpRequest(ctx, this.app, config))
      .as('mcp')
  }
}
```

Registrasi di `adonisrc.ts` dibatasi ke environment `web` supaya `node ace` command tidak ikut memuat provider:

```ts
{ file: () => import('@rikology/adonisjs-mcp/providers/mcp_provider'), environment: ['web'] }
```

**Config** (`config/mcp.ts`, dibuat dari `stubs/config/mcp.stub`):

```ts
import { defineConfig } from '@rikology/adonisjs-mcp'

export default defineConfig({
  enabled: true,
  path: '/__adonis/mcp',
  allowRemoteAccess: false,
  profile: {
    // kosongkan untuk auto-detect; isi hanya untuk mengoreksi tebakan
    surfaces: { web: { prefix: '/', guard: 'web' }, api: { prefix: '/api', guard: 'api' } },
  },
  tools: {
    disabled: [],
    projectEval: { timeout: 30_000 },
    sql: { readOnly: true, maxRows: 100, allowCrossTenant: false },
    logs: { bufferSize: 1000 },
    docs: { include: ['@adonisjs/*', '@rikology/*'] },
  },
  extraTools: [],
})
```

| Key | Default | Arti |
| --- | --- | --- |
| `enabled` | `true` | kill switch tanpa cabut provider |
| `path` | `/tidewave/mcp` | prefix \_\_ menandai route internal, mengikuti pola /\_\_transmit di @adonisjs/transmit |
| `allowRemoteAccess` | `false` | lewati guard localhost (hanya untuk container / remote dev) |
| `tools.sql.readOnly` | `true` | tolak statement selain SELECT/WITH/EXPLAIN |
| `tools.sql.maxRows` | `100` | potong hasil query |
| `tools.logs.bufferSize` | `1000` | panjang ring buffer |
| `tools.docs.include` | `['@adonisjs/*']` | scope `search_package_docs` |
| `extraTools` | `[]` | `ToolDefinition[]` milik user, di-merge ke registry |

**Configure** (`node ace configure @rikology/adonisjs-mcp`) melakukan tiga hal, tanpa prompt:

1. `codemods.updateRcFile` menambah provider dengan `environment: ['web']`.
2. `codemods.makeUsingStub(stubsRoot, 'config/mcp.stub', {})`.
3. Mencetak perintah `claude mcp add --transport http adonis http://localhost:3333/__adonis/mcp` sebagai *next steps*, membaca port dari `.env` kalau ada.

Langkah keempat, hanya jika folder `.claude/` ada di project: salin `skills/adonisjs-mcp/SKILL.md` dari package ke `.claude/skills/adonisjs-mcp/SKILL.md` lewat `makeUsingStub`, tanpa menimpa kalau sudah ada. Skill yang sama juga dipublikasikan di repo GitHub agar bisa dipasang terpisah lewat `npx skills add rikoriswandha/adonisjs-mcp` untuk client selain Claude Code.

**Handler** adalah jembatan HttpContext ke SDK. Mode stateless berarti satu `McpServer` + satu transport per request, karena satu `McpServer` hanya boleh terhubung ke satu transport:

```ts
// src/handler.ts
export async function handleMcpRequest(ctx: HttpContext, app, config) {
  if (!config.allowRemoteAccess && !isLocalhost(ctx.request.ip())) {
    return ctx.response.forbidden({ error: 'MCP hanya menerima koneksi localhost' })
  }
  if (ctx.request.method() !== 'POST') {
    return ctx.response.status(405).send({ error: 'Stateless mode: hanya POST' })
  }

  const server = createMcpServer(app, config)   // src/server.ts
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  ctx.response.response.on('close', () => { transport.close(); server.close() })

  await server.connect(transport)
  await transport.handleRequest(ctx.request.request, ctx.response.response, ctx.request.body())
}
```

Dua hal yang perlu dicek saat implementasi: bodyparser Adonis sudah mem-parse JSON, jadi body diteruskan sebagai argumen ketiga; dan karena transport menulis langsung ke `ServerResponse`, pastikan Adonis tidak menulis ulang response setelah handler selesai (`response.writableEnded` sudah `true`).

## Spesifikasi tool

Lapisan pertama adalah tool runtime generik, dinamai kata kerja + objek dalam snake\_case agar mudah ditebak agen. Tanpa prefix adonis\_: setiap client sudah men-namespace tool per server (mcp\_\_adonis\_\_execute\_sql\_query di Claude Code), dan tabrakan nama dengan MCP lain diselesaikan lewat deskripsi tool yang selalu menyebut "via the running AdonisJS app". Semua tool mengikuti satu kontrak:

```ts
// src/types.ts
export interface ToolContext {
  app: ApplicationService
  config: McpConfig
  logBuffer: LogBuffer
}

export interface ToolDefinition<Input extends z.ZodRawShape = any> {
  name: string
  description: string
  inputSchema: Input
  available?: (ctx: ToolContext) => boolean | Promise<boolean>
  handler: (input: z.infer<z.ZodObject<Input>>, ctx: ToolContext) => Promise<ToolResult>
}
```

`src/server.ts` memanggil `server.registerTool(name, { description, inputSchema }, handler)` untuk tiap definisi yang `available()`-nya benar. Output selalu `{ content: [{ type: 'text', text }] }`, dengan `isError: true` saat gagal, supaya agen membaca pesan error bukan stack trace HTTP.

| Tool | Input | Output | Sumber runtime |
| --- | --- | --- | --- |
| `project_eval` | `code: string`, `timeout?: number` (ms, default 30000) | nilai return (JSON) + stdout yang tertangkap | `app.container` via `AsyncFunction` |
| `execute_sql_query` | `query: string`, `bindings?: unknown[]`, `connection?: string` | rows (dipotong `maxRows`) + jumlah baris + durasi | `db.connection(name).rawQuery()` |
| `get_models` | `name?: string` | daftar model: nama, tabel, kolom, relasi, file path | registry `BaseModel` + `model.$columnsDefinitions`, `$relationsDefinitions` |
| `get_routes` | `pattern?: string`, `method?: string` | route: method, pattern, handler, middleware, name, domain | `router.toJSON()` |
| `get_logs` | `tail?: number` (default 100), `level?: string`, `grep?: string` | baris log terbaru | `LogBuffer` |
| `get_source_location` | `reference: string` (`App/Models/User`, `#models/user`, `@adonisjs/lucid`) | path absolut + baris (jika ada) | `import.meta.resolve` + `app.importMap` + `tsconfig paths` |
| `search_package_docs` | `query: string`, `packages?: string[]` | potongan README / `.d.ts` / JSDoc yang cocok | `node_modules/<pkg>` |

**project\_eval.** Ini tool paling bernilai dan paling berisiko. Implementasi: bungkus `code` ke `new AsyncFunction('app', 'container', 'db', 'console', code)`, inject `console` yang menangkap `log/warn/error`, jalankan dengan `AbortSignal.timeout`. Serialisasi hasil pakai `util.inspect` dengan `depth: 4`, bukan `JSON.stringify`, supaya Lucid model, Map, dan BigInt tetap terbaca. Kode agen harus bisa `const User = await import('#models/user')` secara natural, jadi evaluasi di-scope ke app root.

**Kebijakan tulis: boleh.** Read-only tidak bisa dipaksakan pada kode bebas, dan membungkus eval dalam transaksi yang di-rollback tidak menangkap query lewat koneksi default (`User.query()` tidak memakai `trx`). Jadi `project_eval` berperilaku seperti `node ace repl`: dapat mengubah data dev. Guardrail yang jujur: timeout 30 detik, deskripsi tool menyebut eksplisit "can modify data", setiap eval dicatat ke log buffer (kode + durasi) agar terlihat di `get_logs`, dan `tools.projectEval: false` untuk mematikannya.

**execute\_sql\_query.** Saat `readOnly` benar, tolak jika token pertama (setelah strip komentar) bukan `SELECT`, `WITH`, `EXPLAIN`, `SHOW`, `DESCRIBE`, atau `PRAGMA`. Sertakan dialect aktif (`db.connection().dialect.name`) di output agar agen tidak menulis SQL untuk DB yang salah.

**Raw SQL dan Lucid: dua tool, dua pertanyaan berbeda.** `execute_sql_query` memakai `db.rawQuery()` dan menjawab "apa isi database sebenarnya": melihat baris yang di-soft-delete, melewati global scope tenant, berguna untuk `EXPLAIN` dan memeriksa index. Ditambah `query_model` yang memakai Lucid dan menjawab "apa yang dilihat app": lewat `Model.query()` sehingga scope tenant dari adonisjs-tenant, `SoftDeletes`, `serializeAs`, computed property, dan `preload` ikut berlaku. Input terstruktur, bukan string kode:

```ts
// query_model
{ model: 'User', where: { tenant_id: 3 }, whereNull: ['deleted_at'], preload: ['roles'], orderBy: ['created_at', 'desc'], limit: 20, serialize: true }
```

Keduanya read-only. Mutasi lewat Lucid tetap lewat `project_eval` (`await User.find(1).then(u => u.merge({...}).save())`), karena eval sudah punya timeout dan agen harus menulis kode eksplisit untuk mengubah data. Kalau `adonisjs-tenant` terpasang, `query_model` menerima `tenant?` dan `execute_sql_query` menolak query ke tabel ber-scope tenant tanpa `WHERE tenant_id` kecuali `allowCrossTenant: true` di config; itu cara mencegah agen "menemukan" data lintas tenant lalu menganggapnya bug.

**get\_models.** Tidak ada registry global model di Lucid, jadi: scan `app.modelsPath()` (default `app/models`), import tiap file, saring yang `extends BaseModel`. Cache hasil per proses; invalidate saat HMR (assembler mengirim `hot.dispose`). Untuk tiap model keluarkan: `table`, `primaryKey`, kolom dari `$columnsDefinitions` (nama, `columnName`, `serializeAs`, `isPrimary`), relasi dari `$relationsDefinitions` (tipe, `relatedModel().name`, foreign key), dan `connection` jika di-override.

**get\_routes.** `router.toJSON()` sudah mengembalikan struktur per domain. Normalisasi handler ke string `#controllers/users_controller.index` dan middleware ke nama (`auth`, `tenant`) supaya ringkas.

**get\_logs.** `LogBuffer.attach(logger)` membungkus logger pino: tambah stream kedua yang menulis ke ring buffer. Simpan `{ time, level, msg, ...bindings }`; `grep` dicocokkan ke `msg` dan JSON bindings.

**get\_source\_location.** Urutan resolusi: alias `#` dari `package.json#imports` → path relatif app root → `import.meta.resolve` untuk package. Kembalikan path `.ts` sumber, bukan `build/`, dengan membaca `tsconfig.json#compilerOptions.paths` kalau ada.

**search\_package\_docs.** Tanpa fetch ke internet. Index saat pertama dipanggil: `README.md` dan `*.d.ts` dari package yang cocok `tools.docs.include`, pecah per heading / per deklarasi, cari dengan substring + skor sederhana (jumlah kata cocok). Kembalikan maksimal 5 potongan dengan nama file dan baris. Index ringan (sekitar 1 detik untuk `@adonisjs/*`) dan di-cache di memori.

## Tool khas AdonisJS

Ini lapisan yang tidak dimiliki Tidewave dan jadi alasan package ini lebih berguna untuk Adonis. Tiap tool membaca state yang sudah ada di framework; tidak ada yang perlu instrumentasi tambahan di kode user.

| Tool | Input | Output | Kenapa berguna untuk agen |
| --- | --- | --- | --- |
| `http_request` | `method`, `path`, `body?`, `headers?`, `as?: { userId, guard? }` | status, headers, body, durasi, log yang terjadi selama request | agen bisa menguji endpoint *sebagai user tertentu* tanpa browser; request HTTP sungguhan ke port dev, auth via `guard.authenticateAsClient(user)` (mekanisme `loginAs` di `@japa/api-client`) |
| `get_last_exceptions` | `limit?` | exception terakhir: pesan, stack, route, request id | menangkap error yang `HttpExceptionHandler` tangani; agen tidak perlu grep log |
| `get_container_bindings` | `pattern?` | daftar binding IoC: nama, singleton atau tidak, provider asal | tahu `app.container.make('...')` apa yang tersedia sebelum menulis service |
| `run_ace_command` | `command`, `args?`, `flags?` | stdout/stderr, exit code | `migration:status`, `make:migration`, `list:routes`, atau command dari package @rikology, tanpa shell |
| `get_migrations` | `connection?` | status tiap migrasi (ran/pending), batch, file | `make:migration` tanpa tahu status itu sumber migrasi duplikat |
| `diff_schema` | `connection?` | selisih kolom antara model (`$columnsDefinitions`) dan tabel DB (`information_schema`) | menangkap model yang belum di-migrate atau kolom DB yang belum dideklarasikan di model |
| `get_validators` | `name?` | skema VineJS di `app/validators`: field, rule, pesan kustom | agen tahu kontrak input sebelum membuat form Inertia atau test |
| `get_middleware` | — | stack server, router, dan named middleware, urutan eksekusi | menjawab "kenapa request ini kena 401" tanpa membuka `kernel.ts` |
| `get_inertia_pages` | `route?` | map route → komponen Inertia + daftar props dari `inertia.render(...)` | untuk stack Inertia + React ini adalah peta client-server yang paling sering dicari |
| `get_events` | — | event terdaftar + listener (`start/events.ts`) | memahami side-effect sebelum menyentuh flow |
| `get_config` | `key` (dot notation) | nilai config yang sudah di-resolve, secret di-mask | `config.get('auth.guards')` yang akurat, bukan hasil tebak dari file |
| `get_env` | `prefix?` | key env yang terdefinisi di `start/env.ts` + apakah terisi; nilai disembunyikan | menjawab "kenapa undefined" tanpa membocorkan secret |
| `get_queue_jobs` | `status?` | job terdaftar dan antrian (jika @rikology/adonisjs-queue atau serupa terpasang) | opsional; `available()` false kalau tidak ada queue |

**Transport `http_request`: HTTP sungguhan, bukan in-process.** Tool memanggil `http://127.0.0.1:${PORT}` lewat `fetch` dari dalam proses yang sama. Hasilnya identik dengan browser (bodyparser, CORS, static, `X-Inertia-Version`, middleware server-level), request muncul di `get_logs` dan periscope seperti request biasa, dan tidak ada `IncomingMessage` palsu yang harus dirawat. Untuk `as: { userId, guard }`: ambil user lewat provider guard, panggil `guard.authenticateAsClient(user)`; guard token mengembalikan header `Authorization`, guard session mengembalikan nilai session yang ditulis lewat store aktif lalu dikirim sebagai cookie, persis seperti plugin `@adonisjs/session/plugins/api_client`. Satu request `http_request` tidak bisa memanggil `http_request` lagi secara rekursif (header `X-Adonis-MCP: 1` ditolak oleh handler) untuk mencegah loop.

**Context tenant dan role.** Kalau `@rikology/adonisjs-tenant` terpasang, `http_request`, `execute_sql_query`, dan `project_eval` menerima `tenant?: string` dan menjalankan handler di dalam `TenantService.runWithTenant(...)`. Ini membuat agen bisa mereproduksi bug yang hanya muncul di tenant tertentu, sesuatu yang tidak mungkin dilakukan agen berbasis file. Keputusan: pengetahuan tenant ada di package ini (deteksi lewat hasBinding('tenant.service')), bukan didaftarkan dari adonisjs-tenant lewat registry, karena tenant mengubah semantik tool inti (query\_model, execute\_sql\_query, http\_request), bukan sekadar menambah tool baru.

**Resources, bukan hanya tools.** Beberapa data bersifat statis selama proses hidup dan lebih cocok diekspos sebagai MCP *resource* (agen bisa mem-prefetch, hemat token):

| URI | Isi |
| --- | --- |
| `adonis://routes` | hasil `get_routes` tanpa filter |
| `adonis://models` | ringkasan semua model |
| `adonis://config/{key}` | subtree config |
| `adonis://package` | `package.json` + `adonisrc.ts` yang sudah di-resolve |

**Prompts.** Dua MCP *prompt* bawaan: `debug_request` (ambil route, jalankan `http_request`, baca `get_last_exceptions` dan `get_logs`) dan `add_feature` (cek `get_models`, `get_validators`, `get_inertia_pages` dulu sebelum menulis kode). Prompt ini yang menggantikan kebutuhan mengisi `CLAUDE.md` secara manual.

## Perilaku per jenis project

Satu package, tanpa flag mode. Saat boot, `detectProfile()` membaca `adonisrc.ts`, `package.json`, dan binding container, lalu profil itu menentukan tool mana yang terdaftar dan default apa yang dipakai `http_request`. Agen melihat daftar tool yang berbeda di tiap project, dan `get_project_profile` memberi tahu kenapa.

```ts
interface ProjectProfile {
  kind: 'api' | 'inertia' | 'edge' | 'hybrid'
  inertia?: { adapter: 'react' | 'vue' | 'svelte' | 'solid'; ssr: boolean }
  auth: { guards: string[]; default: string }          // dari config/auth.ts
  packages: { lucid: boolean; tuyau: boolean; transmit: boolean; tenant: boolean; permission: boolean; queue: boolean }
  generated: { controllers: boolean; data: boolean }   // #generated/* ada?
}
```

Deteksi `kind`: `@adonisjs/inertia` terpasang → `inertia`; `edge.js` ada tapi Inertia tidak → `edge`; keduanya → `hybrid`; tidak ada view layer → `api`.

| Aspek | API only | Inertia (React/Vue) | Edge / hypermedia |
| --- | --- | --- | --- |
| `http_request` default header | `Accept: application/json` | `X-Inertia: true`, `X-Inertia-Version` dari manifest → respons berupa `{ component, props }`, bukan HTML | `Accept: text/html`; output HTML dipotong dan dirangkum (judul, form, link) |
| `http_request` opsi `as` | login via guard `access_tokens` atau `api`; tool membuat token sementara di memori | login via guard `web`; sesi + CSRF disuntik ke request | sama dengan Inertia |
| Hasil validasi gagal | body `{ errors: [...] }` apa adanya | dibaca dari session flash (`errors`, `inputErrorsBag`) dan ditampilkan sebagai field → pesan | sama dengan Inertia |
| Tool khusus terdaftar | `get_tuyau_schema` (jika Tuyau ada): daftar route bertipe + shape respons | `get_inertia_pages`, `get_transformers`, `get_shared_props` (`inertia.share`) | `get_views`: daftar template, komponen, dan slot; `render_view` dengan state dummy |
| Tool disembunyikan | `get_inertia_pages`, `get_views` | `get_tuyau_schema` kecuali Tuyau terpasang | `get_inertia_pages` |
| Prompt `add_feature` | langkah: validator → controller → route → test HTTP | langkah: validator → controller → `make:page` → transformer → test HTTP dengan `X-Inertia` | langkah: validator → controller → template Edge → test HTTP |
| `SKILL.md` | satu file, bagian "Conventions" dibaca dari `adonis://profile` agar tidak menyebut Inertia di project API |  |  |

**Hybrid** (API untuk mobile + Inertia untuk web di satu app) tidak diperlakukan sebagai mode ketiga, melainkan keputusan **per route**. `get_routes` menambahkan field `surface: 'web' | 'api'` ke tiap route, ditentukan berurutan: (1) guard di `middleware.auth({ guards })` pada route atau grup; (2) nama middleware (`auth:api`, `auth:web`); (3) prefix grup `/api`, `/v1` atau domain `api.*`; (4) handler memanggil `inertia.render` menurut `get_inertia_pages` → `web`; (5) fallback ke `profile.surfaces.default`. `http_request` mencocokkan path ke route dulu, lalu memakai default surface itu: header JSON untuk `api`, `X-Inertia` untuk `web`; parameter `surface` atau `as.guard` bisa memaksa. Profil hybrid mengekspos `surfaces: { web: { prefix: '/', guard: 'web' }, api: { prefix: '/api', guard: 'api' } }` hasil inferensi, dan agen bisa mengoreksinya lewat `config/mcp.ts` kalau salah tebak.

Kedua set tool terdaftar. Prompt `add_feature` di hybrid menanyakan satu hal di awal: fitur ini untuk web, api, atau keduanya; untuk "keduanya" rencananya satu validator + satu service + transformer bersama dari `@generated/data`, dengan dua controller tipis. Ini kasus umum di app SaaS yang punya admin web dan aplikasi lapangan.

**Yang tidak berubah lintas profil:** `project_eval`, `execute_sql_query`, `get_models`, `get_routes`, `get_logs`, `get_last_exceptions`, `get_container_bindings`, `run_ace_command`, `get_config`, `get_env`. Ini inti yang membuat package tetap berguna di project tanpa Lucid sekalipun — hanya tool database yang hilang.

**Resource `adonis://profile`** mengembalikan objek di atas. Agen membacanya sekali di awal sesi; prompt bawaan dan `SKILL.md` merujuk ke sana, sehingga satu skill bisa berlaku untuk semua jenis project tanpa cabang manual.

## Sistem plugin

Perlu, tapi dalam bentuk paling kecil: satu registry di container, satu helper `defineTool`, tanpa lifecycle, tanpa auto-discovery. Alasannya: tool paling berguna justru datang dari package yang tahu domainnya (`adonisjs-audit-trail` tahu cara membaca jejak, `adonisjs-tenant` tahu cara men-scope query), dan package ini tidak boleh jadi tempat menumpuk pengetahuan tentang semua package lain.

```ts
// package lain, mis. @rikology/adonisjs-audit-trail/providers/audit_trail_provider.ts
async boot() {
  if (!this.app.inDev || !this.app.container.hasBinding('mcp.registry')) return
  const registry = await this.app.container.make('mcp.registry')
  registry.tool(defineTool({
    name: 'audit_list_entries',
    description: 'Entri audit trail terbaru, bisa difilter per model/aktor',
    inputSchema: { model: z.string().optional(), limit: z.number().default(20) },
    handler: async (input, ctx) => { /* ... */ },
  }))
}
```

Kontrak registry:

| Method | Untuk | Catatan |
| --- | --- | --- |
| `tool(def)` | tambah tool | nama unik; tabrakan nama melempar error saat boot, bukan diam-diam ditimpa |
| `resource(def)` | tambah resource `adonis://…` atau skema URI package sendiri |  |
| `prompt(def)` | tambah prompt |  |
| `extend(fn)` | bungkus semua handler: `(call, next) => …` | contoh: mencatat setiap panggilan tool ke audit trail, atau menolak tool tertentu di project tertentu |
| `disable(name)` | matikan tool bawaan dari config user | `tools.disabled: ['project_eval']` |

Aturan yang membuat sistem ini tetap kecil:

- Registrasi eksplisit di `boot()` provider masing-masing. `hasBinding('mcp.registry')` aman dipanggil di `boot()` karena semua `register()` sudah selesai. Tidak ada scan `node_modules`, tidak ada konvensi `./mcp` entry yang harus dipelajari.
- `@rikology/adonisjs-mcp` adalah *optional peer* bagi package lain; mereka hanya mengimpor tipe dari `@rikology/adonisjs-mcp/types`, jadi app tanpa MCP tidak membawa dependency tambahan.
- Nama tool memakai prefix domain (`audit_`, `tenant_`, `notif_`) karena MCP tidak mengizinkan titik atau slash di nama tool dan agen membaca prefix sebagai pengelompokan.
- `extraTools` di `config/mcp.ts` tetap ada untuk tool ad hoc milik app, memakai `defineTool` yang sama. Satu mekanisme untuk package dan app.
- Yang sengaja tidak ada: hook UI, versi API plugin, marketplace. Kalau nanti perlu, registry ini sudah jadi titik tempelnya.

## Keamanan

Endpoint ini setara `node ace repl` yang terbuka lewat HTTP. Keamanannya bertumpu pada empat lapis, bukan satu:

1. **Environment.** `app.inDev` dicek di `boot()`; di luar itu route tidak pernah ada. Provider dipasang hanya di `devDependencies`, jadi build production tidak membawanya.
2. **Jaringan.** Guard menolak `ctx.request.ip()` selain `127.0.0.1` dan `::1` (termasuk bentuk `::ffff:127.0.0.1`). `trustProxy` Adonis bisa mengubah hasil `ip()`; guard membaca `request.request.socket.remoteAddress` langsung, bukan header `X-Forwarded-For`.
3. **Origin.** Tolak request yang membawa header `Origin` selain `null`/kosong atau `http://localhost:*`. Ini menutup DNS-rebinding dari tab browser yang kebetulan terbuka, serangan yang persis ditangani Tidewave lewat CSP.
4. **Tool.** `execute_sql_query` read-only secara default; `project_eval` punya timeout dan bisa dimatikan lewat `tools.projectEval: false`.

Yang sengaja **tidak** dilakukan: autentikasi token. Tidewave tidak memakainya, client MCP memperlakukan endpoint lokal tanpa auth sebagai hal normal, dan menambahkannya hanya menggeser risiko ke file config.

## Integrasi client

Daftarkan sebagai MCP server bertipe HTTP; port mengikuti `PORT` di `.env` (default 3333).

| Client | Cara daftar |
| --- | --- |
| Claude Code | `claude mcp add --transport http adonis http://localhost:3333/__adonis/mcp` |
| Cursor | `.cursor/mcp.json` → `mcpServers.tidewave.url` |
| VS Code (Copilot) | `.vscode/mcp.json` → `servers.tidewave` dengan `type: "http"` |
| Zed | `context_servers.tidewave.settings.url` |

Jangan pilih opsi *Authenticate* di client; server tidak mengimplementasikan endpoint OAuth dan akan mengembalikan 404.

Tambahkan ke `CLAUDE.md` project agar agen benar-benar memakai tool runtime, bukan menebak dari kode:

```markdown
## Runtime tools
MCP server app ini tersedia saat `npm run dev` jalan.
- Pakai `get_models` sebelum menulis query atau migrasi.
- Pakai `execute_sql_query` untuk memverifikasi data, bukan menebak.
- Pakai `project_eval` untuk mencoba kode kecil sebelum menulis ke file.
- Pakai `get_logs` setelah hit endpoint untuk melihat error sebenarnya.
```

Sediakan juga `skills/adonisjs-mcp/SKILL.md` di repo agar bisa dipasang lewat `npx skills add`: kapan memakai tool mana, dan kapan memanggil prompt `debug_request` / `add_feature`.

## SKILL.md

Ditulis dalam bahasa Inggris karena yang membacanya agen dan calon pemakai di luar Indonesia; istilah mengikuti cookbook Flow agar tidak bertabrakan. Satu sumber, dua jalur kirim: ikut di npm (disalin `configure` ke `.claude/skills/`) dan di repo GitHub untuk `npx skills add`. Nama tool di dalamnya tanpa prefix, sesuai keputusan di bagian Spesifikasi tool.

```markdown
---
name: adonisjs-mcp
description: Use the running AdonisJS app as the source of truth. Trigger whenever the task touches models, migrations, routes, controllers, validators, Inertia pages, auth, or when debugging a request, an error, or unexpected data. Requires `npm run dev` to be running and the adonis MCP server connected.
---

# AdonisJS runtime MCP

The app you are editing is running. Ask it before you guess.

## When to call which tool

| You are about to | Call first |
| --- | --- |
| write a query, model, migration, or seeder | `get_models`, `diff_schema`, `get_migrations` |
| add or change a route or controller | `get_routes`, `get_middleware` |
| build or edit an Inertia page | `get_inertia_pages`, `get_transformers`, `get_validators` |
| touch auth, roles, or permissions | `get_config auth`, `get_permissions` |
| explain why a request fails | `http_request`, then `get_last_exceptions`, then `get_logs` |
| use a service, repo, or binding | `get_container_bindings` |
| try an idea before writing it to a file | `project_eval` |
| run `node ace ...` | `run_ace_command` (never a shell) |
| look up how a package API works | `search_package_docs`, `get_source_location` |

## Workflow

1. Read state with the tools above. Do not infer schema, routes, or props from files when a tool can return them.
2. Plan the change. If the project has `.flow/`, write the plan there and follow its blueprint format.
3. Scaffold with ace (`run_ace_command make:controller`, `make:page`, `make:validator`, `make:migration`), then edit the generated files.
4. Verify with the runtime: `http_request` the route (use `as` to act as a specific user), check `get_last_exceptions` and `get_logs`, run `diff_schema` after migrations.
5. Only then report done.

## Conventions this project follows

- Routes reference controllers via `#generated/controllers`; pages via `node ace make:page`; props typed from `@generated/data`.
- Validate with `request.validateUsing(validator)`; never `request.all()`.
- Inertia React uses `<Link route>` and `<Form route>` from `@adonisjs/inertia/react`.
- Transactions: build every query off `trx`; side effects in `trx.after('commit', ...)`.

## Do not

- Do not write raw SQL that mutates data through `execute_sql_query`; it is read-only by design. Use a migration or `project_eval`.
- Do not paste secrets from `get_env` or `get_config` into files or chat; values are masked for a reason.
- Do not run `project_eval` with long-running loops; it has a 30 s timeout.
- Do not assume the dev server restarted after you edit a provider; call `get_container_bindings` to confirm.
```

## Urutan implementasi

Mulai dari jalur tipis ujung ke ujung, lalu tambah tool satu per satu; tiap langkah bisa diverifikasi dengan `claude mcp list` atau `/mcp` di Claude Code.

- [ ] Scaffold package dari template adonisjs-tenant, tambah `@modelcontextprotocol/sdk` + `zod`
- [ ] Provider + handler + guard (localhost, Origin), dengan satu tool dummy `ping`; verifikasi Claude Code menampilkan `connected`
- [ ] `detectProfile()` + `get_project_profile` + resource `adonis://profile`; registry `mcp.registry` + `defineTool`
- [ ] `project_eval` (capture console, timeout, catat ke log buffer)
- [ ] `get_routes` (dengan `surface`), `get_logs`, `get_last_exceptions`, `get_middleware`
- [ ] `execute_sql_query`, `query_model`, `get_models`, `get_migrations`, `diff_schema`, dengan `available()` yang memeriksa `@adonisjs/lucid`
- [ ] `http_request` lewat HTTP ke port dev, default header per surface, `as` via `authenticateAsClient`
- [ ] `get_container_bindings`, `get_config`, `get_env`, `get_events`, `run_ace_command`
- [ ] Tool per profil: `get_inertia_pages`, `get_shared_props`, `get_transformers`; `get_tuyau_schema`; `get_views`, `render_view`
- [ ] `get_validators`, `get_permissions`
- [ ] Integrasi adonisjs-tenant: `tenant?` di `query_model`/`execute_sql_query`/`http_request`/`project_eval`, penolakan query lintas tenant
- [ ] `get_source_location`, `search_package_docs` + cache
- [ ] Resources `adonis://*` dan prompt `debug_request`, `add_feature` (bercabang dari profil)
- [ ] `configure.ts` + stub config + salin SKILL.md ke `.claude/skills/`
- [ ] Tests Japa: handler (guard, 405, origin), profile (api/inertia/edge/hybrid), tiap tool terhadap app contoh dengan SQLite
- [ ] README, `SKILL.md`, publish `0.1.0`

Tiga hal terbuka yang baru bisa dijawab saat coding:

1. Apakah bodyparser Adonis bentrok dengan `transport.handleRequest`; kalau ya, kecualikan `config.path` dari bodyparser dan biarkan transport membaca stream sendiri.
2. Cara paling bersih mendapatkan `remoteAddress` saat `trustProxy` aktif di `config/app.ts`.
3. Apakah HMR assembler memanggil ulang `boot()` provider; kalau tidak, cache `get_models` perlu invalidasi lewat `fs.watch` pada `app/models`.