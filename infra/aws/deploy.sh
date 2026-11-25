#!/bin/bash
# Build the images on this machine, push them to ECR, and roll them out on the server via SSM.
#
#   infra/aws/deploy.sh              # api + web + admin
#   infra/aws/deploy.sh api          # only some of them (the others keep running their last image)
#
# Needs: docker (buildx), the AWS CLI signed in to the account, and `terraform apply` done in infra/aws/terraform.
# Expects the sibling repos next to this one: ../mgr_frontEnd and ../mgr_admin.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$(cd "$HERE/../.." && pwd)"
ROOT="$(dirname "$BACKEND")"
TF="$HERE/terraform"
if [ $# -eq 0 ]; then SERVICES=(api web admin); else SERVICES=("$@"); fi

out() { terraform -chdir="$TF" output -raw "$1"; }
REGION=$(out region); INSTANCE=$(out instance_id); BUCKET=$(out ops_bucket)
REGISTRY=$(out ecr_registry); PREFIX=$(out ecr_prefix); BASE_DOMAIN=$(out base_domain); CIDRS=$(out admin_allowed_cidrs)
TAG="$(date +%Y%m%d-%H%M)-$(git -C "$BACKEND" rev-parse --short HEAD 2>/dev/null || echo local)"

echo "→ signing in to ECR ($REGISTRY)"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

build() { # name, context, dockerfile
  local image="$REGISTRY/$PREFIX/$1"
  echo "→ building $1 ($TAG)"
  docker buildx build --platform linux/arm64 -f "$3" -t "$image:$TAG" -t "$image:latest" --push "$2"
}
# Services not rebuilt run ":latest", i.e. the image they were last deployed with. (Plain variables: macOS ships bash 3.2.)
API_TAG=latest; WEB_TAG=latest; ADMIN_TAG=latest
for s in "${SERVICES[@]}"; do
  case "$s" in
    api)   build api "$BACKEND" "$BACKEND/apps/api/Dockerfile"; API_TAG=$TAG ;;
    web)   build web "$ROOT/mgr_frontEnd" "$ROOT/mgr_frontEnd/Dockerfile"; WEB_TAG=$TAG ;;
    admin) build admin "$ROOT/mgr_admin" "$ROOT/mgr_admin/Dockerfile"; ADMIN_TAG=$TAG ;;
    *) echo "unknown service: $s (api, web, admin)"; exit 2 ;;
  esac
done

echo "→ uploading server files"
STAGE=$(mktemp -d -t moneymgr-deploy); trap 'rm -rf "${STAGE:?}"' EXIT
cp "$HERE/server/"{compose.yml,Caddyfile,up.sh,backup.sh} "$STAGE/"
cat > "$STAGE/deploy.env" <<EOF
REGION=$REGION
BUCKET=$BUCKET
REGISTRY=$REGISTRY
PREFIX=$PREFIX
BASE_DOMAIN=$BASE_DOMAIN
ADMIN_ALLOWED_CIDRS="$CIDRS"
API_TAG=$API_TAG
WEB_TAG=$WEB_TAG
ADMIN_TAG=$ADMIN_TAG
EOF
aws s3 sync "$STAGE" "s3://$BUCKET/deploy/" --region "$REGION" --delete --only-show-errors

echo "→ rolling out on $INSTANCE"
# The commands the server runs, as a JSON file (avoids the CLI's shorthand-quoting rules).
PARAMS=$(mktemp -t moneymgr-ssm)
cat > "$PARAMS" <<EOF
{"commands": [
  "export PATH=\$PATH:/snap/bin",
  "test -f /var/lib/moneymgr-bootstrapped || { echo 'server is still setting up, try again in a minute'; exit 1; }",
  "aws s3 sync s3://$BUCKET/deploy/ /opt/moneymgr/ --region $REGION --only-show-errors",
  "bash /opt/moneymgr/up.sh"
]}
EOF
CMD=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --comment "moneymgr deploy $TAG" --timeout-seconds 900 --parameters "file://$PARAMS" \
  --query Command.CommandId --output text)
rm -f "$PARAMS"

while :; do
  sleep 5
  STATUS=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  case "$STATUS" in Pending|InProgress|Delayed) printf '.';; *) echo; break;; esac
done
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" --query '[StandardOutputContent,StandardErrorContent]' --output text
[ "$STATUS" = Success ] || { echo "✗ deploy failed ($STATUS)"; exit 1; }

echo "✓ deployed $TAG"
echo "  web:   https://app.$BASE_DOMAIN"
echo "  api:   https://api.$BASE_DOMAIN"
echo "  admin: https://admin.$BASE_DOMAIN"
