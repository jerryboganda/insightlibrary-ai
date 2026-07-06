# Local (Windows) deploy helper: push main to the VPS bare repo, then
# rebuild/restart the insight stack remotely. Usage:
#   .\deploy\scripts\deploy.ps1              # up -d --build
#   .\deploy\scripts\deploy.ps1 "ps"         # any compose args
param([string]$ComposeArgs = "up -d --build")

$ErrorActionPreference = "Stop"
git push vps main
ssh root@185.252.233.186 "bash /opt/insight/app/deploy/scripts/compose.sh $ComposeArgs"
