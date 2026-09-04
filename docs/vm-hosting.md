# VM-hosted production

Production Markdoc runs on the existing PostgreSQL VM to avoid the fixed cost
of a VNet-integrated Container Apps environment.

| Resource | Value |
| --- | --- |
| URL | `https://markdoc-burkeholland.eastus2.cloudapp.azure.com` |
| VM | `markdoc-pg` (`Standard_B1ms`) |
| Public IP | `markdoc-web-ip` |
| Service | `markdoc-app.service` |
| Reverse proxy | nginx |
| TLS | Let's Encrypt, renewed by `certbot.timer` |
| Image registry | `markdocacrmnd542unepl56.azurecr.io` |
| Database | PostgreSQL on `10.42.2.4:5432` |

The service runs with host networking, a 768 MiB memory limit, and 0.6 CPU.
`/etc/markdoc/markdoc.env` is root-owned mode `0600`. The VM managed identity
has `AcrPull` on the registry and `Key Vault Secrets User` on the application
vault. Docker registry tokens are removed after each pull.

## Release

Run the manual **Deploy to Azure** workflow. It:

1. Builds the accepted commit in ACR and resolves the immutable digest.
2. Sends `infra/deploy-vm-image.sh` to the VM with the digest and commit SHA.
3. Pulls through the VM managed identity, rewrites the systemd unit, restarts
   the service, and waits for local database/collaboration health.
4. Verifies the public HTTPS endpoint reports the requested commit SHA.

The script never prints or transports application secrets. It reuses the
root-only environment file already on the VM.

## Health and logs

```powershell
Invoke-RestMethod https://markdoc-burkeholland.eastus2.cloudapp.azure.com/api/health

az vm run-command invoke -g markdoc-rg -n markdoc-pg `
  --command-id RunShellScript `
  --scripts "systemctl is-active markdoc-app; journalctl -u markdoc-app --no-pager -n 100" `
  --query "value[0].message" -o tsv
```

Health must report `ok`, `db`, and `collab` as `true`.

## Rollback

Find the previous immutable digest in ACR and run
`infra/deploy-vm-image.sh` through VM Run Command with that digest and its
original commit SHA. Database rollback is not part of an application rollback;
PostgreSQL remains authoritative and retains writes accepted by either image.

## Maintenance tools

The retired `markdoc-maint` Container Apps Job must not be recreated. Run
one-off tools through VM Run Command or a temporary Docker container on
`markdoc-pg`, using `/etc/markdoc/markdoc.env`. Take the documented pgBackRest
and logical backups before any write-mode repair.
