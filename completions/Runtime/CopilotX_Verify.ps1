<#
    CopilotX_Verify.ps1
    Validates:
    - Config files
    - Agents
    - Extension
    - icon.png
    - JSON integrity
    - Node core files
    - Directory structure

    FIXES vs. original version:
    - Root path resolved dynamically instead of hardcoded.
    - Now also validates src/core/*.js and tests/router.test.js exist,
      since those are load-bearing for the extension and CI.
    - Added purple suggestion + resolution block at the end.
#>

param(
    [string]$RootOverride
)

$ErrorActionPreference = "Stop"

if ($RootOverride) {
    $Root = $RootOverride
}
elseif ($env:COPILOTX_ROOT) {
    $Root = $env:COPILOTX_ROOT
}
else {
    $Root = Split-Path -Parent $PSScriptRoot
}

if (-not (Test-Path $Root)) {
    Write-Host "Target root does not exist: $Root" -ForegroundColor Red
    throw "Verification aborted - invalid root path: $Root"
}

Set-Location $Root

$Config = Join-Path $Root "Config"
$Agents = Join-Path $Root "Agents"
$Extension = Join-Path $Root "CopilotX_Extension"
$Core = Join-Path $Root "src\core"
$Tests = Join-Path $Root "tests"
$Logs = Join-Path $Root "Logs"
$LogFile = Join-Path $Logs "Verify.log"

if (-not (Test-Path $Logs)) {
    New-Item -ItemType Directory -Force -Path $Logs | Out-Null
}

function Write-Log {
    param([string]$Message)
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $line = "$timestamp  $Message"
    $line | Out-File -FilePath $LogFile -Append -Encoding UTF8
    Write-Host $Message
}

Write-Log "=== CopilotX Verification Started ==="
Write-Log "Resolved root: $Root"

$Files = @(
    "$Config\actions.json",
    "$Config\agent.json",
    "$Config\environment.json",
    "$Config\multi-agent-system.json",
    "$Config\persona.json",
    "$Config\router.json",
    "$Config\runtime.json",
    "$Config\settings.json",
    "$Config\skills.json",
    "$Config\tasks.json",
    "$Config\tools.json",
    "$Config\validation.json",
    "$Config\workflow.json",

    "$Agents\Ask.agent.md",
    "$Agents\Custom.agent.md",
    "$Agents\Explore.agent.md",
    "$Agents\Plan.agent.md",

    "$Extension\extension.js",
    "$Extension\package.json",
    "$Extension\README.md",
    "$Extension\icon.png",

    "$Core\router.js",
    "$Core\agents.js",
    "$Core\logger.js",
    "$Tests\router.test.js"
)

$Failures = @()

foreach ($file in $Files) {

    if (-not (Test-Path $file)) {
        Write-Log "MISSING: $file"
        $Failures += $file
        continue
    }

    $fileObj = Get-Item $file
    $size = $fileObj.Length

    if ($size -lt 20) {
        Write-Log "CONTENT TOO SHORT (SIZE): $file"
        $Failures += $file
        continue
    }

    if ($file -like "*.json") {
        try {
            $null = Get-Content $file -Raw | ConvertFrom-Json
            Write-Log "VALID JSON: $file"
        }
        catch {
            Write-Log "INVALID JSON: $file"
            $Failures += $file
        }
    }
    else {
        Write-Log "TEXT OK: $file"
    }
}

# === Cross-check: agent identifiers must be lowercase and consistent
#     across router.json / tasks.json / agent.json (this was BUG-02) ===
try {
    $RouterConfig = Get-Content "$Config\router.json" -Raw | ConvertFrom-Json
    $AgentConfig = Get-Content "$Config\agent.json" -Raw | ConvertFrom-Json

    $routerKeys = $RouterConfig.routing.PSObject.Properties.Name | Sort-Object
    $agentKeys = $AgentConfig.agents.PSObject.Properties.Name | Sort-Object

    $expected = @("ask", "custom", "explore", "plan")

    if (($routerKeys -join ",") -ne ($expected -join ",")) {
        Write-Log "AGENT KEY MISMATCH in router.json: found [$($routerKeys -join ', ')]"
        $Failures += "router.json agent keys"
    }
    else {
        Write-Log "Agent key casing OK: router.json"
    }

    if (($agentKeys -join ",") -ne ($expected -join ",")) {
        Write-Log "AGENT KEY MISMATCH in agent.json: found [$($agentKeys -join ', ')]"
        $Failures += "agent.json agent keys"
    }
    else {
        Write-Log "Agent key casing OK: agent.json"
    }

    # v0.2.0: llmRouter section should exist for smart-router parity
    if ($null -eq $RouterConfig.llmRouter) {
        Write-Log "WARNING: router.json missing llmRouter section (smart router disabled)"
    }
    else {
        $mode = [string]$RouterConfig.llmRouter.mode
        if ($mode -notin @("fallback", "always", "off")) {
            Write-Log "WARNING: llmRouter.mode is '$mode' (expected fallback|always|off)"
        }
        else {
            Write-Log "llmRouter config OK (mode=$mode)"
        }
    }
}
catch {
    Write-Log "Could not run agent-key consistency check: $($_.Exception.Message)"
    $Failures += "agent-key consistency check"
}

# === Final Result ===
if ($Failures.Count -eq 0) {
    Write-Log "=== Verification SUCCESS ==="
    Write-Host "`nVerification SUCCESS." -ForegroundColor Green
}
else {
    Write-Log "=== Verification FAILED ==="
    Write-Host "`nVerification FAILED." -ForegroundColor Red
    Write-Host "Failed items:" -ForegroundColor Red
    $Failures | ForEach-Object { Write-Host $_ -ForegroundColor Red }
}

Write-Log "=== CopilotX Verification Completed ==="

# === Suggested next actions (purple) + resolution code (bright purple) ===
if ($Failures.Count -eq 0) {
    Write-Host "`nSuggested next action: run the Node test suite for a second, independent verification." -ForegroundColor DarkMagenta
    Write-Host "node ./tests/router.test.js" -ForegroundColor Magenta
}
else {
    Write-Host "`nSuggested next action: re-run startup, which will report the first missing dependency it hits." -ForegroundColor DarkMagenta
    Write-Host ".\CopilotX_Startup.ps1" -ForegroundColor Magenta
}
