$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $nodePath)) {
  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
}
Start-Process -FilePath $nodePath -ArgumentList 'preview-server-clean.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
Start-Process 'http://127.0.0.1:4174/#dashboard'
