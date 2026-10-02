param([switch]$IntegrationTest)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not $env:REDIS_URL) {
    $redisAddress = ((& wsl.exe -d Ubuntu -- hostname -I) -join '').Trim().Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)[0]
    if ($LASTEXITCODE -ne 0 -or $redisAddress -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
        throw 'Could not find WSL Ubuntu. Start Redis separately and set REDIS_URL.'
    }
    New-Item -ItemType Directory -Path data -Force | Out-Null
    $passwordPath = Join-Path (Get-Location) 'data/local-redis-password'
    if (-not (Test-Path -LiteralPath $passwordPath)) {
        $random = New-Object byte[] 32
        $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($random) } finally { $generator.Dispose() }
        [System.IO.File]::WriteAllText($passwordPath, ([System.BitConverter]::ToString($random)).Replace('-', '').ToLowerInvariant())
    }
    $redisPassword = [System.IO.File]::ReadAllText($passwordPath).Trim()
    $reply = & wsl.exe -d Ubuntu -- env "REDISCLI_AUTH=$redisPassword" sh -c 'redis-cli -p 6380 --no-auth-warning PING 2>/dev/null'
    if (($reply -join '').Trim() -ne 'PONG') {
        $config = @"
bind 127.0.0.1 $redisAddress
port 6380
protected-mode yes
requirepass $redisPassword
save ""
appendonly no
daemonize yes
pidfile /tmp/cricket-redis-6380.pid
logfile /tmp/cricket-redis-6380.log
"@
        $config | & wsl.exe -d Ubuntu -- redis-server /dev/stdin
        if ($LASTEXITCODE -ne 0) { throw 'Could not start local Redis. Check /tmp/cricket-redis-6380.log in WSL.' }
    }
    $env:REDIS_URL = "redis://:$redisPassword@${redisAddress}:6380"
}

if ($IntegrationTest) {
    $env:REDIS_TEST_URL = $env:REDIS_URL
    & npm.cmd run test:integration
} else {
    & node.exe server.js
}
exit $LASTEXITCODE
