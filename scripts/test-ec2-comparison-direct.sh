#!/bin/bash
# Run this ON the EC2 jump box (or any host inside the VPC that can reach the comparison engine).
# Example: ssh ec2-user@<jump-box-public-ip>
#          curl -s http://172.31.7.215:8080/health

set -euo pipefail

CE_URL="${COMPARISON_ENGINE_URL:-http://172.31.7.215:8080}"
API_KEY="${COMPARISON_INTERNAL_API_KEY:-change-me-in-production}"
BUCKET="${COMPARISON_S3_BUCKET:-mirai-minds-s3}"
REGION="${AWS_REGION:-ap-southeast-2}"

echo "==> Health"
curl -sf "${CE_URL}/health"
echo ""

echo "==> Upload test files to S3"
cat > /tmp/preload.csv <<'EOF'
MATNR,NAME,QTY
100,Alpha,5
200,Beta,10
300,Gamma,1
EOF

cat > /tmp/postload.csv <<'EOF'
MATNR,NAME,QTY
100,Alpha,5
200,Beta,99
999,Extra,1
EOF

aws s3 cp /tmp/preload.csv "s3://${BUCKET}/test-ec2/preload.csv" --region "$REGION"
aws s3 cp /tmp/postload.csv "s3://${BUCKET}/test-ec2/postload.csv" --region "$REGION"

echo "==> POST /compare"
curl -sf -X POST "${CE_URL}/compare" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Api-Key: ${API_KEY}" \
  -d "{
    \"preloadS3Key\": \"test-ec2/preload.csv\",
    \"postloadS3Key\": \"test-ec2/postload.csv\",
    \"keyField\": \"MATNR\",
    \"identifierColumns\": [\"MATNR\"],
    \"bucket\": \"${BUCKET}\",
    \"batchId\": \"00000000-0000-4000-8000-000000000099\"
  }" | python3 -m json.tool

echo ""
echo "SUCCESS: comparison engine responded."
