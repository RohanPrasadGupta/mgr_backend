#!/bin/bash
# Nightly (cron, 03:00 Singapore): database dump + receipts + secrets to the private S3 bucket.
set -euo pipefail
export PATH="$PATH:/snap/bin"
cd /opt/moneymgr
# shellcheck disable=SC1091
source ./deploy.env
ts=$(date +%Y-%m-%d-%H%M)
docker compose exec -T postgres pg_dump -U moneymgr -Fc moneymgr | aws s3 cp - "s3://$BUCKET/backups/db/moneymgr-$ts.dump" --region "$REGION" --only-show-errors
aws s3 sync /data/uploads "s3://$BUCKET/backups/uploads/" --delete --region "$REGION" --only-show-errors
aws s3 cp /data/secrets.env "s3://$BUCKET/backups/secrets.env" --region "$REGION" --only-show-errors
echo "$ts backup ok"
