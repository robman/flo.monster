/**
 * Setup command - configure OS user isolation for hub agents
 * This is a LOCAL command (no admin WebSocket needed).
 */

import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig } from '../../config.js';
import { success, error, info, warn } from '../output.js';

const DEFAULT_AGENT_USER = 'flo-agent';
const VALID_USERNAME = /^[a-z_][a-z0-9_-]*$/;

interface SetupOptions {
  user?: string;
}

function parseSetupArgs(args: string[]): SetupOptions {
  const options: SetupOptions = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user' && i + 1 < args.length) {
      options.user = args[++i];
    }
  }
  return options;
}

function runCommand(cmd: string, label: string): boolean {
  try {
    execSync(cmd, { stdio: 'pipe', timeout: 10000 });
    return true;
  } catch (err) {
    const exitCode = (err as any).status;
    const stderr = (err as any).stderr?.toString() || '';
    if (exitCode !== undefined) {
      error(`${label} failed (exit ${exitCode}): ${stderr.trim()}`);
    } else {
      error(`${label} failed: ${(err as Error).message}`);
    }
    return false;
  }
}

export async function setupCommand(args: string[]): Promise<void> {
  const options = parseSetupArgs(args);
  const username = options.user || DEFAULT_AGENT_USER;

  // Validate username
  if (!VALID_USERNAME.test(username)) {
    error(`Invalid username: ${username}. Must match ${VALID_USERNAME}`);
    process.exit(1);
  }

  info(`Setting up OS user isolation with user: ${username}`);

  // Check if running as root or with sudo
  const isRoot = process.getuid?.() === 0;
  if (!isRoot) {
    warn('This command requires root/sudo privileges for system changes.');
    warn('Re-run with: sudo npx tsx packages/hub/src/cli/hub-admin.ts setup');
    process.exit(1);
  }

  // Step 1: Create system user
  info('Step 1: Creating system user...');
  try {
    execSync(`id ${username}`, { stdio: 'pipe' });
    info(`User '${username}' already exists, skipping creation.`);
  } catch {
    // User doesn't exist, create it
    if (!runCommand(
      `useradd --system --no-create-home --shell /usr/sbin/nologin ${username}`,
      'Create user',
    )) {
      process.exit(1);
    }
    success(`Created system user: ${username}`);
  }

  // Step 2: Configure sudoers
  info('Step 2: Configuring sudoers...');
  const hubUser = process.env.SUDO_USER || process.env.USER || 'root';
  const sudoersContent = `# flo.monster hub agent isolation\n${hubUser} ALL=(${username}) NOPASSWD: ALL\n`;
  const sudoersPath = '/etc/sudoers.d/flo-monster';

  try {
    const { writeFileSync, chmodSync } = await import('node:fs');
    writeFileSync(sudoersPath, sudoersContent, 'utf-8');
    chmodSync(sudoersPath, 0o440);
    success(`Configured sudoers: ${sudoersPath}`);
  } catch (err) {
    error(`Failed to write sudoers file: ${(err as Error).message}`);
    process.exit(1);
  }

  // Step 3: Set directory ownership
  info('Step 3: Setting directory ownership...');
  const sandboxPath = join(homedir(), '.flo-monster', 'sandbox');
  const agentStorePath = join(homedir(), '.flo-monster', 'agents');

  // Create dirs if they don't exist
  runCommand(`mkdir -p ${sandboxPath}`, 'Create sandbox dir');
  runCommand(`mkdir -p ${agentStorePath}`, 'Create agent store dir');

  // Set sandbox directory permissions: root-owned, world-traversable (755)
  // Per-agent subdirectories are chowned individually by agent-handler.ts at persist time
  if (runCommand(`chmod 755 ${sandboxPath}`, 'Set sandbox permissions')) {
    success(`Set permissions on ${sandboxPath} to 755 (flo-agent can traverse but not create dirs)`);
  }

  // Step 4: Update hub.json config
  info('Step 4: Updating hub configuration...');
  try {
    const config = await loadConfig();
    config.tools.bash.runAsUser = username;
    await saveConfig(config);
    success(`Updated hub.json: tools.bash.runAsUser = '${username}'`);
  } catch (err) {
    error(`Failed to update config: ${(err as Error).message}`);
    process.exit(1);
  }

  // Step 5: Verify
  info('Step 5: Verifying setup...');
  if (runCommand(`sudo -n -u ${username} echo "OK"`, 'Sudo verification')) {
    success('Verification passed! sudo -n -u works correctly.');
  } else {
    warn('Verification failed. Check sudoers configuration.');
  }

  console.log('');
  success(`Setup complete! Restart the hub server to apply changes.`);
  info(`Agents will execute bash commands as '${username}'.`);
}
