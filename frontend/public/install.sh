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

# Install Chromium/Puppeteer dependencies (needed for WhatsApp login via QR code)
if [ "$(uname)" != "Darwin" ] && command -v apt-get &> /dev/null; then
    echo -e "${YELLOW}>> Installing browser dependencies for WhatsApp...${NC}"
    sudo apt-get update -qq 2>/dev/null || true
    # Install each package individually, trying t64 variant if standard name fails (Ubuntu 24.04+)
    BROWSER_DEPS="libatk1.0-0 libatk-bridge2.0-0 libcups2 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libnspr4 libnss3 libxcomposite1 libxfixes3 libxkbcommon0"
    FAILED_DEPS=""
    for pkg in $BROWSER_DEPS; do
        if ! sudo apt-get install -y -qq "$pkg" 2>/dev/null; then
            if ! sudo apt-get install -y -qq "${pkg}t64" 2>/dev/null; then
                FAILED_DEPS="$FAILED_DEPS $pkg"
            fi
        fi
    done
    if [ -n "$FAILED_DEPS" ]; then
        echo -e "${RED}   ⚠️  Could not install:${FAILED_DEPS}. WhatsApp may not work.${NC}"
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
    if [ -d "$INSTALL_DIR/.git" ]; then
        echo -e "Directory $INSTALL_DIR already exists. Updating to the latest version..."
        cd "$INSTALL_DIR"
        git fetch origin
        git reset --hard origin/$BRANCH
    else
        echo -e "${YELLOW}Directory $INSTALL_DIR exists but is not a valid git repository. Re-installing from scratch...${NC}"
        rm -rf "$INSTALL_DIR"
        git clone -b $BRANCH "$REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi
else
    echo -e "Cloning repository to $INSTALL_DIR..."
    git clone -b $BRANCH "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# 3. Install npm packages
echo ""

echo -e "${YELLOW}>> Installing npm packages and building dependencies...${NC}"
npm install --no-audit --no-fund

# Always clean build artifacts before building to avoid TS6305 stale .tsbuildinfo issues
echo -e "${YELLOW}>> Cleaning build artifacts...${NC}"
rm -rf packages/*/dist packages/*/*.tsbuildinfo frontend/dist 2>/dev/null || true

npm run build

# 4. Create global link for the CLI
echo ""
echo -e "${YELLOW}>> Configuring global 'redbus' binary...${NC}"

# Create a wrapper script in /usr/local/bin that loads NVM and runs redbus
# This avoids PATH issues with NVM-installed Node not being in PATH after script exits
WRAPPER="/usr/local/bin/redbus"
sudo bash -c "cat > $WRAPPER" << 'WRAPPER_EOF'
#!/usr/bin/env bash
# redbus global wrapper — auto-loads NVM if needed
if ! command -v node &> /dev/null; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
fi
SCRIPT_DIR="$(cd -P "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
# If this is the wrapper in /usr/local/bin, redirect to the real script
if [ -f "$HOME/.redbusagent/bin/redbus" ]; then
    exec "$HOME/.redbusagent/bin/redbus" "$@"
fi
echo "Error: redbusagent not found. Reinstall with: curl -fsSL https://redbus.pages.dev/install.sh | bash"
exit 1
WRAPPER_EOF
sudo chmod +x "$WRAPPER" 2>/dev/null || true

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}✅ Redbus Agent installed successfully!${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e ""
echo -e "To start the Redbus Agent, type in your terminal:"
echo -e "  ${YELLOW}redbus${NC}"
echo -e ""
echo -e "To configure AI providers, type:"
echo -e "  ${YELLOW}redbus config${NC}"
echo -e ""
