# Toast activation handler for dsh-desktop-notify.
#
# The desktop app only understands `dsh://open` (focus the window) and has no
# session deep link, so this script carries the session id on its own:
#
#   1. write it to activate.json, which the Host drains on the page's next poll;
#   2. bring DeepSeek Harness to the front through its existing protocol.
#
# A session that no longer exists is not an error: the page fails to open it and
# the window is already in front, which is the documented fallback.

param([string]$Link)

$ErrorActionPreference = 'SilentlyContinue'

try {
  $state = Join-Path $env:LOCALAPPDATA 'dsh-notify'
  New-Item -ItemType Directory -Path $state -Force | Out-Null
  $session = $Link -replace '^dsh-notify://', ''
  $session = ($session -split '/')[0]
  $session = [System.Uri]::UnescapeDataString($session)
  if (-not [string]::IsNullOrWhiteSpace($session)) {
    $payload = @{
      session = $session
      at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    } | ConvertTo-Json -Compress
    Set-Content -LiteralPath (Join-Path $state 'activate.json') -Value $payload -Encoding UTF8
  }
} catch {
  # A missing marker only costs the navigation; the focus below still happens.
}

try {
  Start-Process 'dsh://open'
} catch {
  # Whether or not the protocol answers, this script has done its part.
}
