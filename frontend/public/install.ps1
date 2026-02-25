$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/guilecc/redbusagent.git"
$InstallDir = "$env:USERPROFILE\.redbusagent"
$Branch = "main"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "🚌 Bem-vindo ao instalador do Redbus Agent!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 1. Verifica pré-requisitos
Write-Host ">> Verificando dependências do sistema..." -ForegroundColor Yellow

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Instalando git via winget..." -ForegroundColor Yellow
    winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Instalando Node.js via winget..." -ForegroundColor Yellow
    winget install --id OpenJS.NodeJS -e --source winget --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

$NodeVersionOutput = node -v
$NodeVersion = $NodeVersionOutput -replace 'v', ''
$NodeMajor = [int]($NodeVersion.Split('.')[0])

if ($NodeMajor -lt 18) {
    Write-Host "Versão do Node.js ($NodeVersionOutput) é menor que 18. Atualizando..." -ForegroundColor Yellow
    winget install --id OpenJS.NodeJS -e --source winget --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "Instalando Ollama via winget..." -ForegroundColor Yellow
    winget install --id Ollama.Ollama -e --source winget --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

$NodeVersionCheck = node -v
Write-Host "✔️ Dependências OK ($NodeVersionCheck, git, npm, ollama)" -ForegroundColor Green

# 2. Clonar ou atualizar repositório
Write-Host ">> Baixando o Redbus Agent..." -ForegroundColor Yellow

if (Test-Path $InstallDir) {
    Write-Host "Diretório $InstallDir já existe. Atualizando para a versão mais recente..."
    Set-Location $InstallDir
    git fetch origin
    git reset --hard origin/$Branch
} else {
    Write-Host "Clonando o repositório para $InstallDir..."
    git clone -b $Branch $RepoUrl $InstallDir
    Set-Location $InstallDir
}

# 3. Instalando pacotes npm
Write-Host ""
Write-Host ">> Instalando pacotes npm e compilando dependências..." -ForegroundColor Yellow
npm install --no-audit --no-fund

# 4. Cria o link global para o CLI
Write-Host ""
Write-Host ">> Configurando o binário global 'redbus'..." -ForegroundColor Yellow
npm link

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "✅ Redbus Agent instalado com sucesso!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Para iniciar o Redbus Agent, digite no seu terminal:"
Write-Host "  redbus" -ForegroundColor Yellow
Write-Host ""
Write-Host "Para configurar os provedores de IA, digite:"
Write-Host "  redbus config" -ForegroundColor Yellow
Write-Host ""
