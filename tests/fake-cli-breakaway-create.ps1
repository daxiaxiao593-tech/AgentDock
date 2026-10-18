param(
  [string]$NodeExecutable,
  [string]$Fixture,
  [string]$StateFile,
  [string]$StopFile,
  [string]$ResultFile
)

$ErrorActionPreference = 'Stop'
$nativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AgentDockBreakawayProbe
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp
$inJob = $false
if (-not [AgentDockBreakawayProbe]::IsProcessInJob([AgentDockBreakawayProbe]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$inJob)) {
  throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
}

$commandLine = '"' + $NodeExecutable + '" "' + $Fixture + '" breakaway-worker "' + $StateFile + '" "' + $StopFile + '"'
$startupInfo = New-Object AgentDockBreakawayProbe+STARTUPINFO
$startupInfo.cb = [Runtime.InteropServices.Marshal]::SizeOf([type][AgentDockBreakawayProbe+STARTUPINFO])
$startupInfo.dwFlags = 1
$processInformation = New-Object AgentDockBreakawayProbe+PROCESS_INFORMATION
$creationFlags = [uint32]0x09000000
$created = [AgentDockBreakawayProbe]::CreateProcessW(
  $NodeExecutable,
  [System.Text.StringBuilder]::new($commandLine),
  [IntPtr]::Zero,
  [IntPtr]::Zero,
  $false,
  $creationFlags,
  [IntPtr]::Zero,
  (Get-Location).Path,
  [ref]$startupInfo,
  [ref]$processInformation
)

if ($created) {
  $result = "in-job:$($inJob.ToString().ToLowerInvariant());created:true;error:0;pid:$($processInformation.dwProcessId)"
  [AgentDockBreakawayProbe]::CloseHandle($processInformation.hThread) | Out-Null
  [AgentDockBreakawayProbe]::CloseHandle($processInformation.hProcess) | Out-Null
} else {
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  $result = "in-job:$($inJob.ToString().ToLowerInvariant());created:false;error:$errorCode;pid:0"
}

[System.IO.File]::WriteAllText($ResultFile, $result, [System.Text.UTF8Encoding]::new($false))
while (-not [System.IO.File]::Exists($StopFile)) {
  Start-Sleep -Milliseconds 25
}
