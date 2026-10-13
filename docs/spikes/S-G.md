# S-G — Boundary SQL read-only dan pemulihan pool
Status: LULUS BERSYARAT
Tanggal: 2026-10-13

## Pertanyaan

Query PostgreSQL/SQLite dengan CTE mutating, multi-statement, PRAGMA write, EXPLAIN ANALYZE, cancellation: apakah mode default tidak dapat mengubah data melalui query yang diizinkan, dan state pool pulih setelah error/cancel?

## Lingkungan

Fixture API nyata dari create-adonisjs 3.4.0, clone `/tmp/adonisjs-mcp-m0/s-g-api`; base tidak diubah. Probe dijalankan sebagai Ace command dengan `startApp: true`, memakai service Lucid booted dan Knex yang dikembalikan `getWriteClient()`. Tidak memakai MCP SDK karena eksperimen ini khusus boundary DB, bukan transport.

Versi resolved dari `npm ls @adonisjs/core @adonisjs/lucid knex pg better-sqlite3`: Core **7.6.0**, Lucid **22.4.2**, Knex **3.3.0**, pg **8.16.3**, pg-pool **3.14.0**, better-sqlite3 **13.0.3**. Node **v24.21.0**, npm **11.19.0** (baseline lingkungan), Darwin **27.0.0 arm64**. PostgreSQL **18.4 (Homebrew)**, cluster disposable, port **55441**, listen hanya `127.0.0.1`. PORT app **41120**; Ace tidak membuka HTTP listener. SQLite tetap connection default; tambahan `sqlite_ro`, `pg`, `pg_ro` hanya pada clone.

## Skenario dan command

```sh
node spikes/s-g/run.mjs
# Atau clone disposable yang sudah ada:
node spikes/s-g/run.mjs /tmp/adonisjs-mcp-m0/s-g-api
```

Runner meng-clone API jika belum ada, memasang `pg@8.16.3` exact, menyalin `database.ts` dan `sql_probe.ts`, menjalankan initdb trust pada `/tmp/adonisjs-mcp-m0/s-g-pg`, lalu:

```sh
/opt/homebrew/opt/postgresql@18/bin/pg_ctl -D /tmp/adonisjs-mcp-m0/s-g-pg -o '-p 55441 -h 127.0.0.1 -k /tmp/adonisjs-mcp-m0/s-g-pg' -l /tmp/adonisjs-mcp-m0/s-g-pg/pg.log start
npm ls @adonisjs/core @adonisjs/lucid knex pg better-sqlite3
node ace spike:sql
/opt/homebrew/opt/postgresql@18/bin/pg_ctl -D /tmp/adonisjs-mcp-m0/s-g-pg stop -m fast
```

Cluster dihentikan dan direktori cluster dihapus dalam `finally`. Clone boleh tersisa untuk review. Runner berhasil tiga kali; `spikes/s-g/observed.txt` memuat stdout run final, termasuk versi, seluruh JSON corpus, dan shutdown. SQLite probe table/journal dan file eksperimen di-reset saat run, tidak mengubah tabel fixture lain. Runner menolak cluster path yang sudah ada, bukan mengakses atau menghentikan cluster milik proses lain.

PostgreSQL: tiap corpus memakai dedicated transaction, `SET TRANSACTION READ ONLY`, `SET LOCAL statement_timeout='150ms'`, query, lalu **selalu ROLLBACK**. Observer pg terpisah memeriksa jumlah row/sequence dan advisory locks. Pool sengaja `max:1` untuk menunjukkan pemakaian backend yang sama. Role `spike_reader` hanya mendapat SELECT pada tabel probe; tidak superuser. SQLite: connection Knex dengan `connection.options.readonly:true`, dibandingkan connection read-write dengan `PRAGMA query_only=ON`; observer better-sqlite3 terpisah membaca jumlah row, user_version, journal_mode. File output/attachment diperiksa dari filesystem.

## Hasil teramati

✅ Statement mutating PostgreSQL biasa, CTE, EXPLAIN ANALYZE, sequence mutation ditolak DB; row=1 dan sequence=1 tetap menurut observer.

❌ Boundary transaksi saja bukan policy default aman: multi-statement dapat menutup transaksi; fungsi dan COPY dapat menghasilkan side effect walaupun mode READ ONLY aktif.

✅ PostgreSQL pool pulih setelah SQL error, statement timeout, Knex cancellation, dan explicit abort adapter: backend sama, readonly=off, timeout=0, `state=idle`, `xact_start=null`, `poolUsed=0`, `poolFree=1`.

❌ Pool tidak otomatis bersih untuk semua query yang diterima: session advisory lock bertahan sesudah rollback; SET di luar transaksi bocor ke borrower berikutnya.

✅ SQLite readonly file connection menolak mutasi tabel dan PRAGMA user_version; query berikutnya tetap berhasil sesudah error.

❌ SQLite readonly/query_only bukan SQL sandbox: readonly mengizinkan VACUUM INTO menulis file; query_only mengubah journal mode, membuat file ATTACH, dapat dimatikan oleh query.

❌ SQLite cancellation/deadline belum terpenuhi: `.timeout(20,{cancel:true})` ditolak sebagai unsupported; timeout tanpa cancel tidak membatasi query sinkron.

**Corpus PostgreSQL** — `Ditolak` berarti rejection DB, bukan filter aplikasi. Semua row/sequence diperiksa observer independen. Row awal 1 di-reset per kasus.

| Query/kasus | Ditolak DB? | Perubahan data/state teramati |
| --- | --- | --- |
| SELECT probe | Tidak | Tidak; readonly=on, timeout=150ms dalam transaksi |
| DELETE terselubung nested comments | Ya | Tidak, row=1 |
| SELECT 1; DELETE | Ya | Tidak, row=1 |
| WITH d AS (DELETE RETURNING) SELECT | Ya | Tidak, row=1 |
| EXPLAIN ANALYZE DELETE | Ya | Tidak, row=1 |
| SELECT nextval | Ya | Tidak, sequence=1 |
| SELECT setval | Ya | Tidak, sequence=1 |
| SELECT pg_advisory_lock | Tidak | Lock=1 sesudah rollback, juga terlihat observer |
| SELECT set_config(application_name,…,false) | Tidak | Berubah dalam transaksi; rollback memulihkan string kosong |
| SELECT set_config(transaction_read_only,off,true) | Ya | `must be set before any query`; readonly tetap terlindungi pada kasus SELECT ini |
| SELECT set_config(statement_timeout,0,true) | Tidak | Timeout dalam transaksi berubah menjadi 0; rollback reset |
| DO $$ DELETE $$ | Ya | Tidak, row=1 |
| CALL procedure yang DELETE | Ya | Tidak, row=1 |
| COPY (SELECT 1) TO PROGRAM 'true' | Tidak | DB menerima eksekusi program; row/sequence tidak berubah. Efek OS program tidak diinstrumentasi |
| COPY SELECT TO STDOUT | Tidak | Diterima; bukan mutasi tabel, tidak memberi klaim dukungan streaming COPY |
| LISTEN | Tidak | Tidak ada channel sesudah rollback; juga kosong sebelum commit |
| NOTIFY | Tidak | Diterima lalu rollback; delivery notification tidak diinstrumentasi |
| SELECT pg_sleep(1) | Ya, timeout | Tidak; pool pulih |
| INSERT RETURNING | Ya | Tidak, row=1 |
| COMMIT; DELETE | **Tidak** | **Observer row 1 → 0**; rollback tidak membatalkan DELETE yang sudah autocommit |

**Corpus SQLite** — RO = file opened readonly, QO = query_only pada connection read-write. Row awal 1; seluruh kasus corpus tidak mengubah row utama. Perbedaan state/file tetap merupakan pelanggaran keamanan.

| Query/kasus | RO ditolak? | QO ditolak? | State/file teramati |
| --- | --- | --- | --- |
| SELECT probe | Tidak | Tidak | Tidak berubah |
| Comment DELETE | Ya, readonly | Ya, readonly | Tidak berubah |
| Nested comments | Ya, syntax | Ya, syntax | SQLite tidak menerima nested comment seperti PostgreSQL |
| SELECT 1; DELETE | Ya | Ya | Driver: `contains more than one statement` |
| Mutating CTE | Ya, syntax | Ya, syntax | Bukan bukti read-only enforcement; grammar tidak mendukung bentuk ini |
| EXPLAIN ANALYZE DELETE | Ya, syntax | Ya, syntax | Tidak berubah; bukan grammar SQLite ini |
| PRAGMA user_version=5 | Ya | Ya | Observer version tetap 0 |
| PRAGMA journal_mode=WAL | Ya | **Tidak** | QO: observer journal **delete → wal** |
| ATTACH DATABASE path baru | Ya, cannot open | **Tidak** | QO membuat file dan database attachment; CREATE TABLE pada attachment tetap ditolak selama QO=ON |
| VACUUM INTO path | **Tidak** | Ya | RO membuat salinan DB. QO tetap membuat file target sebelum error, jadi rejection bukan berarti nol filesystem effect |
| SELECT load_extension | Ya, not authorized | Ya, not authorized | Tidak ada extension dimuat; extension loading tidak diaktifkan |
| INSERT RETURNING | Ya | Ya | Row tetap 1 |
| PRAGMA query_only=OFF | Tidak | **Tidak** | QO flag menjadi 0; independent observer melihat row **1 → 2** setelah INSERT berikutnya |

Output penting run final:

```text
pg transaction-escape: rejected=false, before.rows=1, after.rows=0
pg advisory-lock: pooled.advisory=1, independentLocks.advisory=1
session-leak: pid=88482, readonly=on, timeout=321ms
statement_timeout: elapsedMs=508, recovery.pid=88482, readonly=off, timeout=0, healthy=42
knex_cancel: elapsedMs=89, recovery.pid=88482, activity.state=idle, xact_start=null
abort: elapsedMs=83, error=canceling statement due to user request, poolUsed=0, poolFree=1
sqlite-cancel-support: Query cancelling not supported for this dialect
sqlite-timeout: elapsedMs=255, error="", abortedAtReturn=false, abortedAfterYield=true
sqlite-session-leak: nextBorrower=[{"query_only":1}]
sqlite-query-only-bypass: independentRows={"n":2}
```

`AbortController` PostgreSQL dihubungkan **secara eksplisit** ke observer `pg_cancel_backend(pid)`; bukan klaim bahwa Lucid/pg menerima AbortSignal otomatis. Cancellation ditunggu hingga query reject, rollback ditunggu, baru connection dikembalikan. Knex cancel membuka connection cancellation terpisah (bukan memerlukan slot pool app tambahan). SQLite recursive SELECT 2.000.000 langkah dengan `.timeout(10)` sukses setelah 255 ms; timer 10 ms baru dapat jalan sesudah query selesai. Borrower RO berikutnya sukses SELECT 42 dengan poolUsed=0/free=1, tetapi ini recovery setelah completion, **bukan** setelah interrupt yang berhasil.

Role read-only: SELECT diterima; `SET default_transaction_read_only=off` **diterima**; DELETE tetap ditolak `permission denied for table probe`; advisory lock tetap diterima. Jadi privilege SELECT melindungi tabel probe meskipun default setting dapat dimatikan, tetapi bukan pelindung semua function/session/OS effects.

Multi-statement pg: tanpa bindings, `SELECT 1; SELECT 2` memberi **2** result (simple protocol). Dengan binding `[1]`, `SELECT ?::int; SELECT 2` ditolak `cannot insert multiple commands into a prepared statement` (extended protocol). Empty bindings tidak menjamin single-statement. better-sqlite3 menggunakan `prepare`, bukan `exec`, sehingga seluruh string multi-statement ditolak.

## Referensi API/source

Path relatif berikut berada di clone `node_modules`; versi seperti Lingkungan.

- **Public/declared**, Lucid 22.4.2: `@adonisjs/lucid/build/src/types/database.d.ts:100-101` (`getReadClient/getWriteClient`); implementasi `build/src/query_client/index.js:69-71`, `:158-171` transaction dan rollback. `build/src/database/main.js:148-149` rawQuery.
- **Public/documented**, Knex 3.3.0 [transactions](https://knexjs.org/guide/transactions.html), [raw](https://knexjs.org/guide/raw.html), [timeout](https://knexjs.org/guide/query-builder.html#timeout). Source `knex/lib/raw.js:50-56`; `knex/lib/execution/transaction.js:103-104,142-143`; `knex/lib/execution/runner.js:149-150`.
- **Internal/private source evidence**, Knex 3.3.0: `knex/lib/dialects/better-sqlite3/index.js:11-17` meneruskan `connection.options.readonly`; `:42` prepare. Lucid 22.4.2 `build/src/types/database.d.ts:310-317` **tidak mendeklarasikan** nested `options` tersebut walaupun konfigurasi berhasil runtime. Bukan klaim typecheck berhasil.
- **Public/documented**, better-sqlite3 13.0.3 [Database API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md): readonly, prepare, pragma, close. Source `better-sqlite3/lib/database.js:31,58,73` readonly native flag dan loadExtension. Extension SQL tetap unauthorized pada default driver. Driver timeout constructor adalah lock-wait timeout, bukan statement deadline.
- **Internal/private source evidence**, Knex 3.3.0 `knex/lib/client.js:546-548`: unsupported query cancellation; `knex/lib/dialects/postgres/index.js:269-279` pg query config; `:312-327` cancel via `pg_cancel_backend`, lalu destroy cancellation connection. `client.pool.numUsed/numFree` adalah internal instrumentation probe, bukan API package yang direkomendasikan.
- **Public/documented**, pg 8.16.3 [Client query API](https://node-postgres.com/apis/client), [queries](https://node-postgres.com/features/queries). **Internal source evidence** `pg/lib/query.js:35-57,163-175`: values nonempty memicu preparation/extended protocol. Observer memakai public `Client.connect/query/end`.
- **Public/documented**, PostgreSQL 18: [SET TRANSACTION](https://www.postgresql.org/docs/18/sql-set-transaction.html), [SET LOCAL dan rollback](https://www.postgresql.org/docs/18/sql-set.html), [statement_timeout](https://www.postgresql.org/docs/18/runtime-config-client.html), [admin signaling pg_cancel_backend](https://www.postgresql.org/docs/18/functions-admin.html), [advisory locks](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS), [COPY](https://www.postgresql.org/docs/18/sql-copy.html), [pg_stat_activity](https://www.postgresql.org/docs/18/monitoring-stats.html), [CREATE ROLE](https://www.postgresql.org/docs/18/sql-createrole.html), [GRANT](https://www.postgresql.org/docs/18/sql-grant.html).
- **Public/documented**, SQLite [query_only](https://www.sqlite.org/pragma.html#pragma_query_only), [journal_mode](https://www.sqlite.org/pragma.html#pragma_journal_mode), [ATTACH](https://www.sqlite.org/lang_attach.html), [VACUUM INTO](https://www.sqlite.org/lang_vacuum.html), [extension loading](https://www.sqlite.org/loadext.html).
- **Public/documented**, Adonis Ace [creating commands](https://docs.adonisjs.com/guides/ace/creating-commands): BaseCommand, commandName, startApp. Node timers/AbortController hanya adapter probe.

## Keterbatasan

Ini negative-boundary spike, bukan implementasi SQL parser atau package. Tidak ada policy AST yang sudah terbukti, sehingga hasil **tidak** mengklaim supported subset lulus. Bypass COMMIT memang di luar prefix allowlist desain, tetapi membuktikan wrapper transaction tidak cukup; pg_advisory_lock dan set_config justru **masuk SELECT** allowlist desain. COPY/ATTACH/VACUUM adalah defense-in-depth corpus, bukan seluruhnya query yang akan diizinkan desain.

Bukan audit semua PostgreSQL functions, SECURITY DEFINER, views, FDW, extension, virtual table atau user-defined function SQLite. Trusted app DB dapat menyediakan fungsi/view dengan side effect di balik SELECT; melarang function call sintaks saja tidak membuktikan semua view aman. Pengujian COPY program hanya `true`, aman pada disposable cluster; tidak menginstrumentasi efek OS maupun notification delivery. Tidak ada timeout SQLite yang membunuh query; tidak boleh menyebut return timeout sebagai cancellation. Executor worker/process terpisah dengan file readonly merupakan opsi lanjutan, tetapi belum dibuktikan di spike ini dan berdampak pada kontrak in-process.

Runner tidak memulai server HTTP; transport dan request cancellation MCP milik S-A. Semua proses cluster yang dimulai runner sudah dihentikan; tidak menyentuh PostgreSQL 5432. SQLite clone/file eksperimen tersisa untuk review. Typecheck tidak dijalankan; nested readonly options runtime didukung Knex tetapi tidak tercakup deklarasi Lucid versi ini.

## Keputusan dan dampak

Verdict **putaran 1**: acceptance S-G **GAGAL** untuk jaminan default keseluruhan; PostgreSQL recovery error/cancel **LULUS**, SQLite hard deadline/cancel **GAGAL**, DB write boundary dasar pada kedua dialect **LULUS hanya pada kasus mutasi yang diuji**. Verdict akhir sesudah S-G2 adalah **LULUS BERSYARAT** untuk kedua dialect dengan recipe dan batas supported subset di bagian berikutnya; broad arbitrary SQL tetap tidak aman. D10 diperkuat (parser + boundary DB), D18 tidak berubah. D01–D09, D11–D17, D19–D20 tidak diubah, tetapi ownership §4.2 harus menambahkan dedicated SQL connections/child executor milik MCP, bukan pool DB app. WP-16–WP-18 membutuhkan recipe final dan error contract yang membedakan TIMEOUT/CANCELLED dari rejection SQL.

Rekomendasi **policy** (belum implementasi terbukti): parser dialect-aware memvalidasi tepat satu AST SELECT read query; non-mutating WITH harus diperiksa rekursif, bukan token pertama. Tolak transaction control, SELECT INTO, locking clauses, mutating CTE, CALL/DO/COPY/LISTEN/NOTIFY, arbitrary function calls, seluruh write PRAGMA/ATTACH/VACUUM/extension. EXPLAIN tanpa ANALYZE hanya pada AST read query; bukan arbitrary EXPLAIN. PRAGMA awal default-deny, kemudian allowlist read metadata yang diverifikasi per dialect. Function allowlist harus schema-qualified dan trusted, termasuk view dependencies; jangan memakai volatile flag saja sebagai security proof. Supported subset tetap harus berguna untuk SELECT tabel, joins, filtering dan metadata, bukan menonaktifkan seluruh tool.

Rekomendasi **enforcement**: PostgreSQL gunakan dedicated reader connection/least-privilege role, transaction READ ONLY dan SET LOCAL deadline, satu query yang lolos policy; await cancellation settlement + rollback di finally sebelum release. Jangan SET session app pool. SQLite gunakan dedicated readonly-file connection yang tidak berbagi PRAGMA dengan app, plus default-deny policy; query_only hanya defense tambahan, bukan boundary utama. Tanpa executor interrupt yang terbukti, jangan menjanjikan hard SQLite timeout/cancel.

- OBL: WP-16–WP-18 wajib parser dialect-aware single-statement AST, recursive read-only subset, default-deny function/PRAGMA/transaction-control serta regression corpus ini sebelum klaim default aman.
- OBL: PostgreSQL wajib READ ONLY transaction + SET LOCAL timeout + awaited rollback/release dan abort adapter terikat backend aktif; late cancellation tidak boleh membatalkan query borrower berikutnya.
- OBL: Gunakan reader connection milik MCP/role least-privilege dan jangan SET session pada pool aplikasi; audit/reset atau discard connection bila cleanup gagal, termasuk residual session advisory locks.
- OBL: SQLite wajib connection readonly terpisah; dukungan nested Knex options perlu seam typed/version-bound karena Lucid 22.4.2 tidak mendeklarasikannya.
- OBL: SQL capability metadata/documentation harus membedakan cooperative response timeout dengan actual DB cancellation; jangan klaim AbortSignal otomatis didukung pg/Lucid.
- Blocker historis putaran 1: default full SELECT/WITH/EXPLAIN/PRAGMA belum terbukti aman. Putaran 2 menemukan parser JS usable, DB-enforced single statement, native readonly metadata, dan supported subset yang tetap mendukung filter/join/read CTE. Resolusi bersyarat, bukan jaminan arbitrary functions/views.
- Blocker historis putaran 1: deadline SQLite sinkron tidak tersedia in-process. Putaran 2 membuktikan child-process SIGKILL benar-benar menghentikan executor tanpa membekukan app. Worker terminate saja tidak membuktikan interrupt.

## Putaran 2 — resolusi blocker

Reproduce: `node spikes/s-g/run-round2.mjs`. Runner menjalankan setup/corpus putaran 1 dahulu, lalu fresh cluster PostgreSQL 55441, memasang **pgsql-ast-parser 12.0.1** dan **sqlite-parser 1.0.1** pada clone, dan menjalankan `node ace spike:sql-round2`. Dependency tambahan dikonfirmasi `npm ls`. Output final tersimpan `spikes/s-g/observed-round2.txt`. Semua cluster/process milik probe sudah dihentikan; dua executor yang menjalankan billion-step recursive query menerima SIGKILL dan exit ditunggu.

### PostgreSQL: extended protocol, privilege, deadline, cleanup

✅ `client.query({text,values:[],name: uniqueName})` pada **dedicated pg.Client reader**, di dalam BEGIN READ ONLY, menolak `COMMIT; DELETE`, `SELECT 1; DELETE`, dan nested-comment multi-statement dengan `cannot insert multiple commands into a prepared statement`; observer row tetap 1.

❌ **values:[] saja bukan extended protocol**: `SELECT 1; SELECT 2` menghasilkan 2 result. `queryMode:'extended'` tanpa bindings menolaknya. Named prepared statement juga memaksanya. DISCARD ALL menghapus prepared statements; probe memakai nama baru per call supaya cache client tidak mengacu pada statement server yang sudah dihapus. Recipe production yang lebih sederhana: explicit `queryMode:'extended'`, bukan named cache.

❌ Single-statement `COMMIT`, `ROLLBACK`, dan `SET TRANSACTION READ WRITE` **diterima DB**. Statement kind tetap wajib ditolak sebelum execute. Parser mengklasifikasikan commit/rollback; SET TRANSACTION tidak didukung parser ini dan fail-closed. Reader role SELECT-only tetap boundary data tambahan meski setting READ ONLY dimatikan.

Role teramati: `rolsuper=false`, `rolcreaterole=false`, `rolcreatedb=false`, membership signal/files/program semuanya false. Rerun corpus lengkap:

| Kasus | Hasil DB tanpa filter policy | Hasil policy prototype |
| --- | --- | --- |
| SELECT tabel, WHERE filter, JOIN, read-only WITH | Sukses, observer rows=1 | ALLOW |
| Multi-statement/hidden comments | Prepared protocol rejection | DENY |
| COMMIT/ROLLBACK/SET READ WRITE | Diterima | DENY |
| DELETE/comment DELETE/mutating CTE/EXPLAIN ANALYZE/INSERT RETURNING | Read-only transaction rejection | DENY |
| nextval/setval | Permission denied sequence | DENY function call |
| advisory_lock/set_config | Diterima; perlu cleanup/deadline eksternal | DENY function call |
| COPY TO PROGRAM | Permission denied external program | DENY/parser fail-closed |
| COPY TO STDOUT | Diterima | DENY/parser fail-closed |
| dblink_exec ke superuser throwaway DB | `password or GSSAPI delegated credentials required` | DENY function call |
| pg_terminate_backend(app backend superuser) | Permission denied terminate process | DENY function call |
| lo_import/lo_export | Permission denied function | DENY function call |
| DO/CALL mutating | Read-only transaction rejection | DENY/parser fail-closed |
| LISTEN/NOTIFY | Diterima; rollback/DISCARD cleanup | DENY/parser fail-closed |
| pg_sleep | Statement timeout | DENY function call |

dblink **benar-benar dipasang** dengan CREATE EXTENSION pada cluster disposable; bukan mock/absence result. Penolakan credentials pada trust auth bukan bukti dblink selalu aman: valid kredensial/SECURITY DEFINER/user extension bisa mengubah boundary. Karena itu function default-deny tetap wajib. pg_terminate_backend terhadap backend role lain superuser ditolak; sesama role dapat memiliki privilege berbeda, jadi hasil ini tidak melegalkan function tersebut.

✅ Query `SELECT set_config('statement_timeout','0',true),pg_sleep(30)` tetap dibatalkan oleh deadline timer app 100 ms melalui control connection `pg_cancel_backend(pid)`: **102 ms**, `canceling statement due to user request`, observer activity idle/xact_start=null. Query ini sengaja melewati policy untuk menguji lapisan cancellation yang tidak bisa dibatalkan oleh GUC query. Ini hard cancellation DB query, bukan preemption seluruh proses JS atau jaminan real-time saat event loop app diblokir kode lain.

✅ Dedicated reader menerima advisory lock + session application_name + session timeout + LISTEN; `ROLLBACK` lalu **DISCARD ALL** di luar transaksi menghapus lock **1 → 0**, application_name menjadi kosong, timeout=0, listening=[] menurut observer/settings.

✅ Pool app tidak berubah: before/after **PID=1004**, application kosong, timeout=0, readonly=off. Jangan jalankan DISCARD ALL pada pool app.

Parser feasibility: pure JS pgsql-ast-parser mengklasifikasikan SELECT, WITH, mutating CTE, transaction control, DO, function-call AST dan nested comments. Unsupported grammar seperti COPY/CALL/EXPLAIN ANALYZE/SET TRANSACTION menjadi rejection, bukan fallback. Prototype policy recursive menolak calls/mutation nodes dan root selain satu select/with. Positif SELECT/WHERE/JOIN/read CTE benar-benar dijalankan, bukan hanya syntax-check. Parser bukan native PostgreSQL grammar penuh; policy prototype bukan security-reviewed production validator (unknown AST nodes/operator/view dependencies belum exhaustively diaudit).

### SQLite: native statement readonly dan actual interruption

Dedicated `new Database(file,{readonly:true,fileMustExist:true})` + **prepare, bukan exec**:

| Statement | stmt.readonly | Kind/policy akhir |
| --- | --- | --- |
| SELECT, filter, JOIN, read CTE | true | select, ALLOW; dieksekusi sukses |
| DELETE/comment DELETE/INSERT RETURNING | false | DENY; parser RETURNING unsupported fail-closed |
| PRAGMA user_version=5 | false | pragma, DENY |
| PRAGMA journal_mode=WAL | false | pragma, DENY |
| ATTACH | **true** | attach, DENY — native readonly saja tidak cukup |
| VACUUM INTO | false | DENY; parser grammar lama fail-closed |
| PRAGMA query_only=OFF | **true** | pragma, DENY — native readonly saja tidak cukup |
| SELECT load_extension | **true** | select/function, DENY |
| Multiple statements | prepare error | DENY sebelum eksekusi |
| Mutating CTE/EXPLAIN ANALYZE | native syntax error | DENY |

✅ Filter gabungan native readonly + exactly-one select AST + recursive deny fungsi/non-select menutup **seluruh write/file bypass yang teramati**; files attachment/vacuum tetap `false`. Tidak memakai regex SQL sebagai final policy. sqlite-parser AST mengenali select/pragma/attach; grammar lama tidak menerima beberapa sintaks SQLite modern—unsupported gagal tertutup.

❌ `db.loadExtension` **bukan disabled secara keseluruhan**: SQL `load_extension` default `not authorized`, tetapi JS method callable dan mencoba `dlopen` path missing. Native source mengaktifkan C API load extension, bukan SQL entry point. Child executor tidak boleh mengekspos JS ini, memanggil loadExtension, atau meregistrasikan UDF/virtual-table callbacks. Tidak ada extension nyata dimuat oleh probe.

✅ **Child process SIGKILL benar-benar menghentikan sync query** recursive 1.000.000.000 langkah: exit `signal=SIGKILL` **103 ms setelah ready**, timer deadline 100 ms. App Ace tetap menjalankan interval 10 ms (**13 heartbeats** termasuk startup), lalu readerHealth=42 dan SQLite independent fresh connection berhasil membaca row=2 (baseline putaran 1), tidak ada perubahan oleh round2.

❌ **worker.terminate() tidak membuktikan interrupt native better-sqlite3**: setelah terminate dipanggil, masih pending **302 ms**; supervisor proses kemudian di-SIGKILL **503 ms setelah ready** agar native thread tidak tertinggal. Tidak ada resolved terminate event sebelum kill. Pilih **child process**, bukan worker_threads, untuk hard deadline native query ini.

SQL child punya own readonly connection, hanya query SQL/bindings yang tervalidasi, tidak ada state app/IoC shared; MCP endpoint tetap in-process, executor SQL SQLite yang isolated adalah detail internal dengan dampak ownership/shutdown. SQLite in-memory database tidak didukung readonly-file child ini; tidak boleh membuka read-write fallback.

### Referensi tambahan dan verdict final

- **Public/documented**, pg 8.16.3: [Query config/prepared statements](https://node-postgres.com/apis/client), [extended protocol](https://www.postgresql.org/docs/18/protocol-flow.html). Source `node_modules/pg/lib/query.js:35-57` membuktikan queryMode/values/name selection; named queries public, explicit queryMode juga source-backed.
- **Public/documented**, PostgreSQL 18 [DISCARD ALL](https://www.postgresql.org/docs/18/sql-discard.html): tidak boleh di dalam transaksi; reset session, prepared statements, listening, advisory locks. [dblink security](https://www.postgresql.org/docs/18/contrib-dblink-connect.html), extension benar-benar dipasang pada probe.
- **Public/documented**, pgsql-ast-parser 12.0.1 `node_modules/pgsql-ast-parser/readme.md:55-65` parse array; `parser.d.ts:19-23` public typed parse. **Jangan parseFirst**, karena `parser.d.ts:2-3` menyatakan statement sisanya dibuang.
- **Public/documented**, sqlite-parser 1.0.1 `node_modules/sqlite-parser/README.md:35-47,114-118` synchronous AST dan stable shape. Ini parser JS lama, bukan SQLite grammar native current.
- **Public documented metadata + internal implementation evidence**, better-sqlite3 13.0.3 `node_modules/better-sqlite3/src/objects/statement.cpp:156` → sqlite3_stmt_readonly; [SQLite readonly caveats](https://www.sqlite.org/c3ref/stmt_readonly.html). Native `src/objects/database.cpp:154-170` readonly open flags dan C API extension load enabled; `:371-389` JS loadExtension memakai sqlite3_load_extension.
- **Public/documented**, Node 24 [worker.terminate caveat native C++ function](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#workerterminate), [child.kill](https://nodejs.org/docs/latest-v24.x/api/child_process.html#subprocesskillsignal).

**PostgreSQL: LULUS BERSYARAT. SQLite: LULUS BERSYARAT.** Dua blocker teknis putaran 1 mendapat jalur solusi teramati: supported subset/parser + dedicated DB enforcement, dan SQLite child-process hard termination. Ini tidak mengubah broad arbitrary SELECT/functions menjadi aman; view/function/operator code aplikasi tetap trusted code. Tidak ada blocker teknis baru untuk recipe terbatas yang diuji, tetapi obligation berikut merupakan syarat acceptance/release, bukan tugas yang sudah diimplementasikan pada package.

- OBL: PostgreSQL wajib dedicated least-privilege reader, forced extended protocol untuk **setiap** user statement (values kosong bukan cukup), BEGIN READ ONLY, dan fail-closed AST single read SELECT/WITH tanpa arbitrary function/transaction-control; unknown grammar/AST nodes ditolak.
- OBL: PostgreSQL deadline gunakan timer/control connection terpisah; tunggu cancellation settlement, ROLLBACK, lalu DISCARD ALL sebelum reuse; discard/close connection bila cleanup gagal; timer harus dihentikan sebelum operasi berikutnya.
- OBL: SQLite wajib own readonly/fileMustExist child connection, native stmt.readonly **dan** exactly-one read-select AST policy, deny ATTACH/VACUUM/PRAGMA/functions/UDF/extension; unsupported grammar atau non-file/in-memory dialect ditolak tanpa read-write fallback.
- OBL: SQLite hard deadline gunakan child SIGKILL + await exit; jangan worker.terminate atau Knex timeout sebagai hard interruption; ukur deadline dari startup juga dan cleanup executor saat abort/shutdown.
- OBL: WP-16–WP-18 wajib mematangkan AST allowlist dengan security regression corpus/unknown-node default-deny, trusted relation/view/operator boundary, least-privilege provisioning dan typed driver seams; probe recursive validator bukan production parser proof lengkap.
- OBL: Update ownership dan kontrak SQL: connections/SQLite child milik MCP, tidak menyentuh pool app; supported subset/cancellation capabilities jelas, row/output bounds tetap berlaku, error TIMEOUT/CANCELLED jujur.
