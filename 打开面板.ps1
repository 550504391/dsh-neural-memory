<#
  打开类神经记忆面板

  为什么需要它：DSH 每次重启端口都会变，书签会失效。
  这个脚本自己去找：看 DSH 桌面进程占着哪些本地端口，挨个戳 /neural-panel，
  哪个回 200 就用哪个打开浏览器。

  不需要改 DSH 的启动参数，也不需要在设置里加 tab。
#>

$ErrorActionPreference = 'Stop'

function Pause-IfInteractive {
  # 交互时才等按键。原来是递归调用自己 —— 会无限递归。
  try {
    if (-not [Console]::IsInputRedirected) {
      Write-Host ''
      Read-Host '按回车关掉这个窗口' | Out-Null
    }
  } catch { }
}
$EXE = 'DeepSeek Harness.exe'
$MARK = 'neural-panel'

function Find-PanelPort {
  $procs = Get-CimInstance Win32_Process -Filter "Name='$EXE'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' }

  foreach ($p in $procs) {
    $ports = Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
      Select-Object -ExpandProperty LocalPort
    foreach ($port in $ports) {
      try {
        $u = "http://127.0.0.1:$port/$MARK"
        $r = Invoke-WebRequest -Uri $u -TimeoutSec 3 -UseBasicParsing
        if ($r.StatusCode -eq 200) { return $port }
      } catch { }
    }
  }
  return $null
}

Write-Host '找面板地址…'
$port = Find-PanelPort

if (-not $port) {
  Write-Host ''
  Write-Host '没找到。可能的原因：'
  Write-Host '  · DSH 没开着'
  Write-Host '  · 刚重启还没起来（等几秒再试）'
  Write-Host '  · 类神经记忆插件没装 / 没启用'
  Write-Host ''
  Pause-IfInteractive
  exit 1
}

$url = "http://127.0.0.1:$port/$MARK"
Write-Host ('面板地址：' + $url)
Start-Process $url
Start-Sleep -Seconds 1
