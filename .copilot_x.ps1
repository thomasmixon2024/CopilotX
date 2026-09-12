[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('launch')]
    [string]$Command = 'launch',

    [string]$Workspace = (Get-Location).Path,
    [string]$Provider = 'local',
    [string]$Model = 'open_router/anthropic/claude-sonnet-5',
    [string]$BaseUrl = 'http://127.0.0.1:8082/v1',
    [ValidateSet('off', 'approval', 'auto')]
    [string]$AllowWrites = 'approval',
    [string]$Prompt = ''
)

$ErrorActionPreference = 'Stop'

if ($Command -ne 'launch') {
    throw "Unknown command '$Command'. Use: .\.copilot_x.ps1 launch"
}

$launcher = Join-Path $PSScriptRoot 'scripts\copilotx.ps1'
if (-not (Test-Path -LiteralPath $launcher)) {
    throw "CopilotX launcher not found: $launcher"
}

$args = @{
    Workspace = $Workspace
    Provider = $Provider
    Model = $Model
    BaseUrl = $BaseUrl
    AllowWrites = $AllowWrites
}
if ($Prompt) { $args.Prompt = $Prompt }

& $launcher @args
exit $LASTEXITCODE
