# Stage 5C (Hostinger) — VPS production architecture and predeployment audit

**Status: AUDIT COMPLETE. Architecture qualified. No server change performed.**

_Stage 5C-Hostinger-R1 (2026-09-11): SSH key access was granted for the deployment
account, and the read-only audit below is now measured on the server rather than
inferred from outside._

The user has chosen to deploy CAD Fixer on their existing Hostinger VPS. This
document records that decision, everything the audit could establish, the
deployment architecture, and exactly what is still required.

`NO HOSTINGER PRODUCTION DEPLOYMENT PERFORMED. NO DNS CHANGE PERFORMED. NO VPS
CONFIGURATION OR SERVICE MUTATION PERFORMED.`

> **Operational identifiers are deliberately redacted.** This repository is
> **public**. The VPS address, its Hostinger hostname, the Linux account names
> and the SSH host key are recorded outside version control and were reported to
> the user directly. Publishing them beside this document's accurate statement
> that _SSH password authentication is enabled_ would hand a scanner a target
> and a valid user list. The engineering content is unaffected — every
> placeholder is substituted at deployment time.

## 1. Decision: Hostinger VPS supersedes Cloudflare

|                         |                                                     |
| ----------------------- | --------------------------------------------------- |
| Previous recommendation | Cloudflare Workers Static Assets (Stage 5C-1A-R1)   |
| **Current target**      | **Existing Hostinger VPS**                          |
| Reason                  | The user already owns and wishes to operate the VPS |

**Cloudflare was not defective and is not being rejected on merit.** It was
technically qualified and remains so; it is superseded by an explicit
infrastructure decision, which is the user's to make. The Cloudflare work lives
on `stage-5c1b1-cloudflare-preview`, is **not merged**, and must not be. No
Wrangler, `wrangler.jsonc`, `.assetsignore` or Cloudflare-specific test is
carried into this branch — this branch forks cleanly from
`main @ 2dbb6641b4d17a5d63cf00b053e563cb8b4f49da`.

Provider-neutral ideas from that work (a release manifest, source-map
exclusion, header contract tests) remain good and will be **reimplemented
cleanly** for this target rather than cherry-picked.

## 2. Target architecture

```
reviewed Git commit
  → npm ci → npm run build            (on the Mac, never on the VPS)
  → release artifact + SHA-256 manifest
  → rsync over SSH
  → /var/www/cad-fixer/releases/<SHA>/   (immutable)
  → atomic switch of `current` symlink
  → nginx static serving + HTTPS
  → COOP / COEP / CORP
  → Chromium; ALL geometry stays in the browser
```

No application backend, no server-side geometry, no database, no production
Node runtime, no model upload.

## 3. What the audit established

Measured read-only over SSH as the deployment account, plus unauthenticated
checks from outside. **Nothing was modified.**

| Property            | Finding                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| Host                | Hostinger VPS `srv<NNNNNN>`, `<VPS_IP>`, Phoenix US                              |
| OS                  | **Ubuntu 24.04.2 LTS (Noble)**, kernel `6.8.0-110-generic`, `x86_64`             |
| CPU                 | **4 cores**, AMD EPYC 7543P                                                      |
| Memory              | **15 GiB total**, 3.5 GiB used, ~12 GiB available                                |
| **Swap**            | **0 B — none configured**                                                        |
| Disk                | `/` 193 G, **67 G used, 126 G available (35 %)**                                 |
| Uptime / load       | 134 days, load **0.12 / 0.17 / 0.16** — essentially idle                         |
| Deployment account  | `<deploy-user>` (uid 1001), groups: `sudo`, `users`, **`docker`**                |
| Passwordless sudo   | **NOT available** (`sudo -n` → 1)                                                |
| Web server          | **nginx/1.24.0 (Ubuntu)**, worker user **`www-data`** (read from `nginx.conf:1`) |
| Certbot             | **2.9.0 installed, `certbot.timer` ACTIVE** (ran 6 h ago, next in 8 h)           |
| Unattended upgrades | **enabled and active**                                                           |
| fail2ban            | **not installed**                                                                |

All panel figures reconcile with the server: 4 CPU, 16 GB RAM (15 GiB usable),
200 GB disk (193 G usable), ~67 GB used. **No discrepancy.**

### 3.1 THE VPS IS SHARED — three enabled vhosts, two live products

`/etc/nginx/sites-enabled/` contains **three** symlinks, not two. The Debian
`default` site exists in `sites-available` but is **not enabled**.

| vhost           | `server_name`                    | Listens             | Backend                                 | State                                        |
| --------------- | -------------------------------- | ------------------- | --------------------------------------- | -------------------------------------------- |
| `<site-a>`      | `<site-a-domain>`, `www`         | 80 **only**         | `proxy_pass 127.0.0.1:8501` (Streamlit) | **live over HTTP; HTTPS BROKEN**             |
| `<legacy-site>` | `<legacy-domain>`, `www`         | 80 → 301, 443 ssl   | `proxy_pass localhost:8080`             | **dead — DNS gone, cert expired 2025-05-29** |
| `<site-b>`      | `<site-b-domain>`, `www`, `api.` | 443 ssl (+80 → 301) | `proxy_pass 127.0.0.1:3000` and `:8020` | **healthy, cert valid to 2026-11-10**        |

Every enabled vhost is a **reverse proxy**. **None serves static files**, and
none has a `root` under `/var/www`. CAD Fixer would be the first static site on
this server.

`<site-b>` runs as a **Docker Compose stack** — web, api, worker, scheduler,
`redis:7-alpine`, `postgres:16-alpine` — with only `127.0.0.1:3000` and
`127.0.0.1:8020` published to the loopback interface.

### 3.2 THE `default_server` HAZARD — the most important finding

**There is no `default_server` directive anywhere** in `nginx.conf`,
`conf.d/` or any enabled site.

When no server block is marked `default_server`, **nginx makes the FIRST block
loaded for a given `listen` socket the implicit default**, and
`include /etc/nginx/sites-enabled/*` loads in glob (alphabetical) order. So
today:

- **`:80` default → `<site-a>`** (sorts first) — which is why a request to the
  bare IP returns the Streamlit page.
- **`:443` default → `<legacy-site>`** (first block with `listen 443`) — which is
  why the bare IP presents the **expired** certificate, and why `<site-a>` over
  HTTPS also lands on that expired certificate, since `<site-a>` has no TLS
  block of its own.

**The consequence for CAD Fixer is concrete and easy to get wrong.**
`conf.d/*.conf` is included at `nginx.conf:59`, **before** `sites-enabled/*` at
line 60. So a CAD Fixer config placed in `conf.d/`, **or** named
`cad-fixer` in `sites-enabled` (which sorts before `<site-a>`), would
**silently become the implicit default for both `:80` and `:443`** and hijack
every IP-based and unmatched-`Host` request away from the existing site.

Two controls, both required:

1. **Name the site file so it sorts LAST** in `sites-enabled` — e.g.
   `zz-cad-fixer`. Never place it in `conf.d/`.
2. **Verify after install** with `sudo nginx -T` that the first block for each
   of `:80` and `:443` is unchanged, before reloading.

Marking the existing sites `default_server` explicitly would be the more robust
fix, but it **mutates another project's config** and is out of scope here.
Recorded as a recommendation for the owner.

### 3.3 Listeners and exposure

`ss -lntup` shows several services bound to `0.0.0.0`: `8010` (uvicorn),
`3010` (next-server), `8501` (Streamlit), `8080`, and **`631` (CUPS)**.

Measured from off-host, **only `22`, `80` and `443` are reachable**; `631`,
`3010`, `8010`, `8080`, `8501`, `5432` and `11434` are all filtered. So a
firewall **is** active and effective, even though the hPanel firewall shows
0 rules — the filtering is happening at the OS layer (`ufw`, whose rule set
needs sudo to read).

**This is worth stating plainly: those five services are protected by the
firewall, not by their bind address.** If the OS firewall were ever flushed,
five services — including a print daemon and an LLM runtime — would become
publicly reachable in that instant. Unrelated VPS debt, not a CAD Fixer
blocker, but the owner should know.

Correctly bound to loopback: PostgreSQL `5432`, Ollama `11434`, and the
`<site-b>` containers.

### 3.4 Filesystem

`/var/www/cad-fixer` **does not exist — the path is free.** `/var/www` is
`root:root drwxr-xr-x`, so the deployment account **cannot create it**; initial
setup needs one sudo step.

`/var/www` currently holds unreferenced legacy application source
(~840 MB across two directories) that **no enabled vhost points at**. It is not
touched. `/srv` is empty. Application code for the live sites lives under
`/home/<deploy-user>/apps/` (~2.5 GB).

With **126 GB free**, a CAD Fixer release at 2.45 MiB is 0.002 % of free space.

## 4. SSH access — RESOLVED

Key authentication now works for the deployment account:

```
$ ssh -o BatchMode=yes <deploy-user>@<VPS_IP> 'printf "CAD_FIXER_SSH_OK\n"'
CAD_FIXER_SSH_OK
```

`root` is **not** used for audit or deployment, and will not be.

**Passwordless sudo is not available** (`sudo -n` returns 1). That is not a
deployment blocker — it means the handful of privileged steps
(`mkdir /var/www/cad-fixer`, installing the site file, `nginx -t`, `reload`,
Certbot) are run by the user or with an interactive password, never automated.
Everything else — upload, hashing, symlink activation — is unprivileged once the
release root exists and is owned by the deployment account.

### 4.1 Root-only items still outstanding

These need `sudo` and were deliberately not run. Exact read-only bundle for the
user:

```bash
sudo ufw status verbose
sudo nginx -T | grep -nE 'server_name|listen|root|proxy_pass|default_server'
sudo certbot certificates
sudo systemctl status certbot.timer --no-pager
sudo sshd -T | grep -iE 'passwordauthentication|permitrootlogin'
sudo cat /etc/ssh/sshd_config.d/50-cloud-init.conf
```

None of it blocks planning; all of it should be captured before mutation.

## 5. Release directory layout

```
/var/www/cad-fixer/
  releases/
    2dbb6641b4d17a5d63cf00b053e563cb8b4f49da/    immutable
    <NEXT_SHA>/                                   immutable
  current -> releases/<ACTIVE_SHA>/
```

`/var/www` is the Debian/Ubuntu nginx convention and the server already runs
Ubuntu with stock nginx. **The final path must be confirmed against `nginx -T`**
once SSH exists, in case the host's existing sites establish a different
convention (`/srv`, `/home/<user>/...`); if so, CAD Fixer follows the host.

Directories are named by the **full Git SHA**, so what is serving is identifiable
without a lookup table. A release is never edited after activation: a change is
a new directory.

The server needs **no** repository, `node_modules`, build toolchain, Git
credentials or Node runtime. Only static bytes.

## 6. Build locally; never on the VPS

Frozen:

```
Mac, reviewed commit → npm ci → npm run build → manifest → upload static output
```

Explicitly **not** done on the VPS: `git clone` of the source, `npm install`,
Vite, `npm run dev`, a Node static server, or installing Node for CAD Fixer's
sake. Building on a shared production host would put a toolchain and a full
dependency tree next to other people's live services for no benefit — the
output is deterministic and Stage 5B proved it reproducible.

## 7. Release artifact and manifest

The deployable set is the 8 runtime files Stage 5B and 5C-1A already qualified:

| File                                   | Bytes     |
| -------------------------------------- | --------- |
| `assets/self-intersection-*.wasm`      | 1,272,716 |
| `assets/index-*.js`                    | 933,619   |
| `assets/geometry.worker-*.js`          | 143,004   |
| `assets/hole-fill.worker-*.js`         | 82,794    |
| `assets/export.worker-*.js`            | 65,348    |
| `assets/self-intersection.worker-*.js` | 50,939    |
| `assets/index-*.css`                   | 20,641    |
| `index.html`                           | 520       |

**8 files, 2,569,581 bytes (2.45 MiB).**

Excluded from the upload: source maps (5 files, 6,526,115 bytes — **71.7 %** of
the build directory), and everything that was never in `dist` anyway: `.git`,
`.env`, tests, fixtures, corpora, benchmarks, reports, `node_modules`,
documentation, source.

A manifest recording the deployed Git SHA, each relative path, size and SHA-256,
plus the kernel hash, is generated **outside** the uploaded directory and is
**not served**. It carries no absolute path, user name or host name.

### Source maps — recommendation unchanged

**Do not publish `.map` files.** This is a transfer decision, not a security
one: the repository is public and the build is reproducible, so a map for any
released commit can be regenerated locally. `sourcemap: true` stays set.

## 8. Transfer

`rsync` over SSH, into a **new** release directory:

```bash
rsync -a --delete \
  <LOCAL_RELEASE>/ \
  <USER>@<VPS_IP>:/var/www/cad-fixer/releases/<SHA>/
```

`--delete` is safe **only** because the destination is a fresh, CAD-Fixer-owned
directory named for one SHA. It must never be aimed at `current/`, at
`/var/www/`, or at any path another project shares. **Never rsync into
`current/`** — a release is assembled fully, verified, and only then activated.

## 9. Atomic activation — and why the obvious command is wrong

The naive `rm current && ln -s releases/<NEW> current` leaves a window with no
valid release, during which every request 404s. `ln -sfn` is also not reliably
atomic: on GNU coreutils, replacing an existing symlink can become
unlink-then-symlink, which has the same window.

The correct pattern creates the new link under a temporary name and **renames**
it over the old one. `mv -T` uses `rename(2)`, which is atomic within a
filesystem:

```bash
ln -s releases/<NEW_SHA> /var/www/cad-fixer/current.tmp
mv -Tf /var/www/cad-fixer/current.tmp /var/www/cad-fixer/current
```

At no instant does `current` fail to point at a complete release. To be proven
on the server (`mv --version` for GNU coreutils, and `-T` support) before it is
relied on.

nginx must resolve the symlink per request rather than caching the old inode.
With `root /var/www/cad-fixer/current;` nginx re-resolves the path on each
request, so no reload is needed for a release switch — **to be confirmed
empirically** by switching and re-fetching, not assumed. If open-file caching is
enabled anywhere in the existing config, it must be accounted for.

## 10. Rollback

Rollback is the same atomic switch, aimed backwards:

```bash
ln -s releases/<KNOWN_GOOD_SHA> /var/www/cad-fixer/current.tmp
mv -Tf /var/www/cad-fixer/current.tmp /var/www/cad-fixer/current
```

No rebuild, no re-upload, no Hostinger snapshot restore. **Application rollback
must never depend on a whole-VPS snapshot** — restoring the snapshot would also
roll back the other projects on this box, which is precisely the blast radius
to avoid.

At least the immediately previous qualified release is retained. Old releases
are pruned only after a newer one is qualified, and never during a rehearsal.

## 11. nginx configuration

Its own `server` block, static only: no `proxy_pass`, no PHP, no FastCGI, no
CGI, no `autoindex`, no SPA fallback (CAD Fixer has no router, so a missing
asset must be a clean 404 rather than an HTML shell served under a JavaScript
content type).

**Not `default_server`** — that belongs to whatever currently answers on :80.

### 11.1 The header-inheritance trap, and the design that avoids it

nginx's `add_header` directives are inherited from `server` into `location`
**only while that location defines no `add_header` of its own**. The moment a
location adds one — say `Cache-Control` for `/assets/` — **every inherited
header is dropped**, silently.

That failure mode is exactly severe enough to name: COOP and COEP would vanish
on `/assets/*`, the browser would withhold `SharedArrayBuffer`, and conservative
repair would fail closed — in production only.

The design is therefore a snippet included in **every** block that sets any
header:

```nginx
# /etc/nginx/snippets/cad-fixer-security-headers.conf
add_header Cross-Origin-Opener-Policy   "same-origin" always;
add_header Cross-Origin-Embedder-Policy "require-corp" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
add_header X-Content-Type-Options       "nosniff" always;
add_header Referrer-Policy              "no-referrer" always;
```

Installed as **`/etc/nginx/sites-available/zz-cad-fixer`**, symlinked into
`sites-enabled` under the same name so it loads LAST and cannot become the
implicit default for `:80` or `:443` — see §3.2. Never in `conf.d/`.

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name <CAD_FIXER_STAGING_HOST>;    # explicit; never default_server

    access_log /var/log/nginx/cad-fixer.access.log;
    error_log  /var/log/nginx/cad-fixer.error.log;

    root /var/www/cad-fixer/current;
    index index.html;

    include snippets/cad-fixer-security-headers.conf;

    location = /index.html {
        include snippets/cad-fixer-security-headers.conf;   # re-included: see above
        add_header Cache-Control "no-cache" always;
    }

    location /assets/ {
        include snippets/cad-fixer-security-headers.conf;   # re-included: see above
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    location / {
        try_files $uri =404;                 # no SPA fallback
    }
}
```

`always` makes the headers apply to error responses too, so a 404 is still
isolated.

**This design is not trusted until it is measured.** HV10–HV14 must pass
against `/`, against a hashed asset under `/assets/`, against the `.wasm`, and
against a 404 — four separate probes, because inheritance is per-location.

## 12. MIME

Verified against nginx's own source at tag `release-1.24.0` — the exact version
running on the VPS — `conf/mime.types` already contains:

```
application/javascript   js;
application/wasm         wasm;
```

So **no MIME change is expected**: `.wasm` should already be `application/wasm`
and `.js` a valid JavaScript type for module workers. **Confirmed on the server itself** — `/etc/nginx/mime.types:55` contains
`application/wasm wasm;` and line 8 contains `application/javascript js;`. The
Ubuntu package is unpatched, so **no MIME change is required**. It is still
proven on the wire by HV09 rather than trusted from the file.

If a mapping were ever missing, the addition is **narrow** — a `types { }` entry
alongside the existing include — never a replacement of the MIME configuration,
which would change types for every other site on the box.

## 13. Cache policy

`index.html` → `Cache-Control: no-cache` (revalidate; never `immutable`, or a
stale shell would reference hashed chunks that no longer exist).
`/assets/*` → `Cache-Control: public, max-age=31536000, immutable`, safe because
every name carries a content hash.

Both locations must still carry all five isolation headers — see §11.1.

## 14. HTTPS

**A hard release requirement.** `http://<VPS_IP>` cannot complete
qualification: cross-origin isolation and `SharedArrayBuffer` need a secure
context, and an IP address cannot hold a valid public certificate.

Planned method, subject to what the audit finds: **Let's Encrypt via Certbot**
with the nginx plugin, which is the normal Ubuntu 24.04 + nginx path. Before
installing anything, the audit must determine whether Certbot is **already
present** — an expired `<legacy-domain>` Let's Encrypt certificate is being
served, so certificate tooling has been configured on this host before.
**Do not install a second, competing ACME client.** Renewal must be automatic
and its timer verified, not assumed — this server is concrete evidence of what
unmonitored renewal looks like.

No certificate is requested in this stage.

## 15. Domain and DNS

**`DOMAIN OR STAGING SUBDOMAIN REQUIRED.`**

The repository documents no intended CAD Fixer domain — confirmed again here,
as Stage 5C-1A §14 found. And the one domain associated with this VPS,
`<legacy-domain>`, **no longer resolves at all**: no A record, no nameservers,
no MX. Its certificate expired on 2025-05-29, which is consistent with renewal
failing once DNS stopped resolving. **There is currently no working hostname
pointing at this VPS.**

So a hostname must be chosen and provided by the user. Preference: qualify on a
**dedicated staging subdomain first** (conceptually `preview.<domain>` or
`cad-preview.<domain>`), not the apex.

### DNS plan — nothing performed

```
A    <staging-hostname>   →  <VPS_IP>
```

An A record at the existing DNS provider is the documented way to point a
host at a Hostinger VPS; nameservers should **not** be moved merely to host this
app. IPv6/`AAAA` only if the VPS has a routable address and it is verified
separately.

**A subdomain is the safe unit of change.** Editing apex records risks
`MX`, `SPF`, `DKIM`, `DMARC` and provider verification records — breaking email
is a far worse failure than a deployment that has not happened yet. Before any
apex change, the full record set is inventoried first.

## 16. File ownership

Releases are owned by the **deploy user**, readable by the nginx worker, and
writable by nobody else:

```
/var/www/cad-fixer            <deploy>:<nginx-group>   755
/var/www/cad-fixer/releases   <deploy>:<nginx-group>   755
  files                       <deploy>:<nginx-group>   644
```

**Confirmed: the nginx worker user is `www-data`** (`/etc/nginx/nginx.conf:1`),
read from the running config rather than assumed. nginx needs **read** access only; it must never
be able to modify a release. **No `chmod -R 777`**, no world-writable path.

## 17. Deploy user

The existing SSH account is the starting point — **no Linux user is created in
this stage**. For a first MVP a normal SSH user with key auth and the ability to
write `/var/www/cad-fixer` is sufficient.

Given that this box hosts other projects, a **restricted deploy user owning only
`/var/www/cad-fixer`** is worth considering before public production, so a
CAD Fixer deployment mistake cannot reach another project's files. Recommended,
not required for staging, and **not to be done in a way that destabilises SSH**.

## 18. Privacy

Unchanged and unaffected by the host: **all geometry is processed in the
browser and never transmitted.** The VPS serves static bytes and receives no
model data, in any request body, ever.

nginx will keep ordinary access and error logs — URL, IP, user agent, status.
That is normal operational server logging and is **categorically different from
geometry transmission**; both facts belong in any future privacy statement.

**Nothing else is added**: no analytics, no session replay, no Sentry, no
application telemetry, no third-party script.

## 19. Server load

Negligible. Geometry runs in the browser; the VPS serves ~2.45 MiB of static
assets per cold visit and near zero for repeat visits, since hashed assets are
immutably cached. Disk cost is ~2.45 MiB per retained release. **No application
compute infrastructure is needed or to be installed.**

## 20. Security findings

**CAD Fixer release blockers: none.**

**Unrelated VPS security debt** — recorded for the owner, not fixed here:

- **SSH password authentication appears to be ENABLED, and root login is
  permitted.** `sshd_config:121` sets `PermitRootLogin yes`.
  `sshd_config.d/60-cloudimg-settings.conf` sets `PasswordAuthentication no`,
  but `50-cloud-init.conf` sorts first and sshd is first-match-wins; that file
  is root-only and its 27-byte length is exactly `PasswordAuthentication yes`.
  **The authoritative evidence is the server's own behaviour**: the SSH
  handshake advertises `publickey,password`. Confirm with `sudo sshd -T`.
- **fail2ban is not installed.** Combined with the above, an internet-facing
  port 22 accepts password attempts against `root` with no brute-force
  throttling. This is the most significant finding on the host.
- **The deployment account is in the `docker` group**, which is
  root-equivalent on this machine.
- **CUPS (`631`) binds `0.0.0.0`**, as do four other services; only the
  firewall prevents exposure (§3.3).
- **No swap is configured.** With 12 GiB available and an idle load this is not
  a present risk, and CAD Fixer adds no memory pressure.

**Healthy:** unattended-upgrades enabled and active; Certbot timer active and
demonstrably renewing the live certificate; database and container ports bound
to loopback.

## 21. Backup and snapshot — a required gate, not a claim

**Before the first server-mutating step**, a fresh Hostinger VPS snapshot must
exist in hPanel. Hostinger supports on-demand manual snapshots as a rollback
checkpoint, separately from automated backups.

Snapshot creation is an **hPanel action outside this environment**. It will not
be claimed as done unless the user confirms it. The next stage stops until then.

A snapshot is **not** application rollback (§10): restoring it would roll back
the other projects on this box too. In addition, every nginx file about to be
edited is copied first to a timestamped root-owned directory such as
`/root/cad-fixer-predeploy-backup/<timestamp>/`, with SHA-256 recorded, and the
only previous config is never overwritten in place.

## 22. Change procedure for nginx

```
back up the files to be touched   (timestamped, SHA-256 recorded)
  → write the new site config
  → sudo nginx -t                 ← FAIL: stop, do not reload
  → sudo systemctl reload nginx   ← PASS only; reload, never restart
```

`reload` keeps existing connections and does not interrupt the other sites;
`restart` would. If `nginx -t` fails, nothing is reloaded and the previous
config keeps serving.

## 23. HV01–HV40 — deployment qualification matrix

The Hostinger equivalent of PD01–PD40. Every item is an assertion the existing
suites already know how to make; §§HV10–HV16 are the promotion gate.

**Transport and TLS.** HV01 DNS resolves to `<VPS_IP>` · HV02 HTTP
redirects to HTTPS · HV03 certificate valid, correct host, not expired.

**Serving contract.** HV04 root HTML 200 · HV05 HTML type · HV06 JS type ·
HV07 CSS type · HV08 browser Web Worker JS type · HV09 `.wasm` is exactly
`application/wasm`.

**Isolation — the gate.** HV10 COOP · HV11 COEP · HV12 CORP · HV13 nosniff ·
HV14 no-referrer — **each checked on `/`, on `/assets/*`, on the `.wasm`, and on
a 404**, because nginx inheritance is per-location. HV15
`crossOriginIsolated === true` · HV16 `SharedArrayBuffer` available.

**Serving detail.** HV17 missing asset 404, never HTML · HV18 a real `.map` URL
404s · HV19 cold load · HV20 warm load with cache, isolation intact.

**Product flows.** HV21 STL · HV22 OBJ · HV23 3MF import · HV24 topology ·
HV25–HV27 repair preview, Apply, Undo · HV28–HV31 hole inventory, preview,
Apply, Undo · HV32 SI diagnostic · HV33–HV35 STL, OBJ, 3MF export · HV36
malformed import recovery.

**Privacy and identity.** HV37 Geogram WASM still lazy · HV38 **zero model
upload and no geometry in any request body** · HV39 remote asset SHA-256 equals
the local manifest for all 8 files · HV40 rollback rehearsal.

Failing isolation, MIME or privacy is **not** acceptable debt. It stops the
release.

## 24. Rollback rehearsal (HV40)

```
Release A active
  → upload B into releases/<B_SHA>/     (A untouched)
  → atomic switch to B
  → smoke B
  → atomic switch back to A
  → smoke A
  → atomic switch to B
  → smoke B
```

No rebuild and no re-upload at any point; the switch is the only operation.
No previous release is deleted until the rehearsal finishes.

## 25. Deployment tooling

A small dependency-free shell script, or documented commands, providing
`build → manifest → rsync → verify remote hashes → atomic activation`. **No
deployment framework.** Remote hash verification compares the server's bytes
against the local manifest before activation, so a truncated transfer cannot be
promoted. Nothing remote-mutating is implemented until explicitly authorized.

## 26. Monitoring

Recommended, not implemented: an external HTTPS uptime probe, a static asset
probe, and a **certificate-expiry alarm** — the expired certificate already on
this host is the argument for the last one. No geometry or user telemetry, ever.

## 27. No product code change

This stage changed no geometry, repair, hole-fill, self-intersection,
import/export, UI, resource-limit or worker code. Nothing about this hosting
target requires one.

## 28. Required before the next stage

1. **A fresh Hostinger snapshot**, created in hPanel and confirmed by the user.
   The panel shows a weekly schedule and 2 stored snapshots, which is **not**
   proof of a current pre-deployment checkpoint. Blocking.
2. **A staging hostname**, plus confirmation its DNS can be edited and at which
   provider. Blocking for HTTPS, and therefore for browser qualification.
3. **Approval of the nginx plan in §11**, specifically the `zz-` file-name
   control that keeps CAD Fixer from becoming the implicit `default_server`
   (§3.2).
4. **The sudo-only read-only bundle in §4.1**, run by the user, to capture the
   firewall rule set, the full `nginx -T`, the certificate inventory and the
   effective sshd policy.
5. **Acknowledgement of the security debt in §20** — particularly SSH password
   authentication with `PermitRootLogin yes` and no fail2ban. Not a CAD Fixer
   blocker, and the owner's decision.

## 29. Next stage

`Stage 5C-Hostinger-B1 — Controlled VPS Staging Deployment, HTTPS & Remote
Qualification.` Not started.
