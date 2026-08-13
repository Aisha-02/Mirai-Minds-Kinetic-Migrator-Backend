# Deploy comparison-engine on EC2 (no Docker required)

Use this when Docker is not available on your laptop. Python + systemd on EC2 is enough.

## Prerequisites

- EC2 instance in **ap-southeast-2** (same region as S3 `mirai-minds-s3` and RDS)
- Security group: inbound TCP **8080** from Node backend SG only
- IAM instance role with `s3:GetObject`, `s3:HeadObject` on `mirai-minds-s3/*`
- SSH access (key pair or jump box)

## Step 1 — Launch EC2 (if you don't have one yet)

AWS Console → EC2 → Launch instance:

| Setting | Value |
|---------|-------|
| Region | ap-southeast-2 |
| AMI | Amazon Linux 2023 |
| Type | t3.medium (or r6i.large for large files) |
| Subnet | Private subnet in your VPC |
| Security group | Allow 8080 from Node SG |
| IAM role | S3 read policy (see README) |

## Step 2 — Copy code to the instance

**From your Windows laptop (PowerShell):**

```powershell
# Zip the service folder
cd C:\Users\ve00ym783\Mirai-Minds-Kinetic-Migrator-Backend
Compress-Archive -Path services\comparison-engine\app,services\comparison-engine\comparison_engine,services\comparison-engine\requirements.txt,services\comparison-engine\scripts -DestinationPath comparison-engine.zip -Force

# SCP to EC2 (replace key and IP)
scp -i C:\path\to\your-key.pem comparison-engine.zip ec2-user@<EC2-PUBLIC-OR-JUMP-IP>:~/
```

**On the EC2 instance:**

```bash
mkdir -p ~/comparison-engine
cd ~/comparison-engine
unzip ~/comparison-engine.zip
chmod +x scripts/deploy-on-ec2.sh
```

Or clone from git if the repo is accessible:

```bash
git clone <your-repo-url>
cd Mirai-Minds-Kinetic-Migrator-Backend/services/comparison-engine
chmod +x scripts/deploy-on-ec2.sh
```

## Step 3 — Configure `.env` on EC2

```bash
sudo mkdir -p /opt/comparison-engine
sudo nano /opt/comparison-engine/.env
```

```env
COMPARISON_HOST=0.0.0.0
COMPARISON_PORT=8080
COMPARISON_INTERNAL_API_KEY=<same-as-node-src-env>
COMPARISON_DOWNLOAD_DIR=/tmp/comparison-engine
AWS_REGION=ap-southeast-2
```

Generate a secret: `openssl rand -hex 32`

## Step 4 — Run deploy script

```bash
cd ~/comparison-engine   # or wherever you unzipped/cloned
sudo ./scripts/deploy-on-ec2.sh
```

## Step 5 — Verify

```bash
curl http://localhost:8080/health
# {"status":"ok"}

# Get private IP for Node .env
curl -s http://169.254.169.254/latest/meta-data/local-ipv4
```

## Step 6 — Update Node backend `.env`

On the machine running Node (must reach EC2 private IP):

```env
COMPARISON_ENGINE_MODE=service
COMPARISON_ENGINE_URL=http://<EC2-PRIVATE-IP>:8080
COMPARISON_INTERNAL_API_KEY=<same-secret>
COMPARISON_S3_BUCKET=mirai-minds-s3
AWS_REGION=ap-southeast-2
```

Restart Node: `npm run dev`

## Useful commands on EC2

```bash
sudo systemctl status comparison-engine
sudo journalctl -u comparison-engine -f
sudo systemctl restart comparison-engine
```

## Optional — Docker + ECR later

When Docker is available (on EC2 or after installing Docker Desktop):

```bash
aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin 693268013066.dkr.ecr.ap-southeast-2.amazonaws.com
docker build -t comparison-engine .
docker tag comparison-engine:latest 693268013066.dkr.ecr.ap-southeast-2.amazonaws.com/comparison-engine:latest
docker push 693268013066.dkr.ecr.ap-southeast-2.amazonaws.com/comparison-engine:latest
```
