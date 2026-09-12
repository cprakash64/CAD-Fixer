# Post-release VPS SSH hardening

Applied after the **v0.1.0 Technical Preview** release, on the shared VPS that
serves CAD Fixer alongside several unrelated sites.

**Scope: SSH access and brute-force protection only.** This is not a claim that
the machine is fully hardened — remaining debt is listed at the end.

`NO CAD FIXER REDEPLOYMENT PERFORMED.` The released artifact is untouched.

## 1. Starting state

|                      |                                     |
| -------------------- | ----------------------------------- |
| Public-key SSH       | enabled, and already in daily use   |
| **Password SSH**     | **enabled**                         |
| **Direct root SSH**  | **enabled** (`PermitRootLogin yes`) |
| Keyboard-interactive | already disabled                    |
| **fail2ban**         | **not installed**                   |
| Port 22              | reachable from the internet         |

Password authentication plus root login plus no brute-force throttling, on an
internet-facing port 22, was the most significant finding of the deployment
audits.

## 2. Recovery protection, established first

Two independent safeguards were required **before** touching SSH config, because
the failure mode here is locking the administrator out of a machine running
several live sites:

- **Out-of-band console confirmed.** The provider's browser/VNC console was
  opened and verified to give a working root shell independently of SSH. A
  snapshot alone was explicitly rejected as insufficient — restoring one to undo
  an SSH mistake would roll back unrelated production sites.
- **Configuration backup retained** under a timestamped root-owned directory,
  holding the pre-change `sshd_config` and the whole `sshd_config.d/`. It is kept
  through the observation period and its contents are not copied into this
  repository.
- **Two independent SSH sessions held open** throughout, and a **third, fresh**
  connection proved working before either was closed.

## 3. The precedence trap — why the obvious fix would have failed silently

OpenSSH takes the **first obtained value** for a global keyword. The main config
begins with `Include /etc/ssh/sshd_config.d/*.conf`, and that directory held:

```
50-cloud-init.conf         PasswordAuthentication yes   ← WON
60-cloudimg-settings.conf  PasswordAuthentication no    ← ignored
```

The cloud image ships a file disabling password authentication, and cloud-init
writes an earlier-sorting file re-enabling it. **The later file never took
effect.**

The conventional remedy — dropping a `99-hardening.conf` at the end — would have
been **completely ineffective here, while looking correct in review.**
`sshd -T` would still have reported `passwordauthentication yes`, and the server
would have been believed hardened when nothing had changed.

The fix is therefore a file that sorts **first**:

```
/etc/ssh/sshd_config.d/00-cad-fixer-hardening.conf   ← parsed first
50-cloud-init.conf
60-cloudimg-settings.conf
```

Both provider-managed files were left **byte-for-byte untouched**, so the
hardening does not fight cloud-init and cannot be silently reverted by it
rewriting its own file.

### Installed file

```
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
```

Root-owned, `0644`. Deliberately minimal: **no** change to `UsePAM`, the port,
`AllowUsers`/`AllowGroups`, ciphers, MACs, KEX algorithms, forwarding or
`AuthenticationMethods`. Over-hardening an unaudited multi-tenant server is its
own outage risk.

## 4. Final effective state

Confirmed by `sshd -T` after reload — the server's own resolved view, not the
file contents:

```
pubkeyauthentication          yes
passwordauthentication        no
kbdinteractiveauthentication  no
permitrootlogin               no
usepam                        yes
```

`sshd -t` passed both before and after. The change was applied with
`systemctl reload ssh`; **nothing was restarted or stopped**, and no reboot was
performed.

### `UsePAM yes` is retained deliberately

PAM still governs account and session handling and the local `sudo` path. **The
Linux account password still exists and still works for `sudo`.** Only its use
as an _SSH authentication mechanism_ was removed. Removing the account password
would have broken administration for no security gain.

## 5. Proofs

| Check                                             | Result                                         |
| ------------------------------------------------- | ---------------------------------------------- |
| Fresh key-only login, password fallback forbidden | **PASS**                                       |
| Fresh ordinary interactive session                | **PASS** — correct account                     |
| `sudo` after key login                            | **PASS** — local password, as designed         |
| Forced password-only SSH                          | **REJECTED** — `Permission denied (publickey)` |
| Direct root SSH                                   | **REJECTED** — `Permission denied (publickey)` |
| Key login again after fail2ban activation         | **PASS**                                       |

Both negative results were **authentication rejections, not transport failures**
— a distinction §8 below treats as load-bearing.

Root privileges remain fully available through the ordinary account plus `sudo`.

## 6. Brute-force protection

**fail2ban 1.0.2**, installed from the distribution's own packages. No
distribution upgrade, kernel upgrade, `autoremove` or reboot was performed.

Local jail at `/etc/fail2ban/jail.d/sshd.local`, leaving packaged defaults
untouched:

```ini
[sshd]
enabled  = true
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
```

`fail2ban-client -t` reports `OK: configuration test is successful`. The service
is **enabled and active**, with one jail (`sshd`) and **zero bans** — no
administrator was locked out.

One informational notice appears: `'allowipv6' not defined … Using default one:
'auto'`. That is a default being applied, not a failure, and the configuration
was **not** changed merely to silence it.

**No attack traffic was manufactured to demonstrate banning.** The negative
proofs above were each run once. Deliberately generating repeated failures on a
live host risks banning the administrator to prove a mechanism whose
configuration is already verifiable.

## 7. SSH boot mechanism — not a defect

```
ssh.socket   enabled + active    ← owns port 22, starts SSH at boot
ssh.service  disabled + active   ← socket-activated
```

`ssh.service` reporting `disabled` looks alarming beside the earlier nginx
finding, and it is **not the same problem**. Socket activation is the intended
design on this distribution: the socket owns boot startup. It is also proven
empirically — an earlier controlled reboot brought SSH back 17 seconds after
boot.

`ssh.socket` must therefore never be restarted or disabled to "fix" the service
state.

## 8. Monitoring semantics — a rule adopted from a real defect

A release-era watcher once reported `TARGET MISMATCH` for a healthy server. The
cause was in its own output: an SSH call timed out, the variable captured an
error string instead of a value, and a string comparison failed. **A transport
failure was silently converted into a semantic verdict.**

Every remote check must therefore produce one of three outcomes, never two:

| Outcome                   | Meaning                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| **PASS**                  | The target was reached and the value observed is correct.                                     |
| **FAIL**                  | The target was reached and the value observed is incorrect.                                   |
| **UNKNOWN / UNREACHABLE** | The value could not be observed — DNS, TCP, TLS, SSH or request failure, timeout, or refusal. |

A timeout is `UNKNOWN`. It must never become `FAIL` merely because an empty or
error string failed an equality comparison. This rule governs the monitoring
work that follows.

## 9. Firewall

Unchanged: default-deny inbound, with 22, 80 and 443 allowed.

Port 22 remains internet-reachable **by choice** — administration happens from
changing networks, and IP allowlisting would trade a real lockout risk for a
modest gain. It is now protected by key-only authentication, no direct root
login, and the fail2ban jail. Allowlisting remains available as a separate
decision if a stable administrative source ever exists.

## 10. Application regression

No web-facing change was made, and none was observed.

- **CAD Fixer**: HTTP→HTTPS 301; HTTPS 200; valid certificate; COOP, COEP, CORP,
  `nosniff` and `no-referrer` all exact; `crossOriginIsolated === true` and
  `SharedArrayBuffer` available in real Chromium; import and export exercised
  successfully; **zero console errors**; no off-origin request and no request
  body.
- **Served bytes still match the released artifact exactly**, and the active
  release directory is unchanged.
- **Other sites on the machine**: unchanged, including two failures that predate
  all of this work and were deliberately not repaired here.
- **nginx** enabled, active, not failed; **certbot timer** active.

## 11. Recovery procedure

If SSH ever becomes unreachable:

1. Open the provider's out-of-band browser/VNC console and log in locally.
2. Inspect with `sudo sshd -t` and `sudo sshd -T`.
3. Restore from the retained timestamped backup under
   `/root/cad-fixer-security-backup/`.
4. If the dedicated hardening file is the cause, remove
   `/etc/ssh/sshd_config.d/00-cad-fixer-hardening.conf`.
5. Re-validate with `sudo sshd -t`.
6. `sudo systemctl reload ssh` — never restart `ssh.socket`.
7. Retest external key login from a fresh connection.

No credential is stored in this repository.

## 12. Remaining security debt

**Not fixed here, and not claimed to be.**

**Medium / review**

- The deployment account belongs to the `docker` group, which is effectively
  root-equivalent on this host.
- Port 22 remains globally reachable (see §9 — a deliberate trade).
- A printing daemon was previously observed bound to all interfaces; reachable
  only because the firewall blocks it, not because it binds correctly.
- Server log retention and review has not been examined.

**Legacy service debt**

- An expired TLS certificate for a domain that no longer resolves.
- One unrelated site without working HTTPS.
- Possible unused or legacy services from earlier projects.

This stage hardened **SSH access and brute-force resistance**. It did not audit
the rest of the machine.
