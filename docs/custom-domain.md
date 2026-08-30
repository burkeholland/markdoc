# Custom domain cutover

How to move production Markdoc from its Container App default name to a bought domain without breaking sign-in. Steps marked **human** need Burke (DNS console, GitHub OAuth app); steps marked **agent** are Azure CLI work anyone with `Contributor` on `markdoc-rg` can run. Everything below was prepared before the domain existed: replace `<host>` with the real name (for example `markdoc.example.com`, or an apex such as `example.com`) and run the steps in order. Nothing here is executed by the repo automatically.

Facts in this document were read from Azure on 2026-08-28 with read-only `az … show` / `list` calls. Re-read them (the commands are given) if the deployment changed since; none of them is a secret — all three DNS values are meant to be published.

## 1. Before you start

**Burke needs**

- The domain bought, and access to its DNS console (the registrar or the DNS host it is delegated to). If the zone is on Cloudflare, the ability to turn the proxy off for two records (see section 7).
- Owner access to the GitHub OAuth app whose client id is the app's `AUTH_GITHUB_ID` (GitHub → Settings → Developer settings → OAuth Apps).
- A decision: subdomain (`markdoc.example.com`, recommended: a CNAME, simplest validation) or apex (`example.com`: an A record, HTTP validation).

**Current production (read-only facts)**

| Fact | Value | Read with |
| --- | --- | --- |
| Container App / resource group / region | `markdoc` / `markdoc-rg` / East US 2 | — |
| Managed environment | `markdoc-prod-env` | `az containerapp show -n markdoc -g markdoc-rg --query properties.environmentId -o tsv` |
| Default FQDN (CNAME target for a subdomain) | `markdoc.delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io` | `az containerapp show -n markdoc -g markdoc-rg --query properties.configuration.ingress.fqdn -o tsv` |
| Environment default domain | `delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io` | `az containerapp env show -n markdoc-prod-env -g markdoc-rg --query properties.defaultDomain -o tsv` |
| Environment static IP (A record for an apex) | `57.165.73.191` | `az containerapp env show -n markdoc-prod-env -g markdoc-rg --query properties.staticIp -o tsv` |
| `customDomainVerificationId` (the `asuid` TXT value) | `17C7704DD90906C1933411DDBE9839A0ABF7CEE1D2007B0842758C7F87C450C9` | `az containerapp show -n markdoc -g markdoc-rg --query properties.customDomainVerificationId -o tsv` |
| Ingress | external, HTTPS only (`allowInsecure=false`), target port 3000, transport Auto, no custom domains yet | `az containerapp ingress show -n markdoc -g markdoc-rg` |
| Revision mode / replicas | Single / min 1, max 1 | `az containerapp show … --query "{mode:properties.configuration.activeRevisionsMode, min:properties.template.scale.minReplicas, max:properties.template.scale.maxReplicas}"` |
| Active revision (100 % traffic, Healthy, 1 replica) | `markdoc--0000015` | `az containerapp revision list -n markdoc -g markdoc-rg --query "[].{name:name, active:properties.active, traffic:properties.trafficWeight, health:properties.healthState}" -o table` |
| Rollback revision | none exists today: `markdoc--0000015` is the only revision. The revision that is active when Step D starts becomes the rollback. | same command |
| Env vars present (names only) | `NODE_ENV`, `PORT`, `HOST`, `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `AUTH_TRUST_HOST`, `AUTH_URL`, `DATABASE_URL`, `DATABASE_SSL`, `APP_VERSION`, `DEPLOYMENT_CONFIGURATION_VERSION`. `MARKDOC_URL` and `MARKDOC_CANONICAL_HOST` are **not** set. | `az containerapp show -n markdoc -g markdoc-rg --query "properties.template.containers[0].env[].name" -o tsv` |

Print names only when you re-read the env list; never `env[].value` (it would show secrets in the terminal).

**What changes, in one line each**

- DNS: two new records (Step A).
- Azure: one hostname + managed certificate bound to the app (Step B), then one new revision with three env vars changed on the **same image** (Step D). No image build, no database work, no Bicep, no `deploy/azure.ps1`.
- GitHub: two URL fields in the OAuth app (Step C).
- Code: nothing new to deploy. The canonical-host redirect already ships in the current image behind `MARKDOC_CANONICAL_HOST` (unset = off, see `src/proxy.ts`).

Before starting, confirm the tooling once from the repo: `npm run domain:preflight -- --domain <host> --from-azure` must print the `azure` line as `PASS` with the FQDN and static IP above (the DNS and health lines will be `PENDING` — that is expected before Step A).

## 2. Step A (human): DNS records

Create exactly these records at the DNS host. Use the lowest TTL offered (300 s or "auto") so a mistake can be corrected quickly.

**Subdomain** (`<sub>` is the left-most label, e.g. `markdoc` for `markdoc.example.com`):

| Type | Name / host | Value | Notes |
| --- | --- | --- | --- |
| CNAME | `<sub>` | `markdoc.delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io` | Must point **directly** at this name; Azure refuses to issue or renew the certificate through an intermediate CNAME (Cloudflare proxy, Traffic Manager, …). |
| TXT | `asuid.<sub>` | `17C7704DD90906C1933411DDBE9839A0ABF7CEE1D2007B0842758C7F87C450C9` | Proves ownership. Some consoles want the value quoted; paste it without spaces. |

**Apex** (`example.com` itself):

| Type | Name / host | Value | Notes |
| --- | --- | --- | --- |
| A | `@` | `57.165.73.191` | The only A record for the name. Remove any registrar "parking" A/AAAA records first. |
| TXT | `asuid` | `17C7704DD90906C1933411DDBE9839A0ABF7CEE1D2007B0842758C7F87C450C9` | Same value as above. |

Do **not** add an AAAA record: the environment has no public IPv6 address. If the zone has any CAA record, add `CAA 0 issue "digicert.com"` at the zone root as well (section 7).

**Propagation check** (agent or human, from the repo, read-only):

```bash
npm run domain:preflight -- --domain <host> --from-azure
# apex instead:  npm run domain:preflight -- --domain <host> --apex --from-azure
```

Expected after propagation: `dns:cname` (or `dns:a`) `PASS`, `dns:txt` `PASS`, `health` still `PENDING`/`FAIL` (TLS is not bound yet — that is Step B). `PENDING` means the record is not visible yet: wait and rerun; the script asks the system resolvers first and falls back to `1.1.1.1`/`8.8.8.8`, so a `PASS` means the public internet sees it. `--dns-server <ip>` pins a resolver (for example the zone's own name server to check the change before it propagates). Without Azure access, pass `--expect-cname <fqdn>` (or `--expect-ip <ip>`) and `--expect-asuid <id>` from the table instead of `--from-azure`. Do not continue to Step B until both DNS lines are `PASS`.

## 3. Step B (agent): bind the hostname and the managed certificate

This step writes to Azure. It changes only `configuration.ingress.customDomains`: **no env var, no template, no new revision, no traffic move**. Ingress already meets the managed-certificate requirements (external, HTTP ingress, publicly reachable).

```bash
# 1. Register the hostname on the app (state Disabled: no certificate yet, no effect on traffic)
az containerapp hostname add -n markdoc -g markdoc-rg --hostname <host>

# 2. Request the free managed certificate and bind it (subdomain → CNAME, apex → HTTP)
az containerapp hostname bind -n markdoc -g markdoc-rg --hostname <host> \
  --environment markdoc-prod-env --validation-method CNAME     # apex: --validation-method HTTP
```

`hostname bind` blocks while Azure validates DNS and asks DigiCert for the certificate: usually 5–15 minutes, occasionally up to an hour. If the CLI times out, the operation continues server-side; poll rather than rerun:

```bash
az containerapp hostname list -n markdoc -g markdoc-rg -o table
#   bindingType Disabled  → still provisioning;  SniEnabled → bound
az containerapp env certificate list -g markdoc-rg -n markdoc-prod-env --managed-certificates-only \
  --query "[].{name:name, subject:properties.subjectName, state:properties.provisioningState}" -o table
#   provisioningState Pending → Succeeded
```

Verify TLS end to end (the site still *serves* on the new host at this point, but the app still believes it lives on the old URL, so do not sign in yet):

```bash
openssl s_client -connect <host>:443 -servername <host> </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates
curl -sSI https://<host>/api/health          # HTTP/2 200, no certificate warning
npm run domain:preflight -- --domain <host> --from-azure   # every line PASS, exit 0
```

**Rollback of Step B** (safe at any time, no revision involved): `az containerapp hostname delete -n markdoc -g markdoc-rg --hostname <host> --yes`. The managed certificate can be removed afterwards with `az containerapp env certificate delete -g markdoc-rg -n markdoc-prod-env --certificate <name> --yes` once nothing references it. DNS records can stay.

## 4. Step C (human): GitHub OAuth app

In the OAuth app that owns the app's `AUTH_GITHUB_ID` (GitHub → Settings → Developer settings → OAuth Apps → the Markdoc app):

| Field | New value |
| --- | --- |
| Homepage URL | `https://<host>` |
| Authorization callback URL | `https://<host>/api/auth/callback/github` |

Do not create a new OAuth app: the client id and secret in the Container App stay the same.

**Timing matters.** A GitHub OAuth app has exactly **one** callback URL. From the moment Step C is saved until Step D is live, a sign-in started on the old host fails (GitHub sends the browser back to the new host, where the state cookie set by the old host is missing: `OAuthCallbackError`). Once Step D is live, the redirect makes the old host land on the new one before the sign-in starts, so the two steps must be done back to back — Burke saves Step C and immediately tells the agent to run Step D, or the agent runs Step D first and Burke saves Step C within a minute. Either order has a gap of about one minute; do it at a quiet time. Existing sessions are not affected (cookies on the old host simply stop being sent, see section 7).

## 5. Step D (agent): switch the app's URL

Creates **one** new revision from the current template with three env vars changed and the **same image digest** as the active revision. Same rules as an app-only release (`README.md` → "Production runbook: app-only releases"): no image build, no data migration (the app's own Drizzle schema migrations run at startup as on every start, and there are none pending because the image is unchanged), no local writer, single-revision mode and `minReplicas`/`maxReplicas` 1/1 untouched, secrets untouched.

```bash
# Record the rollback point first (names only)
az containerapp revision list -n markdoc -g markdoc-rg --query "[?properties.active].name" -o tsv
az containerapp show -n markdoc -g markdoc-rg --query properties.template.containers[0].image -o tsv

# The switch (no --image: the digest stays what it is)
az containerapp update -n markdoc -g markdoc-rg --set-env-vars \
  AUTH_URL=https://<host> \
  MARKDOC_URL=https://<host> \
  MARKDOC_CANONICAL_HOST=<host>
```

- `AUTH_URL` (exists today) is what Auth.js uses to build the callback it sends to GitHub; it must be `https://<host>` with no trailing slash and no path.
- `MARKDOC_URL` (new; not set today) pins the public origin for MCP links and the same-origin check on browser writes. It must be a bare `https://<host>` origin: the server refuses to start on a value with a path, query, credentials or fragment, so a typo here shows up as a revision that never becomes healthy — roll back (below) rather than debugging in production.
- `MARKDOC_CANONICAL_HOST` (new) is the bare hostname, no scheme. An invalid value is logged once and ignored (the redirect stays off), so it cannot take the site down.

Wait until the new revision is Healthy with one replica and the old one has 0 % traffic:

```bash
az containerapp revision list -n markdoc -g markdoc-rg --query "[].{name:name, active:properties.active, traffic:properties.trafficWeight, health:properties.healthState, replicas:properties.replicas}" -o table
```

Then verify — every one of these must hold before telling Burke it is done:

```bash
# 5 health probes on the new host: 200, ok=true, version = the same APP_VERSION as before
for i in 1 2 3 4 5; do curl -sS https://<host>/api/health; echo; sleep 2; done

# The old host: a top-level page is redirected (308) to the new host, the API is not
curl -sSI https://markdoc.delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io/            # HTTP/2 308, location: https://<host>/
curl -sSI "https://markdoc.delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io/d/abc?x=1"  # location: https://<host>/d/abc?x=1
curl -sSI https://markdoc.delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io/api/health   # HTTP/2 200 (no redirect)

# Sign-in is built for the new host: the Location host must equal <host>
# (the server logs one line for this: `[auth] MissingCSRF during signin (expected from the post-release check)`)
curl -sS -o /dev/null -D - -X POST https://<host>/api/auth/signin/github                 # 302, location: https://<host>/login?error=MissingCSRF
CSRF=$(curl -sS -c cj.txt https://<host>/api/auth/csrf | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')
curl -sS -o /dev/null -D - -b cj.txt -X POST -d "csrfToken=$CSRF" https://<host>/api/auth/signin/github
#   location: https://github.com/login/oauth/authorize?…redirect_uri=https%3A%2F%2F<host>%2Fapi%2Fauth%2Fcallback%2Fgithub…
rm -f cj.txt

npm run domain:preflight -- --domain <host> --from-azure    # all PASS, exit 0
```

Finally the human check: Burke opens `https://<host>`, signs in with GitHub, opens a document; then opens `https://markdoc.delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io/` and lands on `https://<host>/`. Record the new and previous revision names and the image digest in the task.

## 6. Rollback

Order matters: put the app back first (so sign-in works again on the old host), then the OAuth app, then optionally the hostname.

1. **App** — reactivate the revision that was active before Step D (it has the old `AUTH_URL` and no `MARKDOC_URL`/`MARKDOC_CANONICAL_HOST`); in single-revision mode this moves 100 % of traffic back and deactivates the new one:
   `az containerapp revision activate -n markdoc -g markdoc-rg --revision <previous>` — then `revision list` until it is Healthy, and `curl -sSI https://markdoc.delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io/` answers `200` (no `308`).
   If the previous revision cannot be reactivated, `az containerapp update -n markdoc -g markdoc-rg --set-env-vars AUTH_URL=https://markdoc.delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io --remove-env-vars MARKDOC_URL MARKDOC_CANONICAL_HOST` produces an equivalent revision on the same image.
2. **GitHub OAuth app** (human) — Homepage URL `https://markdoc.delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io`, callback `https://markdoc.delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io/api/auth/callback/github`. Until this is done, sign-in on the old host fails the same way as in the Step C gap.
3. **Hostname** (optional) — `az containerapp hostname delete -n markdoc -g markdoc-rg --hostname <host> --yes`. Leaving it bound is harmless (the new host keeps serving; without `MARKDOC_CANONICAL_HOST` there is no redirect from it) and saves the certificate wait when retrying. DNS records can stay either way.

The database is never touched by the cutover or its rollback.

## 7. What can go wrong

- **Certificate stuck in `Pending`** (`hostname list` shows `Disabled` for more than an hour). Almost always DNS: the CNAME points at something other than the exact default FQDN, the `asuid` TXT is missing or on the wrong name (`asuid.<sub>`, not `asuid`), or the records have not propagated to the resolvers DigiCert uses. Rerun `npm run domain:preflight -- --domain <host> --from-azure`; fix the record; Azure retries on its own, or `hostname delete` + `hostname add` + `hostname bind` to restart validation.
- **CAA records.** If the zone (or any parent zone you control) has a CAA record, DigiCert must be allowed: `CAA 0 issue "digicert.com"`. Without it issuance *and every renewal* fail, so leave the record in place for as long as the domain is bound. No CAA record at all is fine.
- **Cloudflare (or any proxying DNS host).** The CNAME must be **DNS only** (grey cloud), not proxied (orange cloud): proxying makes it resolve to Cloudflare's addresses, which is an "intermediate CNAME" and blocks issuance and renewal; it also breaks the `/collab` WebSocket unless configured, and hides the client's origin. Also turn off Cloudflare's "Always use HTTPS"/"Automatic HTTPS Rewrites" games until the managed certificate is `Succeeded`; Container Apps already redirects HTTP to HTTPS.
- **HSTS.** The default `*.azurecontainerapps.io` host and the new host are different origins; browsers keep HSTS state per host. The app does not send `Strict-Transport-Security` itself, so there is nothing to undo; do not add the domain to a preload list until the cutover has been stable for a while, because that cannot be rolled back quickly.
- **Cookies from the old host.** Session cookies are scoped to the exact host, so nobody is "still signed in" on the new host: everyone signs in once more there (a one-time cost, same as the LAN hostname transition in `README.md`). Old-host cookies are not migrated; they expire on their own, and any browser that still hits the old host is redirected before it can use them. Unsaved offline edits live in IndexedDB per origin: a user with a pending offline edit should open the old URL once **before** Step D so it syncs (after Step D the old host redirects on `GET /d/...`, so the old origin's editor can no longer be opened).
- **Agents and MCP clients on the old URL** keep working: `/api/*` is never redirected, tokens are host-independent, and `MARKDOC_URL` only changes the links inside tool results. Update their `MARKDOC_URL`/server URL at leisure.
- **Health probes** (Container Apps' own and `.github/workflows/deploy.yml`) use `/api/health` and are unaffected by the redirect; the workflow's probe of the default FQDN keeps returning `200`.
- **Sign-in `OAuthCallbackError` after the switch.** Check that Step C's callback URL is character-for-character `https://<host>/api/auth/callback/github` and that `AUTH_URL` in the new revision has no trailing slash (`az containerapp show … --query "properties.template.containers[0].env[?name=='AUTH_URL'].value" -o tsv` — this one value is a URL, not a secret).
- **Someone bookmarks the `:443` form or uppercase host.** The redirect compares hostnames case-insensitively and ignores the port, so `https://<HOST>:443/` is treated as canonical and not redirected.
