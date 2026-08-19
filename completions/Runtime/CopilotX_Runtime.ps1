<#
    CopilotX_Runtime.ps1
    Main execution engine for CopilotX.
    Responsibilities:
    - Load config system
    - Load agents
    - Load router, tools, tasks
    - Execute workflows
    - Multi-agent orchestration
    - Logging

    FIXES vs. original version (see AUDIT_UPGRADE_REPORT.md):
    - BUG-01: Router previously read $RouterConfig.routes, but router.json
      only has a .routing property. Fixed to read the correct property and
      to actually resolve an agent from keyword intents instead of always
      returning null.
    - BUG-02: Agent keys are now lowercase everywhere ("ask", "explore",
      "plan", "custom"), matching every Config/*.json file exactly. The
      old PascalCase switch never matched the lowercase config keys.
    - BUG-03: Invoke-Agent no longer returns a hardcoded stub string. It
      loads the matched agent's persona .md file and either calls the
      Claude API (if $env:ANTHROPIC_API_KEY is set) or builds a
      deterministic, persona-grounded response.
    - Root path resolved dynamically instead of hardcoded to an Android
      path, so this runs correctly on Windows.
    - Runtime loop now supports a -OneShot parameter for non-interactive /
      scripted / CI use, in addition to the original interactive loop.
#>

param(
    [string]$RootOverride,
    [string]$OneShot   # if provided, process this single input and exit instead of looping
)

$ErrorActionPreference = "Stop"

# === RULE 1: DIRECTORY ENFORCEMENT (FIRST ACTION) ===
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
    throw "Runtime aborted - invalid root path: $Root"
}

Set-Location $Root

$Config = Join-Path $Root "Config"
$Agents = Join-Path $Root "Agents"
$Logs = Join-Path $Root "Logs"
$LogFile = Join-Path $Logs "Runtime.log"

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

function Load-Json {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        throw "Missing JSON file: $Path"
    }

    $size = (Get-Item $Path).Length
    if ($size -lt 20) {
        throw "JSON file too small: $Path"
    }

    try {
        return (Get-Content $Path -Raw | ConvertFrom-Json)
    }
    catch {
        throw "Invalid JSON: $Path"
    }
}

# === Tokenize input into lowercase words (mirrors src/core/router.js) ===
function Get-Tokens {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return @() }
    $lower = $Text.ToLowerInvariant()
    return ($lower -split '[^a-z0-9]+') | Where-Object { $_.Length -gt 0 }
}

# === FIX for BUG-01/BUG-02 + v0.2.0 smart router parity ===
# Mirrors src/core/router.js: keyword scoring + optional LLM classification
function Resolve-Agent {
    param(
        [Parameter(Mandatory = $true)] $RouterConfig,
        [Parameter(Mandatory = $true)] [string]$Input,
        [switch]$ForceLlm
    )

    $tokens = Get-Tokens -Text $Input
    $candidates = @()

    foreach ($agentKey in $RouterConfig.routing.PSObject.Properties.Name) {
        $entry = $RouterConfig.routing.$agentKey
        $intents = @($entry.intent)
        $matched = @($intents | Where-Object { $tokens -contains $_.ToLowerInvariant() })
        $matchCount = $matched.Count

        if ($matchCount -gt 0) {
            $candidates += [PSCustomObject]@{
                Agent           = $agentKey
                MatchedKeywords = $matched
                Score           = $matchCount
            }
        }
    }

    $candidates = $candidates | Sort-Object -Property Score -Descending

    $keywordResult = $null
    if ($candidates.Count -eq 1) {
        $keywordResult = [PSCustomObject]@{
            Agent           = $candidates[0].Agent
            MatchedKeywords = $candidates[0].MatchedKeywords
            Reason          = "keyword-match"
            LlmUsed         = $false
        }
    }
    elseif ($candidates.Count -gt 1) {
        $topScore = $candidates[0].Score
        $top = @($candidates | Where-Object { $_.Score -eq $topScore })
        if ($top.Count -eq 1) {
            $keywordResult = [PSCustomObject]@{
                Agent           = $top[0].Agent
                MatchedKeywords = $top[0].MatchedKeywords
                Reason          = "keyword-match"
                LlmUsed         = $false
            }
        }
        else {
            $ambiguous = $RouterConfig.rules.ambiguousIntent
            if (-not $ambiguous) { $ambiguous = $top[0].Agent }
            $keywordResult = [PSCustomObject]@{
                Agent           = $ambiguous
                MatchedKeywords = $top[0].MatchedKeywords
                Reason          = "keyword-ambiguous"
                LlmUsed         = $false
            }
        }
    }
    else {
        $fallback = $RouterConfig.rules.missingIntent
        if (-not $fallback) { $fallback = $RouterConfig.defaultAgent }
        if (-not $fallback) { $fallback = "ask" }
        $keywordResult = [PSCustomObject]@{
            Agent           = $fallback
            MatchedKeywords = @()
            Reason          = "fallback-missing-intent"
            LlmUsed         = $false
        }
    }

    # Optional LLM escalation (parity with Node resolveAgentAsync)
    $llmCfg = $RouterConfig.llmRouter
    $llmEnabled = $true
    $llmMode = "fallback"
    if ($llmCfg) {
        if ($null -ne $llmCfg.enabled) { $llmEnabled = [bool]$llmCfg.enabled }
        if ($llmCfg.mode) { $llmMode = [string]$llmCfg.mode }
    }

    $shouldTryLlm = $ForceLlm -or (
        $llmEnabled -and (
            $llmMode -eq "always" -or
            ($llmMode -eq "fallback" -and (
                $keywordResult.Reason -eq "fallback-missing-intent" -or
                $keywordResult.Reason -eq "keyword-ambiguous"
            ))
        )
    )

    if (-not $shouldTryLlm) {
        return $keywordResult
    }

    $apiKey = $env:ANTHROPIC_API_KEY
    if (-not $apiKey) {
        Write-Log "LLM router requested but ANTHROPIC_API_KEY not set; using keyword result"
        return $keywordResult
    }

    try {
        Write-Log "Escalating to LLM router (reason: $($keywordResult.Reason))"
        $llmAgent = Invoke-LlmClassify -UserInput $Input -ApiKey $apiKey -RouterConfig $RouterConfig
        $valid = @("ask", "explore", "plan", "custom")
        if ($valid -contains $llmAgent) {
            return [PSCustomObject]@{
                Agent           = $llmAgent
                MatchedKeywords = $keywordResult.MatchedKeywords
                Reason          = "llm-classification"
                LlmUsed         = $true
            }
        }
        Write-Log "LLM returned unexpected agent '$llmAgent'; falling back to keyword result"
    }
    catch {
        Write-Log "LLM router failed ($($_.Exception.Message)); falling back to keyword result"
    }

    return $keywordResult
}

function Invoke-LlmClassify {
    param(
        [string]$UserInput,
        [string]$ApiKey,
        $RouterConfig
    )

    $llmCfg = $RouterConfig.llmRouter
    $model = "claude-sonnet-4-6"
    $maxTokens = 32
    $system = "You are an intent classifier for a multi-agent system. Given a user message, reply with ONLY one of these exact agent keys: ask, explore, plan, custom.`n`n- ask: analytical reasoning, explanation, clarification, questions about how/why/what`n- explore: brainstorming, ideation, creative expansion, listing alternatives`n- plan: sequencing steps, workflows, roadmaps, prioritization`n- custom: specialized domain tasks, execution, applying specific rules`n`nReply with nothing but the single lowercase agent key."

    if ($llmCfg) {
        if ($llmCfg.model) { $model = [string]$llmCfg.model }
        if ($llmCfg.maxTokens) { $maxTokens = [int]$llmCfg.maxTokens }
        if ($llmCfg.systemPrompt) { $system = [string]$llmCfg.systemPrompt }
    }

    $bodyObj = @{
        model      = $model
        max_tokens = $maxTokens
        system     = $system
        messages   = @(@{ role = "user"; content = $UserInput.Substring(0, [Math]::Min(2000, $UserInput.Length)) })
    }
    $body = $bodyObj | ConvertTo-Json -Depth 6

    $headers = @{
        "x-api-key"         = $ApiKey
        "anthropic-version" = "2023-06-01"
        "Content-Type"      = "application/json"
    }

    $response = Invoke-RestMethod -Uri "https://api.anthropic.com/v1/messages" `
        -Method Post -Headers $headers -Body $body -TimeoutSec 15

    $text = ($response.content[0].text).Trim().ToLowerInvariant()
    if ($text -match '\b(ask|explore|plan|custom)\b') {
        return $Matches[1]
    }
    return ($text -split '\s+')[0]
}

# === FIX for BUG-03: real Invoke-Agent that loads persona + optionally calls Claude API ===
$AgentFileMap = @{
    "ask"     = "Ask.agent.md"
    "explore" = "Explore.agent.md"
    "plan"    = "Plan.agent.md"
    "custom"  = "Custom.agent.md"
}

function Invoke-ClaudeApi {
    param(
        [string]$Persona,
        [string]$UserInput,
        [string]$ApiKey
    )

    $body = @{
        model      = "claude-sonnet-4-6"
        max_tokens = 1000
        system     = $Persona
        messages   = @(@{ role = "user"; content = $UserInput })
    } | ConvertTo-Json -Depth 6

    $headers = @{
        "x-api-key"         = $ApiKey
        "anthropic-version" = "2023-06-01"
        "Content-Type"      = "application/json"
    }

    $response = Invoke-RestMethod -Uri "https://api.anthropic.com/v1/messages" `
        -Method Post -Headers $headers -Body $body -TimeoutSec 30

    return $response.content[0].text
}

function Invoke-Agent {
    param(
        [string]$AgentKey,
        [string]$UserInput,
        [string[]]$MatchedKeywords,
        $TasksConfig,
        $AgentConfig,
        $ActionsConfig
    )

    Write-Log "Agent invoked: $AgentKey"

    $fileName = $AgentFileMap[$AgentKey]
    if (-not $fileName) {
        Write-Log "Unknown agent: $AgentKey"
        return "Unknown agent: $AgentKey"
    }

    $personaPath = Join-Path $Agents $fileName
    if (-not (Test-Path $personaPath)) {
        Write-Log "Missing persona file for agent: $AgentKey"
        return "Error: missing persona file for agent $AgentKey"
    }
    $persona = Get-Content $personaPath -Raw

    $apiKey = $env:ANTHROPIC_API_KEY
    if ($apiKey) {
        try {
            Write-Log "Agent ${AgentKey}: calling Claude API (live mode)"
            return (Invoke-ClaudeApi -Persona $persona -UserInput $UserInput -ApiKey $apiKey)
        }
        catch {
            Write-Log "Agent ${AgentKey}: live API call failed ($($_.Exception.Message)), falling back to deterministic engine"
        }
    }

    Write-Log "Agent ${AgentKey}: using deterministic engine"
    return (Build-DeterministicResponse -AgentKey $AgentKey -Persona $persona `
        -UserInput $UserInput -MatchedKeywords $MatchedKeywords `
        -TasksConfig $TasksConfig -AgentConfig $AgentConfig -ActionsConfig $ActionsConfig)
}

function Get-PersonaSection {
    param([string]$Persona, [string]$Heading)
    $pattern = "(?ms)^##\s*$([regex]::Escape($Heading))\s*\r?\n(.*?)(?=^##\s|\z)"
    $m = [regex]::Match($Persona, $pattern)
    if ($m.Success) { return $m.Groups[1].Value.Trim() }
    return ""
}

function Build-DeterministicResponse {
    param(
        [string]$AgentKey,
        [string]$Persona,
        [string]$UserInput,
        [string[]]$MatchedKeywords,
        $TasksConfig,
        $AgentConfig,
        $ActionsConfig
    )

    $purpose = Get-PersonaSection -Persona $Persona -Heading "Purpose"
    $behaviors = Get-PersonaSection -Persona $Persona -Heading "Core Behaviors"

    $matchingTask = $null
    if ($TasksConfig -and $TasksConfig.tasks) {
        $matchingTask = $TasksConfig.tasks.PSObject.Properties.Value |
            Where-Object { $_.agent -eq $AgentKey } |
            Select-Object -First 1
    }

    $actionNames = @()
    if ($matchingTask -and $matchingTask.actions) {
        $actionNames = @($matchingTask.actions)
    }
    elseif ($AgentConfig -and $AgentConfig.agents -and $AgentConfig.agents.$AgentKey -and $AgentConfig.agents.$AgentKey.capabilities) {
        $actionNames = @($AgentConfig.agents.$AgentKey.capabilities)
    }

    $keywordSummary = if ($MatchedKeywords -and $MatchedKeywords.Count -gt 0) {
        $MatchedKeywords -join ", "
    } else {
        "none (fallback routing)"
    }

    $intent = $UserInput.Trim()
    if ($intent.Length -gt 120) { $intent = $intent.Substring(0, 117) + "..." }

    $actionLines = @()
    foreach ($name in $actionNames) {
        $desc = "Execute this action against the input."
        if ($ActionsConfig -and $ActionsConfig.actions -and $ActionsConfig.actions.$name) {
            $meta = $ActionsConfig.actions.$name
            if ($meta.description) { $desc = [string]$meta.description }
        }
        $actionLines += "  - ${name}: $desc"
    }
    if ($actionLines.Count -eq 0) {
        $actionLines = @("  - (no actions registered for this agent)")
    }

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("[$($AgentKey.ToUpper()) AGENT]") | Out-Null
    $lines.Add("Routed on keyword match: $keywordSummary") | Out-Null
    $lines.Add("") | Out-Null
    $lines.Add("Input: $UserInput") | Out-Null
    $lines.Add("") | Out-Null

    if ($purpose) {
        $lines.Add("Persona purpose:") | Out-Null
        foreach ($ln in ($purpose -split "`n")) {
            $lines.Add("  $($ln.Trim())") | Out-Null
        }
        $lines.Add("") | Out-Null
    }

    if ($behaviors) {
        $lines.Add("Core behaviors:") | Out-Null
        $count = 0
        foreach ($ln in ($behaviors -split "`n")) {
            $t = $ln.Trim()
            if (-not $t) { continue }
            $lines.Add("  $t") | Out-Null
            $count++
            if ($count -ge 6) { break }
        }
        $lines.Add("") | Out-Null
    }

    $lines.Add("Structured response (deterministic engine):") | Out-Null

    switch ($AgentKey) {
        "ask" {
            $lines.Add("1. Interpret intent") | Out-Null
            $lines.Add("   Core question detected: `"$intent`"") | Out-Null
            $lines.Add("") | Out-Null
            $lines.Add("2. Identify missing context") | Out-Null
            $lines.Add("   - What is the desired outcome or success criteria?") | Out-Null
            $lines.Add("   - Are there constraints (time, tools, scope) not stated?") | Out-Null
            $lines.Add("   - Is any domain background required?") | Out-Null
            $lines.Add("") | Out-Null
            $lines.Add("3. Structured reasoning") | Out-Null
            $lines.Add("   Applying registered actions:") | Out-Null
            foreach ($a in $actionLines) { $lines.Add($a) | Out-Null }
            $lines.Add("") | Out-Null
            $lines.Add("   Reasoning sketch:") | Out-Null
            $lines.Add("   - Restate the request in precise terms: $intent") | Out-Null
            $lines.Add("   - Separate known facts from assumptions.") | Out-Null
            $lines.Add("   - Break the problem into the smallest useful parts.") | Out-Null
            $lines.Add("   - Prefer the simplest path that satisfies the stated need.") | Out-Null
            $lines.Add("") | Out-Null
            $lines.Add("4. Actionable next steps") | Out-Null
            $lines.Add("   - Confirm or supply any missing context listed above.") | Out-Null
            $lines.Add("   - Choose one part of the breakdown to resolve first.") | Out-Null
            $lines.Add("   - Re-run with more detail if the answer needs more depth.") | Out-Null
        }
        "explore" {
            $lines.Add("1. Expand the prompt") | Out-Null
            $lines.Add("   Seed idea: `"$intent`"") | Out-Null
            $lines.Add("") | Out-Null
            $lines.Add("2. Generate alternative directions") | Out-Null
            $lines.Add("   Applying registered actions:") | Out-Null
            foreach ($a in $actionLines) { $lines.Add($a) | Out-Null }
            $lines.Add("") | Out-Null
            $lines.Add("   Candidate angles:") | Out-Null
            $lines.Add("   A. Literal / direct interpretation of the request.") | Out-Null
            $lines.Add("   B. Adjacent or related problem that might be more valuable.") | Out-Null
            $lines.Add("   C. Inversion: what if the opposite goal were true?") | Out-Null
            $lines.Add("   D. Constraint-free version: ignore limits and list ideal outcomes.") | Out-Null
            $lines.Add("   E. Minimal version: the smallest useful variant of the idea.") | Out-Null
            $lines.Add("") | Out-Null
            $lines.Add("3. Variations and combinations") | Out-Null
            $lines.Add("   - Mix A+E for a practical quick win.") | Out-Null
            $lines.Add("   - Mix B+D for a longer-term exploration track.") | Out-Null
            $lines.Add("   - Surface any angle that feels surprising relative to the seed.") | Out-Null
            $lines.Add("") | Out-Null
            $lines.Add("4. Suggested exploration next steps") | Out-Null
            $lines.Add("   - Pick 1-2 angles to develop further.") | Out-Null
            $lines.Add("   - Ask the Plan agent to sequence the chosen direction.") | Out-Null
            $lines.Add("   - Or refine the seed and re-run Explore for a tighter set.") | Out-Null
        }
        "plan" {
            $lines.Add("1. Sequence the work") | Out-Null
            $lines.Add("   Goal under planning: `"$intent`"") | Out-Null
            $lines.Add("") | Out-Null
            $lines.Add("2. Identify dependencies") | Out-Null
            $lines.Add("   Applying registered actions:") | Out-Null
            foreach ($a in $actionLines) { $lines.Add($a) | Out-Null }
            $lines.Add("") | Out-Null
            $lines.Add("   Draft sequence:") | Out-Null
            $lines.Add("   Step 1  Clarify success criteria and constraints.") | Out-Null
            $lines.Add("   Step 2  List required inputs, tools, and prior decisions.") | Out-Null
            $lines.Add("   Step 3  Order remaining work by dependency (blockers first).") | Out-Null
            $lines.Add("   Step 4  Assign rough effort or risk to each step.") | Out-Null
            $lines.Add("   Step 5  Define a minimal first milestone that proves value.") | Out-Null
            $lines.Add("") | Out-Null
            $lines.Add("3. Workflow sketch") | Out-Null
            $lines.Add("   [Clarify] -> [Gather inputs] -> [Execute ordered steps] -> [Review milestone]") | Out-Null
            $lines.Add("   Feedback loops: any failed step returns to Clarify or Gather.") | Out-Null
            $lines.Add("") | Out-Null
            $lines.Add("4. Next planning actions") | Out-Null
            $lines.Add("   - Confirm or edit the draft sequence.") | Out-Null
            $lines.Add("   - Hand the first milestone to the Custom or Ask agent for execution detail.") | Out-Null
            $lines.Add("   - Re-run Plan after major scope changes.") | Out-Null
        }
        "custom" {
            $lines.Add("1. Interpret custom / domain intent") | Out-Null
            $lines.Add("   Request: `"$intent`"") | Out-Null
            $lines.Add("") | Out-Null
            $lines.Add("2. Apply domain-oriented actions") | Out-Null
            $lines.Add("   Applying registered actions:") | Out-Null
            foreach ($a in $actionLines) { $lines.Add($a) | Out-Null }
            $lines.Add("") | Out-Null
            $lines.Add("   Execution outline:") | Out-Null
            $lines.Add("   - Map the request onto the nearest registered custom action.") | Out-Null
            $lines.Add("   - Apply any explicit rules or constraints stated in the input.") | Out-Null
            $lines.Add("   - Produce structured output suitable for downstream agents.") | Out-Null
            $lines.Add("   - Flag any part of the request that has no matching rule yet.") | Out-Null
            $lines.Add("") | Out-Null
            $lines.Add("3. Integration notes") | Out-Null
            $lines.Add("   - Results can be passed to Ask (for explanation) or Plan (for sequencing).") | Out-Null
            $lines.Add("   - Extend Config/actions.json and this persona when new domain rules appear.") | Out-Null
            $lines.Add("") | Out-Null
            $lines.Add("4. Next steps") | Out-Null
            $lines.Add("   - Supply explicit rules or domain data if the outline above is too generic.") | Out-Null
            $lines.Add("   - Re-run Custom after updating actions or persona for tighter behavior.") | Out-Null
        }
        default {
            $lines.Add("Structured pass for agent `"$AgentKey`".") | Out-Null
            foreach ($a in $actionLines) { $lines.Add($a) | Out-Null }
        }
    }

    $lines.Add("") | Out-Null
    $lines.Add("---") | Out-Null
    $lines.Add("Mode: deterministic. This response is built from the agent persona, Config/tasks.json, and Config/actions.json without calling an external model. Set ANTHROPIC_API_KEY to obtain a live model-generated response grounded in the same persona.") | Out-Null

    return ($lines -join "`n")
}


# === Phase 1 parity: Workspace context helper ===
function Get-WorkspaceContext {
    param(
        [string]$WorkspaceRoot,
        [string]$ActiveFile,
        [string]$SelectionText,
        [int]$SelectionStartLine = 0,
        [int]$SelectionEndLine = 0,
        [string[]]$OpenTabs,
        [string[]]$ProjectTree
    )

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("@workspace context:") | Out-Null

    if ($WorkspaceRoot) {
        $lines.Add("Workspace root: $WorkspaceRoot") | Out-Null
    }
    if ($OpenTabs -and $OpenTabs.Count -gt 0) {
        $lines.Add("Open tabs:") | Out-Null
        foreach ($t in $OpenTabs) { $lines.Add("  - $t") | Out-Null }
    }
    if ($ActiveFile) {
        $lines.Add("Active file: $ActiveFile") | Out-Null
        if ($SelectionText) {
            $lines.Add("Selection (lines $SelectionStartLine-$SelectionEndLine):") | Out-Null
            $lines.Add('```') | Out-Null
            $lines.Add($SelectionText) | Out-Null
            $lines.Add('```') | Out-Null
        }
        elseif (Test-Path $ActiveFile) {
            try {
                $content = Get-Content $ActiveFile -Raw -ErrorAction Stop
                if ($content.Length -gt 8000) {
                    $content = $content.Substring(0, 7980) + "`n...[truncated]..."
                }
                $lines.Add("Active file content (truncated if large):") | Out-Null
                $lines.Add('```') | Out-Null
                $lines.Add($content) | Out-Null
                $lines.Add('```') | Out-Null
            } catch {
                $lines.Add("(could not read active file)") | Out-Null
            }
        }
    }
    if ($ProjectTree -and $ProjectTree.Count -gt 0) {
        $lines.Add("Project tree (limited):") | Out-Null
        foreach ($p in ($ProjectTree | Select-Object -First 80)) {
            $lines.Add("  $p") | Out-Null
        }
    }

    if ($lines.Count -le 1) { return "" }
    return ($lines -join "`n")
}

# === Phase 2: Tool runner parity ===
function Test-PathSafe {
    param([string]$WorkspaceRoot, [string]$Candidate)
    $root = [System.IO.Path]::GetFullPath($WorkspaceRoot)
    $target = [System.IO.Path]::GetFullPath((Join-Path $root $Candidate))
    if ($target.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $target.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Invoke-CopilotXTool {
    param(
        [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
        [Parameter(Mandatory = $true)]$Payload,
        [switch]$AllowTerminal,
        [string[]]$AllowedCommands = @("echo", "node", "npm", "dir", "ls", "type", "cat")
    )

    if (-not $Payload -or -not $Payload.type) {
        return [PSCustomObject]@{ ok = $false; error = "payload must include type" }
    }

    $type = ([string]$Payload.type).ToUpperInvariant()

    switch ($type) {
        "FILE_CREATE" {
            $rel = [string]$Payload.path
            if (-not (Test-PathSafe -WorkspaceRoot $WorkspaceRoot -Candidate $rel)) {
                return [PSCustomObject]@{ ok = $false; error = "path traversal blocked or path not safe" }
            }
            $abs = Join-Path $WorkspaceRoot $rel
            try {
                $dir = Split-Path -Parent $abs
                if (-not (Test-Path $dir)) {
                    New-Item -ItemType Directory -Force -Path $dir | Out-Null
                }
                if ((Test-Path $abs) -and -not $Payload.overwrite) {
                    return [PSCustomObject]@{ ok = $false; error = "file already exists (set overwrite:true to replace)" }
                }
                $content = if ($null -ne $Payload.content) { [string]$Payload.content } else { "" }
                Set-Content -Path $abs -Value $content -Encoding UTF8 -NoNewline
                return [PSCustomObject]@{ ok = $true; path = $abs; action = "FILE_CREATE" }
            }
            catch {
                return [PSCustomObject]@{ ok = $false; error = $_.Exception.Message }
            }
        }
        "FILE_PATCH" {
            $rel = [string]$Payload.path
            if (-not (Test-PathSafe -WorkspaceRoot $WorkspaceRoot -Candidate $rel)) {
                return [PSCustomObject]@{ ok = $false; error = "path traversal blocked or path not safe" }
            }
            $abs = Join-Path $WorkspaceRoot $rel
            if (-not (Test-Path $abs)) {
                return [PSCustomObject]@{ ok = $false; error = "target file does not exist: $rel" }
            }
            # PowerShell applies a simplified line-based patch: payload may include
            # .replaceOld / .replaceNew for structural parity when full unified
            # diff application is not required. Prefer Node tools.js for complex diffs.
            if ($Payload.replaceOld -and $null -ne $Payload.replaceNew) {
                try {
                    $original = Get-Content $abs -Raw
                    if ($original -notlike "*$($Payload.replaceOld)*") {
                        return [PSCustomObject]@{ ok = $false; error = "replaceOld text not found in file" }
                    }
                    $updated = $original.Replace([string]$Payload.replaceOld, [string]$Payload.replaceNew)
                    Set-Content -Path $abs -Value $updated -Encoding UTF8 -NoNewline
                    return [PSCustomObject]@{ ok = $true; path = $abs; action = "FILE_PATCH" }
                }
                catch {
                    return [PSCustomObject]@{ ok = $false; error = $_.Exception.Message }
                }
            }
            return [PSCustomObject]@{
                ok = $false
                error = "FILE_PATCH in PowerShell requires replaceOld/replaceNew (use Node tools.js for unified diffs)"
            }
        }
        "TERMINAL_EXEC" {
            if (-not $AllowTerminal) {
                return [PSCustomObject]@{
                    ok = $false
                    error = "TERMINAL_EXEC disabled (pass -AllowTerminal to enable)"
                }
            }
            $command = [string]$Payload.command
            if ([string]::IsNullOrWhiteSpace($command)) {
                return [PSCustomObject]@{ ok = $false; error = "TERMINAL_EXEC requires command" }
            }
            $base = ($command -split '\s+')[0]
            if ($AllowedCommands -notcontains $base) {
                return [PSCustomObject]@{
                    ok = $false
                    error = "command '$base' not in allowlist: $($AllowedCommands -join ', ')"
                }
            }
            try {
                Push-Location $WorkspaceRoot
                $output = Invoke-Expression $command 2>&1 | Out-String
                Pop-Location
                return [PSCustomObject]@{
                    ok = $true
                    action = "TERMINAL_EXEC"
                    stdout = $output
                }
            }
            catch {
                Pop-Location -ErrorAction SilentlyContinue
                return [PSCustomObject]@{ ok = $false; error = $_.Exception.Message }
            }
        }
        default {
            return [PSCustomObject]@{ ok = $false; error = "unknown tool type: $($Payload.type)" }
        }
    }
}



# === Phase 3: Inline completion parity (CLI / terminal) ===
function Get-CopilotXCompletion {
    param(
        [string]$Prefix = "",
        [string]$Suffix = "",
        [string]$LanguageId = "javascript"
    )

    $line = ($Prefix -split "`n")[-1]
    $indent = ""
    if ($line -match '^(\s*)') { $indent = $Matches[1] }

    # Mirror a subset of the Node local pattern library
    if ($Prefix -match 'function\s+\w+\s*\([^)]*\)\s*\{\s*$' -or $Prefix -match '=>\s*\{\s*$') {
        return [PSCustomObject]@{ insertText = "`n${indent}  // TODO`n${indent}"; source = "local" }
    }
    if ($line -match '\breturn\s+$') {
        return [PSCustomObject]@{ insertText = "undefined;"; source = "local" }
    }
    if ($line -match '\b(const|let|var)\s+\w+\s*=\s*$') {
        return [PSCustomObject]@{ insertText = "null;"; source = "local" }
    }
    if ($line -match 'console\.log\(\s*$') {
        return [PSCustomObject]@{ insertText = ");"; source = "local" }
    }

    return [PSCustomObject]@{ insertText = ""; source = "local" }
}


$ScriptFailed = $false

try {
    Write-Log "=== CopilotX Runtime Started ==="
    Write-Log "Resolved root: $Root"

    Write-Log "Loading config system..."
    $RuntimeConfig     = Load-Json (Join-Path $Config "runtime.json")
    $RouterConfig      = Load-Json (Join-Path $Config "router.json")
    $TasksConfig       = Load-Json (Join-Path $Config "tasks.json")
    $AgentConfig       = Load-Json (Join-Path $Config "agent.json")
    $ActionsConfig     = Load-Json (Join-Path $Config "actions.json")
    Write-Log "Config system loaded."

    Write-Log "Loading agents..."
    $AgentFiles = Get-ChildItem $Agents -Filter *.md -Force
    foreach ($file in $AgentFiles) {
        $size = (Get-Item $file.FullName).Length
        if ($size -lt 20) { throw "Agent file too small: $($file.Name)" }
        Write-Log "Agent loaded: $($file.Name)"
    }

    Write-Log "Initializing multi-agent runtime..."

    if ($OneShot) {
        # === Non-interactive single-shot mode (for CI / scripting) ===
        $resolved = Resolve-Agent -RouterConfig $RouterConfig -Input $OneShot
        Write-Log "Resolved agent: $($resolved.Agent) ($($resolved.Reason)$(if ($resolved.LlmUsed) { ', via LLM' } else { '' }))"
        $result = Invoke-Agent -AgentKey $resolved.Agent -UserInput $OneShot `
            -MatchedKeywords $resolved.MatchedKeywords -TasksConfig $TasksConfig `
            -AgentConfig $AgentConfig -ActionsConfig $ActionsConfig
        Write-Host "Output: $result"
        Write-Log "Output: $result"
    }
    else {
        # === Interactive runtime loop ===
        Write-Log "Starting runtime loop..."
        while ($true) {
            Write-Host ""
            $userInput = Read-Host "CopilotX Input (type 'exit' to quit)"

            if ($userInput -eq "exit") {
                Write-Log "Runtime terminated by user."
                break
            }
            if ([string]::IsNullOrWhiteSpace($userInput)) {
                Write-Host "Please enter a non-empty message." -ForegroundColor Yellow
                continue
            }

            $resolved = Resolve-Agent -RouterConfig $RouterConfig -Input $userInput
            Write-Log "Resolved agent: $($resolved.Agent) ($($resolved.Reason)$(if ($resolved.LlmUsed) { ', via LLM' } else { '' }))"

            $result = Invoke-Agent -AgentKey $resolved.Agent -UserInput $userInput `
                -MatchedKeywords $resolved.MatchedKeywords -TasksConfig $TasksConfig `
                -AgentConfig $AgentConfig -ActionsConfig $ActionsConfig

            Write-Host "Output: $result"
            Write-Log "Output: $result"
        }
    }

    Write-Log "=== CopilotX Runtime Completed ==="
}
catch {
    $ScriptFailed = $true
    Write-Log "RUNTIME ERROR: $($_.Exception.Message)"
}

# === RULE 3: FINAL STATUS ===
if ($ScriptFailed) {
    Write-Host "`nCopilotX Runtime FAILED." -ForegroundColor Red
}
else {
    Write-Host "`nCopilotX Runtime Completed." -ForegroundColor Green
}

# === RULE 4: SUGGESTED NEXT ACTIONS (purple) + ready-to-run resolution (bright purple) ===
if ($ScriptFailed) {
    Write-Host "`nSuggested next action: run CopilotX_Verify.ps1 to check config/agent/extension integrity." -ForegroundColor DarkMagenta
    Write-Host ".\CopilotX_Verify.ps1" -ForegroundColor Magenta
}
else {
    Write-Host "`nSuggested next action: try a one-shot run to confirm routing without the interactive loop." -ForegroundColor DarkMagenta
    Write-Host '.\CopilotX_Runtime.ps1 -OneShot "explain how routing works"' -ForegroundColor Magenta
}
