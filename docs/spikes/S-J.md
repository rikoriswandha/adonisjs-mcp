# S-J — Eksekusi Ace dari aplikasi HTTP
Status: LULUS BERSYARAT
Tanggal: 2026-10-13

## Pertanyaan

Panggil Ace lewat programmatic API atau `spawn(process.execPath, argv, { shell: false })`; command generator dan command gagal. Lulus bila cwd app benar, stdout/stderr terisolasi, exit code nyata, no prompt hang, dan app HTTP tetap hidup.

## Lingkungan

- macOS 27.0 arm64; Node v24.21.0; npm 11.19.0.
- Fixture API create-adonisjs 3.4.0, clone disposable `/tmp/adonisjs-mcp-m0/s-j-api-1791855414816`; path canonical OS `/private/tmp/...`. Base fixture tidak dimodifikasi.
- Hasil `npm ls @adonisjs/core @adonisjs/ace @adonisjs/lucid @poppinss/ts-exec`: Core **7.6.0**, Ace **14.1.1**, Lucid **22.4.2**, ts-exec **1.5.0**.
- Hasil `npm ls @poppinss/prompts @adonisjs/application`: prompts **3.1.6**, application **9.1.0**.
- HTTP process PID 83035, `HOST=127.0.0.1 PORT=41180 NODE_ENV=development`. SQLite fixture saja; tidak memakai PostgreSQL/Redis.
- MCP SDK tidak dipasang: spike ini menguji invocation Ace dari route HTTP nyata, bukan protocol MCP.

## Skenario dan command

Dari root repository:

```sh
node spikes/s-j/run.mjs
# Opsional: nama clone baru yang belum ada
node spikes/s-j/run.mjs s-j-api-repro
```

Entry script memanggil `bash spikes/clone-fixture.sh api <nama>`, menyalin command dan route probe, kemudian menjalankan:

```sh
HOST=127.0.0.1 PORT=41180 NODE_ENV=development \
  node --import=@poppinss/ts-exec bin/server.ts
```

HTTP GET `/sj/run?argv=<JSON-array>` memulai subprocess **dari dalam server**, bukan dari runner. Invocation aktual:

```js
spawn(process.execPath, ['ace.js', ...argv], {
  cwd: fileURLToPath(app.appRoot), shell: false, detached: true,
  env: { ...process.env, FORCE_COLOR: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
```

`ace.js` mendaftarkan ts-exec sendiri; child tidak perlu mewarisi `process.execArgv` loader HTTP. `bin/console.ts` menggunakan APP_ROOT, Ignitor console, importer relatif, dan `handle(process.argv.splice(2))`. Jangan mengimpor entrypoint console ke proses HTTP: ia menggunakan/mengubah argv global dan lifecycle console.

Skenario: `list`; `list:routes --json`; `make:controller spike_probe`; unknown command; `migration:run --connection=nope`; `make:controller` tanpa argumen; command nyata `spike:probe prompt` memakai Ace `prompt.confirm`; output besar; argv metacharacters; command sleep 60 detik yang membuat child tambahan; state mutation di subprocess dan in-process. GET `/sj/ping` dijalankan selama command masih aktif. Pembandingan in-process memakai service resmi `ace.exec`, bukan `handle`.

Hasil observasi tersimpan di `spikes/s-j/observed.json` (list diringkas menjadi ukuran/jumlah; output route tetap lengkap). Runner mencetak output dan menghentikan process group server dalam `finally`. Clone dibiarkan untuk inspeksi. Controller hasil generator dihapus setelah ukuran file diamati.

## Hasil teramati

- ✅ **Cwd app benar:** command mengeluarkan `cwd=/private/tmp/adonisjs-mcp-m0/s-j-api-1791855414816`, `root=file:///private/tmp/adonisjs-mcp-m0/s-j-api-1791855414816/`. Generator: `DONE: create app/controllers/spike_probes_controller.ts`, 105 bytes, lalu `generator-deleted: true`.
- ✅ **Stdout/stderr terisolasi:** inspection menghasilkan JSON di stdout dan `SEPARATE_STDERR\n` hanya di stderr. `spike:probe state` menghasilkan `COMMAND_STDOUT\n` dan `COMMAND_STDERR\n` pada stream terpisah.
- ✅ **Exit code nyata:** `list` 43 commands/49.847 bytes, exit 0; `list:routes --json` 2.462 bytes, exit 0, berisi route `/sj/ping`, `/sj/run`, dan API fixture. Generator exit 0. Unknown command exit 1 dengan `Command "does:not:exist" is not defined` di stderr. Migration exit 1 dengan `[ error ] "nope" is not a valid connection name. Double check "config/database" file`.
- ✅ **Tidak hang pada input tertutup:** `make:controller` tanpa nama exit 1 (`Missing required argument "name"`). `spike:probe prompt` exit 0, `timedOut=false`, stdout menampilkan `Continue spike? (y/N) › false`. **Tidak** ada JSON `{ answer }` setelah await prompt: process selesai tanpa melanjutkan baris sesudah prompt. Jadi exit 0 tidak membuktikan pekerjaan interaktif selesai; jangan menafsirkan tampilan `false` sebagai jawaban yang benar-benar diterima command.
- ✅ **Deadline dan cleanup tree:** deadline 2.500 ms pada sleep menghasilkan `exitCode=null`, `signal=SIGKILL`, `timedOut=true`; PID command 83529 dan child 83576 keduanya `alive=false` setelah 400 ms. SIGTERM diikuti SIGKILL process group; hasil tidak memalsukan exit code 1 ketika proses mati oleh signal.
- ✅ **Output bounded:** command menulis 100.000 bytes pada masing-masing stream; retained stdout/stderr masing-masing 4.096 bytes, `truncated=true`, exit 0. Pipe tetap didrain sesudah limit supaya command tidak macet.
- ✅ **HTTP app hidup:** `/sj/ping` selama child sleep memberi `{alive:true,pid:83035}` dalam 2 ms; ping setelah subprocess dan in-process juga sukses.
- ✅ **Tidak ada shell interpolation:** argv `; touch SJ_SHELL_EXECUTED $(echo bad) | cat & > file` kembali persis sebagai value; marker `SJ_SHELL_EXECUTED` tidak ada. Inspection juga mengamati `port=41180`, `host=127.0.0.1`, `nodeEnv=development`, `stdinTTY=false`.
- ❌ **In-process bukan isolasi stdout/state:** `ace.exec('list', [])` berhasil, tetapi capture global untuk `spike:probe state` berisi `COMMAND_STDOUT\nHTTP_NEIGHBOR_STDOUT\n` dari request tetangga. Environment parent berubah menjadi `changed-by-command`; mutation subprocess sebelumnya tidak mengubah parent. Monkey-patch capture sengaja hanya eksperimen, bukan solusi yang direkomendasikan.
- ✅ **Tidak meninggalkan proses milik spike:** runner menghentikan PID server 83035; `ps -p 83035,83529,83576 -o pid,ppid,command` hanya menampilkan header, exit 1 (tidak ada PID tersebut).

## Referensi API/source

Path source berikut relatif terhadap clone yang disebut di Lingkungan:

- **Public/documented:** Node v24.21.0 [`child_process.spawn`, options cwd/env/shell/stdio/detached, close/error events](https://nodejs.org/docs/latest-v24.x/api/child_process.html); [`process.kill`](https://nodejs.org/docs/latest-v24.x/api/process.html#processkillpid-signal). `detached` membentuk process group/session baru pada POSIX; negative PID menargetkan group. Byte accounting menggunakan Node [`Buffer`](https://nodejs.org/docs/latest-v24.x/api/buffer.html).
- **Public framework service:** Core 7.6.0 `node_modules/@adonisjs/core/build/services/ace.js:3-15`; exported singleton service. `node_modules/@adonisjs/core/build/providers/app_provider.js:64-75` menunjukkan binding `ace` dan contoh `ace.exec`; provider implementation adalah **internal**, hanya bukti construction.
- **Public API:** Ace 14.1.1 `node_modules/@adonisjs/ace/build/index.js:2609-2629` mendokumentasikan `exec(commandName, argv)`; `:2649-2667` mendokumentasikan `handle` sebagai owner proses dan larangan re-entry. `:709-718` menunjukkan `exitCode` command. Tidak mengimpor file bundle internal tersebut secara langsung.
- **Public command API:** Core 7.6.0 `node_modules/@adonisjs/core/build/modules/ace/commands.d.ts:23-29` (`BaseCommand`, `app`, kernel/prompt); [`creating commands`](https://docs.adonisjs.com/guides/ace/creating-commands) untuk `@args.string` dan `run`; prompts 3.1.6 `node_modules/@poppinss/prompts/build/index.js:266-269` untuk implementasi `confirm` (**internal source evidence**, pemanggilan lewat public `this.prompt`).
- **Internal lifecycle evidence:** Core 7.6.0 `node_modules/@adonisjs/core/build/main-DvUje0hm.js:87-102` membatasi `terminate()` command ke main command; `node_modules/@adonisjs/core/build/create_kernel-Bx7xtr5F.js:23-47` menunjukkan package loaders dan FsLoader untuk directory commands. Tidak dipakai sebagai import recipe.
- **Fixture entrypoints, bukan package API:** `ace.js:20-27` ts-exec registration; `bin/console.ts:21-47` APP_ROOT, importer, Ignitor/handle dan error exit code. Public app service root dipakai melalui `@adonisjs/core/services/app`, bukan `process.chdir`.

## Keterbatasan

Hanya macOS POSIX dan satu versi framework; Linux harus diverifikasi sebelum klaim matrix, Windows memerlukan recipe process-tree berbeda. Process yang sengaja detach/setsid keluar dari group tidak tercakup; bukan sandbox terhadap custom command berbahaya. Putaran 1 memakai direct ts-exec; putaran 2 di bawah menguji HMR/watch supervisor sungguhan. Probe deadline memakai command sleep nyata, bukan `serve` yang berpotensi mencoba port parent karena PORT diwarisi.

stdin `/dev/null` menghindari hang untuk prompt yang diuji tetapi dapat membuat prompt keluar code 0 sebelum pekerjaan selesai. Custom command lain dapat menunggu sumber selain stdin: deadline tetap wajib. Env diwariskan sebagai snapshot saat spawn; tidak mewarisi mutation runtime JS/container/tenant ALS. Command `startApp` mem-boot console app baru dan bisa menjalankan provider effects; stdout bukan proyeksi state in-memory HTTP.

Route eksperimen bukan endpoint MCP dan tidak memiliki input/security production contract; hanya clone loopback disposable. Limit probe berlaku **per stream**, sehingga bukan enforcement final total-result 256 KiB. Probe belum menguji UTF-8 boundary/redaction, concurrent commands, cancellation disconnect, atau failure saat spawn. Tidak ada package source M1+ dibuat.

## Keputusan dan dampak

Semua lima kriteria plan S-J **lulus dengan subprocess pada putaran 1**; in-process gagal kriteria isolasi. Putaran 2 membuktikan generator biasa tetap responsif di HMR, tetapi hard restart menghilangkan response dan mengorbankan cleanup milik HTTP parent. Status tetap **LULUS BERSYARAT** dengan recipe independent watchdog yang diamati di putaran 2; raw detached spawn plus lifecycle hook saja tidak cukup.

D01–D20 tidak perlu diubah; D08 tetap khusus eval, sedangkan Ace deadline dapat mematikan owned subprocess. Kontrak `run_ace_command` tetap command/args/flags → stdout/stderr/exit code; perlu metadata timeout/signal/truncation dan dokumentasi transport interruption/outcome unknown agar tidak menyesatkan. Dampak pada WP-29 (Ace), WP-38 dan E08; mutating annotations tetap berlaku. Recipe macOS harus mencakup watchdog independen, bukan hanya timer parent.

- OBL: WP-29 memakai `spawn(process.execPath, ['ace.js', command, ...argv], {cwd: appRoot, shell:false})` di watchdog independen; argv terstruktur, tanpa import console entrypoint atau `process.chdir` parent; jangan mewarisi `process.execArgv` HTTP secara buta.
- OBL: Wariskan environment aplikasi sebagai snapshot (termasuk HOST/PORT/NODE_ENV) tanpa menampilkan secret; dokumentasikan console app baru dan tidak berbagi singleton/ALS/state in-memory HTTP, serta side effect provider boot.
- OBL: stdin harus non-TTY/tertutup, tanpa jawaban otomatis; dokumentasikan command interaktif unsupported untuk workflow yang memerlukan jawaban dan bahwa exit 0 tidak menjamin prompt menyelesaikan pekerjaan.
- OBL: Terapkan deadline/cancellation pada owned POSIX process group dengan SIGTERM lalu SIGKILL, drain pipe dan tunggu close; laporkan exitCode nullable, signal dan TIMEOUT/CANCELLED terpisah; sweep descendant walau leader sudah exit.
- OBL: Bound stdout/stderr bytes dan total JSON result 256 KiB, lanjutkan drain setelah truncation, tangani UTF-8 boundary serta redaction; jangan memakai capture global stdout/stderr pada HTTP process.
- OBL: Gate WP-38/E08 harus memverifikasi Linux tree cleanup, responsive HTTP, generator cleanup, nonzero exit, prompt behavior, dan truncation; jangan mengklaim Windows atau escaped process cleanup tanpa bukti adapter.
- OBL: WP-29 memakai watchdog di luar HTTP child untuk parent-death detection dan command-group cleanup; timer/lifecycle hook di HTTP process tidak berjalan bila assembler restart mengirim SIGKILL.
- OBL: Dokumentasikan hard restart sebagai transport interruption dengan outcome mutasi unknown: output/exitCode tidak tersedia, side effect sebelum restart tidak dibatalkan, client harus inspect state sesudah reconnect dan tidak otomatis retry.

## Putaran 2 — under HMR

**Status putaran:** generator normal LULUS; hard-restart + raw spawn GAGAL cleanup; independent watchdog LULUS cleanup pada macOS. Status keseluruhan tetap LULUS BERSYARAT.

### Reproduksi dan raw evidence

```sh
node spikes/s-j/run-hmr.mjs
SJ_HMR_CLEANUP=1 node spikes/s-j/run-hmr.mjs
SJ_HMR_GUARD=1 node spikes/s-j/run-hmr.mjs
```

Semua run clone API baru dan memulai **`HOST=127.0.0.1 PORT=41180 NODE_ENV=development node ace.js serve --hmr`**. HTTP route memulai Ace child. Core/Ace/ts-exec sama dengan putaran 1; `npm ls @adonisjs/assembler hot-hook` mengamati assembler **8.5.2**, hot-hook **1.0.0**. Hooks fixture `indexEntities` dan Tuyau `generateRegistry` tetap aktif, tidak dimatikan.

Raw records bertimestamp, stdout/stderr supervisor lengkap, dan route trace ada di `spikes/s-j/observed-hmr-unsafe.json`, `observed-hmr-cleanup.json`, `observed-hmr-guard.json`. `observed-hmr-initial.json` menyimpan run awal yang terhenti saat runner menganggap `routes.json` ada; runner diperbaiki untuk mencatat ENOENT. Tidak menganggap generated file yang absen sebagai kegagalan app. `hmr_probe.ts` memakai Ace `kernel.exec('make:controller', ...)` lalu delay 12 detik sehingga file write terjadi saat HTTP response masih pending. Skenario terakhir sengaja menambah comment pada `adonisrc.ts` 600 ms setelah request dimulai, untuk menguji **hard restart sesungguhnya**, bukan menebak bahwa setiap generator memicu restart.

### Hasil generator normal

Raw-spawn run: supervisor PID **17176**, HTTP PID **17228**. Dari route:

| Command | Duration request | Exit | Observasi |
| --- | --- | --- | --- |
| `make:controller spike_hmr_probe` | 244 ms | 0 | `app/controllers/spike_hmr_probes_controller.ts`; controller index berubah |
| `make:model spike_hmr_model` | 243 ms | 0 | `app/models/spike_hmr.ts`; tidak restart |
| `make:validator spike_hmr_validator` | 311 ms | 0 | `app/validators/spike_hmr.ts`; tidak restart |
| `spike:hmr spike_hmr_held` | 12.274 ms | 0 | generator selesai lalu delay; response/stdout lengkap, HTTP PID tetap 17228 |

Controller index regenerate terbukti oleh log `[ info ] created .adonisjs/server/controllers.ts` dan hash berubah dari `fcc1440b...` ke `a302479b...`, kemudian `dfbeacba...` ketika held controller ditambah. Pada held request, index diubah time **1791856936113**, sedangkan response baru selesai **1791856948111**: codegen benar-benar overlap request aktif tanpa mengganti HTTP PID. Tuyau registry schema hash/mtime tidak berubah untuk generator ini (controller kosong tidak menambah route); tidak mengklaim generateRegistry dipanggil setiap model/validator write. Log bootstrap dan sesudah hard restart menunjukkan Tuyau membuat registry. `routes.json` tidak ada pada boot HMR ini, dicatat ENOENT.

✅ Controller generation memicu entity codegen tetapi tidak process restart pada fixture ini.  
✅ Model/validator generation tidak mengganti HTTP PID; stdout/stderr response lengkap.  
✅ Generator + delay 12 detik tetap memberi response penuh; polling ping tidak mengamati outage pada skenario normal.

### Hard restart ketika command masih berjalan

Raw-spawn run: command PID **18154** selesai membuat controller pada time **1791856949911**. `adonisrc.ts` ditulis pada **1791856950221**; log assembler `update adonisrc.ts` pada **1791856950223**. Response hilang pada **1791856950240** (624 ms sejak request), `fetch failed`, cause `SocketError: other side closed`; bukan JSON response partial yang sukses.

HTTP PID berubah **17228 → 18233**; polling sukses dengan PID baru pada **1791856950985**. Command **18154 masih alive** pada **1791856951767**, sesudah HTTP child lama mati: detached command tidak ikut dibunuh, capture hilang. Trace hanya berisi stdout before/after-generator dan tidak memiliki after-delay/close dari command ini. File generator sudah ada/index sudah berubah; restart bukan rollback. Outage ping teramati sekitar 0,7 detik.

Eksperimen `SJ_HMR_CLEANUP=1` mendaftarkan `app.terminating` dengan SIGTERM→200 ms→SIGKILL ke owned groups. Hasil tetap response lost (641 ms), HTTP **18925 → 20063**, command **20000 masih alive** sesudah restart. Tidak ada `terminating-owned` untuk HTTP lama pada hard restart; hook hanya muncul pada shutdown normal HTTP baru. Jadi provider termination hook bukan perlindungan terhadap HMR hard kill.

❌ Raw detached spawn tidak memenuhi no-orphan ketika parent dibunuh.  
❌ App lifecycle termination hook tidak memperbaikinya pada assembler hard restart.  
✅ Tidak ada klaim exitCode/success/rollback untuk response yang hilang.

### Recipe yang terbukti: independent watchdog + interruption contract

`SJ_HMR_GUARD=1` menjalankan probe `guard.mjs` sebagai subprocess independen. Guardian memulai Ace dalam owned POSIX group, meneruskan stdout/stderr, memeriksa keberadaan PID HTTP parent tiap 100 ms, dan ketika parent hilang mengirim SIGTERM kemudian SIGKILL sesudah 200 ms. Ini **minimum probe**, bukan package implementation atau durable job system.

Guarded run: HTTP **20715 → 21199**, guardian **21138**, Ace **21139**. Restart kehilangan response dalam 640 ms, sama seperti raw spawn. Guardian trace:

```text
1791857131827 parent-gone-stop parentPid=20715 guardianPid=21138 acePid=21139
1791857132028 swept           parentPid=20715 guardianPid=21138 acePid=21139
```

Guardian sudah `alive=false` pada **1791857133315**. Pemeriksaan akhir `ps -p ...21138,21139,21199... -o pid,ppid,pgid,command` hanya header, exit 1; tidak ada proses milik run tertinggal setelah runner cleanup. Normal guarded generator dan held-delay tetap memberi exit 0/output lengkap. Race PID reuse, command sengaja escape process group, dan port Linux belum diuji.

✅ Watchdog tetap berjalan setelah HTTP parent SIGKILL; cleanup tidak bergantung app lifecycle.  
✅ Guardian/command tidak tertinggal pada pemeriksaan akhir; survivor raw-spawn juga dihentikan runner eksternal.  
❌ Watchdog tidak menyelamatkan HTTP response/complete stdout ketika server restart.

**Kontrak aman yang dipilih:** pertahankan sinkron command→result hanya bila transport hidup; jangan menjanjikan “respond before restart” atau flag `serverWillRestart` universal karena restart dapat datang dari concurrent edit dan assembler tidak menunggu response. Saat hard restart, client menerima transport failure dan hasil/side effects dinyatakan **unknown**, inspect state sesudah reconnect, tanpa automatic retry mutating command. Cleanup process harus dimiliki watchdog independen. Tidak membuat durable/polling job API baru (di luar scope release).

### Source references dan dampak tambahan

- Assembler **8.5.2**, `node_modules/@adonisjs/assembler/build/index.js:981-984`: `removeAllListeners(); httpServer.kill('SIGKILL'); startHTTPServer(...)` pada restart. **Internal implementation evidence**, bukan API yang akan diimpor package.
- Fixture `adonisrc.ts:1-3` imports `indexEntities`/`generateRegistry`; bootstrap log mengamati loading hooks, generating indexes, codegen, dan Tuyau registry.
- `app.terminating` adalah public lifecycle API ([application lifecycle](https://docs.adonisjs.com/guides/concepts/application-lifecycle)); observasi menunjukkan tidak berjalan untuk SIGKILL, konsisten Node signal semantics. Guardian memakai public Node spawn/process.kill/timers APIs yang dirujuk pada putaran 1.

- OBL: Perluas WP-38/E08 dengan HMR generator + held request + hard restart; buktikan output normal, interruption unknown, parent-independent cleanup, dan tidak ada retry mutating command.
- OBL: Recipe watchdog final harus memiliki deadline/cancellation sendiri, mendrain output bounded, meneruskan actual Ace exitCode/signal, dan membunuh owned group walau HTTP process mati; probe guardian hanya membuktikan parent-death seam, bukan seluruh package contract.
- BLOCKER: Tidak ada untuk melanjutkan recipe watchdog macOS; raw spawn tanpa watchdog tidak boleh dipakai sebagai fulfillment cleanup HMR.
