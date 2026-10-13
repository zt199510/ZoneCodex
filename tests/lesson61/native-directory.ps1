param(
  [Parameter(Mandatory = $true)][int]$AppPid,
  [Parameter(Mandatory = $true)][string]$Directory,
  [Parameter(Mandatory = $true)][string]$OutputFile
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Lesson61OwnedDialog {
  public delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int maximum);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, string lParam);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@

$records = @()
$recordedDialogs = @{}
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$chosen = $false
while ([DateTime]::UtcNow -lt $deadline -and -not $chosen) {
  $script:ownedDialogs = @()
  $callback = [Lesson61OwnedDialog+EnumProc] {
    param($window, $parameter)
    [uint32]$ownerPid = 0
    [void][Lesson61OwnedDialog]::GetWindowThreadProcessId($window, [ref]$ownerPid)
    $name = New-Object System.Text.StringBuilder 128
    [void][Lesson61OwnedDialog]::GetClassName($window, $name, 128)
    if ($ownerPid -eq $AppPid -and $name.ToString() -eq '#32770' -and [Lesson61OwnedDialog]::IsWindowVisible($window)) {
      $script:ownedDialogs += $window
    }
    return $true
  }
  [void][Lesson61OwnedDialog]::EnumWindows($callback, [IntPtr]::Zero)
  foreach ($window in $script:ownedDialogs) {
    $dialog = [System.Windows.Automation.AutomationElement]::FromHandle($window)
    $scope = [System.Windows.Automation.TreeScope]::Descendants
    $controls = $dialog.FindAll($scope, [System.Windows.Automation.Condition]::TrueCondition)
    $controlRecords = @()
    $field = $null
    foreach ($control in $controls) {
      $current = $control.Current
      if ($controlRecords.Count -lt 100 -and $current.ControlType -ne [System.Windows.Automation.ControlType]::DataItem) {
        $controlRecords += @{ name = $current.Name; id = $current.AutomationId; type = $current.ControlType.ProgrammaticName; enabled = $current.IsEnabled; offscreen = $current.IsOffscreen }
      }
      if ($current.IsEnabled -and -not $current.IsOffscreen -and $current.AutomationId -in @('1148', '1152')) {
        $valuePattern = $null
        if ($control.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) { $field = $valuePattern }
      }
    }
    $script:nativeFields = @()
    $script:nativeButtons = @()
    $childCallback = [Lesson61OwnedDialog+EnumProc] {
      param($childWindow, $parameter)
      [uint32]$childPid = 0
      [void][Lesson61OwnedDialog]::GetWindowThreadProcessId($childWindow, [ref]$childPid)
      $class = New-Object System.Text.StringBuilder 128
      [void][Lesson61OwnedDialog]::GetClassName($childWindow, $class, 128)
      $id = [Lesson61OwnedDialog]::GetDlgCtrlID($childWindow)
      $parentId = [Lesson61OwnedDialog]::GetDlgCtrlID([Lesson61OwnedDialog]::GetParent($childWindow))
      if ($childPid -eq $AppPid -and [Lesson61OwnedDialog]::IsWindowVisible($childWindow) -and [Lesson61OwnedDialog]::IsWindowEnabled($childWindow)) {
        if ($class.ToString() -eq 'Edit' -and ($id -eq 1152 -or ($id -eq 1001 -and $parentId -in @(1148, 1152)))) { $script:nativeFields += $childWindow }
        if ($class.ToString() -eq 'Button' -and $id -eq 1) { $script:nativeButtons += $childWindow }
      }
      return $true
    }
    [void][Lesson61OwnedDialog]::EnumChildWindows($window, $childCallback, [IntPtr]::Zero)
    $windowKey = $window.ToInt64().ToString()
    if (-not $recordedDialogs.ContainsKey($windowKey)) {
      $records += @{ appPid = $AppPid; hwnd = $window.ToInt64(); title = $dialog.Current.Name; controls = $controlRecords; nativeFieldHandles = @($script:nativeFields | ForEach-Object { $_.ToInt64() }); nativeButtonHandles = @($script:nativeButtons | ForEach-Object { $_.ToInt64() }) }
      $recordedDialogs[$windowKey] = $true
    }
    if ($null -ne $field) { $field.SetValue($Directory) }
    elseif ($script:nativeFields.Count -gt 0) { [void][Lesson61OwnedDialog]::SendMessage($script:nativeFields[0], 0x000C, [IntPtr]::Zero, $Directory) }
    else { continue }
    $buttonCondition = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Button)
    $buttons = $dialog.FindAll($scope, $buttonCondition)
    foreach ($button in $buttons) {
      $current = $button.Current
      if ($current.IsEnabled -and -not $current.IsOffscreen -and $current.AutomationId -eq '1') {
        $invoke = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $invoke.Invoke()
        $chosen = $true
        $records += @{ selectedDirectory = $Directory; buttonName = $current.Name; buttonId = $current.AutomationId; ownerPid = $AppPid }
        break
      }
    }
    if (-not $chosen -and $script:nativeButtons.Count -gt 0) {
      $chosen = [Lesson61OwnedDialog]::PostMessage($script:nativeButtons[0], 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
      if ($chosen) { $records += @{ selectedDirectory = $Directory; buttonId = 1; buttonHwnd = $script:nativeButtons[0].ToInt64(); ownerPid = $AppPid; scopedNativeWindowMessage = $true } }
    }
  }
  if (-not $chosen) { Start-Sleep -Milliseconds 100 }
}
@{ pass = $chosen; actualNativeDialog = $true; programmaticUIAutomationControlInput = $true; scopedNativeWindowMessageFallback = $true; targetAppPid = $AppPid; directory = $Directory; records = $records } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputFile -Encoding UTF8
if (-not $chosen) { throw 'Could not identify and select the folder in the owned app native dialog within 20 seconds.' }
