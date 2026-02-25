#!/usr/bin/env bash

set -e

# Configuration
REPO_URL="https://github.com/guilecc/redbusagent.git"
INSTALL_DIR="${HOME}/.redbusagent"
BRANCH="main"

# Output Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}🚌 Welcome to the Redbus Agent Installer!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 1. Check prerequisites
echo -e "${YELLOW}>> Checking system dependencies...${NC}"

if ! command -v git &> /dev/null; then
    echo -e "${YELLOW}Installing Git...${NC}"
    if [ "$(uname)" == "Darwin" ]; then
        xcode-select --install || true
    elif command -v apt-get &> /dev/null; then
        sudo apt-get update && sudo apt-get install -y git
    else
        echo -e "${RED}Error: Could not install git automatically. Please install it manually.${NC}"
        exit 1
    fi
fi

if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    echo -e "${YELLOW}Installing Node.js and npm via NVM...${NC}"
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    nvm install 22
    nvm use 22
fi

# Check Node version (> 18)
NODE_VERSION=$(node -v | cut -d 'v' -f 2)
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d '.' -f 1)
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo -e "${YELLOW}Node.js version ($NODE_VERSION) is lower than 18. Updating via NVM...${NC}"
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    nvm install 22
    nvm use 22
    NODE_VERSION=$(node -v | cut -d 'v' -f 2)
fi

if ! command -v ollama &> /dev/null; then
    echo -e "${YELLOW}Installing Ollama...${NC}"
    if [ "$(uname)" == "Darwin" ]; then
        if command -v brew &> /dev/null; then
            brew install ollama
            brew services start ollama
        else
            echo -e "${RED}Homebrew not found. Please visit https://ollama.com/download to download it for Mac.${NC}"
            # Doesn't fail, just warns
        fi
    else
        curl -fsSL https://ollama.com/install.sh | sh
    fi
fi

echo -e "✔️ Dependencies OK (Node v$NODE_VERSION, git, npm, ollama)"

# 2. Clone or update repository
echo ""
echo -e "${YELLOW}>> Downloading Redbus Agent...${NC}"

if [ -d "$INSTALL_DIR" ]; then
    echo -e "Directory $INSTALL_DIR already exists. Updating to the latest version..."
    cd "$INSTALL_DIR"
    git fetch origin
    git reset --hard origin/$BRANCH
    # Always clean build artifacts on update to avoid stale cache issues
    echo -e "${YELLOW}>> Cleaning previous build artifacts...${NC}"
    rm -rf packages/*/dist packages/*/*.tsbuildinfo frontend/dist 2>/dev/null || true
else
    echo -e "Cloning repository to $INSTALL_DIR..."
    git clone -b $BRANCH "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# 3. Install npm packages
echo ""

echo -e "${YELLOW}>> Installing npm packages and building dependencies...${NC}"
npm install --no-audit --no-fund
npm run build

# 4. Create global link for the CLI
echo ""
echo -e "${YELLOW}>> Configuring global 'redbus' binary...${NC}"
npm link

# Ensure redbus is accessible: create a symlink in /usr/local/bin if npm global bin is not in PATH
NPM_BIN="$(npm prefix -g)/bin"
if ! command -v redbus &> /dev/null; then
    if [ -f "$NPM_BIN/redbus" ] || [ -L "$NPM_BIN/redbus" ]; then
        echo -e "${YELLOW}>> Adding redbus to /usr/local/bin...${NC}"
        sudo ln -sf "$NPM_BIN/redbus" /usr/local/bin/redbus 2>/dev/null || ln -sf "$NPM_BIN/redbus" "$HOME/.local/bin/redbus" 2>/dev/null || true
    fi
fi

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}✅ Redbus Agent installed successfully!${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e ""
if command -v redbus &> /dev/null; then
    echo -e "To start the Redbus Agent, type in your terminal:"
    echo -e "  ${YELLOW}redbus${NC}"
    echo -e ""
    echo -e "To configure AI providers, type:"
    echo -e "  ${YELLOW}redbus config${NC}"
else
    echo -e "To start the Redbus Agent, ${YELLOW}open a new terminal${NC} and type:"
    echo -e "  ${YELLOW}redbus${NC}"
    echo -e ""
    echo -e "If 'redbus' is still not found, run:"
    echo -e "  ${YELLOW}export PATH=\"$NPM_BIN:\$PATH\"${NC}"
    echo -e "  ${YELLOW}redbus${NC}"
fi
echo -e ""
