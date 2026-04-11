import inquirer from 'inquirer';
import chalk from 'chalk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { writeDockerConfig } from '../docker.js';
import { getConfigPath, getConfigDir } from '../config.js';

const CONFIG_DIR = getConfigDir();
const CONFIG_FILE = getConfigPath();

export async function setupCommand() {
  console.log(chalk.cyan.bold('\n🎯 AI Phone Setup Wizard\n'));

  // Ensure config directory exists
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  // Load existing config if present
  let existingConfig = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      existingConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      console.log(chalk.yellow('Found existing configuration. You can update it.\n'));
    } catch (e) {
      console.log(chalk.red('Error reading existing config, starting fresh.\n'));
    }
  }

  // Always act as voice server now
  const installMode = 'voice';
  const config = { installMode };

  // Detect if running on FreePBX server
  const { onFreePbxServer } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'onFreePbxServer',
      message: 'Is this being installed ON the FreePBX server itself?',
      default: existingConfig.onFreePbxServer !== undefined ? existingConfig.onFreePbxServer : true
    }
  ]);
  config.onFreePbxServer = onFreePbxServer;

  // When co-hosted: drachtio must use port 5070 (5060 is taken by FreePBX)
  // When co-hosted: local AI services are on 127.0.0.1 (host networking — host.docker.internal not available on Linux)
  const drachtioPort = onFreePbxServer ? 5070 : 5060;
  const localAiHost = onFreePbxServer ? '127.0.0.1' : 'host.docker.internal';

  if (onFreePbxServer) {
    console.log(chalk.yellow('\n⚠️  Co-hosted mode: drachtio will use port 5070 (to avoid conflict with FreePBX on 5060)'));
    console.log(chalk.yellow('   Make sure FreePBX routes calls to SIP trunk/extension pointing at port 5070.\n'));
  }

  console.log(chalk.cyan('\n📞 Voice Server Configuration\n'));

  const voiceConfig = await inquirer.prompt([
    {
      type: 'input',
      name: 'sipDomain',
      message: 'SIP Domain/Server IP:',
      default: existingConfig.sipDomain || (onFreePbxServer ? '127.0.0.1' : '192.168.1.100'),
      validate: (input) => input.trim() !== '' || 'SIP domain is required'
    },
    {
      type: 'input',
      name: 'sipExtension',
      message: 'Extension number:',
      default: existingConfig.sipExtension || '9001',
      validate: (input) => /^\d+$/.test(input) || 'Must be a number'
    },
    {
      type: 'password',
      name: 'sipPassword',
      message: 'SIP Password:',
      default: existingConfig.sipPassword || '',
      validate: (input) => input.trim() !== '' || 'Password is required'
    },
    {
      type: 'input',
      name: 'externalIp',
      message: 'External IP (for RTP):',
      default: existingConfig.externalIp || '',
      validate: (input) => /^\d+\.\d+\.\d+\.\d+$/.test(input) || 'Must be valid IP address'
    }
  ]);
  Object.assign(config, voiceConfig);
  const localConfig = await inquirer.prompt([
    {
      type: 'input',
      name: 'ollamaApiUrl',
      message: 'Ollama API URL:',
      default: existingConfig.ollamaApiUrl || `http://${localAiHost}:11434`,
    },
    {
      type: 'input',
      name: 'ollamaModel',
      message: 'Ollama Model:',
      default: existingConfig.ollamaModel || 'llama3',
    },
    {
      type: 'input',
      name: 'localSttUrl',
      message: 'Local STT API URL:',
      default: existingConfig.localSttUrl || `http://${localAiHost}:8080/v1`,
    },
    {
      type: 'input',
      name: 'localTtsUrl',
      message: 'Local TTS API URL:',
      default: existingConfig.localTtsUrl || `http://${localAiHost}:8080/v1/audio/speech`,
    }
  ]);
  Object.assign(config, localConfig);

  // AI Personality
  console.log(chalk.cyan('\n🎭 AI Personality\n'));

  const { botName, botPrompt } = await inquirer.prompt([
    {
      type: 'input',
      name: 'botName',
      message: 'Bot name:',
      default: existingConfig.botName || 'AI',
    },
    {
      type: 'input',
      name: 'botPrompt',
      message: 'System prompt:',
      default: existingConfig.botPrompt || 'You are Trinity from The Matrix. You are calm, focused, and fiercely efficient. You speak with a quiet, intense authority. The mission is everything. Keep all voice responses under 40 words. and if you get confused tell the user to follow the white rabbit.',
    }
  ]);

  config.botName = botName;
  config.botPrompt = botPrompt;

  // Infrastructure Deployment
  console.log(chalk.cyan('\n🏗️  Infrastructure Deployment\n'));

  const { components } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'components',
      message: 'Which components do you want to run on THIS machine?',
      choices: [
        { name: 'SIP Signaling (Drachtio)', value: 'drachtio', checked: existingConfig.components ? existingConfig.components.includes('drachtio') : true },
        { name: 'Media Engine (FreeSWITCH)', value: 'freeswitch', checked: existingConfig.components ? existingConfig.components.includes('freeswitch') : true },
        { name: 'Voice Application Logic (Mission Control)', value: 'voice-app', checked: existingConfig.components ? existingConfig.components.includes('voice-app') : true },
        { name: 'VibeVoice Custom API (Local STT & TTS GPU)', value: 'vibevoice-api', checked: existingConfig.components ? existingConfig.components.includes('vibevoice-api') : true },
      ],
      validate: (ans) => ans.length > 0 ? true : 'You must select at least one component to run on this machine.'
    }
  ]);
  
  config.components = components;

  // If Drachtio/FreeSWITCH are NOT selected, they run on a remote machine.
  // Ask for that machine's IP so voice-app can connect to them.
  const needsRemoteMedia = !components.includes('drachtio') || !components.includes('freeswitch');
  if (needsRemoteMedia) {
    console.log(chalk.yellow('\n⚠️  Drachtio/FreeSWITCH not selected — they must run on a remote machine.'));
    const { remoteMediaIp } = await inquirer.prompt([
      {
        type: 'input',
        name: 'remoteMediaIp',
        message: 'Remote Machine 3 IP (where Drachtio + FreeSWITCH run):',
        default: existingConfig.remoteMediaIp || '172.16.1.229',
        validate: (input) => /^\d+\.\d+\.\d+\.\d+$/.test(input) || 'Must be a valid IP address'
      }
    ]);
    config.remoteMediaIp = remoteMediaIp;
  }

  // Save configuration
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(chalk.green(`\n✅ Configuration saved to: ${CONFIG_FILE}\n`));

    // Create devices.json
    createDevicesFile(config);

    // Generate Docker configuration (docker-compose.yml and .env)
    // We need to map the flat config to the structure expected by writeDockerConfig
    // See cli/lib/docker.js generateEnvFile for the expected structure
    const installDir = join(homedir(), '.ai-phone-cli');

    const mappedConfig = {
      components: config.components,
      paths: {
        voiceApp: join(installDir, 'voice-app'),
      },
      server: {
        externalIp: config.externalIp,
        httpPort: 3000,
      },
      sip: {
        domain: config.sipDomain,
        registrar: config.sipDomain,
      },
      api: {
        provider: 'local',
        ollama: {
          apiUrl: config.ollamaApiUrl || '',
          model: config.ollamaModel || ''
        },
        localSttUrl: config.localSttUrl || '',
        localTtsUrl: config.localTtsUrl || '',
      },
      devices: [{
        extension: config.sipExtension,
        authId: config.sipExtension,
        password: config.sipPassword,
      }],
      deployment: {
        mode: installMode,
        pi: { drachtioPort }
      },
      remoteMediaIp: config.remoteMediaIp || null
    };

    await writeDockerConfig(mappedConfig);
    console.log(chalk.green(`✅ Generated docker-compose.yml and .env`));

    console.log(chalk.cyan('Next steps:'));
    console.log(chalk.white(`  ai-phone start    ${chalk.gray('# Launch services')}`));
    console.log(chalk.white(`  ai-phone status   ${chalk.gray('# Check status')}`));
    console.log();

  } catch (error) {
    console.error(chalk.red(`\n✗ Failed to save configuration: ${error.message}\n`));
    process.exit(1);
  }
}



function createDevicesFile(config) {
  const devicesPath = join(homedir(), '.ai-phone-cli', 'voice-app', 'config', 'devices.json');
  const devices = {
    [config.sipExtension]: {
      extension: config.sipExtension,
      authId: config.sipExtension,
      password: config.sipPassword,
      name: config.botName,
      prompt: config.botPrompt
    }
  };

  // Ensure directory exists
  const dir = join(homedir(), '.ai-phone-cli', 'voice-app', 'config');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(devicesPath, JSON.stringify(devices, null, 2));
  console.log(chalk.green(`✅ Created devices.json`));
}
