[CmdletBinding()]
param(
    [string]$Workspace = (Get-Location).Path,
    [string]$Provider = 'local',
    [string]$Model = 'open_router/anthropic/claude-sonnet-5',
    [string]$BaseUrl = 'http://127.0.0.1:8082/v1',
    [ValidateSet('off', 'approval', 'auto')]
    [string]$AllowWrites = 'approval',
    [string]$Prompt = '',
    [switch]$NoColor
)

$ErrorActionPreference = 'Stop'
$cli = Join-Path $PSScriptRoot 'copilotx-cli.js'
if (-not (Test-Path -LiteralPath $cli)) {
    throw "CopilotX CLI not found: $cli"
}

$args = @(
    '--workspace', $Workspace,
    '--provider', $Provider,
    '--model', $Model,
    '--base-url', $BaseUrl,
    '--allow-writes', $AllowWrites
)
if ($Prompt) { $args += @('--prompt', $Prompt) }
if ($NoColor) { $args += '--no-color' }

& node $cli @args
exit $LASTEXITCODE
