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
    Write-Host "Erro: 'git' não está instalado. Por favor instale o git primeiro." -ForegroundColor Red
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Erro: 'node' não está instalado. Por favor instale o Node.js v18 ou superior." -ForegroundColor Red
    exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "Erro: 'npm' não está instalado. Por favor instale o npm." -ForegroundColor Red
    exit 1
}

$NodeVersion = node -v
Write-Host "✔️ Dependências OK ($NodeVersion, git, npm)" -ForegroundColor Green
Write-Host ""

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
