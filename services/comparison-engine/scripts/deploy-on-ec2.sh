#!/bin/bash
# Run this ON the EC2 instance (Amazon Linux 2023 / Ubuntu).
# Usage:
#   chmod +x deploy-on-ec2.sh
#   sudo ./deploy-on-ec2.sh
#
# Before running, edit /opt/comparison-engine/.env (see below).

set -euo pipefail

APP_DIR=/opt/comparison-engine
SERVICE_USER=ec2-user
PYTHON_BIN=python3

if id ubuntu &>/dev/null; then
  SERVICE_USER=ubuntu
fi

echo "==> Installing system packages"
if command -v yum &>/dev/null; then
  sudo yum update -y
  sudo yum install -y python3 python3-pip git
elif command -v apt-get &>/dev/null; then
  sudo apt-get update -y
  sudo apt-get install -y python3 python3-pip python3-venv git
else
  echo "Unsupported OS. Install python3 and pip manually."
  exit 1
fi

echo "==> Setting up ${APP_DIR}"
sudo mkdir -p "${APP_DIR}"
sudo chown "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"

if [ ! -f "${APP_DIR}/.env" ]; then
  cat > "${APP_DIR}/.env" <<'EOF'
COMPARISON_HOST=0.0.0.0
COMPARISON_PORT=8080
COMPARISON_INTERNAL_API_KEY=change-me-in-production
COMPARISON_DOWNLOAD_DIR=/tmp/comparison-engine
COMPARISON_ASYNC_ROW_THRESHOLD=50000
COMPARISON_ASYNC_FILE_SIZE_BYTES=10485760
AWS_REGION=ap-southeast-2
EOF
  echo "Created ${APP_DIR}/.env — EDIT COMPARISON_INTERNAL_API_KEY before starting!"
fi

echo "==> Copy application files into ${APP_DIR}"
# If run from repo checkout on the instance:
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
rsync -a --delete \
  --exclude '__pycache__' --exclude '.pytest_cache' --exclude 'tests' \
  "${SRC_DIR}/app" "${SRC_DIR}/comparison_engine" "${SRC_DIR}/requirements.txt" \
  "${APP_DIR}/"

echo "==> Installing Python dependencies"
cd "${APP_DIR}"
${PYTHON_BIN} -m pip install --user -r requirements.txt

PRIVATE_IP=$(curl -sf http://169.254.169.254/latest/meta-data/local-ipv4 || hostname -I | awk '{print $1}')
echo "Instance private IP: ${PRIVATE_IP}"
echo "Node COMPARISON_ENGINE_URL should be: http://${PRIVATE_IP}:8080"

echo "==> Installing systemd service"
sudo tee /etc/systemd/system/comparison-engine.service > /dev/null <<EOF
[Unit]
Description=Comparison Engine (FastAPI)
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=${PYTHON_BIN} -m uvicorn app.main:app --host 0.0.0.0 --port 8080
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable comparison-engine
sudo systemctl restart comparison-engine

sleep 2
curl -sf "http://localhost:8080/health"
echo ""
echo "SUCCESS: comparison-engine is running."
echo "Check logs: sudo journalctl -u comparison-engine -f"
