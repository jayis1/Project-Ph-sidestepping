import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';

import { startContainers } from '../docker.js';
import { getConfigPath } from '../config.js';

const CONFIG_FILE = getConfigPath();

export async function startCommand(services = []) {
  console.log(chalk.cyan.bold('\n🚀 Starting AI Phone\n'));

  // Check if config exists
  if (!existsSync(CONFIG_FILE)) {
    console.log(chalk.red('✗ No configuration found'));
    console.log(chalk.yellow('  Run: ai-phone setup\n'));
    process.exit(1);
  }

  // Load config
  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (error) {
    console.log(chalk.red(`✗ Failed to read config: ${error.message}\n`));
    process.exit(1);
  }

  const { installMode } = config;

  try {
    console.log(chalk.cyan('📞 Starting services...'));
    const targetServices = services && services.length > 0 
      ? services 
      : (config.components || ['drachtio', 'freeswitch', 'voice-app', 'vibevoice-api']);
    await startContainers(targetServices);

    console.log(chalk.green('\n✅ Services started!\n'));
    console.log(chalk.cyan('Next steps:'));
    console.log(chalk.white(`  ai-phone status   ${chalk.gray('# Check status')}`));
    console.log(chalk.white(`  ai-phone stop     ${chalk.gray('# Stop services')}`));
    console.log();

  } catch (error) {
    console.log(chalk.red(`\n✗ Failed to start services: ${error.message}\n`));
    // Check if it's the specific ENOENT error from before to give better hint
    if (error.message.includes('ENOENT') && error.message.includes('docker')) {
      console.log(chalk.yellow('  Hint: Make sure Docker is installed and "docker" command works.'));
      console.log(chalk.yellow('  Try running: docker compose version'));
    }
    process.exit(1);
  }
}
