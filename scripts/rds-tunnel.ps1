# SSH tunnel: local PC -> EC2 -> private RDS
# Usage (PowerShell):
#   .\scripts\rds-tunnel.ps1 -Ec2PublicIp "YOUR_EC2_PUBLIC_IP" -KeyPath "C:\path\to\your-key.pem"
#
# Keep this window open while developing locally.
# Then set in .env: RDSHOST=127.0.0.1  RDSPORT=5432

param(
  [Parameter(Mandatory = $true)]
  [string]$Ec2PublicIp,

  [Parameter(Mandatory = $true)]
  [string]$KeyPath,

  [string]$Ec2User = "ec2-user",
  [string]$RdsHost = "miraimindsdb2.cnasikoay15v.ap-southeast-2.rds.amazonaws.com",
  [int]$LocalPort = 5432,
  [int]$RdsPort = 5432
)

if (-not (Test-Path $KeyPath)) {
  Write-Error "Key file not found: $KeyPath"
  exit 1
}

Write-Host "Starting SSH tunnel..."
Write-Host "  Local:  127.0.0.1:$LocalPort"
Write-Host "  Remote: ${RdsHost}:$RdsPort via ${Ec2User}@${Ec2PublicIp}"
Write-Host ""
Write-Host "Keep this window open. In .env use:"
Write-Host "  RDSHOST=127.0.0.1"
Write-Host "  RDSPORT=$LocalPort"
Write-Host "  RDSUSER=miraiminds"
Write-Host ""

ssh -i $KeyPath -L "${LocalPort}:${RdsHost}:${RdsPort}" "${Ec2User}@${Ec2PublicIp}" -N
