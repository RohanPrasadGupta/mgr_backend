#!/bin/bash
# Runs on the server (as root, via SSM) after deploy.sh has copied this folder to /opt/moneymgr.
set -euo pipefail
export PATH="$PATH:/snap/bin"
cd /opt/moneymgr
# shellcheck disable=SC1091
source ./deploy.env

# Secrets are created once, on the server, and never leave it (except the encrypted S3 backup copy).
if [ ! -s /data/secrets.env ]; then
  umask 077
  {
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "JWT_SECRET=$(openssl rand -hex 32)"
    echo "ADMIN_SECRET=$(openssl rand -hex 32)"
  } > /data/secrets.env
  echo "generated /data/secrets.env"
fi
umask 077
# No allow-list configured = the admin sign-in page is reachable from anywhere (2FA still required).
cidrs="${ADMIN_ALLOWED_CIDRS:-0.0.0.0/0 ::/0}"
{ grep -v '^ADMIN_ALLOWED_CIDRS=' ./deploy.env; echo "ADMIN_ALLOWED_CIDRS=\"$cidrs\""; cat /data/secrets.env; } > ./.env
touch /data/app.env

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
docker compose pull --quiet
docker compose up -d --remove-orphans
docker image prune -af >/dev/null || true

install -m 755 ./backup.sh /usr/local/bin/moneymgr-backup
echo "0 3 * * * root /usr/local/bin/moneymgr-backup >> /var/log/moneymgr-backup.log 2>&1" > /etc/cron.d/moneymgr-backup

# Wait until the API reports healthy (it runs migrations first).
for _ in $(seq 1 40); do
  state=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q api)" 2>/dev/null || echo starting)
  [ "$state" = healthy ] && { echo "api healthy"; docker compose ps --format 'table {{.Service}}\t{{.Status}}'; exit 0; }
  sleep 5
done
echo "api did not become healthy; last logs:"; docker compose logs --tail 40 api; exit 1
