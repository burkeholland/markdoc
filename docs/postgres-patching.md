# PostgreSQL VM: monthly OS security patching

How the private PostgreSQL VM `markdoc-pg` (Ubuntu 24.04, Standard_B1ms, no public IP, outbound Internet denied by NSG rule 260) gets its operating-system security updates, why the cadence is what it is, what it costs, how a run is verified and how it is rolled back. The code lives in `deploy/patch-postgres-vm.ps1` (operator side), `infra/patch-os.sh` (in-guest side), the shared helpers in `deploy/azure-postgres-network.ps1`, and the alert lines in `infra/main.bicep`. Nothing in the repository runs it automatically; a scheduled GitHub Actions workflow (first Sunday, `workflow_dispatch` for out-of-band runs, the `deploy.yml` OIDC identity) is a later step, to be added once the first observed run has produced real numbers for the estimates below.

## Why a separate cadence exists

`deploy/azure.ps1` never upgrades the base OS. `infra/main.bicep`'s `install-postgresql` and `infra/postgres-recovery.sh` run `apt-get install` for named packages only (`postgresql`, `curl`, `ca-certificates`, `gnupg`, `postgresql-common`, `pgbackrest`), so `-InitializeDatabase` and `-ConfigureRecovery` refresh those and nothing else: not the kernel, glibc, OpenSSL, systemd, sudo or the Azure agent. "Keep as is" is therefore not a quarterly cadence, it is never. The exposure that leaves open, from most to least realistic: authenticated PostgreSQL bugs exploitable with the app role after an app-tier compromise (exactly what PostgreSQL minors fix), PostgreSQL wire-protocol/TLS pre-authentication bugs reachable from the Container Apps subnet, kernel/glibc/sudo/systemd local privilege escalation as the second hop from the `postgres` OS user to root (and from there to the storage account that holds the backups), and outbound-client bugs in `curl`/`python3`/the agents. Inbound stays `DenyAllInbound` except 5432 from `10.42.0.0/23`, which is why monthly, not weekly, is enough.

A database outage does not restart the app: the liveness probe is `/api/health?probe=live` (no database), so a PostgreSQL restart or a VM reboot only makes `/api/health` answer `503 db=false` for the duration while the pool reconnects. Downtime figures here are database-unavailable seconds, not app restarts.

## Options considered

| Option | Cost / month | Downtime / cycle | Egress dependency | Verdict |
| --- | --- | --- | --- | --- |
| **Scheduled temporary-egress window** (`deploy/patch-postgres-vm.ps1`): bootstrap public IP + NSG rule 250, managed run command `unattended-upgrade`, close egress, reboot only if required, verify | ≈ $0.01–0.10 (public IP $0.005/h × ≈ 0.75 h; optional incremental OS-disk snapshot ≈ $0.07 for 7 days; alert extension $0) | 0–10 s without a kernel (one PostgreSQL restart at most), ≈ 60–120 s with one | Internet 80/443 for ≈ 15 min/month, opened and force-closed by the script; independent of the NAT gateway and of default outbound access | **Chosen** |
| Narrowest rule: 250 → `AzureCloud.EastUS2:80` only (Azure's Ubuntu mirror) | same | same | Only Azure's mirror; works only if the image's `noble-security` source points at `azure.archive.ubuntu.com` (verify at the first window) | Hardening step after the first window |
| Azure Update Manager alone | $0 | n/a | Needs the apt sources reachable at assessment and install time, which rule 260 denies: assessment fails | Not viable as-is |
| Update Manager + pre/post maintenance events (Function/Automation opens and closes egress) | ≈ $0–1 | same as chosen | Internet open ≥ 2 h/month; a missed post-event leaves egress open | Viable but heavier; reconsider with a fleet |
| Private apt mirror in a network-restricted storage container (`debmirror`, ≈ 40–80 GB) | ≈ $0.75–1.50 + a sync job | same, and can run daily | None at patch time; staleness becomes the silent failure mode | Right answer for "no egress ever"; not worth 2–3 days for one VM |
| Rebuild from the latest image monthly + pgBackRest restore | ≈ $0 | 15–30 min | Internet during rebuild | Rejected; data lives on the OS disk, keep as the disaster-recovery path |

Prices are East US 2 retail prices read on 2026-08-30 (Standard IPv4 public IP $0.005/h, incremental snapshot Standard HDD LRS $0.05/GB-month, log alert rule $1.50/month at 5 min).

## Cadence

**Monthly, first Sunday of the month, 04:00Z (Saturday 23:00 CDT), a ≈ 25–40 min operator-run window; plus an out-of-band run within 7 days of a PostgreSQL minor with a security fix, an OpenSSL/glibc advisory with a network vector in a client role, or a kernel advisory with a remote or local-privilege-escalation vector; plus the already planned quarterly `-ConfigureRecovery` for the PGDG-sourced `pgbackrest`.**

- Ubuntu publishes several `noble-security` updates a week and a new `linux-azure` kernel roughly every 3–5 weeks; monthly keeps the median exposure of an installed package at ≈ 15 days (≈ 31 worst case). Weekly would double the windows and reboots for little gain on a host with no inbound Internet exposure.
- 04:00Z sits after the Azure Backup snapshot (≈ 02:00–02:22Z), the pgBackRest full (02:30Z + ≤ 10 min) and the logical dump (03:30Z + ≤ 10 min), and ≥ 20 min before the Sunday restore check (05:00Z + ≤ 30 min). Every run therefore has a ≤ 2 h-old VM restore point and a fresh full plus logical backup as rollback, and the restore check then proves that the *patched* VM still restores. The script's pre-checks encode this: an Azure Backup job completed within 26 h, `logical-backup=ok` within 26 h and `backup-health=ok` within 15 min, so an out-of-band run is allowed at any hour as long as the previous night's backups exist.
- The Ubuntu Security Notices feed filtered to `postgresql-16`, `openssl`, `linux-azure`, `glibc`, `sudo`, `systemd`, `curl` and `walinuxagent` is the out-of-band trigger.

| Cadence | Frequency | Source | Downtime | Egress |
| --- | --- | --- | --- | --- |
| OS security | monthly, first Sunday 04:00Z | Ubuntu `noble-security` | 0–10 s / 60–120 s | ≈ 15 min window |
| Out-of-band | ≤ 7 days after a critical advisory | Ubuntu `noble-security` | same | same |
| `pgbackrest` and PostgreSQL client tooling | quarterly `-ConfigureRecovery` | PGDG | none | the same rule-250 window |
| PostgreSQL major | never automatic (see below); a planned migration before 2028-11-09 | next Ubuntu LTS or PGDG | separate project | — |

## The run

`.\deploy\patch-postgres-vm.ps1 -DryRun` first: it prints every `az` call the real run would make, tagged `[read-only]` or `[mutation]`, and makes none of them. Then `.\deploy\patch-postgres-vm.ps1` from a signed-in `az` session (`-Snapshot` for a pre-patch incremental OS-disk snapshot, `-NoReboot` to defer a kernel reboot to a later window, `-Full` for plain `apt-get upgrade` instead of security-only). The steps, in the order the script enforces:

1. **Pre-checks, read-only, abort on any mismatch**: power state `VM running`; steady-state network (rule 260 `DenyOtherInternetEgress` Deny/Outbound/Internet present, rule 250 absent, no public IP on `markdoc-pg-nic`, no `markdoc-pg-bootstrap-ip`); backup freshness as above; `/api/health` reports `ok=true` and `db=true`.
2. **Open egress**: `Restore-PostgresSteadyStateEgress` and `Remove-BootstrapPublicIp` are registered with `Invoke-OperationWithGuaranteedCleanup` before the first mutation; then the public IP is created and attached and rule 250 `AllowApprovedPackageSetup` (Outbound, TCP 80/443 to `Internet`) is created, the same specification `-ConfigureRecovery` deploys, so the cleanup helpers apply unchanged. The optional snapshot is taken inside the same guarded block.
3. **Patch**: `infra/patch-os.sh` is sent verbatim as the managed run command `patch-os` (`--parameters MARKDOC_PATCH_MODE=security|full|rollback`, which the handler exports as environment variables). In the guest: `apt-get update`, then `unattended-upgrade -v` (Ubuntu's `Allowed-Origins` are the `noble-security` and ESM pockets, never PGDG; `Automatic-Reboot` stays off) or `apt-get -y -q upgrade` for `-Full`, a `pg_isready` check and the `postgresql-16` version before and after, `needrestart -b`, `/var/run/reboot-required`. The last output line is `os-patch=ok upgraded=<n> reboot=<required|none> running=<kernel> installed=<kernel>`, or `os-patch=failed … stage=<s>` from the `ERR` trap; both also go to Syslog facility `local0` with tag `markdoc-os-patch`. The apt chatter stays in `/var/log/markdoc-os-patch.log` and `/var/log/apt/history.log`, so the run command's 4 KB output cap is never hit.
4. **Close egress**: the cleanup runs after success, after any failure, and best-effort on Ctrl-C: delete rule 250, verify it is gone, re-assert rule 260, detach and delete the public IP. Egress is closed before any reboot, so the VM never boots with the Internet reachable.
5. **Reboot only if the guest said `reboot=required`**: `az vm restart` (graceful ACPI shutdown, PostgreSQL's unit stops cleanly), with `/api/health` polled every 3 s to measure the database-unavailable seconds. Never a redeploy (that moves the VM to another host, ≈ 5–10 min).
6. **Verify**: power state, `/api/health` within 180 s, then Syslog `os-patch=ok` plus a `backup-health=ok` after the restart and a Heartbeat newer than it (polled up to 10 min for ingestion), the steady-state network again, and the kernel that actually booted from the serial log. The script ends with one line for the board comment: `os-patch-window=ok mode=<m> upgraded=<n> kernel=<before>-><after> reboot=<yes|no|deferred> db-unavailable=<n>s egress-open=<n>min`.

`deploy/azure-safety.tests.ps1` pins the shape of both halves: the cleanup registered before any mutation, both helpers in the cleanup, every mutation inside the guarded block, the restart after it and conditional on `reboot=required`, no distribution upgrade verbs anywhere, the guest never rebooting on its own, the `-Rollback` guards, and the helpers defined exactly once.

## Detection

- A failed guest patch logs `os-patch=failed` to `local0`, which the existing `markdoc-postgres-backup-failure` scheduled-query alert now matches (one extra `or` in its query; same rule, no new alert cost). A VM that does not come back trips `markdoc-postgres-backup-heartbeat` (no `backup-health=ok` for 15 min) after ≈ 15–20 min; a successful reboot (≤ 2 min gap plus the monitor's `OnBootSec=2m`) never does.
- `markdoc-postgres-nsg-rule-write` is a free Activity Log alert on `Microsoft.Network/networkSecurityGroups/securityRules/write` scoped to `markdoc-pg-nsg`, routed to the same action group. It fires once per patch or `-ConfigureRecovery` window; at any other time it means an egress path was opened by hand and the steady state needs checking (the script's pre-checks are the detector, `Restore-PostgresSteadyStateEgress` and `Remove-BootstrapPublicIp` the idempotent fix).
- Blast radius: the VM is never reachable from the Internet (inbound stays `DenyAllInbound` while the public IP is attached, the NSG is the same); outbound is open ≈ 15 min/month to whatever the VM itself initiates. A bad patch is bounded to one VM and one restart; the app keeps serving with database errors and never restarts; backups from ≤ 90 min earlier exist; the restore check runs 20 min later.

## Rollback, ordered by likelihood

- **The script failed before or during the install**: the cleanup already closed egress; `dpkg --configure -a` through a run command if apt was interrupted (no egress needed); nothing else changed. Rerun in the next window or out-of-band.
- **A package regression** (PostgreSQL minor, libssl, systemd): `.\deploy\patch-postgres-vm.ps1 -Rollback <package>=<previous version>` opens the same window and runs `apt-get install --allow-downgrades <package>=<version>` followed by `apt-mark hold <package>` until the fix arrives. The previous `.deb` is not on the VM (Ubuntu removes superseded versions from its pockets), so if `/var/cache/apt/archives` does not have it the guest fetches it from Launchpad. PostgreSQL minor downgrades are supported unless the release notes say otherwise. `-Rollback` refuses to combine with `-Full` and refuses anything but Debian package and version characters.
- **The new kernel misbehaves but boots**: `grub-reboot` to the previous menu entry through a run command (Ubuntu keeps the previous kernel; only older ones are autoremoved), then `az vm restart`.
- **The new kernel does not boot**: serial console (boot diagnostics are enabled) → GRUB, previous kernel; or swap the OS disk from the `-Snapshot` snapshot (`az disk create --source <snapshot>`, `az vm update --os-disk`, VM deallocated ≈ 5–10 min). Because the data lives on the OS disk this reverts the database to snapshot time; recover the writes since then with pgBackRest point-in-time recovery (the WAL archive keeps flowing to the storage account). Last resort: the Azure Backup restore point from 02:00Z plus `-VerifyRecovery`.
- **Egress left open** (the cleanup itself failed): rerun `Restore-PostgresSteadyStateEgress` and `Remove-BootstrapPublicIp` from `deploy/azure-postgres-network.ps1` (dot-source it after `deploy/azure-safety.ps1` in a session where `$Name` and `$ResourceGroup` are set); both are idempotent.

## The PostgreSQL major never moves by accident

Ubuntu never changes the major inside a release (`postgresql-16` stays 16.x for the life of 24.04). A major bump could only come from PGDG's `postgresql`/`postgresql-client` metapackages, which point at a newer major. `unattended-upgrade` never installs from PGDG, plain `apt-get upgrade` never installs new packages, and only a distribution upgrade would, which neither script ever runs. Holding `postgresql-16` would be the wrong guard: it blocks exactly the minors we want. Instead `infra/postgres-recovery.sh` writes `/etc/apt/preferences.d/markdoc-pgdg`, pinning `apt.postgresql.org` to priority 100 for everything except `pgbackrest` (500): with the pin, `postgresql-16`'s candidate is Ubuntu's build and the `postgresql` metapackage stays at 16, while `pgbackrest` still comes from PGDG (Ubuntu's 2.50 is older than the 2.58 the recovery setup requires). A PostgreSQL minor is one ≈ 3–10 s cluster restart by the package's postinst.

## Verify at the first window (all read-only inside the VM)

1. Whether `unattended-upgrades` ran at first boot (`/var/log/unattended-upgrades/unattended-upgrades.log`, `/var/log/apt/history.log`); `unattended-upgrade --dry-run -v` before the real run gives the exact pending count, paste it into the record.
2. `/etc/apt/sources.list.d/ubuntu.sources`: does `noble-security` point at `azure.archive.ubuntu.com` (enables the narrowest rule) or `security.ubuntu.com` (needs `Internet`)?
3. `needrestart` under a non-interactive run command, and that the `postgresql-16` postinst restarts the cluster (`/var/log/apt/term.log`).
4. The real reboot duration from the serial log and the `db-unavailable` figure, to replace the 60–120 s estimate.
5. `apt-cache policy postgresql-16 pgbackrest postgresql` after `-ConfigureRecovery` has written the pin: Ubuntu candidates for the first and last, PGDG for `pgbackrest`.
6. That the GitHub OIDC identity in `deploy.yml` has Contributor on `markdoc-rg` before the scheduled workflow is added.
