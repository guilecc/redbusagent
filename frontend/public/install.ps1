$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/guilecc/redbusagent.git"
$InstallDir = "$env:USERPROFILE\.redbusagent"
$Branch = "main"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "🚌 Welcome to the Redbus Agent Installer!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check prerequisites
Write-Host ">> Checking system dependencies..." -ForegroundColor Yellow

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Installing git via winget..." -ForegroundColor Yellow
    winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Node.js via winget..." -ForegroundColor Yellow
    winget install --id OpenJS.NodeJS -e --source winget --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

$NodeVersionOutput = node -v
$NodeVersion = $NodeVersionOutput -replace 'v', ''
$NodeMajor = [int]($NodeVersion.Split('.')[0])

if ($NodeMajor -lt 18) {
    Write-Host "Node.js version ($NodeVersionOutput) is lower than 18. Updating..." -ForegroundColor Yellow
    winget install --id OpenJS.NodeJS -e --source winget --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Ollama via winget..." -ForegroundColor Yellow
    winget install --id Ollama.Ollama -e --source winget --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

$NodeVersionCheck = node -v
Write-Host "✔️ Dependencies OK ($NodeVersionCheck, git, npm, ollama)" -ForegroundColor Green

# 2. Clone or update repository
Write-Host ">> Downloading Redbus Agent..." -ForegroundColor Yellow

if (Test-Path $InstallDir) {
    if (Test-Path "$InstallDir\.git") {
        Write-Host "Directory $InstallDir already exists. Updating to the latest version..."
        Set-Location $InstallDir
        git fetch origin
        git reset --hard origin/$Branch
        # Always clean build artifacts on update to avoid stale cache issues
        Write-Host ">> Cleaning previous build artifacts..." -ForegroundColor Yellow
        Get-ChildItem -Path "packages" -Recurse -Include "dist","*.tsbuildinfo" -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        Get-ChildItem -Path "packages" -Recurse -Include "*.tsbuildinfo" -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
        if (Test-Path "frontend\dist") { Remove-Item -Recurse -Force "frontend\dist" -ErrorAction SilentlyContinue }
    } else {
        Write-Host "Directory $InstallDir exists but is not a valid git repository. Re-installing from scratch..." -ForegroundColor Yellow
        Remove-Item -Recurse -Force $InstallDir
        git clone -b $Branch $RepoUrl $InstallDir
        Set-Location $InstallDir
    }
} else {
    Write-Host "Cloning repository to $InstallDir..."
    git clone -b $Branch $RepoUrl $InstallDir
    Set-Location $InstallDir
}

# 3. Install npm packages
Write-Host ""

Write-Host ">> Installing npm packages and building dependencies..." -ForegroundColor Yellow
npm install --no-audit --no-fund
npm run build

# 4. Create global link for the CLI
Write-Host ""
Write-Host ">> Configuring global 'redbus' binary..." -ForegroundColor Yellow
npm link

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "✅ Redbus Agent installed successfully!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "To start the Redbus Agent, type in your terminal:"
Write-Host "  redbus" -ForegroundColor Yellow
Write-Host ""
Write-Host "To configure AI providers, type:"
Write-Host "  redbus config" -ForegroundColor Yellow
Write-Host ""
