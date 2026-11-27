const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// Windows PowerShell ships with Windows. File.Replace uses ReplaceFileW and
// refuses a metadata/ACL merge failure. The stage ACL is set at creation time.
const saveScript = String.raw`
$ErrorActionPreference = 'Stop'
$wire = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$inputRecord = [Text.Encoding]::UTF8.GetString($wire) | ConvertFrom-Json
$target = [string]$inputRecord.target
$parent = [IO.Path]::GetDirectoryName($target)
$stage = [IO.Path]::Combine($parent, '.thermal-save-' + [Guid]::NewGuid().ToString('N'))
$temporary = [IO.Path]::Combine($stage, 'project.tmp')
$reparsePoint = [IO.FileAttributes]::ReparsePoint
function Assert-RealDirectory([string]$directory) {
    while ($directory) {
        if ([IO.File]::GetAttributes($directory) -band $reparsePoint) { throw 'Invalid save directory' }
        $directory = [IO.Path]::GetDirectoryName($directory)
    }
}
$owned = $false
try {
    Assert-RealDirectory $parent
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $user, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    if ([IO.Directory]::Exists($stage) -or [IO.File]::Exists($stage)) { throw 'Save staging name already exists' }
    [IO.Directory]::CreateDirectory($stage, $acl) | Out-Null
    $owned = $true
    $stream = [IO.FileStream]::new($temporary, 'CreateNew', 'Write', 'None')
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes([string]$inputRecord.contents)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    $delays = @(25, 50, 100, 200, 400)
    for ($attempt = 0; ; $attempt++) {
        Assert-RealDirectory $stage
        $attributes = $null
        try { $attributes = [IO.File]::GetAttributes($target) }
        catch [IO.FileNotFoundException] {}
        if ($null -ne $attributes -and ($attributes -band ($reparsePoint -bor [IO.FileAttributes]::Directory))) {
            throw 'Invalid save destination'
        }
        try {
            if ($null -eq $attributes) { [IO.File]::Move($temporary, $target) }
            else { [IO.File]::Replace($temporary, $target, [NullString]::Value, $false) }
            break
        } catch {
            $code = $_.Exception.GetBaseException().HResult -band 65535
            if ($attempt -ge $delays.Length -or $code -notin @(5, 32, 33)) { throw }
            Start-Sleep -Milliseconds $delays[$attempt]
        }
    }
} finally {
    if ($owned) {
        Assert-RealDirectory $stage
        [IO.File]::Delete($temporary)
        [IO.Directory]::Delete($stage)
    }
}
`;

function windowsPowerShell() {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[a-z]:[\\/]/i.test(systemRoot)) throw new Error('Windows SystemRoot is unavailable');
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.realpathSync(executable).toLowerCase() !== executable.toLowerCase()) throw new Error('Windows PowerShell path is not canonical');
  return executable;
}

function windowsPowerShellEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
  return { ...env, ...extra, PSModulePath: path.join(path.dirname(windowsPowerShell()), 'Modules') };
}

function windowsWriteProject(target, contents) {
  const command = Buffer.from(saveScript, 'utf16le').toString('base64');
  // The fixed command receives UTF-8 data over standard input, without
  // placing file names or project contents in command-line arguments.
  const payload = Buffer.from(JSON.stringify({ target, contents }), 'utf8').toString('base64');
  const executable = windowsPowerShell();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      cwd: path.dirname(executable), windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: windowsPowerShellEnv(),
    });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('실험 파일을 저장할 수 없습니다. 폴더와 파일의 권한을 확인해 주세요.'));
    });
    child.stdin.end(payload);
  });
}

module.exports = { windowsPowerShell, windowsPowerShellEnv, windowsWriteProject };
