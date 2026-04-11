import { spawn, execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import {
  getDockerComposePath,
  getEnvPath,
  getConfigDir
} from './config.js';
import { getLocalIP } from './utils.js';

/**
 * Detect which docker compose command to use
 * Some systems have 'docker compose' (plugin), others have 'docker-compose' (standalone)
 * @returns {{cmd: string, args: string[]}} Command and base args for compose
 */
function getComposeCommand() {
  // Try 'docker compose' (plugin) first
  try {
    execSync('docker compose version', { stdio: 'pipe' });
    return { cmd: 'docker', args: ['compose'] };
  } catch (e) {
    // Fall back to standalone docker-compose
    try {
      execSync('docker-compose --version', { stdio: 'pipe' });
      return { cmd: 'docker-compose', args: [] };
    } catch (e2) {
      // Default to plugin style, let it fail with helpful error
      return { cmd: 'docker', args: ['compose'] };
    }
  }
}

/**
 * Generate a random secret for Docker services
 * @returns {string} Random 32-character hex string
 */
function generateSecret() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Check if Docker is installed and running
 * @returns {Promise<{installed: boolean, running: boolean, error?: string}>}
 */
export async function checkDocker() {
  // Check if docker command exists
  const installed = await new Promise((resolve) => {
    const check = spawn('docker', ['--version']);
    check.on('close', (code) => resolve(code === 0));
    check.on('error', () => resolve(false));
  });

  if (!installed) {
    return {
      installed: false,
      running: false,
      error: 'Docker not found. Please install Docker from https://docs.docker.com/engine/install/'
    };
  }

  // Check if Docker daemon is running by running a simple command
  const running = await new Promise((resolve) => {
    const check = spawn('docker', ['ps', '-q'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    check.on('close', (code) => resolve(code === 0));
    check.on('error', () => resolve(false));
  });

  if (!running) {
    return {
      installed: true,
      running: false,
      error: 'Docker is installed but not running. Please start Docker Desktop.'
    };
  }

  return {
    installed: true,
    running: true
  };
}

/**
 * Generate docker-compose.yml from config
 * @param {object} config - Configuration object
 * @returns {string} Docker compose YAML content
 */
export function generateDockerCompose(config) {
  const externalIp = config.server.externalIp === 'auto' ? '${EXTERNAL_IP}' : config.server.externalIp;

  // Ensure secrets exist in config
  if (!config.secrets) {
    config.secrets = {
      drachtio: generateSecret(),
      freeswitch: generateSecret()
    };
  }

  // Determine drachtio port from config (5070 when SBC detected, 5060 otherwise)
  const drachtioPort = config.deployment && config.deployment.pi && config.deployment.pi.drachtioPort
    ? config.deployment.pi.drachtioPort
    : 5060;

  // Determine if running on Pi (ARM64) - use specific versions with platform
  const isPiMode = config.deployment && config.deployment.mode === 'pi-split';
  const drachtioImage = isPiMode ? 'drachtio/drachtio-server:0.9.4' : 'drachtio/drachtio-server:latest';
  const freeswitchImage = 'drachtio/drachtio-freeswitch-mrf:0.9.0';
  const platformLine = isPiMode ? '\n    platform: linux/arm64' : '';

  const components = config.components || ['drachtio', 'freeswitch', 'voice-app', 'vibevoice-api'];
  const has = (comp) => components.includes(comp);

  const dependsOnString = components
    .filter(c => c !== 'voice-app') // voice-app depends on others
    .map(c => `      - ${c}`)
    .join('\n');

  let yaml = `
# CRITICAL: All containers must use network_mode: host
# Docker bridge networking causes FreeSWITCH to advertise internal IPs
# in SDP, making RTP unreachable from external callers.

services:`;

  if (has('drachtio')) {
    yaml += `
  drachtio:
    image: ${drachtioImage}${platformLine}
    container_name: drachtio
    restart: unless-stopped
    network_mode: host
    command: >
      drachtio
      --contact "sip:*:${drachtioPort};transport=tcp,udp"
      --external-ip \${EXTERNAL_IP}
      --secret \${DRACHTIO_SECRET}
      --port 9022
      --loglevel info
`;
  }

  if (has('freeswitch')) {
    yaml += `
  freeswitch:
    image: ${freeswitchImage}${platformLine}
    container_name: freeswitch
    restart: unless-stopped
    network_mode: host
    tmpfs:
      - /usr/local/freeswitch/db
    security_opt:
      - seccomp:unconfined
    cap_add:
      - IPC_LOCK
      - SYS_NICE
    command: >
      freeswitch
      -a 30000
      -z 30100
      -nonat -nf
    environment:
      - EXTERNAL_IP=${externalIp}
    volumes:
      - ${config.paths.voiceApp}/audio:/app/audio
      - ${config.paths.voiceApp}/static:/app/static
`;
  }

  if (has('voice-app')) {
    yaml += `
  voice-app:
    build: 
      context: ${config.paths.voiceApp}
      network: host
    container_name: voice-app
    restart: unless-stopped
    network_mode: host
    env_file:
      - ${getEnvPath()}
    volumes:
      - ${config.paths.voiceApp}/audio:/app/audio
      - ${config.paths.voiceApp}/config:/app/config`;

    if (dependsOnString) {
      yaml += `
    depends_on:
${dependsOnString}`;
    }
    yaml += '\n';
  }

  if (has('vibevoice-api')) {
    yaml += `
  vibevoice-api:
    build:
      context: ${config.paths.voiceApp}/../vibevoice-api
    container_name: vibevoice-api
    restart: unless-stopped
    network_mode: host
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    volumes:
      - huggingface-cache:/root/.cache/huggingface
`;
  }

  yaml += `
volumes:
  huggingface-cache:
`;

  return yaml;
}

/**
 * Generate .env file from config
 * @param {object} config - Configuration object
 * @returns {string} Environment file content
 */
export function generateEnvFile(config) {
  // Ensure secrets exist in config
  if (!config.secrets) {
    config.secrets = {
      drachtio: generateSecret(),
      freeswitch: generateSecret()
    };
  }

  const lines = [
    '# ====================================',
    '# AI Phone Configuration',
    '# Generated by ai-phone CLI',
    '# ====================================',
    '',
    '# Network Configuration',
    `EXTERNAL_IP=${config.server.externalIp === 'auto' ? getLocalIP() : config.server.externalIp}`,
    '',
    '# Drachtio Configuration',
    `DRACHTIO_HOST=${config.remoteMediaIp || '127.0.0.1'}`,
    'DRACHTIO_PORT=9022',
    `DRACHTIO_SECRET=${config.secrets.drachtio}`,
    `DRACHTIO_SIP_PORT=${config.deployment?.pi?.drachtioPort || 5060}`,
    '',
    '# FreeSWITCH Configuration',
    `FREESWITCH_HOST=${config.remoteMediaIp || '127.0.0.1'}`,
    'FREESWITCH_PORT=8021',
    'FREESWITCH_SECRET=JambonzR0ck$',
    '',
    '# SIP Configuration',
    `SIP_DOMAIN=${config.sip.domain}`,
    `SIP_REGISTRAR=${config.sip.registrar}`,
    '',
    '# Default extension',
    `SIP_EXTENSION=${config.devices[0].extension}`,
    `SIP_AUTH_ID=${config.devices[0].authId}`,
    `SIP_PASSWORD=${config.devices[0].password}`,
    '',
    '# Local AI (Ollama LLM)',
    `OLLAMA_API_URL=${config.api.ollama?.apiUrl || 'http://host.docker.internal:11434'}`,
    `OLLAMA_MODEL=${config.api.ollama?.model || 'llama3'}`,
    '',
    '# Local STT (VibeVoice API served on port 8080)',
    `LOCAL_STT_URL=${config.api.localSttUrl || 'http://127.0.0.1:8080/v1'}`,
    '',
    '# Local TTS (VibeVoice API served on port 8080)',
    `LOCAL_TTS_URL=${config.api.localTtsUrl || 'http://127.0.0.1:8080/v1/audio/speech'}`,
    '',
    '# Application Settings',
    `HTTP_PORT=${config.server.httpPort}`,
    'WS_PORT=3001',
    'AUDIO_DIR=/app/audio',
    '',
    '# Outbound Call Settings',
    'MAX_CONVERSATION_TURNS=10',
    'OUTBOUND_RING_TIMEOUT=30',
    ''
  ];

  return lines.join('\n');
}

/**
 * Write Docker configuration files
 * @param {object} config - Configuration object
 * @returns {Promise<void>}
 */
export async function writeDockerConfig(config) {
  const dockerComposePath = getDockerComposePath();
  const envPath = getEnvPath();

  const dockerComposeContent = generateDockerCompose(config);
  const envContent = generateEnvFile(config);

  // Ensure directory exists
  await fs.promises.mkdir(getConfigDir(), { recursive: true });

  await fs.promises.writeFile(dockerComposePath, dockerComposeContent, { mode: 0o644 });
  await fs.promises.writeFile(envPath, envContent, { mode: 0o600 });
}

/**
 * Start Docker containers
 * @param {string[]} [services=[]] - Specific services to start (empty = all)
 * @returns {Promise<void>}
 */
export async function startContainers(services = []) {
  const configDir = getConfigDir();
  const dockerComposePath = getDockerComposePath();

  if (!fs.existsSync(dockerComposePath)) {
    throw new Error('Docker configuration not found. Run "ai-phone setup" first.');
  }

  const compose = getComposeCommand();
  const composeArgs = [...compose.args, '-f', dockerComposePath, 'up', '-d', '--build', '--force-recreate', '--remove-orphans', ...services];

  return new Promise((resolve, reject) => {
    const child = spawn(compose.cmd, composeArgs, {
      cwd: configDir,
      stdio: 'pipe'
    });

    let output = '';
    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      output += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        // AC22: Detect ARM64 image pull failure
        if (output.includes('no matching manifest') ||
          output.includes('image with reference') && output.includes('arm64')) {
          const error = new Error(
            'ARM64 Docker image pull failed.\n\n' +
            'Try manually pulling images:\n' +
            '  docker pull drachtio/drachtio-server:latest\n' +
            '  docker pull drachtio/drachtio-freeswitch-mrf:latest\n\n' +
            'If images are not available for ARM64, you may need to build them locally.'
          );
          reject(error);
        } else {
          reject(new Error(`Docker compose failed (exit ${code}): ${output}`));
        }
      }
    });
  });
}

/**
 * Stop Docker containers
 * @param {string[]} [services=[]] - Specific services to stop (empty = all)
 * @returns {Promise<void>}
 */
export async function stopContainers(services = []) {
  const configDir = getConfigDir();
  const dockerComposePath = getDockerComposePath();

  if (!fs.existsSync(dockerComposePath)) {
    // No compose file — still try to clean up orphaned containers
    await forceRemoveStaleContainers();
    return;
  }

  const compose = getComposeCommand();

  let composeArgs;
  if (services.length > 0) {
    composeArgs = [...compose.args, '-f', dockerComposePath, 'stop', ...services];
  } else {
    // Use 'down --remove-orphans' for clean shutdown + removal of stale containers
    composeArgs = [...compose.args, '-f', dockerComposePath, 'down', '--remove-orphans'];
  }

  await new Promise((resolve, reject) => {
    const child = spawn(compose.cmd, composeArgs, {
      cwd: configDir,
      stdio: 'pipe'
    });

    let output = '';
    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      output += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Docker compose down failed (exit ${code}): ${output}`));
      }
    });
  });

  // Force-remove any orphaned containers that compose down missed
  await forceRemoveStaleContainers();
}

/**
 * Force-remove stale containers by known service names
 * This catches orphaned containers that compose down missed
 * @returns {Promise<void>}
 */
async function forceRemoveStaleContainers() {
  const knownContainers = ['drachtio', 'freeswitch', 'voice-app', 'vibevoice-api', 'whisper-stt', 'kokoro-tts', 'voxtral-tts', 'openedai-speech'];

  for (const name of knownContainers) {
    try {
      execSync(`docker rm -f ${name}`, { stdio: 'pipe' });
    } catch (e) {
      // Container doesn't exist — that's fine
    }
  }
}

/**
 * Get status of Docker containers
 * @returns {Promise<Array<{name: string, status: string}>>}
 */
export async function getContainerStatus() {
  const dockerComposePath = getDockerComposePath();

  if (!fs.existsSync(dockerComposePath)) {
    return [];
  }

  const compose = getComposeCommand();
  // Use -a to show all containers, including stopped/exited ones
  const composeArgs = [...compose.args, '-f', dockerComposePath, 'ps', '-a', '--format', 'json'];

  return new Promise((resolve) => {
    const child = spawn(compose.cmd, composeArgs, {
      stdio: 'pipe'
    });

    let output = '';
    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        try {
          // Parse JSON lines (one per container)
          const lines = output.trim().split('\n').filter(l => l);
          const containers = lines.map(line => {
            const data = JSON.parse(line);
            return {
              name: data.Name || data.Service,
              status: data.State || data.Status
            };
          });
          resolve(containers);
        } catch (error) {
          resolve([]);
        }
      } else {
        resolve([]);
      }
    });
  });
}
