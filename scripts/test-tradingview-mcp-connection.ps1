param(
    [int]$Port = 9222
)

$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$desktopRoot = Join-Path $projectRoot 'tools\tradingview-mcp'
$desktopCli = Join-Path $desktopRoot 'src\cli\index.js'

function Get-JsonFromNode {
    param(
        [string]$WorkingDir,
        [string[]]$Args
    )

    Push-Location $WorkingDir
    try {
        $raw = (& node @Args 2>&1 | Out-String).Trim()
        $json = $null
        try {
            $json = $raw | ConvertFrom-Json -ErrorAction Stop
        } catch {
            $json = $null
        }

        [pscustomobject]@{
            raw = $raw
            json = $json
            exitCode = $LASTEXITCODE
        }
    }
    finally {
        Pop-Location
    }
}

$desktopStatus = Get-JsonFromNode -WorkingDir $desktopRoot -Args @($desktopCli, 'status')
$desktopLaunch = $null
if (-not ($desktopStatus.json -and $desktopStatus.json.success -eq $true)) {
    $desktopLaunch = Get-JsonFromNode -WorkingDir $desktopRoot -Args @($desktopCli, 'launch')
    $desktopStatus = Get-JsonFromNode -WorkingDir $desktopRoot -Args @($desktopCli, 'status')
}

$uvVersion = (& uv --version 2>&1 | Out-String).Trim()
$uvOk = $LASTEXITCODE -eq 0

$screenerHelp = (& uv tool run --from git+https://github.com/atilaahmettaner/tradingview-mcp.git tradingview-mcp --help 2>&1 | Out-String).Trim()
$screenerOk = $LASTEXITCODE -eq 0 -and $screenerHelp -match 'TradingView Screener MCP server'

Write-Host '=== TradingView MCP Connection Check ==='
Write-Host "Project: $projectRoot"
Write-Host ''

Write-Host '[Desktop MCP]'
if ($desktopStatus.json -and $desktopStatus.json.success -eq $true) {
    Write-Host '- status: CONNECTED'
    Write-Host "- details: $($desktopStatus.raw)"
} else {
    Write-Host '- status: NOT CONNECTED'
    if ($desktopLaunch) {
        Write-Host "- launch attempt: $($desktopLaunch.raw)"
    }
    Write-Host "- final status: $($desktopStatus.raw)"
    Write-Host '- action: install/open TradingView Desktop and start with --remote-debugging-port=9222'
}

Write-Host ''
Write-Host '[Screener MCP]'
Write-Host "- uv: $uvVersion"
if ($screenerOk) {
    Write-Host '- status: READY'
} else {
    Write-Host '- status: NOT READY'
    Write-Host "- details: $screenerHelp"
}

if (($desktopStatus.json -and $desktopStatus.json.success -eq $true) -or $screenerOk) {
    exit 0
}

exit 1
