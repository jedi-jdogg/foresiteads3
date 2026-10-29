# One-paste installer for the Foresite Agent Hub on Windows 10/11.
# Installs Node.js, Git and the GitHub CLI if missing (through winget), signs in to GitHub in the browser,
# downloads the hub into %USERPROFILE%\foresiteads3, puts a shortcut on the Desktop and starts it.
# Safe to run again: it updates instead.
$ErrorActionPreference = 'Stop'
$Branch = 'claude/multi-agent-interface-hub-d8ahj4'
$Repo   = 'jedi-jdogg/foresiteads3'
$Dest   = Join-Path $env:USERPROFILE 'foresiteads3'

function Say($t) { Write-Host "`n$t" -ForegroundColor Cyan }
function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function RefreshPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function WingetInstall($id, $label) {
  if (-not (Have 'winget')) { throw "winget is missing. Install 'App Installer' from the Microsoft Store, then run this again." }
  Say "Installing $label (Windows may ask you to allow it)..."
  winget install --id $id -e --accept-source-agreements --accept-package-agreements --silent | Out-Null
  RefreshPath
}

# 1. Node.js 22 LTS (the hub needs 20.12 or newer)
$needNode = -not (Have 'node')
if (-not $needNode) { $needNode = ((& node -p 'typeof process.loadEnvFile') -ne 'function') }
if ($needNode) { WingetInstall 'OpenJS.NodeJS.LTS' 'Node.js' }

# 2. Git, so the hub can update itself on every start
if (-not (Have 'git')) { WingetInstall 'Git.Git' 'Git' }

# 3. GitHub CLI, for a browser sign-in instead of tokens
if (-not (Have 'gh')) { WingetInstall 'GitHub.cli' 'the GitHub tool' }
& gh auth status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Say 'Sign in to GitHub: a code will appear below, your browser will open, paste the code there.'
  & gh auth login --hostname github.com --git-protocol https --web
}
& gh auth setup-git 2>$null | Out-Null

# 4. Get or update the hub
if (Test-Path (Join-Path $Dest '.git')) {
  Say 'Hub already installed. Updating...'
  & git -C $Dest fetch --quiet origin $Branch
  & git -C $Dest checkout --quiet $Branch
  & git -C $Dest pull --ff-only --quiet
  if ($LASTEXITCODE -ne 0) { Write-Host 'Could not fast-forward (local edits?). Keeping the installed version.' }
} else {
  Say "Downloading the hub to $Dest..."
  & gh repo clone $Repo $Dest -- --branch $Branch --quiet
}

# 5. Desktop shortcut that runs the launcher
$Hub = Join-Path $Dest 'agent-hub'
$Shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Agent Hub.lnk'
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($Shortcut)
$lnk.TargetPath = Join-Path $Hub 'start-windows.cmd'
$lnk.WorkingDirectory = $Hub
$lnk.IconLocation = 'shell32.dll,43'
$lnk.Save()

Say "Installed. 'Agent Hub' is on your Desktop; starting it now."
Start-Process -FilePath (Join-Path $Hub 'start-windows.cmd') -WorkingDirectory $Hub
