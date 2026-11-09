# Ukur RAM Sedot di Windows dengan angka yang sama dengan kolom "Memory" Task Manager
# (Working Set - Private), dijumlahkan untuk seluruh pohon proses aplikasi (termasuk WebView2/Chromium).
# aria2c tidak dihitung (sama untuk kedua versi). Dipakai oleh .github/workflows/ram-windows.yml.
param([Parameter(Mandatory)][string]$Tauri, [Parameter(Mandatory)][string]$Electron, [Parameter(Mandatory)][string]$AppDir)
$ErrorActionPreference = 'Stop'

function Get-Tree([int]$root) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $ids = [System.Collections.Generic.List[int]]::new(); $ids.Add($root)
  $q = [System.Collections.Generic.Queue[int]]::new(); $q.Enqueue($root)
  while ($q.Count) {
    $p = $q.Dequeue()
    foreach ($k in ($all | Where-Object ParentProcessId -eq $p)) {
      if (-not $ids.Contains([int]$k.ProcessId)) { $ids.Add([int]$k.ProcessId); $q.Enqueue([int]$k.ProcessId) }
    }
  }
  return ,$ids
}

function Measure-App([int]$root) {
  $ids = Get-Tree $root
  $perf = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids.Contains([int]$_.IDProcess) -and $_.Name -notlike 'aria2c*' })
  $total = [math]::Round((($perf | Measure-Object WorkingSetPrivate -Sum).Sum) / 1MB, 1)
  $detail = ($perf | Sort-Object WorkingSetPrivate -Descending | ForEach-Object { '{0} {1}' -f ($_.Name -replace '#\d+$', ''), [math]::Round($_.WorkingSetPrivate / 1MB, 1) }) -join ', '
  [pscustomobject]@{ Total = $total; Count = $perf.Count; Detail = $detail }
}

function Close-Main([System.Diagnostics.Process]$p) {
  for ($i = 0; $i -lt 20; $i++) {
    $p.Refresh()
    if ($p.MainWindowHandle -ne [IntPtr]::Zero -and $p.CloseMainWindow()) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Stop-App([int]$root) {
  foreach ($id in (Get-Tree $root)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  Get-Process aria2c -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 3
}

$rows = [System.Collections.Generic.List[object]]::new()
function Add-Row($app, $state, $m) {
  $rows.Add([pscustomobject]@{ Aplikasi = $app; Keadaan = $state; 'RAM (MB)' = $m.Total; Proses = $m.Count; Rincian = $m.Detail })
  Write-Host ("{0,-26} {1,-34} {2,7} MB  ({3} proses)  {4}" -f $app, $state, $m.Total, $m.Count, $m.Detail)
}

function Run-Suite($name, $exe, [string[]]$exeArgs) {
  $p = Start-Process -FilePath $exe -ArgumentList $exeArgs -PassThru
  Start-Sleep -Seconds 15
  Add-Row $name 'jendela terbuka' (Measure-App $p.Id)
  if (Close-Main $p) {
    Start-Sleep -Seconds 10
    Add-Row $name 'ditutup ke tray' (Measure-App $p.Id)
    Start-Process -FilePath $exe -ArgumentList $exeArgs | Out-Null   # buka lagi (instance kedua -> tampilkan jendela)
    Start-Sleep -Seconds 12
    Add-Row $name 'dibuka lagi' (Measure-App $p.Id)
    if (Close-Main $p) {
      Start-Sleep -Seconds 10
      Add-Row $name 'ditutup lagi (cek bocor)' (Measure-App $p.Id)
    }
  } else {
    Write-Host "$name : jendela utama tidak ditemukan"
  }
  Stop-App $p.Id
  $h = Start-Process -FilePath $exe -ArgumentList ($exeArgs + '--hidden') -PassThru
  Start-Sleep -Seconds 15
  Add-Row $name 'mulai langsung di tray (--hidden)' (Measure-App $h.Id)
  Stop-App $h.Id
}

Run-Suite 'Tauri' $Tauri @()
$env:SEDOT_WV_ARGS = '--disable-gpu'
Run-Suite 'Tauri --disable-gpu' $Tauri @()
Remove-Item Env:SEDOT_WV_ARGS
Run-Suite 'Electron v0.5' $Electron @($AppDir)

$md = "## RAM Sedot di Windows (Working Set - Private, seperti Task Manager)`n`n| Aplikasi | Keadaan | RAM (MB) | Proses | Rincian |`n|---|---|---:|---:|---|`n"
foreach ($r in $rows) { $md += "| $($r.Aplikasi) | $($r.Keadaan) | $($r.'RAM (MB)') | $($r.Proses) | $($r.Rincian) |`n" }
if ($env:GITHUB_STEP_SUMMARY) { $md | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8 }
$md | Out-File -FilePath ram-windows.md -Encoding utf8
