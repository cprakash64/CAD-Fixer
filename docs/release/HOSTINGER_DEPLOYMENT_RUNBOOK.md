# CAD Fixer — Hostinger VPS deployment runbook

Operator steps for deploying a reviewed commit to the VPS. Provider-neutral and
sanitized: substitute the placeholders from your own records.

```
<SSH_TARGET>               deployment account and host
<CAD_FIXER_STAGING_HOST>   the staging hostname
<DEPLOYMENT_SOURCE_SHA>    the exact commit being deployed
```

**The server is shared.** It already serves other live sites. Every step below
is scoped to CAD Fixer's own paths, and nothing touches another vhost.

## 0. Preconditions — all blocking

- A **fresh** Hostinger snapshot, created in hPanel immediately beforehand. The
  weekly backup is not a checkpoint for this change.
- `<CAD_FIXER_STAGING_HOST>` chosen, with an `A` record resolving to the VPS.
- SSH key authentication working for `<SSH_TARGET>`.
- A clean tracked tree at `<DEPLOYMENT_SOURCE_SHA>`.

## 1. Build the artifact locally

Never on the server: it needs no repository, Node, `node_modules` or toolchain.

```bash
npm ci
npm run build
npm run release:build      # refuses a dirty tracked tree
npm run release:verify     # HV-C01–HV-C20
```

The order matters: `release:verify` checks the manifest against current `HEAD`,
so always **commit first, then build, then verify**.

To re-run the product suite against a deployed origin rather than the local
preview server:

```bash
CAD_FIXER_E2E_BASE_URL=https://<host> npm run test:e2e
```

With the variable unset everything runs locally exactly as before.

Produces `artifacts/release/site/` (deployable) and
`artifacts/release/release-manifest.json` (describes it, never uploaded).

## 2. Record the pre-change baseline

Capture the status of every existing site **before** touching nginx, so a later
comparison means something.

## 3. Back up the server configuration

```bash
ssh <SSH_TARGET>
TS=$(date -u +%Y%m%dT%H%M%SZ)
sudo mkdir -p /root/cad-fixer-predeploy-backup/$TS
sudo cp -a /etc/nginx/nginx.conf /etc/nginx/sites-available \
           /etc/nginx/sites-enabled /etc/nginx/snippets \
           /root/cad-fixer-predeploy-backup/$TS/
```

Never overwrite an earlier backup. Do not copy private key material off the
server.

## 4. Create the release root — once

```bash
sudo mkdir -p /var/www/cad-fixer/releases
sudo chown <deploy-user>:www-data /var/www/cad-fixer /var/www/cad-fixer/releases
sudo chmod 755 /var/www/cad-fixer /var/www/cad-fixer/releases
```

nginx needs **read** access only and must never be able to modify a release.
No world-writable path, ever.

## 5. Upload an immutable release

Into a **new** directory named for the commit — never into `current/`, never
into `/var/www/`, never into another site's tree.

```bash
mkdir -p /var/www/cad-fixer/releases/<DEPLOYMENT_SOURCE_SHA>   # on the server

rsync -a --delete \
  artifacts/release/site/ \
  <SSH_TARGET>:/var/www/cad-fixer/releases/<DEPLOYMENT_SOURCE_SHA>/
```

`--delete` is safe **only** because the destination is a fresh, CAD-Fixer-owned
directory for one SHA.

## 6. Verify remote bytes before activating

```bash
ssh <SSH_TARGET> \
  'cd /var/www/cad-fixer/releases/<DEPLOYMENT_SOURCE_SHA> && \
   find . -type f -exec sha256sum {} + | sed "s|\./||" | sort -k2'
```

Compare every hash against `release-manifest.json`. **Any mismatch stops the
deployment** — do not activate.

## 7. Activate atomically

```bash
cd /var/www/cad-fixer
ln -s "releases/<DEPLOYMENT_SOURCE_SHA>" current.tmp
mv -Tf current.tmp current
readlink -f current
```

`mv -T` is a `rename(2)`, which is atomic within a filesystem. **Never
`rm current` first** — that leaves a window in which every request 404s, and
`ln -sfn` is not reliably atomic either. If `current.tmp` already exists,
investigate before doing anything: something previously failed part-way.

## 8. Install the nginx site

```bash
sudo cp deploy/nginx/cad-fixer-security-headers.conf \
        /etc/nginx/snippets/cad-fixer-security-headers.conf

# render <CAD_FIXER_STAGING_HOST> first
sudo cp zz-cad-fixer /etc/nginx/sites-available/zz-cad-fixer
sudo ln -s /etc/nginx/sites-available/zz-cad-fixer \
           /etc/nginx/sites-enabled/zz-cad-fixer
```

**The `zz-` prefix is load-bearing.** The server declares no `default_server`,
so nginx makes the first block loaded per listen socket the default, and
`sites-enabled/*` loads in glob order. A file named `cad-fixer` would sort
before the existing sites and capture the bare IP. Never use `conf.d/`, which
loads earlier still.

## 9. Validate, then reload

```bash
sudo nginx -t                 # FAIL: remove the new files, restore, stop
sudo nginx -T | grep -nE 'server_name|listen|default_server'
sudo systemctl reload nginx   # only after -t passes; reload, never restart
```

> **`systemctl reload nginx` is correct as of 2026-09-12.** Earlier in this
> stage nginx ran from a manually started master while the unit was `disabled`
> and `failed`, so systemd could not signal it and `nginx -s reload` was the
> required workaround. The unit has since been enabled and a controlled reboot
> handed ownership to systemd — `is-active: active`, with the master launched by
> the unit's own `ExecStart`. If `systemctl reload` ever reports the unit is
> inactive again, something has restarted nginx outside systemd; diagnose that
> rather than falling back to `nginx -s reload` permanently.

Confirm from `nginx -T` that the first block for `:80` and `:443` is unchanged.
Then re-check every existing site against the step-2 baseline. **Any regression
→ remove the CAD Fixer config, `nginx -t`, reload, and stop.**

## 10. HTTPS

Reuse the server's existing Certbot. Do not install a second ACME client, and
do not combine other domains into the certificate.

```bash
sudo certbot --nginx -d <CAD_FIXER_STAGING_HOST>
sudo nginx -t
```

If Certbot offers to modify an unrelated server block, decline and stop.

## 11. Qualify

Run HV01–HV40. HV10–HV16 are the promotion gate. Check the five security
headers at **four** locations — `/`, a hashed asset, the `.wasm`, and a 404 —
because nginx inheritance is per-location and a single probe at `/` proves
nothing about `/assets/`.

## 12. Rollback

The same atomic switch, aimed at the previous qualified release:

```bash
cd /var/www/cad-fixer
ln -s "releases/<PREVIOUS_SHA>" current.tmp
mv -Tf current.tmp current
```

No rebuild, no upload, no nginx reload, and **no Hostinger snapshot restore** —
the snapshot is disaster recovery for the whole shared machine and would roll
back the other sites too. Keep at least the previous qualified release; prune
only after a newer one is qualified.
