$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../probe-factory-api.ps1')
$checks = 0
function Assert-Probe($Condition, $Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}
$plan = @(Get-FactoryProbePlan)
Assert-Probe ($plan.Count -eq 3) 'Expected exactly three read-only probes'
foreach ($probe in $plan) {
    $uri = [Uri]$probe.Url
    Assert-Probe ($uri.Scheme -eq 'https' -and $uri.Host -eq 'api.factory.ai') 'Unexpected API origin'
    Assert-Probe ($uri.AbsolutePath -notmatch 'sessions|messages|chat/completions') 'No billable/session endpoints allowed'
}
$yesterday = [DateTime]::UtcNow.Date.AddDays(-1).ToString('yyyy-MM-dd')
Assert-Probe ($plan[0].Url.Contains("startDate=$yesterday&endDate=$yesterday")) 'Must query yesterday UTC'
$usage = Get-FactoryProbeSummary $plan[0] @{ Status = 200; Note = ''; Json = @{ data = @(@{ fsc = 12 }, @{ fsc = 4 }) } }
Assert-Probe ($usage.Detail -eq 'Historical FSC consumed: 16') 'Incorrect usage summary'
$empty = Get-FactoryProbeSummary $plan[0] @{ Status = 200; Note = ''; Json = @{ data = @() } }
Assert-Probe ($empty.Detail -match 'No historical rows') 'Empty rows must not imply remaining quota'
$malformed = Get-FactoryProbeSummary $plan[0] @{ Status = 200; Note = ''; Json = @{ data = @(@{ fsc = 'fk-secret' }) } }
Assert-Probe ($malformed.Detail -eq 'HTTP success; usage schema not recognized') 'Must not reflect arbitrary usage fields'
$failure = Get-FactoryProbeSummary $plan[0] @{ Status = 403; Note = 'Insufficient role'; Json = @{ secret = 'fk-secret' } }
Assert-Probe (($failure | ConvertTo-Json -Compress) -notmatch 'fk-secret') 'Error body must not escape'
$models = Get-FactoryProbeSummary $plan[1] @{ Status = 200; Note = ''; Json = @{ data = @(@{ model = 'fk-secret' }) } }
Assert-Probe ($models.Detail -match 'not a list of entitled models') 'Historical models must not imply entitlements'
Assert-Probe (($models | ConvertTo-Json -Compress) -notmatch 'fk-secret') 'Unknown model fields must not escape'
$limit = Get-FactoryProbeSummary $plan[2] @{ Status = 200; Note = ''; Json = @{ secret = 'fk-secret' } }
Assert-Probe ($limit.Detail -match 'schema not recognized') 'Missing limit must not imply personal balance'
$limit = Get-FactoryProbeSummary $plan[2] @{ Status = 200; Note = ''; Json = @{ limit = 1000000 } }
Assert-Probe ($limit.Detail -eq 'Organization global per-user credit limit: 1000000; not personal remaining quota') 'Incorrect admin-limit summary'
$limit = Get-FactoryProbeSummary $plan[2] @{ Status = 200; Note = ''; Json = @{ limit = $null } }
Assert-Probe ($limit.Detail -match 'not configured') 'Null limit must not be treated as zero'
$limit = Get-FactoryProbeSummary $plan[2] @{ Status = 200; Note = ''; Json = @{ limit = 'fk-secret' } }
Assert-Probe (($limit | ConvertTo-Json -Compress) -notmatch 'fk-secret') 'Malformed limit must not escape'

Add-Type -TypeDefinition @'
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
public class FactoryProbeFakeHandler : HttpMessageHandler {
    public int Calls = 0;
    public int Status = 200;
    public string Body = "{}";
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
        Calls++;
        if (request.Method != HttpMethod.Get) throw new System.Exception("Only GET permitted");
        return Task.FromResult(new HttpResponseMessage((HttpStatusCode)Status) { Content = new StringContent(Body) });
    }
}
'@
$handler = [FactoryProbeFakeHandler]::new()
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(2)
$client.MaxResponseContentBufferSize = 65536
try {
    $handler.Body = '{"data":[{"fsc":12}]}'
    $result = Invoke-FactoryGet $plan[0] $client
    Assert-Probe ($result.Status -eq 200 -and $result.Json.data[0].fsc -eq 12) 'Valid GET JSON not parsed'
    # Reuse the client to catch invalid configuration changes after first send.
    $result = Invoke-FactoryGet $plan[1] $client
    Assert-Probe ($result.Status -eq 200 -and $handler.Calls -eq 2) 'Repeated GET failed'
    $handler.Status = 403
    $handler.Body = '{"echo":"fk-secret"}'
    $result = Invoke-FactoryGet $plan[0] $client
    Assert-Probe ($result.Status -eq 403 -and $null -eq $result.Json) 'Must omit error bodies'
    Assert-Probe (($result | ConvertTo-Json -Compress) -notmatch 'fk-secret') 'Error credential echo escaped'
    $handler.Status = 302
    $result = Invoke-FactoryGet $plan[0] $client
    Assert-Probe ($result.Status -eq 302 -and $null -eq $result.Json) 'Redirect must not count as success'
    $handler.Status = 200
    $handler.Body = 'invalid json fk-secret'
    $result = Invoke-FactoryGet $plan[0] $client
    Assert-Probe ($result.Note -eq 'Response was not valid JSON') 'Invalid JSON must be safely reported'
    $handler.Body = 'x' * 70000
    $result = Invoke-FactoryGet $plan[0] $client
    Assert-Probe ($result.Status -eq 0) 'Oversized response must be bounded'
    $calls = $handler.Calls
    $result = Invoke-FactoryGet @{ Url = 'https://example.com/' } $client
    Assert-Probe ($result.Status -eq 0 -and $handler.Calls -eq $calls) 'Non-Factory origin must be rejected before send'
} finally {
    $client.Dispose()
    $handler.Dispose()
}
Write-Output "$checks offline checks passed. No network or key used."
