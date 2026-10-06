# Requires PowerShell 7. The key is entered interactively, never as an argument.
# Dot-sourcing loads functions only, for offline tests.
[CmdletBinding()]
param()

function Get-FactoryProbePlan {
    $day = [DateTime]::UtcNow.Date.AddDays(-1).ToString('yyyy-MM-dd')
    @(
        [pscustomobject]@{
            Name = 'Personal usage (yesterday UTC)'
            Kind = 'usage'
            Url = "https://api.factory.ai/api/v1/analytics/cost/me/query?queryKey=headline_daily&startDate=$day&endDate=$day"
        }
        [pscustomobject]@{
            Name = 'Historical models (yesterday UTC, not entitlements)'
            Kind = 'models'
            Url = "https://api.factory.ai/api/v1/analytics/cost/me/query?queryKey=by_model&startDate=$day&endDate=$day"
        }
        [pscustomobject]@{
            Name = 'Organization global per-user limit (not personal balance)'
            Kind = 'limit'
            Url = 'https://api.factory.ai/api/v0/organization/usage/limits/global'
        }
    )
}

function Invoke-FactoryGet {
    param($Probe, [System.Net.Http.HttpClient]$Client)
    $response = $null
    try {
        $uri = [Uri]$Probe.Url
        if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'api.factory.ai' -or -not $uri.IsDefaultPort -or $uri.UserInfo) {
            return @{ Status = 0; Note = 'Refused non-Factory endpoint'; Json = $null }
        }
        # Buffer within a fixed size/timeout: HeadersRead + synchronous reads
        # could wait indefinitely after the headers have arrived.
        $response = $Client.GetAsync($uri).GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        if ($status -ne 200) {
            # Do not print error bodies, headers, request objects or exceptions.
            $note = switch ($status) {
                401 { 'Invalid key or authentication not accepted' }
                403 { 'Insufficient role, plan or Analytics access' }
                404 { 'Endpoint unavailable on this deployment' }
                429 { 'Rate limited; no retry was made' }
                default { 'Request not successful; response body omitted' }
            }
            return @{ Status = $status; Note = $note; Json = $null }
        }
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        try {
            $json = $body | ConvertFrom-Json -Depth 30 -ErrorAction Stop
        } catch {
            return @{ Status = $status; Note = 'Response was not valid JSON'; Json = $null }
        }
        return @{ Status = $status; Note = ''; Json = $json }
    } catch {
        return @{ Status = 0; Note = 'Network/TLS/timeout/size failure; details omitted'; Json = $null }
    } finally {
        if ($response) { $response.Dispose() }
    }
}

function Get-FactoryProbeSummary {
    param($Probe, $Result)
    $summary = [ordered]@{ Probe = $Probe.Name; HttpStatus = $Result.Status; Detail = $Result.Note }
    if ($Result.Status -ne 200 -or $null -eq $Result.Json) {
        return [pscustomobject]$summary
    }
    # Successful bodies are summarized via an allowlist, never dumped.
    switch ($Probe.Kind) {
        'usage' {
            $rows = @($Result.Json.data)
            $credits = @($rows | Where-Object {
                ($_.fsc -is [int] -or $_.fsc -is [long] -or $_.fsc -is [double] -or $_.fsc -is [decimal]) -and
                $_.fsc -ge 0 -and -not [double]::IsInfinity([double]$_.fsc) -and -not [double]::IsNaN([double]$_.fsc)
            })
            if ($credits.Count -eq $rows.Count -and $credits.Count -gt 0) {
                $summary.Detail = 'Historical FSC consumed: ' + (($credits | Measure-Object -Property fsc -Sum).Sum)
            } elseif ($null -ne $Result.Json.data -and $rows.Count -eq 0) {
                $summary.Detail = 'No historical rows returned; not evidence of remaining quota'
            } else {
                $summary.Detail = 'HTTP success; usage schema not recognized'
            }
        }
        'models' {
            # The by_model shape is not assumed without a confirmed contract.
            $summary.Detail = 'Historical by_model query accepted; this is not a list of entitled models'
        }
        'limit' {
            $hasLimit = if ($Result.Json -is [System.Collections.IDictionary]) {
                $Result.Json.Contains('limit')
            } else {
                $null -ne $Result.Json.PSObject.Properties['limit']
            }
            $limit = $Result.Json.limit
            if ($hasLimit -and $null -eq $limit) {
                $summary.Detail = 'Organization global per-user limit not configured; not personal remaining quota'
            } elseif ($hasLimit -and ($limit -is [int] -or $limit -is [long]) -and $limit -ge 0) {
                $summary.Detail = "Organization global per-user credit limit: $limit; not personal remaining quota"
            } else {
                $summary.Detail = 'HTTP success; organization limit schema not recognized'
            }
        }
    }
    [pscustomobject]$summary
}

function Invoke-FactoryApiProbe {
    $secureKey = $null
    $plainKey = $null
    $bstr = [IntPtr]::Zero
    $client = $null
    $handler = $null
    try {
        Write-Host 'Read-only Factory API probe: 3 GET requests, no sessions or model calls.'
        Write-Host 'Enter the temporary key at the hidden prompt. Do not put it in a command.'
        $secureKey = Read-Host 'Factory API key' -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        if ([string]::IsNullOrWhiteSpace($plainKey) -or $plainKey -notmatch '^fk-[A-Za-z0-9_-]+$') {
            Write-Host 'Invalid key format. No requests made.'
            return
        }
        $handler = [System.Net.Http.HttpClientHandler]::new()
        $handler.AllowAutoRedirect = $false
        $handler.UseCookies = $false
        $client = [System.Net.Http.HttpClient]::new($handler)
        $client.Timeout = [TimeSpan]::FromSeconds(20)
        $client.MaxResponseContentBufferSize = 65536
        $client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $plainKey)
        $client.DefaultRequestHeaders.Accept.ParseAdd('application/json')
        $results = foreach ($probe in Get-FactoryProbePlan) {
            Get-FactoryProbeSummary $probe (Invoke-FactoryGet $probe $client)
        }
        $results | Format-Table -AutoSize -Wrap
        Write-Host 'No key or raw response was written to disk by this script.'
        Write-Host 'A usage/limit success does not establish inference access or personal quota remaining.'
    } finally {
        if ($client) {
            $client.DefaultRequestHeaders.Authorization = $null
            $client.Dispose()
        }
        if ($handler) { $handler.Dispose() }
        $plainKey = $null
        if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        if ($secureKey) { $secureKey.Dispose() }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-FactoryApiProbe
}
