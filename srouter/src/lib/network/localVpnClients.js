import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

// Read process/listener metadata only. Never open profiles, subscriptions or controller APIs.
export async function discoverLocalVpnClients() {
  if (process.platform !== "win32") return { clients: [], supported: false, note: "Automatic discovery is currently Windows-only. Enter a local proxy URL manually." };
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $apps = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
    $result = @()
    foreach ($label in @('FlClashX', 'Happ', 'Incy')) {
      $pattern = switch ($label) { 'FlClashX' { '^flclashx([-.].*)?\.exe$' } 'Happ' { '^happ([-.].*)?\.exe$' } 'Incy' { '^incy([-.].*)?\.exe$' } }
      $roots = @($apps | Where-Object { $_.Name -match $pattern })
      $ids = @($roots | ForEach-Object { $_.ProcessId })
      for ($depth = 0; $depth -lt 3; $depth++) {
        $ids = @($ids + @($apps | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId }) | Select-Object -Unique)
      }
      $ports = @($listeners | Where-Object { $ids -contains $_.OwningProcess -and $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::', '::1') } | ForEach-Object { [int]$_.LocalPort } | Sort-Object -Unique)
      $result += @{ name = $label; running = ($roots.Count -gt 0); ports = $ports }
    }
    ConvertTo-Json -InputObject $result -Depth 4 -Compress
  `;
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 12000, maxBuffer: 128 * 1024, windowsHide: true,
  });
  return { clients: JSON.parse(stdout.trim()), supported: true };
}
