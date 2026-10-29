#!/usr/bin/env bash
# Run only by smoke.mjs in a disposable, networkless container without a Docker socket.
set -Eeuo pipefail
[[ -f /.dockerenv && ! -S /var/run/docker.sock && -d /fixture/scripts/hosting ]] || exit 1
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
image=ghcr.io/treca-raja/rajcord-public@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
release=/opt/tricord/releases/$sha
config=/etc/tricord/staging
mkdir -p "$release/scripts" "$release/infrastructure" "$config/letsencrypt/live/tricord"
cp -r /fixture/scripts/hosting "$release/scripts/hosting"
cp -r /fixture/infrastructure/hosting "$release/infrastructure/hosting"
chmod 700 "$config"
printf 'staging\n' >"$config/environment"
printf '8.8.8.8\n' >"$config/public-ip"
printf 'fixture\n' >"$config/letsencrypt/live/tricord/fullchain.pem"
printf 'RESTIC_REPOSITORY=sftp:fixture:/offsite\nRESTIC_PASSWORD=disposable-test\n' >"$config/restic.env"
chmod 600 "$config/restic.env"
cat >/usr/local/bin/docker <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>/tmp/operations
if [[ $* == *'certbot certonly'* && $* != *'--interactive=false'* ]]; then cat >/dev/null; fi
if [[ $* == *'exec -T postgres pg_dump'* ]]; then printf 'PGDMP fixture'; fi
if [[ $* == *'node dist/migrate.js'* && -f /tmp/fail-migration ]]; then exit 1; fi
MOCK
cat >/usr/local/bin/restic <<'MOCK'
#!/usr/bin/env bash
if [[ $1 == backup ]]; then cat >/dev/null; [[ ! -f /tmp/fail-backup ]]; fi
MOCK
cat >/usr/local/bin/curl <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>/tmp/operations
[[ ! -f /tmp/fail-health ]]
MOCK
cat >/usr/local/bin/timeout <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>/tmp/operations
exit 0
MOCK
chmod 755 /usr/local/bin/docker /usr/local/bin/restic /usr/local/bin/curl /usr/local/bin/timeout
deploy() { bash "$release/scripts/hosting/deploy.sh" staging "$image" "$sha" >/tmp/deploy-output 2>&1; }

bash -c 'source "$1"; initialize_host staging; [[ $TRICORD_IMAGE == "$2" ]]' bash \
  "$release/scripts/hosting/common.sh" \
  ghcr.io/treca-raja/rajcord-public@sha256:0000000000000000000000000000000000000000000000000000000000000000

# Failed off-server backup must block migrations and must not publish release markers.
touch /tmp/fail-backup
if deploy; then exit 1; fi
if grep -q 'node dist/migrate.js' /tmp/operations; then exit 1; fi
[[ ! -e $config/image && ! -e /opt/tricord/staging-current ]]
rm /tmp/fail-backup

# A failed migration leaves the app stopped and preserves the previous successful marker.
printf 'previous-image\n' >"$config/image"
touch /tmp/fail-migration
: >/tmp/operations
if deploy; then exit 1; fi
grep -q 'node dist/migrate.js' /tmp/operations
if grep -q 'up -d --wait --wait-timeout 180 app proxy' /tmp/operations; then exit 1; fi
[[ $(cat "$config/image") == previous-image ]]
rm /tmp/fail-migration

# Failed post-deploy HTTPS must not mark the candidate as successful.
touch /tmp/fail-health
if deploy; then exit 1; fi
[[ $(cat "$config/image") == previous-image ]]
rm /tmp/fail-health

# Only a complete successful run advances the immutable release and maintenance link.
deploy
[[ $(cat "$config/image") == "$image" && $(cat "$config/commit") == "$sha" ]]
[[ $(readlink /opt/tricord/staging-current) == "$release" ]]

# Choose the correct ACME identity type, then use DNS/SNI for domain health checks.
mv "$config/letsencrypt/live/tricord" "$config/letsencrypt/live/tricord.fixture"
: >/tmp/operations
bash "$release/scripts/hosting/bootstrap-tls.sh" staging operator@example.test >/dev/null
grep -q -- '--ip-address 8.8.8.8' /tmp/operations
printf 'rajcord.test\n' >"$config/public-host"
printf 'turn.rajcord.test\n' >"$config/turn-host"
: >/tmp/operations
bash "$release/scripts/hosting/bootstrap-tls.sh" staging operator@example.test >/dev/null
grep -q -- '-d rajcord.test -d turn.rajcord.test' /tmp/operations
if grep -q -- '--ip-address' /tmp/operations; then exit 1; fi
: >/tmp/operations
bash "$release/scripts/hosting/bootstrap-tls.sh" staging >/dev/null
grep -q -- '--register-unsafely-without-email' /tmp/operations
printf 'bash %q staging\nprintf done > /tmp/operator-stdin-preserved\n' "$release/scripts/hosting/bootstrap-tls.sh" | bash -se >/dev/null
[[ $(cat /tmp/operator-stdin-preserved) == 'done' ]]
mv "$config/letsencrypt/live/tricord.fixture" "$config/letsencrypt/live/tricord"
deploy
grep -q -- 'https://rajcord.test/ready' /tmp/operations
grep -q -- '-verify_hostname turn.rajcord.test -servername turn.rajcord.test' /tmp/operations
: >/tmp/operations
for rejected_image in \
  ghcr.io/treca-raja/rajcord-public:latest \
  "ghcr.io/fakebane/tricord-public@sha256:${image##*@sha256:}" \
  "ghcr.io/treca-raja/tricord-public@sha256:${image##*@sha256:}" \
  "ghcr.io/other/rajcord-public@sha256:${image##*@sha256:}"; do
  if bash "$release/scripts/hosting/deploy.sh" staging "$rejected_image" "$sha" >/dev/null 2>&1; then exit 1; fi
done
[[ ! -s /tmp/operations && $(cat "$config/image") == "$image" ]]
if bash "$release/scripts/hosting/deploy.sh" production "$image" "$sha" >/dev/null 2>&1; then exit 1; fi
printf 'PASS: backup/migration/HTTPS failures block release success; Rajcord bootstrap and immutable image/environment checks fail closed.\n'
