# S-F — Impersonation melalui HTTP loopback
Status: LULUS BERSYARAT
Tanggal: 2026-10-13

## Pertanyaan

Auth access-token/session + CSRF + validation flash melalui loopback HTTP: apakah identitas target benar, normal middleware tetap berlaku, dan session/token bersih setelah sukses/gagal/timeout?

## Lingkungan

Observasi pada clone disposable `/tmp/adonisjs-mcp-m0/s-f-api` dan `/tmp/adonisjs-mcp-m0/s-f-react`; base fixture tidak diubah. Kit API mempunyai default guard `api` (access tokens) serta `web` (session); React mempunyai guard `web`, `useRememberMeTokens: false`. Driver session aktif `cookie`; SQLite fixture sendiri.

- Node `v24.21.0`, npm `11.19.0` (baseline runner); macOS `27.0`, build `26A428`, Darwin `27.0.0`, arm64.
- Hasil nyata `npm ls ... --depth=0`, kedua clone: `@adonisjs/core@7.6.0`, `@adonisjs/auth@10.1.0`, `@adonisjs/lucid@22.4.2`, `@adonisjs/session@8.1.0`, `@adonisjs/shield@9.0.0`, `@vinejs/vine@4.4.0`.
- React tambahan: `@adonisjs/inertia@5.0.1`.
- Port HTTP `41100` (API), `41101` (React), host `127.0.0.1`.
- SDK MCP tidak dipasang: eksperimen ini membuktikan adapter auth/HTTP aplikasi, bukan transport MCP. Tidak membutuhkan perubahan dependency fixture.

## Skenario dan command

Dari root repository:

```sh
# Default: clone baru dari masing-masing base, lalu apply probe dan jalankan.
node spikes/s-f/run.mjs

# Pilihan: pakai dua clone yang sudah disiapkan dalam direktori ini.
spikes/clone-fixture.sh api s-f-api
spikes/clone-fixture.sh react s-f-react
node spikes/s-f/run.mjs /tmp/adonisjs-mcp-m0
```

Runner meng-copy `spikes/s-f/probe.js` ke `start/sf_probe.js`, menambah import pada routes clone saja, mencetak versi dan `OBSERVED`, serta menyimpan `sf-observations.json` dalam clone. Server yang dimulai:

```sh
SF_KIT=api PORT=41100 HOST=127.0.0.1 node --import=@poppinss/ts-exec bin/server.ts
SF_KIT=react PORT=41101 HOST=127.0.0.1 node --import=@poppinss/ts-exec bin/server.ts
```

Client luar hanya memanggil GET `/sf/run`. **Semua** impersonated request, token creation/deletion, cookie generation, CSRF fetch, dan redirect follow berlangsung di dalam handler `/sf/run` pada proses aplikasi yang sedang running. Protected route memakai `middleware.auth({ guards: [...] })` asli; router/session/Shield/bodyparser/Inertia stack fixture tidak diganti atau dimatikan. Redirect selalu `manual`. POST invalid menuju `/sf/validate`, lalu GET location melalui host loopback yang sama.

Runner mengirim SIGTERM lalu SIGKILL bila diperlukan dan menunggu child exit. Seluruh server eksperimen sudah dihentikan. Clone dibiarkan untuk review.

## Hasil teramati

Ringkasan output run kedua, target user `id=2` pada kedua clone (run pertama `id=1`; user probe dihapus pada akhir run):

```json
{"anonymous":{"status":401,"body":{"errors":[{"message":"Unauthorized access"}]}}}
{"guard":"unsupported","error":"CAPABILITY_UNSUPPORTED"}
{"guard":"api","error":"NOT_FOUND"}
{"guard":"web","error":"NOT_FOUND"}
```

Access tokens:

```text
mode=success status=200 id=2 before=0 after=0 tokenRemoved=true
mode=error   status=500 message="S-F deliberate application failure" before=0 after=0 tokenRemoved=true
mode=timeout error=TimeoutError before=0 after=0 tokenRemoved=true
mode=abort   error=AbortError   before=0 after=0 tokenRemoved=true
```

`AbortSignal.timeout(40)` dan explicit `AbortController.abort()` setelah 40 ms memutus client pada protected handler yang menunggu 180 ms. Credential cleanup berada di `finally`, bukan bergantung pada HTTP 2xx. Handler server tidak otomatis berhenti ketika fetch abort; semua slow request sudah melewati auth sebelum abort.

Session cookie, masing-masing success/error/timeout/abort: `jarSizeAfter=0`, tanpa server-side session record. Success `200 id=2`, deliberate application error `500`, timeout `TimeoutError`, abort `AbortError`.

```json
{"csrfMissing":{"status":302,"location":"/","body":"Redirecting to /"}}
{"csrfValid":{"status":200,"body":{"id":2}}}
{"xsrfValid":{"status":200,"body":{"id":2}}}
{"invalid":{"status":302,"location":"http://127.0.0.1:41101/sf/page"},"validation":{"status":200,"errors":{"title":"The title field must be defined"},"flashErrors":{"title":["The title field must be defined"]}}}
{"store":"memory","existed":true,"after":null}
{"store":"file","existed":true,"after":null,"filesAfter":[]}
{"cookieReplayAfterDiscard":{"status":200,"body":{"middleware":"auth-passed","id":2,"mode":"replay"}}}
```

CSRF tanpa token pada fixture ini **redirect 302**, bukan asumsi 403. Flow valid diuji dua kali: GET `/sf/csrf` mengambil `request.csrfToken`, POST dengan `x-csrf-token`; dan POST dengan `x-xsrf-token` dari cookie XSRF hasil GET. Tidak ada secret/token/cookie dicetak.

Percobaan awal GET Inertia tanpa version menghasilkan `409` walaupun props errors ada; setelah header `X-Inertia-Version: ctx.inertia.getVersion()` diberikan, GET menghasilkan `200`. Validation error asli berada di session `inputErrorsBag`, bukan key `errors`; shared props `errors` mengambil pesan pertama tiap field.

Contoh log protected handler:

```json
{"request_id":"869eb6fd-e44b-4549-9e6e-c9b96b53542a","middleware":"auth-passed","id":2,"requestId":"869eb6fd-e44b-4549-9e6e-c9b96b53542a","mode":"success","msg":"S-F normal protected middleware"}
{"request_id":"8bc73036-63fd-4925-ab2d-d6df7cbc5a35","middleware":"auth-passed","id":2,"requestId":"8bc73036-63fd-4925-ab2d-d6df7cbc5a35","mode":"success","msg":"S-F normal protected middleware"}
```

API mempunyai empat authenticated request ID berbeda; React lima termasuk replay. Anonymous tidak mencapai handler protected. Bodyparser dibuktikan oleh field validation JSON, Shield oleh failure/success CSRF, session oleh auth/flash, Inertia oleh props/version handshake.

- ✅ Identitas target benar: semua authenticated route memakai `id=2`; anonymous ditolak.
- ✅ Normal middleware berlaku: auth asli, request ID/log terpisah, Shield tetap memblok POST tanpa token, bodyparser/validation/session/Inertia benar-benar dijalankan.
- ✅ Token bersih setelah success/500/timeout/abort: count `0→0` dan query ID token kosong pada keempat kasus.
- ✅ Session cookie tidak meninggalkan server record; jar lokal dibuang pada keempat kasus; memory/file store primitive `destroy` terbukti menghapus state milik probe.
- ❌ Jika “bersih” berarti **revocation credential**: cookie yang disalin sebelum discard tetap autentikasi `200`. Cookie store stateless tidak menyediakan revocation server-side melalui `destroy`.
- ✅ Unknown user/requested guard gagal eksplisit, tanpa anonymous fallback.

## Referensi API/source

Path berikut relatif terhadap clone `node_modules/`. Reference source adalah file terpasang exact version, bukan asumsi dokumentasi dari major lain.

- **Public/documented**, auth `10.1.0`: `@adonisjs/auth/build/modules/session_guard/guard.d.ts:175` dan `main.js:454-456`: `authenticateAsClient(user)` menghasilkan `{ session: { [sessionKeyName]: userId } }`, bukan cookie. `sessionKeyName` tidak di-hardcode probe.
- **Public/documented**, auth `10.1.0`: `@adonisjs/auth/build/modules/access_tokens_guard/guard.d.ts:152-155` dan `main.js:860-861`: token `authenticateAsClient` memberi Authorization tetapi tidak token handle; `main.js:1033` (`DbAccessTokensProvider.create`) dan `main.js:1117` (`delete`) menyediakan lifecycle konkret. Probe memakai model provider `User.accessTokens` supaya identifier tersedia untuk cleanup. `main.js:755` adalah `getUserOrFail`.
- **Public/documented**, session `8.1.0`: `@adonisjs/session/build/session-CtFzPhwZ.js:160-212` `defineConfig`/resolved stores; `:233-258` factory file/redis/cookie. Factory menerima context nyata dan resolved config.
- **Public exported, khusus integrasi test**, session `8.1.0`: `@adonisjs/session/build/src/plugins/japa/api_client.js:35-44,108-138`: plugin memilih **memory store**, bukan store aktif, commit sebelum request dan destroy saat error/teardown. **Jangan menyalin plugin ini sebagai adapter production/dev HTTP generic.**
- **Public exported**, session `8.1.0`: `@adonisjs/session/build/src/client.js:74-90` `SessionClient.commit/destroy`; panggilan store tidak di-await oleh implementation tersebut. Probe memanggil `await store.write/destroy` langsung sehingga file I/O benar-benar selesai.
- **Public store contract; implementation internal/versioned**, session `8.1.0`: `@adonisjs/session/build/cookie-DH8O4a87.js:42-71` menyimpan value dalam encrypted cookie bernama session ID; destroy hanya clear response cookie jika request membawa cookie itu. `session-CB0uNFzC.js:165-167` membaca ID melalui cookie utama; `:576` commit session request. Cookie store tidak mempunyai row/file/server map.
- **Public store contract; implementation internal/versioned**, session `8.1.0`: `session-CtFzPhwZ.js:52-94` memory write/read/destroy; `file-CoDeKml_.js:92-150` file write/read/destroy; `redis-CiCcOEEX.js:155-157` Redis destroy menjalankan `DEL sessionId`. Redis tidak diuji runtime.
- **Public/documented**, Shield `9.0.0`: `@adonisjs/shield/build/src/shield_middleware.d.ts:19-25` `request.csrfToken`; **internal implementation reference**, `frame_guard-yu-WWHZp.js:50-63` mendukung `_csrf`, `x-csrf-token`, encrypted `x-xsrf-token`. Probe tidak memanggil fungsi private atau mendekripsi token secara manual.
- **Public/documented**, Inertia `5.0.1`: `@adonisjs/inertia/build/src/inertia.d.ts:170` `getVersion`; `src/inertia_middleware.js:33-44` `getValidationErrors` membaca `inputErrorsBag`, dan `:107-115` version mismatch GET → 409/reflash.
- **Public/documented**, Core `7.6.0`: https://docs.adonisjs.com/guides/basics/routing (router/get/post/named middleware); https://docs.adonisjs.com/guides/basics/response (cookie/encryptedCookie/getHeader/removeHeader/redirect); https://docs.adonisjs.com/guides/basics/request (request.id); https://docs.adonisjs.com/guides/concepts/config-providers (`configProvider.resolve`). Response API digunakan pada context HTTP nyata untuk mint cookie lalu capture header secara lokal; tidak membuat `IncomingMessage` palsu.
- **Public/documented**, Lucid `22.4.2`: https://lucid.adonisjs.com/docs/crud-operations (`firstOrCreate`, `find`, `delete`); https://lucid.adonisjs.com/docs/select-query-builder (count/where/first). Vine `4.4.0`: https://vinejs.dev/docs/types/string (`compile`, required string/minLength); Core request validation menggunakan https://docs.adonisjs.com/guides/basics/validation.
- **Public/documented**, Node `24.21.0`: https://nodejs.org/docs/latest-v24.x/api/globals.html (`fetch`, `AbortController`, `AbortSignal.timeout`, `Headers.getSetCookie`); runner menggunakan https://nodejs.org/docs/latest-v24.x/api/child_process.html (`spawn`, `spawnSync`, `kill`).

## Keterbatasan

Probe bukan package implementation dan bukan adapter universal. Route eksperimen sengaja mempunyai orkestrasi credential; probe JS tidak mempunyai kontrak TypeScript publik. Jalankan satu `/sf/run` per proses: cookie jar/event array probe shared untuk observasi serial, bukan pola singleton yang boleh dibawa ke M5. Credential jar runtime package wajib per call.

Memory/file telah diuji store primitive secara nyata, tetapi belum protected HTTP success/error/abort pada driver tersebut. Redis hanya source analysis, tidak diklaim compatible. Session regeneration/logout/custom guard/remember-me/custom provider belum termasuk fixture evidence. Abort fetch tidak menghentikan controller, transaction, atau side effect server. `[INFERENCE]` Pada stateful driver, cleanup sebelum controller selesai dapat kalah oleh commit middleware yang menulis kembali sesi; jadi tidak boleh langsung mengklaim cleanup abort universal.

Outer response probe dapat menerima cookie anonymous normal dari session/Shield middleware setelah handler selesai; credential impersonation hasil mint ditangkap dan removed, tidak disampaikan ke client luar. Probe tidak log Authorization/Cookie/Set-Cookie. Cookie replay observasi dilakukan sebelum user probe dihapus; cleanup user di akhir tidak menjadi mekanisme revocation adapter.

## Keputusan dan dampak

Pass criterion identitas dan middleware: **LULUS**. Token lifecycle pada `api`: **LULUS**. Session `web` cookie lifecycle: **LULUS BERSYARAT**: putaran 1 membuktikan no server residue/local discard, bukan immediate revocation; putaran 2 membuktikan cookie dengan embedded deadline diterima sebelum dan ditolak sesudah expiry, termasuk rewrap response cookie. Status tetap bersyarat karena normal middleware menghapus embedded expiry ketika refresh dan recipe harus membatasi setiap hop; stateful session HTTP abort belum dibuktikan. Blocker cookie putaran 1 **terselesaikan** sebagai recipe bounded replay, bukan janji immediate revocation.

Putaran 3 menambah gate M5 **LULUS** untuk `@rikology/adonisjs-tenant@1.0.2` access-token/session guard dengan membership A/B, tenant mapping melalui middleware, negative cross-tenant request, token cleanup success/error/abort, dan request anonymous berikutnya. Status keseluruhan tetap LULUS BERSYARAT karena batas cookie-expiry/refresh serta driver stateful yang telah dijelaskan; bukan karena tenant-aware HTTP belum diuji.

Resep adapter per guard:

1. **Access tokens/Lucid**: validate requested guard dan pilih user provider/model yang benar; temukan user atau `NOT_FOUND`; `User.accessTokens.create(user, abilities, { expiresIn, name })`; simpan returned identifier; fetch Authorization hanya ke app origin; `await User.accessTokens.delete(user, identifier)` dalam `finally` untuk 2xx/5xx/network error/deadline/cancel. Jangan hanya memakai `authenticateAsClient` tanpa cara memperoleh handle cleanup. Expiry 60 detik probe adalah defense cadangan, bukan pengganti delete. Jangan menyapu seluruh tabel atau token user lainnya.
2. **Web/cookie**: `guard.authenticateAsClient(user)` menghasilkan session bag; resolve config asli, gunakan factory cookie dengan context nyata dan session ID baru, `await store.write(id, bag)`, keluarkan signed ID cookie dengan response cookie API dan encrypted data cookie melalui store; capture kedua cookies **lokal** tanpa output credential. GET normal untuk CSRF/XSRF; update jar pada **setiap** response/redirect; POST protected, follow hop secara manual dengan version Inertia benar; discard seluruh jar dalam `finally`. Tidak ada row untuk dihapus; clearCookie bukan revocation salinan yang sudah dibuat.
3. **Memory/file (recipe belum certified HTTP)**: store factory aktif, ID baru, `await write`; kirim signed ID cookie; baca/ikut ID baru bila regeneration terjadi; `await destroy` semua ID yang dimiliki operasi setelah request middleware selesai. Memory menghapus map entry/tag; file menghapus `<id>.txt`; Redis perlu `await destroy`/DEL (serta cleanup tagging bila adapter memakai tagging). Tidak boleh memakai global destroy/destroyAll user atau menunggu TTL saja.

D17 diperjelas: token benar-benar persisted; cookie session tidak server-persisted, local discard bukan revocation. Putaran 2 memilih embedded cryptographic expiry untuk membatasi replay credential yang dikendalikan adapter, dengan rewrap seluruh response/session/XSRF sebelum cookie dipakai lagi. D12 tetap: context in-process tidak menyeberangi socket. WP-19/WP-20/WP-21/WP-22 mempertahankan ordinary HTTP chain, manual redirects, per-call credentials, error flash/version semantics, dan safe-header filtering. Tidak mengubah D01–D16/D18–D20 atau menulis package M1+.

- OBL: D17/WP-20 harus membedakan “tidak ada server-side residue/local jar discarded” dari revocation cookie; dokumentasikan bahwa cookie credential yang disalin tetap berlaku sampai expiry.
- OBL: WP-20 harus mempertahankan handle token hasil create dan `await delete` dalam finally pada success/app-error/timeout/cancel; cleanup hanya credential milik call, bukan seluruh token user.
- OBL: WP-20 memakai resolved active store, bukan memory-only Japa session plugin; await operasi store langsung untuk asynchronous store dan simpan setiap ID hasil regeneration.
- OBL: Sebelum mengklaim memory/file/redis sebagai adapter HTTP supported, buktikan protected HTTP + cleanup sesudah server-side middleware finalization pada error/abort; mitigasi write-after-destroy harus diuji nyata.
- OBL: WP-21/WP-22 kirim Inertia version yang aktual, baca `inputErrorsBag`/props errors, pertahankan redirect status asli (302 CSRF/POST validation teramati), dan jangan mengasumsikan 403/303 universal.
- OBL: WP-19/WP-20 menolak requested guard/user tidak valid sebelum HTTP dan memakai cookie jar serta credential state per call, tidak singleton serial seperti probe.
- Keputusan blocker putaran 1: **RESOLVED** oleh embedded expiry + deadline-preserving rewrap; immediate revocation cookie tetap bukan capability. Lihat hasil, limitation, dan obligation tambahan pada putaran 2.

## Putaran 2 — resolusi blocker

**Verdict: blocker terselesaikan secara bersyarat.** Cookie dengan expiry dalam encrypted payload benar-benar diterima oleh session/auth aplikasi sebelum deadline dan ditolak server setelah deadline; tidak mengandalkan browser maxAge. Akan tetapi, response cookie normal aplikasi menghapus expiry itu. Adapter harus menjaga deadline asli ketika menerima cookie baru dan tidak boleh memakai response cookie mentah sebagai credential berikutnya. Status keseluruhan tetap **LULUS BERSYARAT**, bukan klaim immediate revocation atau adapter stateful universal.

### Reproduksi dan versi tambahan

```sh
# Clone baru, apply kedua probe, run React lalu API; port 41102/41103.
node spikes/s-f/run-r2.mjs
# Atau reuse dua clone round 1.
node spikes/s-f/run-r2.mjs /tmp/adonisjs-mcp-m0
```

Probe tambahan: `spikes/s-f/probe-r2.js`; runner `spikes/s-f/run-r2.mjs`. Semua credential dibuat di handler dalam proses app. Runner merekam seluruh stdout/stderr default `LOG_LEVEL=info`, membandingkan dengan credential nyata tanpa mencetak credential, memeriksa result body dan outer response headers, lalu menghapus file secret-candidate sementara dari clone. Hasil aman tersimpan dalam `sf-round2-observations.json` pada masing-masing clone. Kedua child dihentikan dan ditunggu exit.

Versi tambahan teramati dari `npm ls @adonisjs/http-server @boringnode/encryption @poppinss/utils --all`: `@adonisjs/http-server@9.3.1`, `@boringnode/encryption@1.0.1`, `@poppinss/utils@7.1.2`. Active encrypter fixture `gcm` (`config/encryption.ts:8-11`). Versi lain sama seperti putaran 1.

### Format cookie dan expiry

Source store cookie memanggil `response.encryptedCookie(sessionId, values, cookieOptions)`. HTTP serializer membuat `e:${encryption.encrypt(value, undefined, cookieName)}`: **purpose adalah nama cookie/session ID**, tetapi tidak memasukkan expiry; `maxAge`/Expires hanya cookie transport/browser attributes. Cookie primer `adonis-session` signed membawa ID; authentication membutuhkan encrypted data cookie bernama ID tersebut.

Recipe probe:

```js
const encrypted = `e:${encryption.encrypt(sessionBag, '2 seconds', sessionId)}`
ctx.response.plainCookie(sessionId, encrypted, {
  ...resolvedSessionConfig.cookie,
  stringify: false,
})
// Signed ID cookie menggunakan response.cookie seperti sebelumnya.
```

`stringify: false` diperlukan agar `plainCookie` tidak melakukan MessageBuilder/base64 wrapping kedua. HTTP cookie parser menerima format `e:` normal, decrypt dengan purpose session ID, lalu MessageBuilder memverifikasi embedded `expiryDate`. Probe menormalkan getHeader Set-Cookie string/array sebelum capture. Percobaan awal memakai wrapping/default plainCookie dan single-string iteration gagal 401 sebelum expiry; itu tidak dianggap bukti expiry. Run final sesudah format/capture benar menghasilkan:

```text
expectedId=8
inspection: idFound=true, valueType=object, keys=[auth_web,csrf-secret]
same bounded original cookie before expiry: 200, id=8
same original bytes replay after 2200ms (TTL=2s): 401 Unauthorized access
normal response-cookie replay after same expiry: 200, id=8
response-session value rewrapped with TTL=1s: before=200, id=8
same rewrapped bytes after 1200ms: 401 Unauthorized access
```

Probe menyimpan salinan cookie asli sebelum request, sehingga replay after expiry benar-benar mengirim credential yang sama, bukan jar hasil logout/expiry browser. Server rejection terbukti dengan Node fetch yang tetap mengirim string cookie tersebut.

**Refresh caveat yang teramati:** session middleware menulis ulang cookie menggunakan serializer normal tanpa expiry; replay cookie response itu masih `200`. Rewrap berhasil membatasi value hasil refresh: decrypt nilai cookie data asli dengan purpose ID, encrypt ulang dengan TTL tersisa, serialize tanpa wrapping kedua. Untuk implementasi nanti, gunakan deadline absolut call yang sama pada semua mint/rewrap; jangan membuat TTL baru yang memperpanjang replay window tiap hop. Jika remaining deadline ≤0, hentikan request dan buang jar. Primary signed ID tidak mengandung identity sendiri tanpa encrypted data yang masih valid.

### CSRF dan XSRF

XSRF header menerima encrypted payload dengan purpose `XSRF-TOKEN`. Probe mengambil XSRF asli dari GET Shield, decrypt melalui public encryption service, lalu encrypt ulang token yang sama dengan expiry 2 detik:

```text
bounded x-xsrf-token before expiry, authenticated session valid: POST 200 id=8
same x-xsrf-token after 2200ms, authenticated refreshed session still valid:
POST 302 location=/
```

Karena session tetap autentikasi `200` pada kontrol refreshedReplay, rejection POST sesudah expiry bukan sekadar auth gagal: Shield tidak menerima expired XSRF payload. Raw `request.csrfToken` yang diambil dari GET adalah token CSRF biasa tanpa expiry sendiri; adapter tidak dapat mengklaim token raw itu time-bound. Batas session-secret + bounded XSRF header cukup untuk flow yang dipilih. Response XSRF baru juga harus di-rewrap sesuai deadline, sama seperti session response cookie. Tidak perlu mematikan Shield atau mengubah token verifier.

### Exposure dan logout aplikasi asli

Scan default log level info mencakup stdout/stderr server serta log protected-route dengan request_id. Candidate list memuat raw/encoded session cookies, cookie headers, original/refreshed/clamped cookie, XSRF encrypted value, dan token bearer API. Nilai kosong/clear-cookie tidak dianggap secret candidate.

```json
{"kit":"react","logLevel":"info","candidates":59,"secretsInAppLogs":0,"secretsInResult":0,"secretsInOuterHeaders":0,"authRequestLogCount":5}
{"kit":"api","logLevel":"info","candidates":2,"secretsInAppLogs":0,"secretsInResult":0,"secretsInOuterHeaders":0,"authRequestLogCount":1}
```

API probe nyata menghasilkan `200 id=4` lalu delete token dalam finally. Probe/tool result tidak meneruskan Authorization/Cookie/Set-Cookie; outer response hanya menerima cookie anonymous normal yang bukan minted impersonation credential. Scan juga memeriksa outer headers nyata, bukan hanya boolean dalam hasil. **Tidak ada credential minted teramati dalam default app/request logs.** Ini bukan jaminan untuk logger/middleware kustom, debug environment `NODE_DEBUG`, atau aplikasi yang sengaja mencetak header; boundary itu wajib didokumentasikan.

Flow real kit, bukan `authenticateAsClient`: GET CSRF → POST `/login` menggunakan email/password user probe + CSRF → protected identity → GET CSRF → copy cookie → POST `/logout` → identity memakai jar logout → identity memakai copy sebelum logout:

```text
login: 302 /dashboard
loggedIn: 200 id=8
logout: 302 /login
afterLogout (jar normal): 401
logoutReplay (cookie copied before logout): 200 id=8
```

Dengan demikian local-discard/replay sifat putaran 1 **sama dengan logout aplikasi cookie-session sendiri**, bukan penurunan keamanan khusus impersonation. Jangan menyatakan session age=2h sebagai hard server replay bound bagi cookie serializer normal: source tidak menambahkan embedded expiry. Bukti runtime hanya replay segera sesudah logout; tidak ada uji menunggu dua jam. Bounded-expiry recipe putaran 2 justru memperketat credential yang dipegang adapter.

### Referensi tambahan

- **Public/documented**, Core `7.6.0` encryption service, https://docs.adonisjs.com/guides/security/encryption : encrypt `expiresIn`/purpose dan decrypt. Exact underlying API **public exported**, `@boringnode/encryption@1.0.1`, `build/index.js:76-89` menerima positional/options expiresIn dan purpose; `build/src/drivers/aes_256_gcm.js:42-61,109-116` memasukkan MessageBuilder expiry serta purpose AAD.
- **Public API, versioned format implementation**, HTTP server `9.3.1`, `build/define_config-CthsZu7o.js:1288-1315`: `e:` format, cookie-purpose encrypt/decrypt, default expiry undefined; `:3657-3661` plain cookie stringify override; `:3685-3688` encrypt lalu cookie serialization; `:4457-4475` public response encryptedCookie/plainCookie. Recipe memakai service/API publik, tetapi bergantung format `e:` yang harus dijaga adapter versi-terikat.
- **Public utility implementation**, `@poppinss/utils@7.1.2`, `build/index.js:134-180`: expiryDate dibangun dari expiresIn, invalid/expired message ditolak oleh verify. Ini menjelaskan server-side rejection, bukan hanya HTTP maxAge.
- **Shield internal behavior evidence**, `@adonisjs/shield@9.0.0`, `build/frame_guard-yu-WWHZp.js:59-63`: x-xsrf-token decrypt dengan purpose `XSRF-TOKEN`; menggunakan encryption service yang sama sehingga embedded expiry berlaku.
- **App source nyata**, React clone `app/controllers/session_controller.ts:10-20`: verifyCredentials/login lalu logout guard asli; `start/routes.ts:21-31`: real login/logout route middleware; `config/session.ts:26` age 2h. Default LOG_LEVEL kedua fixture=info dikonfirmasi.

### Keputusan dan obligation putaran 2

Blocker putaran 1 tidak lagi menghalangi WP-20 cookie adapter dengan trust-model lokal. Pilih bounded cryptographic cookie expiry dan no-exposure, bukan immediate revoke. Tetap tolak klaim “abort menghentikan kode server” atau “cookie response normal otomatis mempertahankan deadline”.

- OBL: WP-20 cookie adapter mint `e:` payload melalui encryption service dengan purpose cookie/session ID dan embedded expiresIn terikat deadline absolut call; gunakan non-stringifying serialization dan uji replay sebelum/sesudah expiry.
- OBL: WP-20 rewrap setiap authenticated response cookie dan XSRF payload dengan remaining lifetime deadline asli, termasuk redirect/regeneration ID baru; response cookie normal terbukti menghapus expiry, tidak boleh dipakai mentah sebagai credential berikutnya.
- OBL: WP-20/WP-22 strip credential headers/results, discard seluruh salinan jar, dan scan default logs/header output; dokumentasikan batas app-defined/debug request logging yang dapat mengekspos header di luar kontrol tool.
- OBL: Versi-terikat test format `e:`, purpose session-ID/XSRF-TOKEN, stringify:false, expiry verification, dan normalized Set-Cookie string/array wajib sebelum mengklaim kompatibilitas versi lain.

Tidak ada BLOCKER aktif dari cookie replay dalam fixture ini. Immediate revocation tetap bukan capability; stateful-driver HTTP abort obligation putaran 1 tetap belum certified.

## Putaran 3 — guard tenant-aware

### Fixture, command, dan public API

Fresh clone API `/tmp/adonisjs-mcp-m0/s-f3-api`, bukan clone putaran 1 atau base. `npm install @rikology/adonisjs-tenant@1.0.2`; observed versions: Core `7.6.0`, Auth `10.1.0`, Lucid `22.4.2`, Session `8.1.0`, tenant `1.0.2`. Node/OS sama dengan putaran sebelumnya. Port `41104`, host `127.0.0.1`, default log level info, SQLite hanya clone sendiri.

```sh
# Fresh clone otomatis dan install exact dependency.
node spikes/s-f/run-r3.mjs
# Command yang benar-benar dijalankan:
spikes/clone-fixture.sh api s-f3-api
node spikes/s-f/run-r3.mjs /tmp/adonisjs-mcp-m0/s-f3-api
# Export outputs seluruh putaran ke repository setelah scenario selesai:
node spikes/s-f/export-evidence.mjs /tmp/adonisjs-mcp-m0
```

Runner memasang provider tenancy sesudah auth provider; mengganti config auth/User hanya dalam clone dengan `auth-r3.ts`/`user-r3.ts`, menambah `tenancy-r3.ts` dan `probe-r3.js`. Guard dikonfigurasi melalui **public** `defineTenantAuthConfig`/`tenantGuards` dari guards subpath. User global memakai **public** `withTenantAuthFinder` membership mode dengan pivot `tenant_user`; session guard memakai `TenantUserProvider` yang sama; access-token guard memakai `User.accessTokens` sebagai `tenantTokenProvider`. Existing table token clone ditambah `tenant_id` nullable; pivot/data fixture dibuat lewat real SQLite DDL dalam probe, bukan mock provider.

Resolver header memiliki lookup statis terpercaya A/B; adapter memilih mapping hanya sesudah `TenantUserProvider.findById(tenant,userId)` membuktikan membership. Outgoing `X-Tenant-ID` berasal lookup tersebut, bukan copy arbitrary caller header. **Header resolver sendiri bukan authorization**: ordinary endpoint tetap mengharuskan credential guard dan token-to-tenant/membership checks. Named tenant middleware diletakkan sebelum named auth middleware; starter silent-auth lebih awal tetap berjalan normal.

### Hasil teramati

Semua outgoing requests dibuat di dalam running handler `/sf3/run` dengan fetch ke port app sendiri. Final run user A=`3`, user B=`4`.

```text
requested user A + tenant B before mint:
TENANT_MEMBERSHIP_DENIED, tokenRows=0

access-token A + mapping A:
200 id=3 tenant=a rows=[A-private], persisted tokenTenant=a, count 0→0
same token A + mapping B:
401 Unauthorized access

access-token B + mapping B:
200 id=4 tenant=b rows=[B-private], persisted tokenTenant=b, count 0→0
same token B + mapping A:
401 Unauthorized access

access-token A application error:
500 \"S-F3 deliberate app error\", count 0→0
access-token A explicit AbortController.abort() after 40ms:
AbortError (server handler waits 180ms), count 0→0

tenant-aware session A + mapping A:
200 id=3 tenant=a rows=[A-private]
same session cookie A + mapping B:
401 Unauthorized access
tenant-aware session B + mapping B:
200 id=4 tenant=b rows=[B-private]
same session cookie B + mapping A:
401 Unauthorized access

next anonymous request (no mapping, no credential):
200 {authenticated:false,tenant:null}
next anonymous protected request + mapping A:
401 Unauthorized access
callerTenantAfter=null, finalTokenRows=0
```

Normal protected routes mengeluarkan requestId dan app log `S-F3 tenant-aware normal auth middleware`. A success request ID `695a07b4-d1fd-415d-b25b-c62f1513d4f6`; B `8713e2d6-8ce4-409c-91dc-595a7ccebb9a`. Data dipilih oleh aplikasi memakai active resolved tenant; ini membuktikan auth/tenant routing, **bukan** generic raw SQL isolation/RLS. Access token dibuat dalam `TenantService.run` pada tenant yang dipilih; outgoing request membangun ALS sendiri melalui middleware, tidak mewarisi context caller melewati socket.

```json
{"candidates":14,"secretsInLogs":0,"secretsInResult":0,"secretsInHeaders":0}
```

Scan memakai issued credential nyata (empat token lifecycle dan dua session cookie), tidak sekadar regex. Temporary candidate file dihapus. Semua child processes dihentikan dan ditunggu exit.

- ✅ Identity + tenant data benar pada token/session A/B.
- ✅ User A + requested tenant B ditolak sebelum mint.
- ✅ Token yang issued tenant A tidak diterima oleh protected request tenant B (dan sebaliknya).
- ✅ Session guard membuktikan membership ketika cookie A dipakai pada B, menghasilkan 401.
- ✅ Token count 0→0 success/error/explicit abort; final row count nol.
- ✅ Request anonymous berikutnya tidak mempunyai auth/tenant context residual; caller context juga null.
- ✅ Credential tidak tampil pada captured info-level logs, result, atau outer headers.

### References dan batas klaim

Semua source references berikut dari `node_modules/@rikology/adonisjs-tenant@1.0.2` dalam clone:

- **Public documented:** `README.md:94-114` konfigurasi access-token guard; `:177-203` membership-mode mixin dan TenantUserProvider; `:90-92` silent tenant-less check dan automatic AuthManager extension.
- **Public exports/API:** `build/index.js:19`, `build/src/guards/define_config.d.ts:22-42` factories; `build/src/guards/tenant_aware_access_tokens.d.ts:18-42` verifier contract; `build/src/guards/tenant_aware_session.d.ts:21-24` tenant provider contract.
- **Internal implementation evidence, tidak diimpor probe:** `build/src/mixins/index.js:18-34` create menulis tenant_id aktif; `:60-68` verifier mengecek stored token ID+tenant_id; `:102-104` mixin menyediakan tenant token provider.
- **Internal behavior evidence:** `build/define_config-WiAuPLL-.js:22-28` session membership check, `:35-37` tenant-less silent check, `:58-72` access-token provider verification. Token guard membuktikan token-to-tenant binding; **tidak melakukan membership preflight saat createUserForGuard/createToken**. Karena itu impersonation adapter sendiri wajib lookup membership sebelum mint; tidak boleh mengasumsikan `authenticateAsClient(user)` memvalidasi pilihan tenant.
- **Public API with source evidence:** `build/src/user_providers/tenant_user_provider.js:14-21` user/pivot lookup; `build/src/middleware/tenant_middleware.js:22-37` resolved tenant/context; `build/path_resolver-AqE_tt6j.js:6-49` trusted configured header lookup.

Keterbatasan: tenant-aware session hanya diuji protected GET/cross-tenant identity; session CSRF/flash/lifecycle driver cookie memakai bukti putaran 1–2, belum cross-product tenant-aware stateful-driver abort. Abort client tidak menghentikan kode server. Membership dapat berubah selama call; spike membuktikan preflight dan guard checks fixture statis, bukan transaksi authorization terhadap concurrent membership revocation. HTTP resolver mapping A/B bukan dukungan seluruh resolver package.

### Raw evidence tersimpan dan secret scan

Output JSON nyata kini disimpan dalam repository, bukan hanya `/tmp`:

- `spikes/s-f/sf-round1-api.json`
- `spikes/s-f/sf-round1-react.json`
- `spikes/s-f/sf-round2-api.json`
- `spikes/s-f/sf-round2-react.json`
- `spikes/s-f/sf-round3-api.json`
- `spikes/s-f/sf-evidence-manifest.json`

Exporter mempertahankan structured raw output/status/request IDs dan exposure scan; credential-named fields/access-token strings di-redact jika ditemukan. Development error `frames` ditandai redacted karena dapat memuat source/context. Semua lima files menghasilkan `secretPatternMatchesAfterRedaction=0`. Round 2/3 juga memiliki zero-match comparison terhadap nilai credential yang benar-benar issued, lebih kuat daripada regex saja. Fixture email synthetic dipertahankan, tidak berasal user data. Repository ini tidak mempunyai Git metadata; “commit evidence” berarti artefak repository sudah ditulis untuk integration owner, tidak ada commit Git yang diklaim.

### Keputusan dan obligation

M5 tenant-aware impersonation gate pada kombinasi versi/fixture ini **LULUS**, dan P2 missing evidence terselesaikan. D12 dan D17 diperkuat: membership preflight + context-scoped token issuance + trusted outgoing mapping + normal tenant/auth middleware + per-call cleanup harus merupakan satu recipe, bukan ALS wrapping saja.

- OBL: WP-20/WP-21 tenant-aware impersonation harus lookup tenant dan membership lewat provider guard sebelum mint; unknown/mismatched user-tenant ditolak tanpa credential creation atau anonymous fallback.
- OBL: WP-20 tenant-aware access-token adapter memakai tenant-bound provider/verifier nyata dan mint dalam tenant context yang tervalidasi; jangan mengganti dengan ordinary unbound DbAccessTokensProvider.
- OBL: WP-19/WP-21 mapping Host/header berasal konfigurasi terpercaya dan tenant middleware harus berjalan sebelum auth; outbound mapping tidak boleh dipercayai sebagai authorization sendiri.
- OBL: Gate M5 harus mempertahankan corpus cross-tenant token/session, token cleanup success/error/abort, dan anonymous-after-call; stateful-driver/cross-product coverage lain tetap perlu bukti sebelum klaim.

Tidak ada BLOCKER aktif pada tenant-aware HTTP guard yang diuji.
