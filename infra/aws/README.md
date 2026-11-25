# Hosting on AWS (budget setup)

One small ARM server in Singapore runs everything with Docker. No domain needed: the apps get free HTTPS
addresses like `https://app.13-250-1-2.sslip.io` (sslip.io turns the IP in the name into DNS).

```
            phone app ─┐
 browser ─ https ─► Caddy (HTTPS, certificates) ─┬─► web    (Next.js)   ─┐
                       EC2 t4g.small            ├─► admin  (Next.js)   ─┼─► api (NestJS) ─► Postgres
                                                └─► api ◄───────────────┘                └► Redis
 data disk (/data): database · Redis · receipts · certificates · secrets
 nightly: database dump + receipts → private S3 bucket (30 days) · daily disk snapshot (7 days)
```

## What it costs (Singapore, on-demand, approximate — check the AWS pricing calculator)

| Item | ~USD / month |
|---|---|
| EC2 `t4g.small` (2 vCPU, 2 GB) | ~15 |
| Public IPv4 address | ~3.6 |
| Disks: 20 GB system + 10 GB data (gp3) | ~3 |
| Snapshots, S3 backups, ECR images | ~1 |
| Data out (first 100 GB/month free) | ~0 |
| **Total** | **~22–25** |

Cheaper: `instance_type = "t4g.micro"` (1 GB) saves ~$7/month but is tight — Postgres, Redis and three Node apps
share 1 GB plus swap. Start with `t4g.small`; new AWS accounts usually get sign-up credits (see Billing → Credits).
A budget alert emails you when the month heads past `monthly_budget_usd` (default $30).

## One-time setup on your Mac

```bash
brew install terraform
brew install --cask session-manager-plugin     # remote shell on the server (no SSH keys, no open port 22)
aws configure                                   # an IAM user/SSO profile with admin rights; region ap-southeast-1
docker buildx version                           # Docker Desktop includes it
```

Keep the four repos side by side: `mgr_backend`, `mgr_frontEnd`, `mgr_admin`, `mgr_mobile`.

## 1. Create the infrastructure

```bash
cd mgr_backend/infra/aws/terraform
cp terraform.tfvars.example terraform.tfvars    # set budget_alert_email; optionally lock the admin site to your IP
terraform init
terraform plan                                  # read it: ~25 resources, nothing outside this project
terraform apply
```

This creates: the server (Ubuntu 24.04 ARM), its data disk, a fixed IP, a firewall that only opens 80/443,
three image registries, the private S3 bucket, daily disk snapshots and the budget alert.
Give the server ~3 minutes after `apply` to finish its first-boot setup (Docker, swap, data disk).

`terraform.tfstate` stays on your Mac (gitignored). It contains no passwords, but losing it means Terraform no longer
knows what it created — keep a copy somewhere safe.

## 2. Deploy the apps

```bash
cd mgr_backend
infra/aws/deploy.sh             # builds api + web + admin for ARM, pushes them, starts everything on the server
infra/aws/deploy.sh api         # later: redeploy only what changed (api, web and/or admin)
```

It prints the three addresses at the end. The first visit to each can take a few seconds while the HTTPS
certificate is issued. Database migrations run automatically every time the API starts.

On the first deploy the server generates its own secrets (database password, `JWT_SECRET`, `ADMIN_SECRET`) in
`/data/secrets.env`. They never pass through your Mac or Terraform. Nightly backups keep an encrypted copy in S3.

## 3. Create your admin account

```bash
aws ssm start-session --target "$(terraform -chdir=infra/aws/terraform output -raw instance_id)"
sudo -i
cd /opt/moneymgr
docker compose exec api node dist/admin.js create --email you@example.com --name "Your Name"   # asks for a password
exit
```

Then open the admin address and sign in; the first time it shows a QR code for your authenticator app.

## 4. Point the mobile app at it

In `mgr_mobile/.env`: `EXPO_PUBLIC_API_URL=https://api.<your-ip>.sslip.io` (the `api` URL from the deploy output).

## Day-to-day

| Task | How |
|---|---|
| Deploy a change | `infra/aws/deploy.sh [api] [web] [admin]` |
| Logs | session (step 3), then `cd /opt/moneymgr && docker compose logs -f --tail 100 api` |
| Status | `docker compose ps` |
| Roll back | set `API_TAG=<older tag>` in `/opt/moneymgr/deploy.env` (tags are in ECR, last 5 kept), then `bash /opt/moneymgr/up.sh` |
| Backup now | `sudo moneymgr-backup` |
| Restore the database | copy a dump from `s3://<ops_bucket>/backups/db/`, then `docker compose exec -T postgres pg_restore -U moneymgr -d moneymgr --clean < file.dump` |
| Server settings (e.g. email) | add lines to `/data/app.env` (e.g. `MAIL_TRANSPORT=smtp`, `SMTP_URL=…`, `MAIL_FROM=…`), then `bash /opt/moneymgr/up.sh` |
| Lock admin to your IP | `admin_allowed_cidrs = ["x.x.x.x/32"]` in tfvars → `terraform apply` → `infra/aws/deploy.sh admin` |
| Stop paying for it | `terraform destroy` (the data disk is protected; remove `prevent_destroy` first if you really mean it) |

## Known limits of the budget setup (and the upgrade path)

- **Email is logged, not sent** (`MAIL_TRANSPORT=log`): verification and password-reset emails don't go out yet.
  Sending needs a domain you own. With a domain (~$10/year): verify it in Amazon SES, request production access,
  put SMTP settings in `/data/app.env`.
- **One server**: an AWS hardware failure means downtime until the server is recreated (`terraform apply`) — the data
  disk, snapshots and S3 backups survive it. Upgrade path: RDS for Postgres, then ECS/Fargate behind a load balancer.
- **sslip.io names** work but look temporary, and share Let's Encrypt limits with other sslip.io users (Caddy falls
  back to ZeroSSL). With your own domain: set `domain = "example.com"` in tfvars, add A records for
  `app`, `api` and `admin` pointing at the IP, `terraform apply`, then `infra/aws/deploy.sh`.
- **Updates**: Ubuntu installs security updates automatically; Docker base images update when you redeploy.
- The API's scheduled jobs (recurring transactions, FX refresh) run inside the one API container — correct for one server.
