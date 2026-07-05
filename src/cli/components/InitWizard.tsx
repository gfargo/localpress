/**
 * Ink-based interactive init wizard component.
 *
 * Renders a step-by-step flow in the terminal:
 *   1. Site URL input
 *   2. Site name input (with hostname default)
 *   3. Username input
 *   4. Application Password input (masked)
 *   5. Connection test (spinner)
 *   6. Capability report
 *   7. SSH configuration prompt (optional)
 *   8. SSH host input
 *   9. SSH user input
 *  10. SSH port input
 *  11. SSH wpPath input
 *  12. SSH identityFile input (optional)
 *  13. SSH connection test
 *  14. Final capability report
 *  15. Save confirmation
 */

import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { SiteConfig, SshConfig } from '../../types.ts';
import { isValidSiteName, loadConfig, saveConfig } from '../utils/config.ts';

type WizardStep =
  | 'url'
  | 'name'
  | 'username'
  | 'password'
  | 'testing'
  | 'report'
  | 'ssh-prompt'
  | 'ssh-host'
  | 'ssh-user'
  | 'ssh-port'
  | 'ssh-wp-path'
  | 'ssh-identity-file'
  | 'ssh-testing'
  | 'ssh-error'
  | 'final-report'
  | 'done'
  | 'error';

interface InitWizardProps {
  /** Pre-filled values from CLI flags. */
  initialUrl?: string;
  initialName?: string;
  initialUsername?: string;
  initialPassword?: string;
}

export function InitWizard({
  initialUrl,
  initialName,
  initialUsername,
  initialPassword,
}: InitWizardProps) {
  const { exit } = useApp();

  const [step, setStep] = useState<WizardStep>(initialUrl ? 'name' : 'url');
  const [url, setUrl] = useState(initialUrl ?? '');
  const [siteName, setSiteName] = useState(initialName ?? '');
  const [username, setUsername] = useState(initialUsername ?? '');
  const [password, setPassword] = useState(initialPassword ?? '');
  const [inputValue, setInputValue] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [nameError, setNameError] = useState('');
  const [authenticatedAs, setAuthenticatedAs] = useState('');
  const [capabilities, setCapabilities] = useState<Array<{ name: string; available: boolean }>>([]);

  // SSH state
  const [sshHost, setSshHost] = useState('');
  const [sshUser, setSshUser] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshWpPath, setSshWpPath] = useState('');
  const [sshIdentityFile, setSshIdentityFile] = useState('');
  const [sshErrorMessage, setSshErrorMessage] = useState('');
  const [, setSshConfigured] = useState(false);

  // Skip steps that already have values. Runs once on mount — deps intentionally empty.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only effect
  useEffect(() => {
    if (initialName && !isValidSiteName(initialName)) {
      setErrorMessage(
        `Invalid site name '${initialName}'. Use only letters, numbers, '.', '_' and '-'.`,
      );
      setStep('error');
      return;
    }
    if (step === 'url' && initialUrl) {
      setUrl(normalizeUrl(initialUrl));
      setStep(initialName ? 'username' : 'name');
    }
    if (step === 'name' && initialName) {
      setSiteName(initialName);
      setStep(initialUsername ? 'password' : 'username');
    }
    if (step === 'username' && initialUsername) {
      setUsername(initialUsername);
      setStep(initialPassword ? 'testing' : 'password');
    }
    if (step === 'password' && initialPassword) {
      setPassword(initialPassword);
      setStep('testing');
    }
  }, []);

  // Run connection test when we reach the testing step.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable refs; re-running on each dep change would break the wizard flow
  useEffect(() => {
    if (step !== 'testing') return;

    const testConnection = async () => {
      const normalizedUrl = normalizeUrl(url);
      const credentials = `${username}:${password}`;
      const authHeader = `Basic ${btoa(credentials)}`;

      try {
        const response = await fetch(`${normalizedUrl}/wp-json/wp/v2/users/me`, {
          headers: { Authorization: authHeader },
        });

        if (!response.ok) {
          if (response.status === 401) {
            setErrorMessage('Authentication failed. Check your username and Application Password.');
          } else {
            setErrorMessage(`Connection failed: ${response.status} ${response.statusText}`);
          }
          setStep('error');
          return;
        }

        const user = (await response.json()) as { name?: string; slug?: string };
        setAuthenticatedAs(user.name ?? user.slug ?? username);

        // Build capability report (REST-only at this point).
        const siteConfig: SiteConfig = {
          name: siteName || new URL(normalizedUrl).hostname,
          url: normalizedUrl,
          username,
          appPassword: password,
          createdAt: new Date().toISOString(),
        };

        if (!isValidSiteName(siteConfig.name)) {
          setErrorMessage(
            `Invalid site name '${siteConfig.name}'. Use only letters, numbers, '.', '_' and '-'.`,
          );
          setStep('error');
          return;
        }

        const resolver = new AdapterResolver(siteConfig);
        const report = resolver.capabilityReport();
        setCapabilities(
          report.map((r) => ({
            name: r.capability,
            available: r.preferredAdapter !== null,
          })),
        );

        // Save config (without SSH for now).
        const config = await loadConfig();
        config.sites[siteConfig.name] = siteConfig;
        if (!config.activeSite) {
          config.activeSite = siteConfig.name;
        }
        await saveConfig(config);

        setSiteName(siteConfig.name);
        setStep('report');
      } catch (err) {
        setErrorMessage(`Could not connect: ${err instanceof Error ? err.message : String(err)}`);
        setStep('error');
      }
    };

    testConnection();
  }, [step]);

  // Run SSH connection test.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable refs; re-running on each dep change would break the wizard flow
  useEffect(() => {
    if (step !== 'ssh-testing') return;

    const testSsh = async () => {
      try {
        const { sshExec } = await import('../../adapters/ssh.ts');

        const sshConfig: SshConfig = {
          host: sshHost,
          user: sshUser,
          port: Number.parseInt(sshPort, 10) || 22,
          wpPath: sshWpPath,
        };
        if (sshIdentityFile) {
          sshConfig.identityFile = sshIdentityFile;
        }

        // Test 1: Can we SSH in and run wp --info?
        const wpInfoResult = await sshExec(
          sshConfig,
          `cd ${sshWpPath} && wp --info --allow-root 2>/dev/null || echo "__WP_CLI_NOT_FOUND__"`,
        );

        if (wpInfoResult.exitCode !== 0) {
          setSshErrorMessage(
            `SSH connection failed (exit ${wpInfoResult.exitCode}): ${wpInfoResult.stderr || 'Could not connect'}`,
          );
          setStep('ssh-error');
          return;
        }

        if (wpInfoResult.stdout.includes('__WP_CLI_NOT_FOUND__')) {
          setSshErrorMessage(
            'SSH connected, but WP-CLI is not installed or not in PATH on the remote server.\n' +
              'Install WP-CLI: https://wp-cli.org/#installing',
          );
          setStep('ssh-error');
          return;
        }

        // Test 2: Verify wpPath has wp-config.php
        const wpConfigResult = await sshExec(
          sshConfig,
          `test -f "${sshWpPath}/wp-config.php" && echo "OK" || echo "MISSING"`,
        );

        if (wpConfigResult.stdout.trim() === 'MISSING') {
          setSshErrorMessage(
            `wp-config.php not found at ${sshWpPath}. Check that wpPath points to your WordPress root directory.`,
          );
          setStep('ssh-error');
          return;
        }

        // SSH works! Save the config with SSH.
        const config = await loadConfig();
        const siteConfig = config.sites[siteName];
        if (siteConfig) {
          siteConfig.ssh = sshConfig;
          await saveConfig(config);
        }

        setSshConfigured(true);

        // Rebuild capability report with SSH.
        const updatedSiteConfig: SiteConfig = {
          ...siteConfig,
          ssh: sshConfig,
        } as SiteConfig;
        const resolver = new AdapterResolver(updatedSiteConfig);
        const report = resolver.capabilityReport();
        setCapabilities(
          report.map((r) => ({
            name: r.capability,
            available: r.preferredAdapter !== null,
          })),
        );

        setStep('final-report');
      } catch (err) {
        setSshErrorMessage(`SSH test failed: ${err instanceof Error ? err.message : String(err)}`);
        setStep('ssh-error');
      }
    };

    testSsh();
  }, [step]);

  // Handle text input.
  useInput((input, key) => {
    if (step === 'final-report' || step === 'done') {
      if (key.return || input === 'q') {
        exit();
      }
      return;
    }

    // Report step: y/n for SSH prompt, or Enter to skip
    if (step === 'report') {
      if (input === 'y' || input === 'Y') {
        setInputValue('');
        setStep('ssh-host');
        return;
      }
      if (input === 'n' || input === 'N' || key.return) {
        exit();
        return;
      }
      return;
    }

    if (step === 'ssh-error') {
      if (key.return) {
        // Allow retry or skip
        exit();
      }
      return;
    }

    if (step === 'error') {
      exit();
      return;
    }

    if (step === 'testing' || step === 'ssh-testing') return;

    if (key.return) {
      submitCurrentStep();
      return;
    }

    if (key.backspace || key.delete) {
      setInputValue((prev) => prev.slice(0, -1));
      return;
    }

    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    // Only accept printable characters.
    if (input && !key.ctrl && !key.meta) {
      setInputValue((prev) => prev + input);
    }
  });

  function submitCurrentStep() {
    switch (step) {
      case 'url': {
        const value = inputValue.trim();
        if (!value) return;
        setUrl(normalizeUrl(value));
        setInputValue('');
        setStep('name');
        break;
      }
      case 'name': {
        const defaultName = getHostname(url);
        const value = inputValue.trim() || defaultName;
        if (!isValidSiteName(value)) {
          setNameError(`Invalid name '${value}'. Use only letters, numbers, '.', '_' and '-'.`);
          return;
        }
        setNameError('');
        setSiteName(value);
        setInputValue('');
        setStep('username');
        break;
      }
      case 'username': {
        const value = inputValue.trim();
        if (!value) return;
        setUsername(value);
        setInputValue('');
        setStep('password');
        break;
      }
      case 'password': {
        const value = inputValue.trim();
        if (!value) return;
        setPassword(value);
        setInputValue('');
        setStep('testing');
        break;
      }
      case 'ssh-host': {
        const value = inputValue.trim() || getHostname(url);
        setSshHost(value);
        setInputValue('');
        setStep('ssh-user');
        break;
      }
      case 'ssh-user': {
        const value = inputValue.trim();
        if (!value) return;
        setSshUser(value);
        setInputValue('');
        setStep('ssh-port');
        break;
      }
      case 'ssh-port': {
        const value = inputValue.trim() || '22';
        setSshPort(value);
        setInputValue('');
        setStep('ssh-wp-path');
        break;
      }
      case 'ssh-wp-path': {
        const value = inputValue.trim();
        if (!value) return;
        setSshWpPath(value);
        setInputValue('');
        setStep('ssh-identity-file');
        break;
      }
      case 'ssh-identity-file': {
        const value = inputValue.trim();
        setSshIdentityFile(value);
        setInputValue('');
        setStep('ssh-testing');
        break;
      }
    }
  }

  const hasMissingCapabilities = capabilities.some((c) => !c.available);

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text bold color="cyan">
        localpress — connect a WordPress site
      </Text>
      <Text dimColor>─────────────────────────────────────</Text>
      <Text> </Text>

      {/* Step 1: URL */}
      {step === 'url' ? (
        <Box>
          <Text>Site URL: </Text>
          <Text color="green">{inputValue}</Text>
          <Text color="gray">▌</Text>
        </Box>
      ) : url ? (
        <Box>
          <Text color="green">✓</Text>
          <Text> Site URL: {url}</Text>
        </Box>
      ) : null}

      {/* Step 2: Name */}
      {step === 'name' ? (
        <Box flexDirection="column">
          <Box>
            <Text>Site name [{getHostname(url)}]: </Text>
            <Text color="green">{inputValue}</Text>
            <Text color="gray">▌</Text>
          </Box>
          {nameError ? <Text color="red">{nameError}</Text> : null}
        </Box>
      ) : siteName ? (
        <Box>
          <Text color="green">✓</Text>
          <Text> Site name: {siteName}</Text>
        </Box>
      ) : null}

      {/* Step 3: Username */}
      {step === 'username' ? (
        <Box>
          <Text>WordPress username: </Text>
          <Text color="green">{inputValue}</Text>
          <Text color="gray">▌</Text>
        </Box>
      ) : username ? (
        <Box>
          <Text color="green">✓</Text>
          <Text> Username: {username}</Text>
        </Box>
      ) : null}

      {/* Step 4: Password */}
      {step === 'password' ? (
        <Box flexDirection="column">
          <Text dimColor>Application Passwords: {url}/wp-admin/profile.php</Text>
          <Box>
            <Text>Application Password: </Text>
            <Text color="green">{'*'.repeat(inputValue.length)}</Text>
            <Text color="gray">▌</Text>
          </Box>
        </Box>
      ) : password ? (
        <Box>
          <Text color="green">✓</Text>
          <Text> Password: {'*'.repeat(Math.min(password.length, 12))}...</Text>
        </Box>
      ) : null}

      {/* Step 5: Testing */}
      {step === 'testing' ? (
        <Box>
          <Text color="yellow">⠋</Text>
          <Text> Testing connection to {url}...</Text>
        </Box>
      ) : null}

      {/* Step 6: Report + SSH prompt */}
      {step === 'report' ? (
        <Box flexDirection="column">
          <Text> </Text>
          <Box>
            <Text color="green">✓</Text>
            <Text> Authenticated as </Text>
            <Text bold>{authenticatedAs}</Text>
          </Box>
          <Box>
            <Text color="green">✓</Text>
            <Text> Site '{siteName}' saved and set as active.</Text>
          </Box>
          <Text> </Text>
          <Text bold>Capabilities:</Text>
          {capabilities.map((cap) => (
            <Box key={cap.name}>
              <Text> </Text>
              <Text color={cap.available ? 'green' : 'red'}>{cap.available ? '✓' : '✗'}</Text>
              <Text> {cap.name}</Text>
            </Box>
          ))}
          <Text> </Text>
          {hasMissingCapabilities ? (
            <Box flexDirection="column">
              <Text dimColor>
                SSH + WP-CLI unlocks: replace-in-place, regenerate-thumbnails, prune-orphans,
                full-references.
              </Text>
              <Text dimColor>Requires: SSH access to your server with WP-CLI installed.</Text>
              <Text> </Text>
              <Text>Configure SSH now? </Text>
              <Text color="cyan">[y/N]</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text color="green" bold>
                All capabilities available!
              </Text>
              <Text dimColor>Press Enter to exit.</Text>
            </Box>
          )}
        </Box>
      ) : null}

      {/* SSH Configuration Steps */}
      {(step === 'ssh-host' ||
        step === 'ssh-user' ||
        step === 'ssh-port' ||
        step === 'ssh-wp-path' ||
        step === 'ssh-identity-file' ||
        step === 'ssh-testing' ||
        step === 'ssh-error' ||
        step === 'final-report') && (
        <Box flexDirection="column">
          <Text> </Text>
          <Box>
            <Text color="green">✓</Text>
            <Text> Authenticated as </Text>
            <Text bold>{authenticatedAs}</Text>
          </Box>
          <Box>
            <Text color="green">✓</Text>
            <Text> Site '{siteName}' saved and set as active.</Text>
          </Box>
          <Text> </Text>
          <Text bold color="cyan">
            SSH Configuration (WP-CLI)
          </Text>
          <Text dimColor>─────────────────────────────────────</Text>
          <Text> </Text>
        </Box>
      )}

      {/* SSH Host */}
      {step === 'ssh-host' ? (
        <Box>
          <Text>SSH host [{getHostname(url)}]: </Text>
          <Text color="green">{inputValue}</Text>
          <Text color="gray">▌</Text>
        </Box>
      ) : sshHost &&
        (step === 'ssh-user' ||
          step === 'ssh-port' ||
          step === 'ssh-wp-path' ||
          step === 'ssh-identity-file' ||
          step === 'ssh-testing' ||
          step === 'ssh-error' ||
          step === 'final-report') ? (
        <Box>
          <Text color="green">✓</Text>
          <Text> SSH host: {sshHost}</Text>
        </Box>
      ) : null}

      {/* SSH User */}
      {step === 'ssh-user' ? (
        <Box>
          <Text>SSH user: </Text>
          <Text color="green">{inputValue}</Text>
          <Text color="gray">▌</Text>
        </Box>
      ) : sshUser &&
        (step === 'ssh-port' ||
          step === 'ssh-wp-path' ||
          step === 'ssh-identity-file' ||
          step === 'ssh-testing' ||
          step === 'ssh-error' ||
          step === 'final-report') ? (
        <Box>
          <Text color="green">✓</Text>
          <Text> SSH user: {sshUser}</Text>
        </Box>
      ) : null}

      {/* SSH Port */}
      {step === 'ssh-port' ? (
        <Box>
          <Text>SSH port [22]: </Text>
          <Text color="green">{inputValue}</Text>
          <Text color="gray">▌</Text>
        </Box>
      ) : sshPort &&
        (step === 'ssh-wp-path' ||
          step === 'ssh-identity-file' ||
          step === 'ssh-testing' ||
          step === 'ssh-error' ||
          step === 'final-report') ? (
        <Box>
          <Text color="green">✓</Text>
          <Text> SSH port: {sshPort}</Text>
        </Box>
      ) : null}

      {/* SSH WordPress Path */}
      {step === 'ssh-wp-path' ? (
        <Box flexDirection="column">
          <Text dimColor>
            Absolute path to WordPress root on the server (where wp-config.php lives).
          </Text>
          <Box>
            <Text>WordPress path: </Text>
            <Text color="green">{inputValue}</Text>
            <Text color="gray">▌</Text>
          </Box>
        </Box>
      ) : sshWpPath &&
        (step === 'ssh-identity-file' ||
          step === 'ssh-testing' ||
          step === 'ssh-error' ||
          step === 'final-report') ? (
        <Box>
          <Text color="green">✓</Text>
          <Text> WordPress path: {sshWpPath}</Text>
        </Box>
      ) : null}

      {/* SSH Identity File */}
      {step === 'ssh-identity-file' ? (
        <Box flexDirection="column">
          <Text dimColor>
            Path to SSH private key (leave blank to use ssh-agent or ~/.ssh/id_rsa).
          </Text>
          <Box>
            <Text>Identity file [ssh-agent]: </Text>
            <Text color="green">{inputValue}</Text>
            <Text color="gray">▌</Text>
          </Box>
        </Box>
      ) : sshIdentityFile &&
        (step === 'ssh-testing' || step === 'ssh-error' || step === 'final-report') ? (
        <Box>
          <Text color="green">✓</Text>
          <Text> Identity file: {sshIdentityFile}</Text>
        </Box>
      ) : !sshIdentityFile &&
        (step === 'ssh-testing' || step === 'ssh-error' || step === 'final-report') ? (
        <Box>
          <Text color="green">✓</Text>
          <Text> Identity file: (ssh-agent)</Text>
        </Box>
      ) : null}

      {/* SSH Testing */}
      {step === 'ssh-testing' ? (
        <Box>
          <Text color="yellow">⠋</Text>
          <Text>
            {' '}
            Testing SSH connection to {sshUser}@{sshHost}...
          </Text>
        </Box>
      ) : null}

      {/* SSH Error */}
      {step === 'ssh-error' ? (
        <Box flexDirection="column">
          <Text> </Text>
          <Box>
            <Text color="red">✗</Text>
            <Text> {sshErrorMessage}</Text>
          </Box>
          <Text> </Text>
          <Text dimColor>
            SSH setup skipped. You can configure it later by editing your config file:
          </Text>
          <Text dimColor> localpress config get</Text>
          <Text dimColor>Or re-run: localpress init --site {siteName}</Text>
          <Text> </Text>
          <Text dimColor>Press Enter to exit.</Text>
        </Box>
      ) : null}

      {/* Final Report (after SSH configured) */}
      {step === 'final-report' ? (
        <Box flexDirection="column">
          <Text> </Text>
          <Box>
            <Text color="green">✓</Text>
            <Text>
              {' '}
              SSH connected to {sshUser}@{sshHost}
            </Text>
          </Box>
          <Box>
            <Text color="green">✓</Text>
            <Text> WP-CLI verified at {sshWpPath}</Text>
          </Box>
          <Text> </Text>
          <Text bold>Capabilities (with WP-CLI):</Text>
          {capabilities.map((cap) => (
            <Box key={cap.name}>
              <Text> </Text>
              <Text color={cap.available ? 'green' : 'red'}>{cap.available ? '✓' : '✗'}</Text>
              <Text> {cap.name}</Text>
            </Box>
          ))}
          <Text> </Text>
          <Text color="green" bold>
            Ready! All capabilities unlocked. Try `localpress list` to see your media library.
          </Text>
          <Text dimColor>Press Enter to exit.</Text>
        </Box>
      ) : null}

      {/* Error */}
      {step === 'error' ? (
        <Box flexDirection="column">
          <Text> </Text>
          <Box>
            <Text color="red">✗</Text>
            <Text> {errorMessage}</Text>
          </Box>
          <Text> </Text>
          <Text dimColor>Press any key to exit.</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// -- Helpers ------------------------------------------------------------------

function normalizeUrl(url: string): string {
  let normalized = url;
  if (!normalized.startsWith('http')) {
    normalized = `https://${normalized}`;
  }
  return normalized.replace(/\/+$/, '');
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'my-site';
  }
}
