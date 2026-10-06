$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$clearBytes = $null
$taskProcess = $null
try {
  if ($args.Count -ne 0) { throw 'No launcher arguments accepted.' }
  $taskStart = [Diagnostics.ProcessStartInfo]::new()
  $taskStart.FileName = (Get-Command ssh.exe).Source
  $taskStart.UseShellExecute = $false
  $taskStart.CreateNoWindow = $true
  $taskStart.RedirectStandardInput = $true
  $taskStart.ArgumentList.Add('-o')
  $taskStart.ArgumentList.Add('BatchMode=yes')
  $taskStart.ArgumentList.Add('iris-vps')
  $taskStart.ArgumentList.Add('python3 /opt/iris/repository/evidence/pd-supervised-20261006/ops.py prepare')
  $clearBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    [IO.File]::ReadAllBytes('C:/Users/59912/AppData/Local/Iris/bailian-eval-20260918/bailian-key.dpapi'),
    $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $taskProcess = [Diagnostics.Process]::Start($taskStart)
  $taskProcess.StandardInput.Write([Text.Encoding]::UTF8.GetString($clearBytes))
  $taskProcess.StandardInput.Close()
  [Array]::Clear($clearBytes,0,$clearBytes.Length)
  $clearBytes=$null
  $taskProcess.WaitForExit()
  $resultCode=$taskProcess.ExitCode
} catch {
  Write-Host 'Protected pilot launcher failed; no credential details logged.'
  $resultCode=1
} finally {
  if ($null -ne $clearBytes) {[Array]::Clear($clearBytes,0,$clearBytes.Length)}
  if ($null -ne $taskProcess) {$taskProcess.Dispose()}
}
exit $resultCode
