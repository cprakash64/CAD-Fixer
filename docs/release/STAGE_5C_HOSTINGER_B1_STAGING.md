# Stage 5C-Hostinger-B1 — Controlled staging deployment and HV01–HV40 qualification

**Status: FULLY QUALIFIED.** CAD Fixer is deployed to the Hostinger VPS on a
dedicated staging hostname, over HTTPS, cross-origin isolated, byte-identical to
a reviewed commit, with rollback rehearsed and every pre-existing site unaffected.

`NO FINAL PUBLIC PRODUCTION PROMOTION PERFORMED.`

## 1. Identity

|                         |                                                           |
| ----------------------- | --------------------------------------------------------- |
| **Deployed source SHA** | `00fc4e25c23b94737bdab947487ccf82bcdaf7c3`                |
| **Staging hostname**    | `fixcad.thelunai.com`                                     |
| Stage branch            | `stage-5c-hostinger-vps`                                  |
| Canonical `main`        | `2dbb6641b4d17a5d63cf00b053e563cb8b4f49da` (unchanged)    |
| VPS                     | Hostinger `srv<NNNNNN>`, Ubuntu 24.04.2 LTS, nginx 1.24.0 |
| Predeploy snapshot      | **CONFIRMED — 2026-09-11 19:33** (user-created, hPanel)   |

The evidence commit recording this document is **necessarily a later commit than
the deployed source**, and the two are never conflated.

## 2. Pre-mutation state

DNS verified on three independent resolvers — system, `1.1.1.1`, `8.8.8.8` — all
returning the VPS IPv4 directly. **No Cloudflare proxy addresses**, so the origin
was qualified without an intermediary. CAA on the parent domain includes
`0 issue "letsencrypt.org"`.

Existing-site baseline, taken immediately before the first mutation:

| Target                | HTTP                   | HTTPS                                      |
| --------------------- | ---------------------- | ------------------------------------------ |
| site A                | 200                    | **000 — already broken before this stage** |
| site B                | 301                    | 200                                        |
| site B api            | 301                    | 404 (API root)                             |
| chat host             | 200                    | 200                                        |
| legacy host           | 000                    | 000 — DNS gone before this stage           |
| bare IP :80           | 200 → existing app     | —                                          |
| `fixcad.thelunai.com` | 200 → **existing app** | —                                          |

That last row is the point: before deployment the staging hostname fell through
to the implicit `:80` default, which is exactly what the audit predicted and what
the `zz-` filename exists to prevent CAD Fixer from becoming.

## 3. Release artifact

Built from the clean tracked tree at the deployed SHA, twice, producing an
identical manifest and identical file hashes.

**8 files, 2,569,581 bytes.** 5 source maps excluded (6,526,115 bytes). Kernel
SHA-256 `507ea5e7…3399fc3`, unchanged throughout.

Local gates before mutation: `verify` 2,158 tests / 98 files · e2e 172 + 2
skipped · timing 11 · harness 77 · `release:verify` 21/21 (HV-C01–HV-C20).

## 4. Mutations performed

Three privileged checkpoints, each run by the user; everything else unprivileged.

| Step              | Result                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Config backup     | `/root/cad-fixer-predeploy-backup/20260912T083104Z` — `nginx.conf`, `sites-available`, `sites-enabled`, `snippets` |
| Release root      | `/var/www/cad-fixer{,/releases}` — `<deploy-user>:www-data`, `0755`                                                |
| Immutable release | `/var/www/cad-fixer/releases/00fc4e25…af7c3`, created empty, verified                                              |
| Upload            | `rsync -a --delete` scoped to that SHA directory only                                                              |
| Modes             | dirs `0755`, files `0644`, **zero world-writable entries**                                                         |
| Activation        | `ln -s … current.tmp` + `mv -Tf current.tmp current`                                                               |
| nginx snippet     | `/etc/nginx/snippets/cad-fixer-security-headers.conf`                                                              |
| nginx site        | `/etc/nginx/sites-available/zz-cad-fixer` + `sites-enabled` symlink                                                |
| Certificate       | Let's Encrypt, `fixcad.thelunai.com` only, expires **2026-12-11**                                                  |

Nothing outside these paths was created, modified or deleted.

### 4.1 Remote hash proof — 8 / 8 exact, twice

Every uploaded file was compared against the manifest **before** activation, and
every file was then fetched back **over HTTPS** and compared again. Both passed
8/8 with no extra remote files.

| SHA-256 (first 16)  | File                                   |
| ------------------- | -------------------------------------- |
| `906a857b61cd7f4c…` | `assets/export.worker-*.js`            |
| `1da8c6c6b48c34e6…` | `assets/geometry.worker-*.js`          |
| `485e301eb303228d…` | `assets/hole-fill.worker-*.js`         |
| `cbe28d6b60470983…` | `assets/index-*.css`                   |
| `b3b96f54d0e00fa0…` | `assets/index-*.js`                    |
| `507ea5e7c9110781…` | `assets/self-intersection-*.wasm`      |
| `7e3873981ada98d5…` | `assets/self-intersection.worker-*.js` |
| `7574edde4d1877c6…` | `index.html`                           |

The WASM hash equals the qualified Geogram kernel exactly, so the deployed
kernel is provably the one Stage 3C-1B qualified.

## 5. A pre-existing condition found during deployment

`systemctl reload nginx` **failed**: `nginx.service is not active, cannot reload`.

nginx has been running since **2026-07-25** as a **manually started master**
(`nginx -c /etc/nginx/nginx.conf`, PPID 1) while the systemd unit sits `failed`
and `disabled`. Nothing in this deployment caused it.

The reload was therefore performed with `nginx -s reload`, which reads
`/run/nginx.pid` and sends the master `SIGHUP` — precisely what a systemd reload
does internally. It is graceful: **the master PID was identical before and after
(2722132)** and only the workers were replaced. No restart, no dropped
connections, and every existing site stayed up throughout.

**The systemd unit was deliberately not touched.** `systemctl start nginx` would
try to bind ports 80 and 443 that the live master already holds, fail, and could
leave three live sites worse off. That is unrelated debt for its own task —
with one consequence worth stating plainly:

> **nginx will not restart automatically after a reboot.** The unit is
> `disabled` and `failed`. This affects the pre-existing sites more than it
> affects CAD Fixer, and should be reconciled deliberately, not inside a
> deployment.

## 6. HV01–HV18

| ID   | Gate                                  | Result                                                                                   |
| ---- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| HV01 | DNS → VPS, three resolvers            | **PASS**                                                                                 |
| HV02 | HTTP → HTTPS                          | **PASS** — 301 to `https://fixcad.thelunai.com/`                                         |
| HV03 | TLS valid                             | **PASS** — Let's Encrypt, CN matches, valid to 2026-12-11, `curl` validated without `-k` |
| HV04 | Root 200                              | **PASS**                                                                                 |
| HV05 | HTML type                             | **PASS** — `text/html`                                                                   |
| HV06 | JS type                               | **PASS** — `application/javascript`                                                      |
| HV07 | CSS type                              | **PASS** — `text/css`                                                                    |
| HV08 | Browser worker JS type                | **PASS** — `application/javascript`                                                      |
| HV09 | WASM type                             | **PASS** — **`application/wasm`**                                                        |
| HV10 | COOP                                  | **PASS** — `same-origin`                                                                 |
| HV11 | COEP                                  | **PASS** — `require-corp`                                                                |
| HV12 | CORP                                  | **PASS** — `same-origin`                                                                 |
| HV13 | nosniff                               | **PASS**                                                                                 |
| HV14 | Referrer-Policy                       | **PASS** — `no-referrer`                                                                 |
| HV15 | `crossOriginIsolated === true`        | **PASS** (real Chromium)                                                                 |
| HV16 | `SharedArrayBuffer` + `Atomics`       | **PASS** (real Chromium)                                                                 |
| HV17 | Missing asset → 404, never HTML shell | **PASS**                                                                                 |
| HV18 | Source map → 404                      | **PASS**                                                                                 |

### 6.1 Header inheritance — the gate that justified the design

All five headers were verified at **seven** resources, not just `/`:

`/` · hashed JS · hashed CSS · **`.wasm`** · browser worker JS · **404 probe** ·
**`.map` probe**

All five present at every one, first at the HTTP origin **before** Certbot ran —
isolating nginx correctness from TLS configuration — and again over HTTPS
afterwards.

The two 404 rows are the ones that prove the most: they show `always` is doing
its job, so an error response is as isolated as a success. And the `/assets/`
rows prove the snippet re-include worked: without it, adding `Cache-Control`
there would have silently dropped COOP and COEP from every asset, withheld
`SharedArrayBuffer`, and failed conservative repair closed in production only.

### 6.2 Cache

`/` → `Cache-Control: no-cache`, never `immutable`.
`/assets/*` → `public, max-age=31536000, immutable`, **with all five security
headers retained**.

## 7. Isolation from the existing sites

**Zero regression**, measured three times: immediately after the failed reload,
immediately after the successful reload, and at the end of the stage.

| Target       | Baseline     | Final            | Verdict   |
| ------------ | ------------ | ---------------- | --------- |
| site A       | 200 / 000    | 200 / 000        | unchanged |
| site B       | 301 / 200    | 301 / 200        | unchanged |
| site B api   | 301 / 404    | 301 / 404        | unchanged |
| chat host    | 200 / 200    | 200 / 200        | unchanged |
| bare IP :80  | existing app | **existing app** | unchanged |
| bare IP :443 | legacy cert  | **legacy cert**  | unchanged |

**CAD Fixer became neither implicit default.** The bare IP still serves the
pre-existing application on `:80` and still presents the legacy certificate on
`:443`. The `zz-` load-order control worked exactly as designed, and
`nginx -T` confirmed no `default_server` directive was introduced — the only
matches in the dump were CAD Fixer's own explanatory comments.

Certbot modified **only** `zz-cad-fixer`, adding `listen 443 ssl`, the
certificate paths, and a redirect server block scoped by
`if ($host = fixcad.thelunai.com)`. Every existing certificate was left alone,
including the expired legacy one, which remains expired by design.

## 8. HV19–HV39 — product qualification against the deployment

The repository's own end-to-end specs were re-pointed at the live origin.

**167 of 172 passed directly. The 5 that did not were an origin assumption, not
a defect**, and this was proven rather than asserted.

Those five are the network-privacy specs, and they hardcode
`http://localhost:4173` as "our own origin". Against a deployed origin that
predicate classifies **CAD Fixer's own assets** as external. The failure output
made it unambiguous — the four "external" URLs were
`https://fixcad.thelunai.com/`, its JS, its CSS and its geometry worker.

Two independent confirmations were then produced:

1. **The same five specs re-run verbatim with one substitution** — the hardcoded
   origin replaced by the real one, no assertion relaxed, nothing else altered:
   **80 / 80 passed**, including every previously failing test.
2. **An origin-correct privacy test** asserting the stronger property directly
   (below).

Notably, `no request ever carries a model payload, even to our own origin` —
the test that actually inspects methods and request bodies, and is therefore
origin-independent — **passed on the deployment in the original run**.

Covered by those runs: STL, OBJ and 3MF import · topology · conservative repair
preview, Apply and Undo · opening inventory, planar fill preview, Apply and Undo
· self-intersection diagnostic · STL, OBJ and 3MF export · malformed-import
recovery · cold and warm load.

### 8.1 HV37 / HV38 — privacy, measured

Over a representative flow (load → STL import → export) on the live origin:

```
TOTAL_REQUESTS: 6      all GET, all https://fixcad.thelunai.com
OFF_ORIGIN:     []
WITH_BODIES:    []     no request body, no non-GET method
WASM_AT_STARTUP:[]     kernel not fetched merely by opening the page
```

**No geometry upload, no analytics, no telemetry, no WebSocket, no third-party
request of any kind.** The Geogram WASM was fetched only later in the flow,
confirming it stays lazy.

### 8.2 Server-log privacy

1,585 lines in `cad-fixer.access.log`: **1,584 GET, zero POST or PUT.** Exactly
one query string appears, and it is the documented `repairMemoryCeilingMiB` test
option — not geometry. Every path is an application asset, the ACME challenge,
a favicon, or the deliberate 404 probes.

## 9. HV40 — rollback rehearsal

Two hash-identical copies of the qualified artifact were created on the server;
all three directories produced the same aggregate digest
(`19629da3f48fb724…`), so the rehearsal tests **release-pointer mechanics** and
introduces no unreviewed product build.

```
A → B → A → B → canonical
```

Each switch used the identical atomic procedure (`ln -s … current.tmp` +
`mv -Tf`). At every state the symlink target, a 200 response, COOP, COEP and the
application shell were verified. **All five states passed.**

**No nginx reload, no rebuild, no re-upload and no snapshot restore at any
point** — the symlink switch alone changed what was served, which is the whole
claim the atomic-activation design makes.

Final state: `current -> releases/00fc4e25c23b94737bdab947487ccf82bcdaf7c3`,
`current.tmp` absent, no rollback suffix active. The rollback copies are
retained deliberately.

## 10. Final server state

nginx master `2722132` unchanged since before the deployment · `nginx -t` PASS ·
`certbot.timer` **active** · CAD Fixer certificate valid 89 days · all
pre-existing certificates untouched · canonical release active.

## 11. Accepted limitations

- **The staging hostname is internet-reachable.** It is not access-controlled,
  and is a Technical Preview qualification endpoint rather than a launch.
- **`nginx.service` remains `failed`/`disabled`** — pre-existing, deliberately
  untouched, and it means nginx will not come back on its own after a reboot.
- **SSH password authentication and `PermitRootLogin yes` remain**, with no
  fail2ban. Pre-existing debt, explicitly out of scope for this stage.
- **The legacy expired certificate remains expired**, and one existing site
  still has no working HTTPS. Both predate CAD Fixer and were left alone.
- Source maps are not published; they remain reproducible from the commit.

## 12. Production-promotion eligibility

**ELIGIBLE.** Every hard gate passed: exact artifact deployed and byte-verified
twice, HTTPS valid, COOP/COEP/CORP correct at every resource including 404s,
`crossOriginIsolated` and `SharedArrayBuffer` confirmed in a real browser, full
product flow qualified, privacy proven, rollback rehearsed, and no existing site
affected.

What remains is a decision, not a defect: the final public hostname and the
launch positioning.
