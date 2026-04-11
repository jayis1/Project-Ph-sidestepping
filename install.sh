#!/bin/bash
set -e

# Usage: curl -sSL https://raw.githubusercontent.com/jayis1/Project-Ph-sidestepping/vibevoice-integration/install.sh | bash
INSTALL_DIR="$HOME/.ai-phone-cli"
REPO_URL="https://github.com/jayis1/Project-Ph-sidestepping.git"

echo "🎯 AI Phone CLI Installer"
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then
  SUDO=""
  echo "✓ Running as root"
else
  SUDO="sudo"
fi

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Darwin*)
    echo "✓ Detected macOS"
    BIN_DIR="/usr/local/bin"
    PKG_MANAGER="brew"
    ;;
  Linux*)
    echo "✓ Detected Linux"
    BIN_DIR="$HOME/.local/bin"
    mkdir -p "$BIN_DIR"
    # Detect package manager
    if command -v apt-get &> /dev/null; then
      PKG_MANAGER="apt"
    elif command -v dnf &> /dev/null; then
      PKG_MANAGER="dnf"
    elif command -v pacman &> /dev/null; then
      PKG_MANAGER="pacman"
    else
      PKG_MANAGER="unknown"
    fi
    ;;
  *)
    echo "✗ Unsupported OS: $OS"
    exit 1
    ;;
esac

# Function to install Node.js
install_nodejs() {
  echo ""
  echo "📦 Installing Node.js..."
  case "$PKG_MANAGER" in
    apt)
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      $SUDO apt-get install -y nodejs
      ;;
    dnf)
      $SUDO dnf install -y nodejs npm
      ;;
    pacman)
      $SUDO pacman -S --noconfirm nodejs npm
      ;;
    brew)
      brew install node
      ;;
    *)
      echo "✗ Cannot auto-install Node.js on this system"
      echo "  Install manually from: https://nodejs.org/"
      exit 1
      ;;
  esac
  echo "✓ Node.js installed: $(node -v)"
  echo "⬆️  Updating npm to latest..."
  npm install -g npm@latest
}

# Function to install ROCm for AMD GPU support
install_rocm() {
  echo ""
  echo "🔴 Installing AMD ROCm (GPU drivers for Ollama)..."
  case "$PKG_MANAGER" in
    apt)
      # Detect OS codename for ROCm repo (ubuntu 22.04=jammy, 24.04=noble)
      # For Debian, map to jammy since AMD doesn't publish official Debian repos
      if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS_CODENAME=$VERSION_CODENAME
        OS_ID=$ID
      else
        OS_CODENAME="jammy" # fallback
        OS_ID="unknown"
      fi
      
      REPO_CODENAME=$OS_CODENAME
      
      # Map all Debian versions (buster, bullseye, bookworm) to Ubuntu 22.04 (jammy)
      if [ "$OS_ID" = "debian" ] || [ "$OS_CODENAME" = "bookworm" ] || [ "$OS_CODENAME" = "bullseye" ] || [ "$OS_CODENAME" = "buster" ]; then
        REPO_CODENAME="jammy"
        echo "   Mapping Debian ($OS_CODENAME) to Ubuntu jammy ROCm repository"
      fi

      # Remove old/incorrect repo file if it exists to prevent conflicts
      $SUDO rm -f /etc/apt/sources.list.d/rocm.list
      
      # Add AMD ROCm repository
      curl -fsSL https://repo.radeon.com/rocm/rocm.gpg.key | $SUDO gpg --dearmor -o /etc/apt/keyrings/rocm.gpg --yes
      echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/rocm.gpg] https://repo.radeon.com/rocm/apt/latest $REPO_CODENAME main" | $SUDO tee /etc/apt/sources.list.d/rocm.list
      echo -e 'Package: *\nPin: release o=repo.radeon.com\nPin-Priority: 600' | $SUDO tee /etc/apt/preferences.d/rocm-pin-600
      
      echo "   Updating package lists..."
      $SUDO apt-get clean
      $SUDO apt-get update
      # Fix any broken packages from previous failed noble repo attempts
      $SUDO apt-get --fix-broken install -y
      $SUDO apt-get install -y rocm
      # Add user to render/video groups for GPU access
      $SUDO usermod -aG render,video $USER
      echo "✓ ROCm installed — you may need to log out/in for group changes to take effect"
      ;;
    dnf)
      $SUDO dnf install -y rocm-dev rocm-hip rocm-opencl
      $SUDO usermod -aG render,video $USER
      echo "✓ ROCm installed"
      ;;
    *)
      echo "⚠️  Cannot auto-install ROCm on this system"
      echo "   Install manually: https://rocm.docs.amd.com/projects/install-on-linux/en/latest/"
      ;;
  esac
}

# Function to install Ollama
install_ollama() {
  echo ""
  echo "🦙 Installing Ollama (and zstd dependency)..."
  case "$PKG_MANAGER" in
    apt)
      $SUDO apt-get update -y && $SUDO apt-get install -y zstd
      ;;
    dnf)
      $SUDO dnf install -y zstd
      ;;
    pacman)
      $SUDO pacman -S --noconfirm zstd
      ;;
  esac
  curl -fsSL https://ollama.com/install.sh | sh
  echo "✓ Ollama installed"
}

# Function to install Docker
install_docker() {
  echo ""
  echo "📦 Installing Docker..."
  case "$PKG_MANAGER" in
    apt)
      curl -fsSL https://get.docker.com | $SUDO sh
      $SUDO usermod -aG docker $USER
      echo "⚠️  You may need to log out and back in for Docker group to take effect"
      ;;
    dnf)
      $SUDO dnf install -y docker
      $SUDO systemctl start docker
      $SUDO systemctl enable docker
      $SUDO usermod -aG docker $USER
      ;;
    pacman)
      $SUDO pacman -S --noconfirm docker
      $SUDO systemctl start docker
      $SUDO systemctl enable docker
      $SUDO usermod -aG docker $USER
      ;;
    brew)
      echo "📦 Docker Desktop required on macOS"
      echo "  Install from: https://www.docker.com/products/docker-desktop"
      echo ""
      read -p "Press Enter after installing Docker Desktop..."
      ;;
    *)
      echo "✗ Cannot auto-install Docker on this system"
      echo "  Install from: https://docs.docker.com/engine/install/"
      exit 1
      ;;
  esac
}

# Function to install git
install_git() {
  echo ""
  echo "📦 Installing git..."
  case "$PKG_MANAGER" in
    apt)
      $SUDO apt-get update && $SUDO apt-get install -y git
      ;;
    dnf)
      $SUDO dnf install -y git
      ;;
    pacman)
      $SUDO pacman -S --noconfirm git
      ;;
    brew)
      brew install git
      ;;
    *)
      echo "✗ Cannot auto-install git"
      exit 1
      ;;
  esac
  echo "✓ Git installed"
}

echo ""
echo "Checking prerequisites..."
echo ""

# Check git
if ! command -v git &> /dev/null; then
  echo "✗ Git not found"
  read -p "  Install git automatically? (Y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    install_git
  else
    exit 1
  fi
else
  echo "✓ Git installed"
fi

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "✗ Node.js not found"
  read -p "  Install Node.js automatically? (Y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    install_nodejs
  else
    echo "  Install manually from: https://nodejs.org/"
    exit 1
  fi
else
  NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_VERSION" -lt 18 ]; then
    echo "✗ Node.js 18+ required (found v$NODE_VERSION)"
    read -p "  Upgrade Node.js automatically? (Y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
      install_nodejs
    else
      exit 1
    fi
  else
    echo "✓ Node.js $(node -v)"
  fi
fi

# Check Docker
if ! command -v docker &> /dev/null; then
  echo "✗ Docker not found"
  read -p "  Install Docker automatically? (Y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    install_docker
  else
    echo "  Install from: https://docs.docker.com/engine/install/"
    exit 1
  fi
else
  echo "✓ Docker installed"
fi

# Check Docker permissions (Linux only)
if [ "$OS" = "Linux" ]; then
  if ! docker info &> /dev/null 2>&1; then
    echo "⚠️  Docker permission issue"
    echo "  Adding user to docker group..."
    $SUDO usermod -aG docker $USER
    echo "  ⚠️  You need to log out and back in, OR run: newgrp docker"
    echo ""
    read -p "Continue anyway? (Y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Nn]$ ]]; then
      exit 1
    fi
  fi
fi


# Clone or update repository
echo ""
if [ -d "$INSTALL_DIR" ]; then
  echo "Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull origin vibevoice-integration
else
  echo "Cloning AI Phone..."
  git clone -b vibevoice-integration "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Install CLI dependencies
echo ""
echo "Installing CLI dependencies..."
cd "$INSTALL_DIR/cli"
npm install --silent --production

# Install Voice App dependencies
echo ""
echo "Installing Voice App dependencies..."
cd "$INSTALL_DIR/voice-app"
npm install --silent --production


# Create symlink
echo ""
if [ -L "$BIN_DIR/ai-phone" ]; then
  rm "$BIN_DIR/ai-phone"
fi

if [ "$OS" = "Linux" ]; then
  ln -s "$INSTALL_DIR/cli/bin/ai-phone.js" "$BIN_DIR/ai-phone"
  echo "✓ Installed to: $BIN_DIR/ai-phone"

  if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    echo ""
    echo "⚠️  Adding $HOME/.local/bin to PATH..."
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
    export PATH="$HOME/.local/bin:$PATH"
  fi
else
  if [ -w "$BIN_DIR" ]; then
    ln -s "$INSTALL_DIR/cli/bin/ai-phone.js" "$BIN_DIR/ai-phone"
  else
    $SUDO ln -s "$INSTALL_DIR/cli/bin/ai-phone.js" "$BIN_DIR/ai-phone"
  fi
  echo "✓ Installed to: $BIN_DIR/ai-phone"
fi

echo ""
echo "════════════════════════════════════════════"
echo "✓ Installation complete!"
echo "════════════════════════════════════════════"
echo ""

# Detect AMD GPU
AMD_GPU=""
if command -v lspci &> /dev/null; then
  AMD_GPU=$(lspci 2>/dev/null | grep -iE "VGA|Display|3D" | grep -i "AMD\|Radeon\|Advanced Micro" | head -1)
fi

if [ -n "$AMD_GPU" ]; then
  echo "🔴 AMD GPU detected: $AMD_GPU"

  if ! command -v rocminfo &> /dev/null && [ ! -d "/opt/rocm" ]; then
    echo "   ROCm not found — Ollama will run on CPU only"
    read -p "   Install AMD ROCm for GPU acceleration? (Y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
      install_rocm
    else
      echo "   Skipping ROCm — install later from: https://rocm.docs.amd.com/"
    fi
  else
    ROCM_VERSION=$(cat /opt/rocm/.info/version 2>/dev/null || rocminfo 2>/dev/null | grep "ROCm" | head -1 | awk '{print $NF}' || echo "installed")
    echo "✓ ROCm detected ($ROCM_VERSION) — Ollama will use AMD GPU automatically"
  fi
  echo ""
fi

echo "Checking for Ollama (required for local AI)..."
if ! command -v ollama &> /dev/null; then
  echo "✗ Ollama not found"
  read -p "  Install Ollama automatically? (Y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    install_ollama
    echo ""
    if [ -n "$AMD_GPU" ] && (command -v rocminfo &> /dev/null || [ -d "/opt/rocm" ]); then
      echo "🔴 Ollama will use your AMD GPU via ROCm"
    fi
    echo "🦙 Pull a model to get started:"
    echo "  ollama pull gemma4:e4b"
  else
    echo "  Install manually from: https://ollama.com"
  fi
else
  echo "✓ Ollama installed: $(ollama --version 2>/dev/null || echo 'ok')"
  # List available models
  MODELS=$(ollama list 2>/dev/null | tail -n +2 | awk '{print $1}' | head -3)
  if [ -z "$MODELS" ]; then
    echo "💡 No Ollama models found. Pull one before starting:"
    echo "  ollama pull gemma4:e4b"
  else
    echo "✓ Available models: $MODELS"
  fi
fi

echo ""
echo "Next steps:"
echo "  ai-phone setup    # Configure API endpoints + SIP credentials"
echo "  ai-phone start    # Launch Docker containers"
echo ""
