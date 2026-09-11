# Stage 5C (Hostinger) — VPS production architecture and predeployment audit

**Status: PARTIAL. Architecture qualified; on-server audit BLOCKED on SSH access.**

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

Everything below was obtained **without logging in** — reverse DNS, an SSH
protocol banner, and unauthenticated HTTP/TLS against the user's own server.
Nothing was modified.

| Property                  | Finding                                                                                                         | How                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| VPS address               | `<VPS_IP>`                                                                                                      | shell history + `known_hosts`    |
| Reverse DNS               | **`srv<NNNNNN>.hstgr.cloud`** — confirms a Hostinger VPS                                                        | PTR lookup                       |
| OS                        | **Ubuntu** — `OpenSSH_9.6p1 Ubuntu-3ubuntu13.19` and `nginx/1.24.0 (Ubuntu)` both indicate **Ubuntu 24.04 LTS** | SSH banner, HTTP `Server` header |
| SSH                       | OpenSSH 9.6p1, port 22 open, offers `publickey,password`                                                        | SSH handshake                    |
| Host key                  | `ssh-ed25519 <recorded outside the repository>`                                                                 | SSH handshake                    |
| Web server                | **nginx/1.24.0 (Ubuntu) already installed and serving**                                                         | HTTP `Server` header             |
| Ports 22 / 80 / 443       | **all OPEN from the public internet**                                                                           | TCP connect                      |
| Existing site on `:80`    | a **Streamlit** application (`<title>Streamlit</title>`), `Cache-Control: no-cache`, last modified 2025-02-27   | HTTP GET                         |
| TLS on `:443`             | Let's Encrypt certificate `CN=<legacy-domain>` (+`www`), **EXPIRED 2025-05-29**                                 | `openssl s_client`               |
| `<legacy-domain>`         | **does not resolve at all** — no A, no NS, no MX                                                                | DNS                              |
| Known Linux users         | `<deploy-user>`, `root`                                                                                         | shell history                    |
| Other projects on the box | several unrelated application directories under `/home/<deploy-user>/apps/`                                     | shell history                    |

### 3.1 THE VPS IS NOT DEDICATED TO CAD FIXER — the hard safety gate

This is the most important finding in this document.

The server **already runs other work**: a live Streamlit application answering
on port 80, an nginx vhost carrying a `<legacy-domain>` certificate, and
several Luna AI project directories under `/home/<deploy-user>/apps/`. At least one of
those is serving the public internet right now.

Consequences, and none of them are optional:

- **Any nginx change can break a running site.** A new `server` block, a
  changed `default_server`, or a careless reload affects everything nginx
  serves. Every future change is preceded by a config backup, `nginx -t`, and
  `reload` (never `restart`).
- **CAD Fixer must not become the catch-all.** It gets its own `server` block
  matched by `server_name`. It must NOT be marked `default_server`, or it would
  capture traffic currently going to the Streamlit app.
- **Nothing belonging to another project is to be stopped, moved, reconfigured
  or deleted** — not to tidy up, not to free a port, not to standardise.
- **The expired certificate is somebody else's vhost.** It is a finding, not a
  thing to fix under this task.

### 3.2 Firewall — already permissive, at both layers

Ports 22, 80 and 443 all accept connections from outside. Hostinger maintains
a **managed VPS firewall in hPanel that is separate from the OS firewall**, and
an OS-level `ufw status` alone would not have proved inbound traffic works.
Reachability from off-host proves **both layers already allow** 80 and 443, so
**no firewall change is expected** for this deployment. The OS firewall's own
rule set still needs `ufw status verbose` once SSH access exists, for the record.

### 3.3 What the audit could NOT establish

Blocked on SSH, all of it read-only and required before any mutation:

RAM · swap · disk capacity and free space · CPU count · load and uptime ·
full running-service list · Docker containers · `nginx -T` vhost inventory and
roots · `ufw status verbose` · Certbot presence, certificates and renewal timer
· `authorized_keys` · SSH root-login and password-auth policy as configured ·
`fail2ban` · unattended-upgrades · the nginx worker user · whether
`/etc/nginx/mime.types` is stock · existing backup/snapshot evidence.

## 4. SSH access — the blocker

A read-only `BatchMode` connectivity test was run against both known users:

```
<deploy-user>@<VPS_IP>: Permission denied (publickey,password).
root@<VPS_IP>: Permission denied (publickey,password).
```

The TCP connection and SSH handshake **succeed**, so the server is reachable and
healthy. What fails is authentication: this Mac's only key,
`~/.ssh/id_ed25519` , is
offered and **rejected** for both users, `ssh-agent` holds no identities, and
`~/.ssh/config` has no Hostinger alias (its single `akida-cloud` entry is an
unrelated host). The shell history shows past sessions, so the user has been
authenticating **interactively with a password**.

Per the stage rules this is a full stop: no brute force, no credential
prompting, and no request for a password or private key in chat.

**Remediation — the user runs this in their own terminal**, where the password
prompt is answered locally and never enters this conversation:

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub <deploy-user>@<VPS_IP>
```

Then confirm key-only access works:

```bash
ssh -o BatchMode=yes <deploy-user>@<VPS_IP> 'echo OK'
```

If that account is not the right deployment account, substitute it. Whether a
dedicated deploy user is warranted is §12.

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

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name <STAGING_HOSTNAME>;          # never default_server

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
and `.js` a valid JavaScript type for module workers. Two caveats: confirm the
Ubuntu package has not patched `mime.types` (`grep wasm /etc/nginx/mime.types`),
and prove it on the wire (HV09) rather than from the file.

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

The nginx worker user must be read from the running config (Ubuntu stock is
`www-data`) rather than assumed. nginx needs **read** access only; it must never
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

**Release blockers — none identified so far**, but the audit is incomplete.

**Findings to note, not to fix under this task:**

- **SSH password authentication is enabled** (the server offers
  `publickey,password`). Once key access works, disabling password auth is
  ordinary hardening — but it touches a shared box and belongs to its own
  change, not to a CAD Fixer deployment.
- **An expired TLS certificate is being served** on :443 for a domain that no
  longer resolves. Another project's vhost; evidence that certificate renewal
  is unmonitored here, which matters because CAD Fixer will depend on renewal.
- Root login policy, `fail2ban`, unattended-upgrades and exposed database
  listeners are **unknown** pending SSH.

Unrelated VPS debt is recorded as debt. CAD Fixer does not refactor another
project's server posture.

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

1. **SSH key access** — `ssh-copy-id` as in §4. Blocking.
2. **Hostinger snapshot** created in hPanel and confirmed by the user. Blocking.
3. **A staging hostname** chosen and provided. Blocking for HTTPS.
4. **Confirmation that its DNS can be edited**, and at which provider.
5. **Approval of the nginx change plan** in §11, given the box is shared.

## 29. Next stage

`Stage 5C-Hostinger-B1 — Controlled VPS Staging Deployment, HTTPS & Remote
Qualification.` Not started.
