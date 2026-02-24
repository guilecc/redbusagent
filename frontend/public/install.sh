#!/usr/bin/env bash

set -e

# Configurações
REPO_URL="https://github.com/guilecc/redbusagent.git"
INSTALL_DIR="${HOME}/.redbusagent"
BRANCH="main"

# Cores para o output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}🚌 Bem-vindo ao instalador do Redbus Agent!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 1. Verifica pré-requisitos
echo -e "${YELLOW}>> Verificando dependências do sistema...${NC}"

if ! command -v git &> /dev/null; then
    echo -e "${RED}Erro: 'git' não está instalado. Por favor instale o git primeiro.${NC}"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo -e "${RED}Erro: 'node' não está instalado. Por favor instale o Node.js v18 ou superior.${NC}"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo -e "${RED}Erro: 'npm' não está instalado. Por favor instale o npm.${NC}"
    exit 1
fi

# Verifica a versão do Node (> 18)
NODE_VERSION=$(node -v | cut -d 'v' -f 2)
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d '.' -f 1)
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo -e "${RED}Erro: A versão do Node.js deve ser 18 ou superior. Sua versão atual é $NODE_VERSION.${NC}"
    exit 1
fi
echo -e "✔️ Dependências OK (Node v$NODE_VERSION, git, npm)"

# 2. Clonar ou atualizar repositório
echo ""
echo -e "${YELLOW}>> Baixando o Redbus Agent...${NC}"

if [ -d "$INSTALL_DIR" ]; then
    echo -e "Diretório $INSTALL_DIR já existe. Atualizando para a versão mais recente..."
    cd "$INSTALL_DIR"
    git fetch origin
    git reset --hard origin/$BRANCH
else
    echo -e "Clonando o repositório para $INSTALL_DIR..."
    git clone -b $BRANCH "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# 3. Instalando pacotes npm
echo ""
echo -e "${YELLOW}>> Instalando pacotes npm e compilando dependências...${NC}"
npm install --no-audit --no-fund

# 4. Cria o link global para o CLI
echo ""
echo -e "${YELLOW}>> Configurando o binário global 'redbus'...${NC}"
npm link

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}✅ Redbus Agent instalado com sucesso!${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e ""
echo -e "Para iniciar o Redbus Agent, digite no seu terminal:"
echo -e "  ${YELLOW}redbus${NC}"
echo -e ""
echo -e "Para configurar os provedores de IA, digite:"
echo -e "  ${YELLOW}redbus config${NC}"
echo -e ""
