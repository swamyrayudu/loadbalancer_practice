# talentpath — local nginx load balancer lab

Three instances of a Next.js app behind one nginx round-robin load balancer, with
shared session state in Redis and automatic failover when an instance dies.

Everything here runs on one Windows laptop. Commands are **PowerShell**.

```
                    http://localhost:8080
                             │
                      ┌──────▼──────┐
                      │    nginx    │   round robin
                      │    :8080    │   passive health checks
                      └──┬───┬───┬──┘
             ┌───────────┘   │   └───────────┐
             ▼               ▼               ▼
        :3000           :3001            :3003
      instance-1      instance-2       instance-3
             │               │               │
             └───────────────┼───────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
      Redis (Upstash)              Supabase (remote, Mumbai)
      sessions, rate limits         application data
      instance counters
```

---

# 1. Quick start

Assumes setup (section 3) is already done. **Four terminals.**

### Terminals 1–3 — the app instances

```powershell
cd "C:\Users\swamy\OneDrive\ドキュメント\swamy web dev\learning_system_design\load balancer\talentpath-2\talentpath"; $env:LB_DIST_DIR=".next-lb"; $env:PORT="3000"; $env:INSTANCE_ID="instance-1"; npx next start
```

```powershell
cd "C:\Users\swamy\OneDrive\ドキュメント\swamy web dev\learning_system_design\load balancer\talentpath-2\talentpath"; $env:LB_DIST_DIR=".next-lb"; $env:PORT="3001"; $env:INSTANCE_ID="instance-2"; npx next start
```

```powershell
cd "C:\Users\swamy\OneDrive\ドキュメント\swamy web dev\learning_system_design\load balancer\talentpath-2\talentpath"; $env:LB_DIST_DIR=".next-lb"; $env:PORT="3003"; $env:INSTANCE_ID="instance-3"; npx next start
```

Each one holds its terminal open. That is normal.

### Terminal 4 — nginx

Double-click `C:\nginx\start-lb.bat`, **or** run this (works from any folder):

```powershell
C:\nginx\nginx.exe -p C:/nginx -c C:/nginx/conf/talentpath-lb.conf
```

### Verify

```powershell
1..6 | ForEach-Object { curl.exe -s http://localhost:8080/api/health; "" }
```

Expected — `instance` rotates through all three:

```
{"status":"ok","instance":"instance-1","port":"3000",...}
{"status":"ok","instance":"instance-2","port":"3001",...}
{"status":"ok","instance":"instance-3","port":"3003",...}
{"status":"ok","instance":"instance-1","port":"3000",...}
...
```

Then open **http://localhost:8080** in a browser.

### Stop everything

```powershell
C:\nginx\nginx.exe -p C:/nginx -c C:/nginx/conf/talentpath-lb.conf -s stop
```

Then `Ctrl+C` in each of the three app terminals.

---

# 2. Order matters

**nginx does not start your app servers.** It only forwards traffic.

```
Run 3 servers only      →  3000 ✅  3001 ✅  3003 ✅  8080 ❌ connection refused
Run 3 servers + nginx   →  3000 ✅  3001 ✅  3003 ✅  8080 ✅
```

Always: **app servers first, nginx second.** Start nginx alone and every request returns
`502 Bad Gateway`, because it has nowhere to forward to.

---

# 3. One-time setup

### 3.1 Install nginx

Extract the official Windows zip to `C:\nginx` (short, ASCII-only path — nginx on
Windows handles non-ASCII paths like `ドキュメント` badly):

```powershell
Expand-Archive -Path "$env:USERPROFILE\Downloads\nginx-1.31.8.zip" -DestinationPath "C:\" -Force; Rename-Item "C:\nginx-1.31.8" "nginx"
```

### 3.2 Copy the config into nginx

```powershell
Copy-Item "C:\Users\swamy\OneDrive\ドキュメント\swamy web dev\learning_system_design\load balancer\nginx\conf\talentpath-lb.conf" "C:\nginx\conf\"
```

> There are **two copies** of this config: the one in this repo (version-controlled,
> for reading and editing) and the one in `C:\nginx\conf\` (the one nginx actually
> reads). After editing the repo copy, re-run the command above.

### 3.3 Test the config before using it

```powershell
C:\nginx\nginx.exe -p C:/nginx -c C:/nginx/conf/talentpath-lb.conf -t
```

Expect `syntax is ok` and `test is successful`.

### 3.4 Environment variables

In `talentpath/.env`:

```
AUTH_URL=http://localhost:8080
NEXTAUTH_URL=http://localhost:8080
BETTER_AUTH_URL=http://localhost:8080
NEXT_PUBLIC_APP_URL=http://localhost:8080
AUTH_TRUST_HOST=true
```

All three instances read the same `.env`, so they share one `AUTH_SECRET` — which is
what makes the JWT session cookie valid on any of them.

### 3.5 Required code change

`src/lib/auth.ts`:

```ts
// before — breaks login behind the load balancer
useSecureCookies: process.env.NODE_ENV === 'production',

// after
useSecureCookies: process.env.USE_SECURE_COOKIES === 'true',
```

The instances run in production mode but are reached over plain `http://localhost:8080`.
With secure cookies on, Auth.js sets the `__Secure-` prefix and the `Secure` flag, and
browsers refuse to send those over HTTP — you would sign in successfully and be logged
out on the next request, **with no error anywhere**.

### 3.6 Google OAuth

Add `http://localhost:8080/api/auth/callback/google` to the authorised redirect URIs in
Google Cloud Console. The callback now arrives through the load balancer, not `:3000`.

### 3.7 Build

```powershell
cd "C:\Users\swamy\OneDrive\ドキュメント\swamy web dev\learning_system_design\load balancer\talentpath-2\talentpath"; $env:LB_DIST_DIR=".next-lb"; npm run build
```

---

# 4. Why `LB_DIST_DIR`

`next.config.ts` contains:

```ts
distDir: process.env.LB_DIST_DIR || ".next",
```

A running `next dev` server owns `.next` and keeps `.next\trace` locked, which makes
`next build` fail with `EPERM`. Building to `.next-lb` lets the production build and the
dev server coexist.

- Set the variable → build and start use `.next-lb`
- Leave it unset → ordinary `.next` behaviour, unchanged

**Every build and start command needs it**, or `next start` looks in `.next`, finds no
`BUILD_ID`, and errors with *"Could not find a production build"*.

`.gitignore` covers `.next-*`, so none of these folders get committed.

---

# 5. Updating code

```
1. edit code
2. $env:LB_DIST_DIR=".next-lb"; npm run build
3. Ctrl+C and restart terminal 1  (3000)
4. Ctrl+C and restart terminal 2  (3001)
5. Ctrl+C and restart terminal 3  (3003)
   → nginx keeps running, untouched
```

`next start` loads the build into memory **once, at startup**. It does not watch for
changes — production mode never hot-reloads. Rebuilding alone changes nothing until you
restart the instances.

**Rolling restart:** restart the three one at a time, waiting for each to come up. At
least two instances are always alive, so http://localhost:8080 never goes down. That is
a zero-downtime deployment, and it is one of the main reasons to run multiple instances.

---

# 6. How it works

## 6.1 Round robin

```nginx
upstream talentpath_backends {
    server 127.0.0.1:3000  max_fails=2  fail_timeout=10s;
    server 127.0.0.1:3001  max_fails=2  fail_timeout=10s;
    server 127.0.0.1:3003  max_fails=2  fail_timeout=10s;
    keepalive 64;
}
```

Round robin is nginx's **default** — there is no `round_robin;` directive. Listing servers
with no algorithm directive *is* round robin: 3000 → 3001 → 3003 → 3000 → …

`keepalive 64` reuses upstream TCP connections instead of a handshake per request. It only
works together with `proxy_http_version 1.1` and `proxy_set_header Connection ""` — a very
common silent misconfiguration.

Proof it is working: the response carries `X-Served-By`, and `C:\nginx\logs\lb-access.log`
records `upstream=` on every line.

## 6.2 Sessions across instances

The app uses **NextAuth v5 with `strategy: 'jwt'`**. The session lives in a signed cookie,
not in server memory, so all three instances can validate it from the shared `AUTH_SECRET`.
**Round robin does not log users out by itself** — that problem belongs to in-memory session
stores, which this app does not use.

What a stateless JWT genuinely cannot do, and what `src/lib/session-store.ts` adds:

1. **Revocation** — a JWT is valid until it expires (30 days here). "Log out everywhere" and
   "ban this user now" are impossible without a server-side record.
2. **Shared visibility** — "how many active sessions?" has three different wrong answers if
   held in memory.
3. **Shared counters** — three instances each limiting to 100 req means the real limit is 300.
   One counter in Redis keeps the limit honest.

### Why not sticky sessions

`ip_hash` would pin each client to one backend and also "solve" this. It is the worse answer:
it unbalances the pool, and when a backend dies every user pinned to it loses their session
anyway. Shared state keeps the pool evenly balanced **and** survives a backend dying.

## 6.3 Health checks and failover

```nginx
proxy_next_upstream        error timeout http_502 http_503 http_504 non_idempotent;
proxy_next_upstream_tries  3;
proxy_connect_timeout      2s;
```

**Open-source nginx has no active health checks.** The `health_check` directive is NGINX Plus
(commercial) only. Open source uses **passive** checks — it learns a backend is dead by
failing a real request to it.

When a backend dies:

1. Round robin routes a request to it.
2. The connection is refused; `proxy_connect_timeout 2s` caps the wait.
3. `proxy_next_upstream` retries that same request on a healthy backend.
   **The user gets a normal 200 and never sees the failure.**
4. After `max_fails=2`, the backend leaves the ring for `fail_timeout=10s`.
5. After 10s nginx sends one real request to test it. Dead → another 10s out.
   Alive → silently rejoins.

No restart, no config reload. The cost is roughly one probe request per 10s window.

`http://localhost:8080/lb-health` answers even when all three backends are down, which is how
you tell "load balancer down" from "backends down".

---

# 7. Test results

All measured on one Windows laptop with `autocannon` running on the same machine, so
absolute throughput is understated. Ratios between runs are valid because conditions were
identical.

## 7.1 Dev mode vs production — same endpoint, no database

`/api/health` returns a fixed JSON object. No DB, no Redis, no external calls.

| | `npm run dev` | `npx next start` | Factor |
|---|---|---|---|
| rps at c=1 | 8.2 | **477** | **58x** |
| p50 at c=1 | 78 ms | **1 ms** | **78x** |
| at c=50 | 49 errors, collapse | 331 rps, 0 errors | — |
| at c=100 | **100 errors, total failure** | 349 rps, 0 errors | — |

**Never benchmark `next dev`.** It saturates at ~8 rps and falls over at 50 connections.

## 7.2 Single production instance — concurrency sweep

`/api/health`, 10s per run, warmup discarded.

| -c | rps | p50 | p99 | max | errors |
|---|---|---|---|---|---|
| 1 | 477.4 | 1 ms | 7 ms | 62 ms | 0 |
| **10** | **872.9** ⬅ peak | 10 ms | 46 ms | 106 ms | 0 |
| 25 | 785.0 | 21 ms | 168 ms | 537 ms | 0 |
| 50 | 330.8 | 121 ms | 1346 ms | 1491 ms | 0 |
| 100 | 348.9 | 250 ms | 1053 ms | 1843 ms | 0 |
| 200 | 383.4 | 564 ms | 1134 ms | 1330 ms | 0 |

- **Service time S ≈ 1–2 ms**
- **λ_max = 873 rps** at concurrency 10
- **λ_safe ≈ 870 rps** (p99 still 46 ms)

Past c=25 throughput goes **down**, 873 → 331 rps. That is retrograde scaling — the
`βN(N−1)` term of the Universal Scalability Law. More load made it slower, not just no faster.

Little's Law holds throughout (`concurrency ≈ rps × p50`), confirming the measurements are
self-consistent: c=10 → `873 × 0.010 = 8.7 ≈ 10` ✓, c=200 → `383 × 0.564 = 216 ≈ 200` ✓.

## 7.3 Database-backed routes

`/api/dsa-stats` — direct Supabase query:

| -c | rps | p50 | p99 |
|---|---|---|---|
| 1 | 6.9 | 141 ms | 286 ms |
| 5 | 33.3 | 142 ms | 272 ms |
| 10 | 59.9 | 156 ms | 356 ms |
| 25 | **62.4** ⬅ ceiling | 398 ms | 637 ms |

`/api/patterns` — Upstash Redis cache + Supabase:

| -c | rps | p50 | p99 |
|---|---|---|---|
| 1 | 4.6 | 216 ms | 260 ms |
| 5 | 21.4 | 223 ms | 440 ms |
| 10 | 39.1 | 242 ms | 528 ms |
| 25 | **61.1** ⬅ ceiling | 375 ms | 899 ms |

## 7.4 Latency budget, measured by subtraction

| Layer | Cost at c=1 |
|---|---|
| Next.js + Node floor | **1 ms** |
| + Supabase query | **+140 ms** |
| + Upstash REST cache path | **+215 ms** |

**99.3% of response time is network wait to Mumbai. The application code costs ~1 ms.**

## 7.5 The app is I/O-bound, not CPU-bound

On `/api/dsa-stats`, c=1 → c=10 took throughput from 6.9 → 59.9 rps (**8.7x**) while p50 stayed
flat (141 → 156 ms). Flat latency with rising throughput is the signature of *waiting*, not
*working*.

**Consequence:** adding Node workers (PM2 cluster, more CPU) does nothing for these routes.
The Node layer does 873 rps; the DB path caps at 62 rps. Node was never the bottleneck.

## 7.6 Load balancer scaling — the headline result

| Setup | Throughput |
|---|---|
| 1 instance | 873 rps |
| **3 instances + nginx** | **~1,661 rps** |
| 3 instances if scaling were perfect | 2,619 rps |

**Measured speedup: 1.9x, not 3x.** The missing 37% went to the proxy hop and CPU contention —
all four processes share one laptop's cores.

> ⚠️ Do **not** claim "99% faster from load balancing". That figure comes from comparing a dev
> server to production. The production build gave ~290x; the load balancer gave ~1.9x.

## 7.7 Failover

A dead backend (`127.0.0.1:3999`) was added to the pool and nginx reloaded:

```
12 requests sent  →  12 returned HTTP 200  →  0 failures
```

nginx's log shows the mechanism:

```
[error] upstream timed out while connecting to upstream: "http://127.0.0.1:3999/api/health"
[warn]  upstream server temporarily disabled while connecting to upstream
```

A quarter of requests were routed to a dead server, silently retried on a healthy one, and the
dead backend was pulled from the ring. **The client never saw an error.**

## 7.8 Mixed backends — why uniformity matters

With one dev-mode server accidentally left in the pool:

| Target | rps | p50 | p99 |
|---|---|---|---|
| Through LB | 54.5 | 5 ms | **1391 ms** |
| Direct to :3001 (prod) | 196.0 | 35 ms | 331 ms |
| Direct to :3000 (dev) | **2.0** | 3425 ms | 8827 ms |

The load balancer was **3.6x slower than a single good backend**. Note p50 = 5 ms but
p99 = 1391 ms — a bimodal distribution. The median says healthy; one request in three crawls.

**A load balancer is only as good as its slowest backend.** Round robin assumes uniform servers.

## 7.9 Upstash Redis connectivity

```
host: sharp-kiwi-75802.upstash.io:6379 (TLS)
PING    -> PONG  (361 ms, includes TLS handshake)
SET+GET -> ok    (91 ms for both)
```

Steady state ≈ **45 ms per operation** over a persistent TCP connection — faster than the
216 ms of the REST client, but ~45x slower than local Redis would be.

---

# 8. File structure

```
load balancer/
├── nginx/conf/talentpath-lb.conf   the load balancer config (repo copy)
├── docker-compose.yml              optional local Redis on :6379
├── linkedin/                       write-up images and post text
├── README.md                       this file
└── talentpath-2/talentpath/
    └── src/
        ├── lib/session-store.ts            shared state across instances
        └── app/api/
            ├── health/route.ts             liveness probe + benchmark baseline
            └── whoami/route.ts             demonstrates all three behaviours

C:\nginx\                           the nginx PROGRAM (not in this repo)
├── nginx.exe
├── conf\talentpath-lb.conf         ← the copy nginx actually reads
├── logs\lb-access.log              every request, with the backend that served it
├── logs\lb-error.log               failover events
└── start-lb.bat / stop-lb.bat      double-click shortcuts
```

| File | Why it exists |
|---|---|
| `nginx/conf/talentpath-lb.conf` | kept in the repo so the config is version-controlled and reviewable |
| `docker-compose.yml` | Redis as a disposable container — no Windows install, no PATH edits |
| `src/lib/session-store.ts` | the only place that talks to Redis — one place to change keys, TTL or backing store |
| `src/app/api/health/route.ts` | touches nothing. A health check that queries the DB tells you the DB is up, not that the instance is |
| `src/app/api/whoami/route.ts` | one endpoint showing round robin, shared sessions and failover together |

**nginx is not part of the project.** It is a standalone program at `C:\nginx`, exactly like
Node lives at `C:\Program Files\nodejs`. The app never imports it and does not know it exists.

---

# 9. Useful commands

Check what is running:

```powershell
Get-Process nginx -ErrorAction SilentlyContinue
```

```powershell
3000,3001,3003 | ForEach-Object { "$_ : " + (curl.exe -s "http://localhost:$_/api/health") }
```

Is the load balancer itself up (answers even if all backends are dead):

```powershell
curl.exe -s http://localhost:8080/lb-health
```

Reload nginx after editing the config — no downtime, no restart:

```powershell
C:\nginx\nginx.exe -p C:/nginx -c C:/nginx/conf/talentpath-lb.conf -s reload
```

Watch which backend served each request:

```powershell
Get-Content C:\nginx\logs\lb-access.log -Tail 20 -Wait
```

Benchmark through the load balancer:

```powershell
npx autocannon -c 10 -d 15 -l --renderStatusCodes http://localhost:8080/api/health
```

Benchmark a single instance, for the fair comparison:

```powershell
npx autocannon -c 10 -d 15 -l --renderStatusCodes http://localhost:3001/api/health
```

Optional local Redis instead of Upstash (needs Docker Desktop running):

```powershell
cd "C:\Users\swamy\OneDrive\ドキュメント\swamy web dev\learning_system_design\load balancer"; docker compose up -d
```

---

# 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `'nginx' is not recognized` | nginx is not on PATH | use the full path `C:\nginx\nginx.exe`, or double-click `start-lb.bat` |
| `start nginx` shows the grey "Welcome to nginx!" page | it loaded the **default** `conf\nginx.conf` (port 80) | always pass `-c C:/nginx/conf/talentpath-lb.conf` |
| autocannon: thousands of errors, 0 bytes, 0 ms latency | **nginx is not running** — nothing is listening on 8080 | start nginx. 0 ms + 100% errors always means "nobody is listening" |
| `502 Bad Gateway` on every request | nginx is up but no backends are | start the three app servers first |
| `listen EADDRINUSE: :::3000` | something already owns that port (usually a dev server) | stop it, or check `netstat -ano \| Select-String ":3000.*LISTENING"` |
| `Could not find a production build in '.next'` | `LB_DIST_DIR` was not set | prefix the command with `$env:LB_DIST_DIR=".next-lb";` |
| Build fails with `EPERM ... .next\trace` | a `next dev` server holds `.next` locked | stop the dev server, or build with `LB_DIST_DIR=.next-lb` |
| `bind() to 0.0.0.0:8080 failed` | nginx is already running | stop it first with `-s stop` |
| Login succeeds, then you are logged out immediately | `useSecureCookies` on over plain HTTP | apply the `auth.ts` change in section 3.5 |
| Google sign-in: `redirect_uri_mismatch` | callback URL not registered for :8080 | add it in Google Cloud Console (section 3.6) |
| `[session-store] redis unavailable: ECONNREFUSED 127.0.0.1:6379` | pointing at local Redis that is not running | start Docker, or let it fall back to Upstash |
| nginx `-s stop` leaves processes behind | workers finishing shutdown | wait a second, or `Stop-Process -Name nginx -Force` |
| Hot reload does not work through :8080 | HMR needs WebSockets; the config sets `Connection ""` for keepalive, and round robin would split the socket from the page | develop against one server at `localhost:3000` directly; use the LB only for load-balancer testing |

---

# 11. Known limitations

- **nginx on Windows is slow.** It uses `select()` rather than epoll and runs limited workers.
  Treat throughput as relative to your own baseline, not as an absolute number.
- **The load generator shares the laptop** with the servers, so it competes for CPU. Real
  capacity is higher than measured.
- **Non-ASCII paths.** This project lives under `ドキュメント`; nginx on Windows handles that
  badly, which is why nginx and its config live at `C:\nginx`.
- **Port 3002 is unused.** The ports are 3000, 3001, 3003. They do not need to be contiguous,
  but the ports you start must match the `upstream` block exactly.
- **`non_idempotent` is enabled** in `proxy_next_upstream`, so POSTs are retried too. Fine for
  a lab; in production a retried POST can double-charge a card or create two records.
