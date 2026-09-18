#requires -Version 7.0

<#
.SYNOPSIS
Adds configurable cycle limits and resettable error recovery to the managed watering Advanced Flows.

.DESCRIPTION
Runs a read-only preflight by default. Use -Apply to back up and update Homey.

.EXAMPLE
pwsh ./tools/configure-watering-flow-errors.ps1

.EXAMPLE
pwsh ./tools/configure-watering-flow-errors.ps1 -Apply -BackupDirectory C:\safe\watering-backups
#>

[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$BackupDirectory = (Join-Path ([System.IO.Path]::GetTempPath()) 'com.rothmann.soil/watering-flow-backups')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$homeyUrl = ([string]$env:HOMEY_URL).TrimEnd('/')
$homeyToken = [string]$env:HOMEY_TOKEN
if ([string]::IsNullOrWhiteSpace($homeyUrl) -or [string]::IsNullOrWhiteSpace($homeyToken)) {
    throw 'HOMEY_URL and HOMEY_TOKEN must be configured.'
}

$managedFlows = @(
    [ordered]@{ FlowName = 'Bregnebed vanding'; Prefix = 'VAND Bregnebed'; Slug = 'bregnebed' }
    [ordered]@{ FlowName = 'Drivhus Indenfor vanding'; Prefix = 'VAND Drivhus inde'; Slug = 'drivhus-inde' }
    [ordered]@{ FlowName = 'Drivhus Udenfor vanding'; Prefix = 'VAND Drivhus ude'; Slug = 'drivhus-ude' }
    [ordered]@{ FlowName = 'Husfacade vanding'; Prefix = 'VAND Husfacade'; Slug = 'husfacade' }
    [ordered]@{ FlowName = 'Nordhegn vanding'; Prefix = 'VAND Nordhegn'; Slug = 'nordhegn' }
    [ordered]@{ FlowName = 'Rhododendron vanding'; Prefix = 'VAND Rhododendron'; Slug = 'rhododendron' }
    [ordered]@{ FlowName = 'Terasse vanding'; Prefix = 'VAND Terasse'; Slug = 'terasse' }
    [ordered]@{ FlowName = 'Terassebed vanding'; Prefix = 'VAND Terassebed'; Slug = 'terassebed' }
)

function Invoke-HomeyRequest {
    param(
        [Parameter(Mandatory)][ValidateSet('GET', 'POST', 'PUT')][string]$Method,
        [Parameter(Mandatory)][string]$Path,
        [object]$Body
    )

    $parameters = @{
        Method = $Method
        Uri = "$homeyUrl/api$Path"
        Headers = @{ Authorization = "Bearer $homeyToken"; Accept = 'application/json' }
    }
    if ($PSBoundParameters.ContainsKey('Body')) {
        $parameters.ContentType = 'application/json'
        $parameters.Body = $Body | ConvertTo-Json -Depth 100 -Compress
    }

    try {
        Invoke-RestMethod @parameters
    }
    catch {
        $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        throw "$Method $Path failed: $detail"
    }
}

function Get-Values {
    param([object]$Value)

    if ($null -eq $Value) { return @() }
    if ($Value -is [System.Collections.IDictionary]) { return @($Value.Values) }
    if ($Value -is [pscustomobject] -and -not $Value.PSObject.Properties['id']) {
        return @($Value.PSObject.Properties.Value)
    }
    return @($Value)
}

function Copy-Object {
    param([Parameter(Mandatory)][object]$Value)

    $Value | ConvertTo-Json -Depth 100 | ConvertFrom-Json -Depth 100 -AsHashtable
}

function Get-Outputs {
    param([System.Collections.IDictionary]$Card)

    @('outputSuccess', 'outputTrue', 'outputFalse') | ForEach-Object {
        if ($Card.Contains($_) -and $null -ne $Card[$_]) { @($Card[$_]) }
    }
}

function Set-Output {
    param(
        [System.Collections.IDictionary]$Card,
        [Parameter(Mandatory)][string]$Property,
        [string[]]$Targets = @()
    )

    $Card[$Property] = @($Targets)
}

function Add-Output {
    param(
        [System.Collections.IDictionary]$Card,
        [Parameter(Mandatory)][string]$Property,
        [Parameter(Mandatory)][string]$Target
    )

    $targets = @(if ($Card.Contains($Property)) { @($Card[$Property]) } else { @() })
    if ($Target -notin $targets) { $targets += $Target }
    $Card[$Property] = $targets
}

function Test-Reachable {
    param(
        [System.Collections.IDictionary]$Cards,
        [string[]]$StartKeys,
        [Parameter(Mandatory)][string]$TargetKey
    )

    $queue = [System.Collections.Generic.Queue[string]]::new()
    @($StartKeys) | ForEach-Object { if ($_ -and $Cards.Contains($_)) { $queue.Enqueue($_) } }
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    while ($queue.Count -gt 0) {
        $key = $queue.Dequeue()
        if ($key -eq $TargetKey) { return $true }
        if (-not $seen.Add($key)) { continue }
        foreach ($next in (Get-Outputs -Card $Cards[$key])) {
            if ($Cards.Contains([string]$next)) { $queue.Enqueue([string]$next) }
        }
    }
    return $false
}

function Get-CardEntries {
    param([System.Collections.IDictionary]$Cards)

    @($Cards.GetEnumerator())
}

function Get-ExactVariable {
    param(
        [object[]]$Variables,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Type,
        [switch]$Required
    )

    $matches = @($Variables | Where-Object { $_.name -ceq $Name })
    if ($matches.Count -gt 1) { throw "Multiple Logic variables are named '$Name'." }
    if ($Required -and $matches.Count -ne 1) { throw "Missing Logic variable '$Name'." }
    if ($matches.Count -eq 1 -and $matches[0].type -ne $Type) {
        throw "Logic variable '$Name' must be type $Type, but is $($matches[0].type)."
    }
    if ($matches.Count -eq 1) { return $matches[0] }
    return $null
}

function Get-ReferencedVariableIds {
    param(
        [System.Collections.IDictionary]$Card,
        [object[]]$Variables
    )

    $json = $Card | ConvertTo-Json -Depth 30 -Compress
    @($Variables | Where-Object { $_.id -and $json.Contains([string]$_.id) } | ForEach-Object { [string]$_.id })
}

function Set-CardVariable {
    param(
        [System.Collections.IDictionary]$Card,
        [Parameter(Mandatory)][string]$VariableId,
        [string]$VariableName
    )

    if ($Card.Contains('droptoken') -and $Card.droptoken -like 'homey:manager:logic|*') {
        $Card.droptoken = "homey:manager:logic|$VariableId"
        return
    }
    if ($Card.Contains('args') -and $Card.args -and $Card.args.variable -and $Card.args.variable.id) {
        $Card.args.variable.id = $VariableId
        if ($VariableName -and $Card.args.variable.Contains('name')) {
            $Card.args.variable.name = $VariableName
        }
        return
    }
    throw "Card '$($Card.id)' has no replaceable Logic variable reference."
}

function Get-CardVariableId {
    param([System.Collections.IDictionary]$Card)

    if ($Card.Contains('droptoken')) {
        $match = [regex]::Match([string]$Card.droptoken, '^homey:manager:logic\|(.+)$')
        if ($match.Success) { return $match.Groups[1].Value }
    }
    if ($Card.Contains('args') -and $Card.args -and $Card.args.variable) {
        return [string]$Card.args.variable.id
    }
    return $null
}

function Reset-CardOutputs {
    param([System.Collections.IDictionary]$Card)

    foreach ($property in @('outputSuccess', 'outputTrue', 'outputFalse')) {
        if ($Card.Contains($property)) { $Card[$property] = @() }
    }
}

function Get-DemandBranch {
    param(
        [System.Collections.IDictionary]$Cards,
        [System.Collections.DictionaryEntry]$DemandEntry,
        [Parameter(Mandatory)][string]$MaxComparatorKey
    )

    $trueReachesMax = Test-Reachable -Cards $Cards -StartKeys @($DemandEntry.Value.outputTrue) -TargetKey $MaxComparatorKey
    $falseReachesMax = Test-Reachable -Cards $Cards -StartKeys @($DemandEntry.Value.outputFalse) -TargetKey $MaxComparatorKey
    if ($trueReachesMax -eq $falseReachesMax) {
        throw "Demand condition '$($DemandEntry.Key)' must have exactly one branch leading to the max comparator."
    }
    if ($trueReachesMax) { return 'outputTrue' }
    return 'outputFalse'
}

function Get-InitialMaxValue {
    param(
        [System.Collections.IDictionary]$Comparator,
        [object[]]$Variables,
        [string]$MaxVariableName
    )

    $rawValue = $Comparator.args.comparator
    $directTag = [regex]::Match([string]$rawValue, '^\[\[homey:manager:logic\|([^\]]+)\]\]$')
    if ($directTag.Success) {
        $referenced = @($Variables | Where-Object { $_.id -eq $directTag.Groups[1].Value })
        if ($referenced.Count -ne 1 -or $referenced[0].name -cne $MaxVariableName -or $referenced[0].type -ne 'number') {
            throw "Max comparator has an unexpected direct Logic tag '$rawValue'."
        }
        $value = [double]$referenced[0].value
    }
    else {
        $value = 0
        if (-not [double]::TryParse([string]$rawValue, [Globalization.NumberStyles]::Number, [Globalization.CultureInfo]::InvariantCulture, [ref]$value)) {
            throw "Max comparator value '$rawValue' is neither a number nor a direct Logic tag."
        }
    }
    if ($value -ne [math]::Truncate($value) -or $value -lt 1 -or $value -gt 100) {
        throw "Max comparator value '$value' must be an integer from 1 to 100."
    }
    return [int]$value
}

function Get-FlowPreflight {
    param(
        [System.Collections.IDictionary]$Config,
        [System.Collections.IDictionary]$Flow,
        [object[]]$Variables
    )

    if ($Flow.enabled -eq $false) { throw "$($Config.FlowName) is disabled." }
    if (-not $Flow.cards -or $Flow.cards -isnot [System.Collections.IDictionary]) {
        throw "$($Config.FlowName) has no Advanced Flow card map."
    }
    $cards = $Flow.cards
    $entries = Get-CardEntries -Cards $cards
    $comparators = @($entries | Where-Object { $_.Value.type -eq 'condition' -and $_.Value.id -eq 'homey:manager:logic:lt' })
    if ($comparators.Count -ne 1) { throw "$($Config.FlowName) must have exactly one Logic lt cycle comparator." }
    $comparator = $comparators[0]

    $maxName = "$($Config.Prefix) max cyklusser"
    $errorName = "$($Config.Prefix) vandingsfejl"
    $statusName = "$($Config.Prefix) status"
    $maxVariable = Get-ExactVariable -Variables $Variables -Name $maxName -Type number
    $errorVariable = Get-ExactVariable -Variables $Variables -Name $errorName -Type boolean
    $statusVariable = Get-ExactVariable -Variables $Variables -Name $statusName -Type string -Required
    $maxValue = Get-InitialMaxValue -Comparator $comparator.Value -Variables $Variables -MaxVariableName $maxName

    $incrementCandidates = @()
    foreach ($entry in $entries) {
        $card = $entry.Value
        if ($card.type -ne 'action' -or $card.id -ne 'homey:manager:logic:variable_set_number') { continue }
        if ([string]$card.args.value -notmatch '^\[\[[^\]]+\]\]$') { continue }
        $conditions = @(@($card.outputSuccess) | Where-Object { $cards.Contains([string]$_) -and $cards[[string]$_].type -eq 'condition' })
        foreach ($conditionKey in $conditions) {
            $conditionEntry = $entries | Where-Object Key -eq ([string]$conditionKey)
            $truePath = Test-Reachable -Cards $cards -StartKeys @($conditionEntry.Value.outputTrue) -TargetKey ([string]$comparator.Key)
            $falsePath = Test-Reachable -Cards $cards -StartKeys @($conditionEntry.Value.outputFalse) -TargetKey ([string]$comparator.Key)
            if ($truePath -ne $falsePath) {
                $incrementCandidates += [ordered]@{ Increment = $entry; Demand = $conditionEntry }
            }
        }
    }
    if ($incrementCandidates.Count -ne 1) {
        throw "$($Config.FlowName) must have one tagged cycle-counter set action leading directly to one demand condition whose single branch reaches the max comparator."
    }
    $increment = $incrementCandidates[0].Increment
    $demand = $incrementCandidates[0].Demand
    $demandBranch = Get-DemandBranch -Cards $cards -DemandEntry $demand -MaxComparatorKey ([string]$comparator.Key)

    $recoveryTriggerKey = "watering-error-$($Config.Slug)-recovery-trigger"
    $valveOnActions = @($entries | Where-Object {
        $_.Value.type -eq 'action' -and $_.Value.id -match '^homey:device:[^:]+:on$'
    })
    if ($valveOnActions.Count -ne 1) {
        throw "$($Config.FlowName) must have exactly one physical valve on action."
    }
    $triggerCandidates = @($entries | Where-Object {
        $_.Value.type -eq 'trigger' -and $_.Key -ne $recoveryTriggerKey -and
        (Test-Reachable -Cards $cards -StartKeys @($_.Value.outputSuccess) -TargetKey ([string]$valveOnActions[0].Key)) -and
        ($_.Value.ownerUri -eq $demand.Value.ownerUri)
    })
    $demandVariableIds = @(Get-ReferencedVariableIds -Card $demand.Value -Variables $Variables)
    if ($demandVariableIds.Count -gt 0) {
        $triggerCandidates = @($triggerCandidates | Where-Object {
            $triggerIds = @(Get-ReferencedVariableIds -Card $_.Value -Variables $Variables)
            @($triggerIds | Where-Object { $_ -in $demandVariableIds }).Count -gt 0
        })
    }
    if ($triggerCandidates.Count -ne 1) {
        throw "$($Config.FlowName) must have one unambiguous initial demand trigger matching the derived demand condition."
    }
    $initialGateKey = "watering-error-$($Config.Slug)-initial-gate"
    $initialOutputs = @(if ($cards.Contains($initialGateKey)) {
        @($cards[$initialGateKey].outputFalse) + @($cards[$initialGateKey].outputTrue)
    }
    else {
        @($triggerCandidates[0].Value.outputSuccess)
    })
    if ($initialOutputs.Count -eq 0) { throw "$($Config.FlowName) initial demand path has no output to preserve." }

    $idleActions = @($entries | Where-Object {
        $_.Key -ne "watering-error-$($Config.Slug)-set-idle" -and
        $_.Value.type -eq 'action' -and $_.Value.id -eq 'homey:manager:logic:variable_set_string' -and
        $_.Value.args.variable.id -eq $statusVariable.id -and $_.Value.args.value -eq 'idle'
    })
    if ($idleActions.Count -ne 1) { throw "$($Config.FlowName) must have exactly one status=idle action." }
    $booleanActions = @($entries | Where-Object {
        $_.Value.type -eq 'action' -and $_.Value.id -eq 'homey:manager:logic:variable_set_boolean' -and $_.Value.args.variable.id
    })
    if ($booleanActions.Count -lt 1) { throw "$($Config.FlowName) needs an existing Logic boolean-set action as a card template." }
    $migrationKeys = @(
        "watering-error-$($Config.Slug)-initial-gate",
        "watering-error-$($Config.Slug)-latch",
        "watering-error-$($Config.Slug)-recovery-trigger",
        "watering-error-$($Config.Slug)-recovery-clear",
        "watering-error-$($Config.Slug)-reset-cycle",
        "watering-error-$($Config.Slug)-set-idle",
        "watering-error-$($Config.Slug)-demand"
    )

    $alreadyMigrated = @($migrationKeys | Where-Object { $cards.Contains($_) }).Count -eq $migrationKeys.Count
    $initialError = $statusVariable.value -eq 'cycle_limit'
    [ordered]@{
        Config = $Config
        Flow = $Flow
        Comparator = $comparator
        Increment = $increment
        Demand = $demand
        DemandBranch = $demandBranch
        InitialTrigger = $triggerCandidates[0]
        IdleAction = $idleActions[0]
        BooleanActionTemplate = $booleanActions[0]
        StatusVariable = $statusVariable
        MaxVariable = $maxVariable
        ErrorVariable = $errorVariable
        MaxValue = $maxValue
        InitialError = $initialError
        ExpectedError = if ($alreadyMigrated -and $errorVariable) { [bool]$errorVariable.value } else { $initialError }
        AlreadyMigrated = $alreadyMigrated
    }
}

function Get-LogicBooleanTemplates {
    param(
        [object[]]$Plans,
        [object[]]$Variables
    )

    $rhodo = $Plans | Where-Object { $_.Config.FlowName -eq 'Rhododendron vanding' }
    $request = Get-ExactVariable -Variables $Variables -Name 'VAND Rhododendron ønskes' -Type boolean -Required
    $references = @(Get-ReferencedVariableIds -Card $rhodo.Demand.Value -Variables $Variables)
    if ($references.Count -ne 1 -or $references[0] -ne $request.id) {
        throw 'Rhododendron demand condition must reference only VAND Rhododendron ønskes.'
    }
    if ($rhodo.InitialTrigger.Value.id -ne 'homey:manager:logic:variable_changed') {
        throw 'Rhododendron initial demand trigger must be the Logic variable_changed card used as the recovery trigger template.'
    }
    [ordered]@{
        Condition = $rhodo.Demand.Value
        Trigger = $rhodo.InitialTrigger.Value
        ActiveBranch = $rhodo.DemandBranch
        InactiveBranch = if ($rhodo.DemandBranch -eq 'outputTrue') { 'outputFalse' } else { 'outputTrue' }
    }
}

function Update-MaxNotification {
    param(
        [System.Collections.IDictionary]$Cards,
        [System.Collections.DictionaryEntry]$Comparator,
        [Parameter(Mandatory)][string]$MaxTag
    )

    $reachable = @()
    foreach ($entry in (Get-CardEntries -Cards $Cards)) {
        if (-not $entry.Value.Contains('id') -or $entry.Value.id -ne 'homey:manager:notifications:create_notification') { continue }
        if (Test-Reachable -Cards $Cards -StartKeys @($Comparator.Value.outputFalse) -TargetKey ([string]$entry.Key)) {
            $reachable += $entry
        }
    }
    $safe = @($reachable | Where-Object { [string]$_.Value.args.text -match '(?i)(stopper efter\s+)\d+(\s+vandcyklusser)' })
    if ($safe.Count -eq 1) {
        $safe[0].Value.args.text = [regex]::Replace(
            [string]$safe[0].Value.args.text,
            '(?i)(stopper efter\s+)\d+(\s+vandcyklusser)',
            "`$1$MaxTag`$2"
        )
        return $true
    }
    return $false
}

function Update-WateringFlow {
    param(
        [System.Collections.IDictionary]$Plan,
        [System.Collections.IDictionary]$Templates,
        [Parameter(Mandatory)][string]$MaxVariableId,
        [Parameter(Mandatory)][string]$ErrorVariableId
    )

    $flow = Copy-Object -Value $Plan.Flow
    $cards = $flow.cards
    $slug = $Plan.Config.Slug
    $keys = [ordered]@{
        InitialGate = "watering-error-$slug-initial-gate"
        LatchError = "watering-error-$slug-latch"
        RecoveryTrigger = "watering-error-$slug-recovery-trigger"
        RecoveryClear = "watering-error-$slug-recovery-clear"
        ResetCycle = "watering-error-$slug-reset-cycle"
        SetIdle = "watering-error-$slug-set-idle"
        Demand = "watering-error-$slug-demand"
    }
    $oldInitialOutputs = @(if ($cards.Contains($keys.InitialGate)) {
        @($cards[$keys.InitialGate][$Templates.InactiveBranch])
    }
    else {
        @($cards[[string]$Plan.InitialTrigger.Key].outputSuccess)
    })
    if ($oldInitialOutputs.Count -eq 0) { throw "$($Plan.Config.FlowName) initial demand path has no output to preserve." }

    $gate = Copy-Object -Value $Templates.Condition
    Reset-CardOutputs -Card $gate
    Set-CardVariable -Card $gate -VariableId $ErrorVariableId -VariableName "$($Plan.Config.Prefix) vandingsfejl"
    $gate.x = 2180; $gate.y = 180
    Set-Output -Card $gate -Property $Templates.ActiveBranch
    Set-Output -Card $gate -Property $Templates.InactiveBranch -Targets $oldInitialOutputs
    $cards[$keys.InitialGate] = $gate
    Set-Output -Card $cards[[string]$Plan.InitialTrigger.Key] -Property outputSuccess -Targets @($keys.InitialGate)

    $latch = Copy-Object -Value $Plan.BooleanActionTemplate.Value
    Reset-CardOutputs -Card $latch
    Set-CardVariable -Card $latch -VariableId $ErrorVariableId -VariableName "$($Plan.Config.Prefix) vandingsfejl"
    $latch.args.value = $true; $latch.x = 2420; $latch.y = 1260
    $cards[$keys.LatchError] = $latch
    $maxFailureTargets = @($cards[[string]$Plan.Comparator.Key].outputFalse | Where-Object { $cards.Contains([string]$_) })
    if ($maxFailureTargets.Count -eq 0) {
        $maxNotifications = @(Get-CardEntries -Cards $cards | Where-Object {
            $_.Value.Contains('id') -and $_.Value.id -eq 'homey:manager:notifications:create_notification' -and
            [string]$_.Value.args.text -match '(?i)stopper efter\s+(?:\d+|\[\[homey:manager:logic\|[^\]]+\]\])\s+vandcyklusser'
        })
        if ($maxNotifications.Count -ne 1) {
            throw "$($Plan.Config.FlowName) has no unambiguous max-cycle notification target to repair."
        }
        $maxFailureTargets = @([string]$maxNotifications[0].Key)
    }
    $maxFailureTargets = @($maxFailureTargets + $keys.LatchError | Select-Object -Unique)
    Set-Output -Card $cards[[string]$Plan.Comparator.Key] -Property outputFalse -Targets $maxFailureTargets

    $recoveryTrigger = Copy-Object -Value $Templates.Trigger
    Reset-CardOutputs -Card $recoveryTrigger
    Set-CardVariable -Card $recoveryTrigger -VariableId $ErrorVariableId -VariableName "$($Plan.Config.Prefix) vandingsfejl"
    $recoveryTrigger.x = 2180; $recoveryTrigger.y = 1540
    Set-Output -Card $recoveryTrigger -Property outputSuccess -Targets @($keys.RecoveryClear)
    $cards[$keys.RecoveryTrigger] = $recoveryTrigger

    $recoveryClear = Copy-Object -Value $Templates.Condition
    Reset-CardOutputs -Card $recoveryClear
    Set-CardVariable -Card $recoveryClear -VariableId $ErrorVariableId -VariableName "$($Plan.Config.Prefix) vandingsfejl"
    $recoveryClear.x = 2420; $recoveryClear.y = 1540
    Set-Output -Card $recoveryClear -Property $Templates.ActiveBranch
    Set-Output -Card $recoveryClear -Property $Templates.InactiveBranch -Targets @($keys.ResetCycle)
    $cards[$keys.RecoveryClear] = $recoveryClear

    $resetCycle = Copy-Object -Value $Plan.Increment.Value
    Reset-CardOutputs -Card $resetCycle
    $resetCycle.args.value = 0; $resetCycle.x = 2660; $resetCycle.y = 1540
    Set-Output -Card $resetCycle -Property outputSuccess -Targets @($keys.SetIdle)
    $cards[$keys.ResetCycle] = $resetCycle

    $setIdle = Copy-Object -Value $Plan.IdleAction.Value
    Reset-CardOutputs -Card $setIdle
    $setIdle.x = 2900; $setIdle.y = 1540
    Set-Output -Card $setIdle -Property outputSuccess -Targets @($keys.Demand)
    $cards[$keys.SetIdle] = $setIdle

    $demand = Copy-Object -Value $Plan.Demand.Value
    Reset-CardOutputs -Card $demand
    $demand.x = 3140; $demand.y = 1540
    Set-Output -Card $demand -Property $Plan.DemandBranch -Targets $oldInitialOutputs
    Set-Output -Card $demand -Property $(if ($Plan.DemandBranch -eq 'outputTrue') { 'outputFalse' } else { 'outputTrue' })
    $cards[$keys.Demand] = $demand

    $maxTag = "[[homey:manager:logic|$MaxVariableId]]"
    $cards[[string]$Plan.Comparator.Key].args.comparator = $maxTag
    $notificationUpdated = Update-MaxNotification -Cards $cards -Comparator $Plan.Comparator -MaxTag $maxTag
    [ordered]@{ Flow = $flow; Keys = $keys; NotificationUpdated = $notificationUpdated; OldInitialOutputs = $oldInitialOutputs }
}

function Write-Backup {
    param(
        [object[]]$Plans,
        [object[]]$RelevantVariables
    )

    if (-not (Test-Path -LiteralPath $BackupDirectory)) {
        New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
    }
    $timestamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfffZ')
    $path = Join-Path $BackupDirectory "watering-flow-errors-$timestamp.json"
    $backup = [ordered]@{
        createdAt = [DateTime]::UtcNow.ToString('o')
        homeyUrl = $homeyUrl
        flows = @($Plans | ForEach-Object { $_.Flow })
        variables = @($RelevantVariables)
    }
    $backup | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $path -Encoding utf8NoBOM
    return $path
}

function Assert-AppliedFlow {
    param(
        [System.Collections.IDictionary]$Plan,
        [System.Collections.IDictionary]$Updated,
        [System.Collections.IDictionary]$Flow,
        [Parameter(Mandatory)][string]$MaxVariableId,
        [Parameter(Mandatory)][string]$ErrorVariableId,
        [System.Collections.IDictionary]$Templates
    )

    $isBroken = $Flow.Contains('broken') -and $Flow.broken -eq $true
    if ($Flow.enabled -eq $false -or $isBroken) { throw "$($Plan.Config.FlowName) is disabled or broken after update." }
    $cards = $Flow.cards
    $keys = $Updated['Keys']
    foreach ($key in $keys.Values) {
        if (-not $cards.Contains([string]$key)) { throw "$($Plan.Config.FlowName) is missing migrated card '$key'." }
    }
    $maxTag = "[[homey:manager:logic|$MaxVariableId]]"
    if ($cards[[string]$Plan.Comparator.Key].args.comparator -ne $maxTag) { throw "$($Plan.Config.FlowName) max comparator tag verification failed." }
    if (@($cards[[string]$Plan.Comparator.Key].outputFalse) -notcontains [string]$keys.LatchError) {
        throw "$($Plan.Config.FlowName) max comparator error branch verification failed."
    }
    if (@($cards[[string]$Plan.InitialTrigger.Key].outputSuccess) -notcontains $keys.InitialGate) {
        throw "$($Plan.Config.FlowName) initial error gate verification failed."
    }
    if (@($cards[$keys.InitialGate][$Templates.ActiveBranch]).Count -ne 0 -or
        (@($cards[$keys.InitialGate][$Templates.InactiveBranch]) -join "`n") -ne (@($Updated.OldInitialOutputs) -join "`n") -or
        (Get-CardVariableId -Card $cards[$keys.InitialGate]) -ne $ErrorVariableId) {
        throw "$($Plan.Config.FlowName) initial error gate branch verification failed."
    }
    if ((Get-CardVariableId -Card $cards[$keys.LatchError]) -ne $ErrorVariableId -or $cards[$keys.LatchError].args.value -ne $true) {
        throw "$($Plan.Config.FlowName) error latch verification failed."
    }
    if ((Get-CardVariableId -Card $cards[$keys.RecoveryTrigger]) -ne $ErrorVariableId -or
        $cards[$keys.RecoveryTrigger].id -ne 'homey:manager:logic:variable_changed') {
        throw "$($Plan.Config.FlowName) recovery trigger verification failed."
    }
    if ($keys.RecoveryClear -notin @($cards[$keys.RecoveryTrigger].outputSuccess) -or
        (Get-CardVariableId -Card $cards[$keys.RecoveryClear]) -ne $ErrorVariableId -or
        $keys.ResetCycle -notin @($cards[$keys.RecoveryClear][$Templates.InactiveBranch]) -or
        [double]$cards[$keys.ResetCycle].args.value -ne 0 -or
        $keys.SetIdle -notin @($cards[$keys.ResetCycle].outputSuccess) -or
        $cards[$keys.SetIdle].args.value -ne 'idle' -or
        $keys.Demand -notin @($cards[$keys.SetIdle].outputSuccess) -or
        (@($cards[$keys.Demand][$Plan.DemandBranch]) -join "`n") -ne (@($Updated.OldInitialOutputs) -join "`n")) {
        throw "$($Plan.Config.FlowName) recovery chain verification failed."
    }
}

$flowsResponse = Invoke-HomeyRequest -Method GET -Path '/manager/flow/advancedflow'
$variablesResponse = Invoke-HomeyRequest -Method GET -Path '/manager/logic/variable'
$flows = Get-Values -Value $flowsResponse
$variables = Get-Values -Value $variablesResponse
$plans = @()
foreach ($config in $managedFlows) {
    $matches = @($flows | Where-Object { $_.name -ceq $config.FlowName })
    if ($matches.Count -ne 1) { throw "Expected exactly one Advanced Flow named '$($config.FlowName)', found $($matches.Count)." }
    $flow = Copy-Object -Value $matches[0]
    $plans += Get-FlowPreflight -Config $config -Flow $flow -Variables $variables
}
$templates = Get-LogicBooleanTemplates -Plans $plans -Variables $variables

# Build every flow with harmless placeholder IDs so apply cannot discover a card-shape error after writes begin.
$previews = @{}
foreach ($plan in $plans) {
    $maxId = if ($plan.MaxVariable) { $plan.MaxVariable.id } else { '00000000-0000-0000-0000-000000000001' }
    $errorId = if ($plan.ErrorVariable) { $plan.ErrorVariable.id } else { '00000000-0000-0000-0000-000000000002' }
    $previews[$plan.Config.FlowName] = Update-WateringFlow -Plan $plan -Templates $templates -MaxVariableId $maxId -ErrorVariableId $errorId
}

$summary = @($plans | ForEach-Object {
    [ordered]@{
        flow = $_.Config.FlowName
        prefix = $_.Config.Prefix
        maxCycles = $_.MaxValue
        maxVariable = if ($_.MaxVariable) { 'reuse' } else { 'create' }
        errorVariable = if ($_.ErrorVariable) { 'reuse' } else { 'create' }
        initialError = $_.InitialError
        alreadyMigrated = $_.AlreadyMigrated
        demandBranch = $_.DemandBranch
        notificationText = if ($previews[$_.Config.FlowName].NotificationUpdated) { 'update' } else { 'unchanged' }
    }
})
if (-not $Apply) {
    [ordered]@{ mode = 'dry-run'; validatedFlows = $summary; writes = 0 } | ConvertTo-Json -Depth 10
    exit 0
}

$relevantVariables = @($variables | Where-Object {
    $name = [string]$_.name
    @($managedFlows | Where-Object { $name.StartsWith("$($_.Prefix) ", [StringComparison]::Ordinal) }).Count -gt 0
})
$backupPath = Write-Backup -Plans $plans -RelevantVariables $relevantVariables

foreach ($plan in $plans) {
    if (-not $plan.MaxVariable) {
        $plan.MaxVariable = Invoke-HomeyRequest -Method POST -Path '/manager/logic/variable' -Body ([ordered]@{
            name = "$($plan.Config.Prefix) max cyklusser"; type = 'number'; value = $plan.MaxValue
        })
    }
    elseif ([int]$plan.MaxVariable.value -ne $plan.MaxValue) {
        $plan.MaxVariable = Invoke-HomeyRequest -Method PUT -Path "/manager/logic/variable/$($plan.MaxVariable.id)" -Body @{ value = $plan.MaxValue }
    }
    if (-not $plan.ErrorVariable) {
        $plan.ErrorVariable = Invoke-HomeyRequest -Method POST -Path '/manager/logic/variable' -Body ([ordered]@{
            name = "$($plan.Config.Prefix) vandingsfejl"; type = 'boolean'; value = $plan.InitialError
        })
    }
    elseif (-not $plan.AlreadyMigrated -and [bool]$plan.ErrorVariable.value -ne $plan.InitialError) {
        $plan.ErrorVariable = Invoke-HomeyRequest -Method PUT -Path "/manager/logic/variable/$($plan.ErrorVariable.id)" -Body @{ value = $plan.InitialError }
    }
}

$updates = @()
foreach ($plan in $plans) {
    $updated = Update-WateringFlow -Plan $plan -Templates $templates `
        -MaxVariableId $plan.MaxVariable.id -ErrorVariableId $plan.ErrorVariable.id
    Invoke-HomeyRequest -Method PUT -Path "/manager/flow/advancedflow/$($plan.Flow.id)" -Body $updated.Flow | Out-Null
    $updates += [ordered]@{ Plan = $plan; Updated = $updated }
}

$verifiedVariables = Get-Values -Value (Invoke-HomeyRequest -Method GET -Path '/manager/logic/variable')
foreach ($update in $updates) {
    $plan = $update.Plan
    $max = Get-ExactVariable -Variables $verifiedVariables -Name "$($plan.Config.Prefix) max cyklusser" -Type number -Required
    $verifiedErrorVariable = Get-ExactVariable -Variables $verifiedVariables -Name "$($plan.Config.Prefix) vandingsfejl" -Type boolean -Required
    if ([int]$max.value -ne $plan.MaxValue) { throw "$($plan.Config.FlowName) max variable value verification failed." }
    if ([bool]$verifiedErrorVariable.value -ne $plan.ExpectedError) { throw "$($plan.Config.FlowName) error variable value verification failed." }
    $verifiedFlow = Invoke-HomeyRequest -Method GET -Path "/manager/flow/advancedflow/$($plan.Flow.id)"
    $verifiedFlow = Copy-Object -Value $verifiedFlow
    Assert-AppliedFlow -Plan $plan -Updated $update.Updated -Flow $verifiedFlow `
        -MaxVariableId $max.id -ErrorVariableId $verifiedErrorVariable.id -Templates $templates
}

[ordered]@{
    mode = 'apply'
    backup = $backupPath
    verifiedFlows = @($summary.flow)
    notificationTextUpdated = @($updates | Where-Object { $_.Updated.NotificationUpdated } | ForEach-Object { $_.Plan.Config.FlowName })
} | ConvertTo-Json -Depth 10
