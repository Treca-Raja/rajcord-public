# Production backup setup

The live database uses the VPS disk. The prepared backup scripts upload encrypted database snapshots to a separate restic repository before migrations and daily after deployment. Local temporary dumps are removed after upload; persistent local backup retention is not implemented. On 2026-10-27 the user created the private Standard R2 bucket rajcord-production-backups and its scoped key; its encrypted restic repository was initialized and a disposable upload/retrieval plus full repository check passed. No live database has been deployed or backed up yet. The steps below document setup and recovery requirements; do not reinitialize the existing repository.

## Cloudflare setup

1. Open **R2 Object Storage** in the Cloudflare account containing rajcord.com. If activation requires billing, review those terms before proceeding. Standard includes 10 GB-month of storage, one million Class A operations and ten million Class B operations monthly; excess usage is billed. This is not a hard spending cap. See [current pricing](https://developers.cloudflare.com/r2/pricing/).
2. Create `rajcord-production-backups` with **Standard** storage. Keep public access disabled: no public development URL and no custom domain. Do not configure object expiry or bucket locks; restic manages a repository whose objects must remain available until its own retention/prune operations remove them. [Bucket creation](https://developers.cloudflare.com/r2/buckets/create-buckets/) and [public access](https://developers.cloudflare.com/r2/buckets/public-buckets/) describe these settings.
3. Under R2 **Account Details → API Tokens → Manage**, create a dedicated backup token with **Object Read & Write**, scoped only to this bucket. It does not need account-wide administration or DNS permissions. Save the **Access Key ID**, **Secret Access Key** and the bucket's **S3 endpoint**. The secret is shown only once. Use the endpoint displayed for this bucket, including its jurisdiction suffix if present. See [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/).

Do not send credentials in chat or save them in GitHub Actions. In the maintainer's Windows PowerShell session, these hidden prompts save the two values encrypted for the current Windows account in ignored local storage:

```powershell
New-Item -ItemType Directory -Force .local/cloudflare/r2 | Out-Null
Read-Host 'R2 Access Key ID' -AsSecureString | ConvertFrom-SecureString | Set-Content .local/cloudflare/r2/access-key.dpapi
Read-Host 'R2 Secret Access Key' -AsSecureString | ConvertFrom-SecureString | Set-Content .local/cloudflare/r2/secret-key.dpapi
```

The endpoint and bucket name are configuration values and may be supplied separately. Decrypt the saved keys only in this Windows account, transfer over verified SSH without command-line secrets or diagnostic printing, and install them in the root-only server environment. The existing DNS token cannot perform this setup.

## Server initialization and recovery proof

After explicit approval on 2026-10-27, the production configuration and certificate/private-key snapshot was encrypted into R2 under host `tricord-production`, tag `tricord-runtime-production`. Retrieval into a private temporary directory matched file bytes, file permissions and certificate symlinks; the R2 credential file and backup password were excluded. The full repository data check passed. The runtime tag is separate from the database tag `tricord-production`, so the database restore job cannot select this configuration snapshot. Temporary restored files were removed; the live configuration was not replaced.

To recover this configuration, use the separately preserved restic password and valid bucket credentials, restore the `tricord-runtime-production` snapshot into a private staging directory, inspect it and only then deliberately install the needed files. Never restore directly over an initialized runtime directory. The local recovery password currently lives in ignored `.local/cloudflare/r2/restic-password.dpapi`, encrypted for the maintainer's Windows account; preserve a separate password-manager copy for recovery without that Windows installation. R2 credentials can be reissued for the bucket, but the restic password cannot be recreated from the encrypted snapshots.

Use [the reference environment](../infrastructure/hosting/backups/.env.example) to prepare `/etc/tricord/production/restic.env` on the server, owned by root with mode `600`. Generate an independent random restic password in `/etc/tricord/production/restic-password`, also root-owned with mode `600`. Never overwrite initialized credentials or an existing repository. Preserve the encryption password in a password manager outside the VPS before relying on backups; losing it makes the encrypted snapshots unrecoverable.

With the protected environment loaded in a root shell, initialize the empty repository once using `restic init`. Before allowing deployment, verify a disposable encrypted upload, retrieval and byte-for-byte comparison, then run `restic check`. That probe proves storage access, not database recovery. Never print credentials or enable shell tracing while loading the environment.

The first deployment creates a pre-migration database backup, which may contain no application schema yet. After migrations, run `backup.sh production` and `restore-check.sh production` from the reviewed release. The latter retrieves a database snapshot into an isolated temporary PostgreSQL instance and verifies the application schema; it never restores over the live database. Enable the daily backup and weekly restore timers only after that succeeds. See [deployment and maintenance commands](deployment.md#off-server-backups-and-first-deployment).

Daily retention keeps seven daily, four weekly and six monthly snapshots. Forgetting snapshot references alone does not reclaim all stored data: check repository health and run a deliberate restic prune as maintenance. Monitor storage consumption and backup failures. This retention policy does not guarantee staying inside R2's free allowance.
