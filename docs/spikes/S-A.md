# S-A — Bridge MCP melalui router Adonis
Status: LULUS BERSYARAT
Tanggal: 2026-10-13

## Pertanyaan
Pasang SDK v2 factory/Node adapter di route Adonis dengan bodyparser dan Shield aktif; jalankan modern + legacy client. Apakah tools/list dan call memberi tepat satu response, notifications benar, tanpa double body read, double-send, atau CSRF redirect pada endpoint MCP?

## Lingkungan
macOS 27.0 build 26A428, arm64; Node v24.21.0, npm 11.19.0. Fixture create-adonisjs 3.4.0: Inertia React (`s-a-react`, 41000) dan API (`s-a-api`, 41001). Base fixtures tidak diubah. Server langsung memakai ts-exec, bukan server HTTP SDK terpisah.

Resolved `npm ls` kedua clone: Core 7.6.0, http-server 9.3.1, bodyparser 11.0.4, Shield 9.0.0, session 8.1.0, auth 10.1.0, Lucid 22.4.2, CORS 3.0.0; MCP server 2.3.1, Node adapter 2.1.1, client 2.3.1, MCP core 2.3.1, Zod 4.6.7. React tambahan: Inertia 5.0.1, static 2.0.1, Vite 6.0.3. Application 9.1.0 teramati melalui `npm ls @adonisjs/application` pada React. Output dependency tree lengkap terdapat di `spikes/s-a/observations.jsonl` (event `versions`). Tuple yang diminta kompatibel; tidak ada penggantian versi.

## Skenario dan command
Dari repository:

```sh
node spikes/s-a/run.mjs
```

Entry script meng-clone fixture bila clone belum ada dengan `bash spikes/clone-fixture.sh react s-a-react` dan padanannya untuk API, meng-install exact tuple, menyalin `spikes/s-a/probe.ts` ke `start/sa_probe.ts`, menambah import preload routes, lalu menjalankan masing-masing:

```sh
HOST=127.0.0.1 PORT=41000 NODE_ENV=development node --import=@poppinss/ts-exec bin/server.ts
HOST=127.0.0.1 PORT=41001 NODE_ENV=development node --import=@poppinss/ts-exec bin/server.ts
npm ls @adonisjs/core @adonisjs/http-server @adonisjs/bodyparser @adonisjs/shield @modelcontextprotocol/server @modelcontextprotocol/node @modelcontextprotocol/client zod
```

Script melakukan perubahan yang scoped: `csrf.exceptRoutes: ['/__adonis/mcp']`; mengaktifkan CSRF API karena default kit tersebut `false`; tidak menonaktifkan bodyparser/Shield. API `force_json_response_middleware` tetap aktif tetapi assignment Accept dikecualikan **hanya** bila `ctx.request.url() === '/__adonis/mcp'`. Exception handler hanya ditambah observer kode/status/pesan sebelum `super.handle`, tidak mengganti handling.

Untuk setiap kit, dua official `Client` konkuren di setiap era: modern `versionNegotiation.mode: { pin: '2026-07-28' }`, legacy `mode: 'legacy'`. Discovery/initialize, list, call, notification, lalu close. Fetch wrapper merekam status, headers, body dan tidak mengikuti redirect. Negative requests: JSON rusak, modern header tanpa envelope, unsupported revision dengan envelope lengkap, version mismatch, method mismatch, GET/DELETE dengan dan tanpa modern header, body 1.048.648 byte, POST aplikasi dan sibling prefix. Child dihentikan dengan SIGTERM dan ditunggu exit dalam `finally`; tidak ada proses milik spike tersisa dari run yang selesai.

## Hasil teramati
Bukti final: `spikes/s-a/observations.jsonl`. Matriks berlaku untuk **kedua** kit:

| Skenario | HTTP / body teramati |
| --- | --- |
| Modern discovery, dua client | 200 application/json; `supportedVersions: ["2026-07-28"]`; tidak ada initialize |
| Modern tools/list dan tools/call | Masing-masing 200, satu JSON-RPC result per request |
| Legacy initialize | 200 text/event-stream; `protocolVersion: "2025-11-25"`, satu data frame |
| Legacy tools/list dan tools/call | Masing-masing 200 text/event-stream, **tepat satu** `data:` frame per response |
| Modern cancellation notification | 202; body kosong |
| Legacy initialized + cancellation notifications | 202; body kosong |
| Malformed `{bad` | 400 dari Adonis bodyparser; bukan JSON-RPC SDK |
| Header modern tanpa envelope | 400 JSON-RPC `-32602` |
| Unsupported `2099-01-01`, envelope lengkap | 400 JSON-RPC `-32022`, `supported: ["2026-07-28"]` |
| Version mismatch / method mismatch | 400 JSON-RPC `-32020` |
| GET / DELETE, modern header atau tanpa header | 405 JSON-RPC `-32000`, `Method not allowed.` |
| Body melewati limit | 413, `E_REQUEST_ENTITY_TOO_LARGE` dari bodyparser; factory tidak dipanggil untuk body itu |
| POST `/sa/csrf-control` dan `/__adonis/mcp-extra` | 302 Location `/`; observer menunjukkan `E_BAD_CSRF_TOKEN`, status asal 403; kedua handler aplikasi tidak dieksekusi |

Ada 8 response tool sukses per kit (2 clients × 2 methods × 2 eras), 16 total; setiap JSON response merupakan satu object dan setiap SSE response memiliki tepat satu data frame. Tool sungguhan membaca app yang berjalan: React `{"inDev":true,"routes":10,"instance":5}` dan API `{"inDev":true,"routes":8,"instance":5}`. `instance` berbeda antar request; factory mencatat `era: modern` atau `legacy`.

Excerpt:

```text
SA_BEFORE {"method":"POST","remoteAddress":"127.0.0.1","readableEnded":true,"parsedKeys":["jsonrpc","id","method","params"]}
SA_FACTORY {"instance":1,"era":"modern"}
SA_AFTER {"finished":false,"pending":false,"writableEnded":true}
SA_EXCEPTION {"code":"E_BAD_CSRF_TOKEN","status":403,"message":"Invalid or expired CSRF token"}
```

`finished:false` pada saat log bukan kegagalan: raw `writableEnded:true` dan headers sudah dikirim; `isPending:false` sehingga finalizer Adonis tidak menulis lagi. Log final kedua kit: `headersSentError:false`, `serializationFailure:false`; tidak ada level-50 error log. `SA_SDK_ERROR` hanya mencatat penolakan input negatif yang sengaja diuji. Headers sukses mempertahankan Shield `x-frame-options: DENY`, `x-content-type-options: nosniff`, HSTS; modern `content-type: application/json`, legacy `text/event-stream`. Cookie/credential tidak disertakan dalam evidence.

- ✅ Tools/list tepat satu response: kedua kit, kedua era, dua client konkuren.
- ✅ Tools/call tepat satu response dan hasil app nyata: kedua kit, kedua era.
- ✅ Notifications: 202 tanpa body; modern tidak melakukan initialized handshake.
- ✅ Tidak double-read stream: sebelum bridge POST sudah `readableEnded:true`; argumen ketiga parsed body melewati SDK tanpa membaca IncomingMessage lagi (seam publik dan source di bawah).
- ✅ Tidak double-send/ERR_HTTP_HEADERS_SENT/serialization failure; response SDK diselesaikan sebelum route selesai.
- ✅ Tidak ada CSRF redirect pada MCP; kontrol aplikasi dan sibling prefix tetap diblokir oleh Shield.

Percobaan sebelumnya yang mengarah pada konfigurasi final: API tanpa exemption force-JSON menghasilkan **406** legacy (`Client must accept both application/json and text/event-stream`); modern tetap sukses. Modern `notifications/initialized` ditolak official client sebelum HTTP dengan `METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION`; dipilih cancellation notification yang valid untuk kedua era. Fetch default yang mengikuti CSRF redirect sempat menghasilkan 500 Missing manifest pada root React (atau 200 root API), bukan respons CSRF asli; run final memakai `redirect: manual`, sehingga tidak lagi menyentuh page root/manifest.

## Referensi API/source
Path relatif terhadap clone `node_modules`; nomor line dan versi sesuai artefak yang diperiksa.

- **Public/documented:** `@modelcontextprotocol/server@2.3.1/dist/createMcpHandler-D4NN8WsG.d.mts:3861-3901` factory fresh per request dan context era; `:3923-4015` stateless fallback, 405 GET/DELETE, limits, fetch/close; `:4121-4132` createMcpHandler dan Node bridge.
- **Public/documented:** file server yang sama `:3266` McpServer constructor, `:3346-3382` registerTool dengan Zod object dan content callback.
- **Public/documented:** `@modelcontextprotocol/node@2.1.1/dist/index.d.mts:224-264` toNodeHandler `(req,res,parsedBody?)`; `:289-296` parsed body tidak membaca stream; `:242-249` stream-bound request limit. **Internal implementation evidence, bukan API konsumen:** `dist/index.mjs:294-313` pass-through parsedBody ke handler; `:383-410` JSON serialization tanpa stream read saat body tersedia.
- **Public/documented:** `@modelcontextprotocol/client@2.3.1/dist/index.d.mts:1838-1870,1906-1929` mode legacy/modern pin, `:3517-3555` transport dan headers dari envelope. **Internal implementation evidence:** `dist/src-WCy6ifGf.mjs:3193-3206` notification methods modern tidak mengandung initialized.
- **Public/documented:** `@adonisjs/http-server@9.3.1/build/src/router/main.d.ts:111-118,243-246` router.any dan toJSON; `build/src/request.d.ts:18-19,106-110` native request dan body(); `build/src/response.d.ts:81-92,137-148,557-561` response state, relayHeaders dan idempotent finish. **Internal implementation evidence:** `build/define_config-CthsZu7o.js:3826-3839,4053-4056,4503-4504,5154-5159` raw state dan finalizer melewati response yang headers-nya telah terkirim. Dokumentasi response publik tidak memberikan flag `takeover`/`handled`: https://docs.adonisjs.com/guides/basics/response . Tidak mengada-adakan API seperti `implicitEnd=false`.
- **Public configuration:** `@adonisjs/shield@9.0.0`, fixture `config/shield.ts:29-49` csrf.enabled/exceptRoutes/methods; https://docs.adonisjs.com/guides/security/securing-ssr-applications . **Internal implementation evidence:** `build/frame_guard-yu-WWHZp.js:35-48` exemption memakai exact `ctx.route.pattern` melalui Array.includes, bukan prefix wildcard.
- **Public configuration:** `@adonisjs/bodyparser@11.0.4/build/define_config-Jdzxr5yj.js:41-44` default JSON limit 1mb. **Internal implementation evidence:** `build/bodyparser_middleware-CwdbAAgG.js:700-711,754-778` raw(inflate(req)) menghabiskan stream, parse JSON dan 400 parser error.
- **Public/documented:** `@adonisjs/application@9.1.0/build/src/application.d.ts:146,537` inDev dan terminating hook. Hook dipakai untuk menutup shared handler pada shutdown, bukan setiap response.
- **Public/documented:** Zod 4.6.7 `z.object({})`, https://zod.dev/api#objects ; Node 24 IncomingMessage/socket.remoteAddress, https://nodejs.org/docs/latest-v24.x/api/http.html#class-httpincomingmessage dan https://nodejs.org/docs/latest-v24.x/api/net.html#socketremoteaddress . Socket teramati `127.0.0.1` di handler.
- **App-owned source, bukan SDK API:** API fixture `app/middleware/force_json_response_middleware.ts:6` overwrites Accept; scope exception dalam run script adalah perubahan konfigurasi aplikasi, bukan API framework baru.

## Keterbatasan
Spike transport, bukan implementasi keamanan package, HMR, TLS, IPv6/proxy trust, atau persistent subscriptions. `router.any` berarti common HTTP methods menurut Adonis, bukan semua extension methods arbitrary. Tidak menguji SSE mid-call notifications/backpressure/abort; hasil tool kecil hanya terminal result.

Parsed-body bridge didukung SDK dan menghindari stream read kedua, tetapi tetap melakukan JSON.stringify dan parsing pada web Request; bukan zero-copy. SDK size limit **tidak diterapkan** pada parsedBody, sehingga bodyparser menjadi pemilik enforcement ukuran. Default fixture JSON limit 1mb, bukan klaim boundary persis 1 MiB untuk semua konfigurasi aplikasi. Malformed JSON ditangani framework sebelum guard/SDK, memunculkan error debug dengan `raw.body`; ini belum memenuhi kontrak redaction endpoint production-grade. Tidak menguji alternatif exclusion bodyparser karena public parsed-body seam sudah bekerja. Yang belum ada adalah mekanisme flag takeover eksplisit; ownership terbukti melalui public state dan finalizer versi-terikat, bukan klaim dokumentasi yang tidak ditemukan.

## Keputusan dan dampak
Semua pass criteria S-A §5 **LULUS** pada bridge final untuk kedua kit/era. Status keseluruhan **LULUS BERSYARAT** karena installation contract harus menjaga Accept dan limit/malformed-body boundary; tidak ada blocker transport M2 yang membutuhkan penggantian SDK.

Pilih `createMcpHandler(factory)` bersama sekali per aplikasi, `toNodeHandler(handler)` bersama, dan `await bridge(ctx.request.request, ctx.response.response, ctx.request.body())` untuk body-bearing requests. `response.relayHeaders()` sebelum bridge mempertahankan headers middleware; route tidak mengembalikan payload lain. Tutup handler melalui app.terminating. D01/D02/D03 dipertahankan; D05 socket tersedia. Perlu tambahan installation integration pada WP-07–WP-08, bukan shim protokol.

- OBL: WP-07–WP-08/configure harus mengecualikan exact endpoint dari middleware aplikasi yang mengubah Accept (API kit force_json_response_middleware); tanpa itu legacy client gagal 406. Jangan menonaktifkan middleware global.
- OBL: WP-07–WP-08 harus menjamin byte limit endpoint walau memakai parsedBody; SDK limit tidak melindungi parsedBody dan config bodyparser aplikasi dapat menaikkannya. Tetapkan boundary 1 MiB yang eksplisit, bukan mengandalkan default fixture 1mb.
- OBL: WP-07–WP-08 harus menetapkan handling malformed-body/redaction sebelum SDK karena Adonis parser dapat mengeluarkan raw body/stack debug; pilih endpoint-scoped parser/error normalization atau path-scoped bypass bila JSON-RPC SDK ownership wajib. Jangan mengklaim malformed JSON milik SDK pada bridge ini.
- OBL: WP-07–WP-08 harus mempertahankan exact Shield exemption, relayHeaders sebelum SDK, await bridge sampai selesai, tanpa payload return tambahan; kunci contract test isPending/headersSent/finalizer untuk http-server yang didukung. Tidak ada takeover flag publik yang terbukti.

Tidak ada BLOCKER terbuka untuk pass criteria transport yang diuji. DESIGN.md dan IMPLEMENTATION_PLAN.md tidak diubah; integrasi owner dapat memasukkan obligation tersebut ke ledger.
