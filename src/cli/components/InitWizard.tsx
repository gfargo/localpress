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
 *   7. Save confirmation
 */

import { useState, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { SiteConfig } from '../../types.ts';
import { loadConfig, saveConfig } from '../utils/config.ts';

type WizardStep =
  | 'url'
  | 'name'
  | 'username'
  | 'password'
  | 'testing'
  | 'report'
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
  const [authenticatedAs, setAuthenticatedAs] = useState('');
  const [capabilities, setCapabilities] = useState<Array<{ name: string; available: boolean }>>([]);

  // Skip steps that already have values.
  useEffect(() => {
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
            setErrorMessage(
              'Authentication failed. Check your username and Application Password.',
            );
          } else {
            setErrorMessage(`Connection failed: ${response.status} ${response.statusText}`);
          }
          setStep('error');
          return;
        }

        const user = (await response.json()) as { name?: string; slug?: string };
        setAuthenticatedAs(user.name ?? user.slug ?? username);

        // Build capability report.
        const siteConfig: SiteConfig = {
          name: siteName || new URL(normalizedUrl).hostname,
          url: normalizedUrl,
          username,
          appPassword: password,
          createdAt: new Date().toISOString(),
        };

        const resolver = new AdapterResolver(siteConfig);
        const report = resolver.capabilityReport();
        setCapabilities(
          report.map((r) => ({
            name: r.capability,
            available: r.preferredAdapter !== null,
          })),
        );

        // Save config.
        const config = await loadConfig();
        config.sites[siteConfig.name] = siteConfig;
        if (!config.activeSite) {
          config.activeSite = siteConfig.name;
        }
        await saveConfig(config);

        setSiteName(siteConfig.name);
        setStep('report');
      } catch (err) {
        setErrorMessage(
          `Could not connect: ${err instanceof Error ? err.message : String(err)}`,
        );
        setStep('error');
      }
    };

    testConnection();
  }, [step]);

  // Handle text input.
  useInput((input, key) => {
    if (step === 'report' || step === 'done') {
      if (key.return || input === 'q') {
        exit();
      }
      return;
    }

    if (step === 'error') {
      exit();
      return;
    }

    if (step === 'testing') return;

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
    }
  }

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
        <Box>
          <Text>Site name [{getHostname(url)}]: </Text>
          <Text color="green">{inputValue}</Text>
          <Text color="gray">▌</Text>
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
          <Text dimColor>
            Application Passwords: {url}/wp-admin/profile.php
          </Text>
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

      {/* Step 6: Report */}
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
              <Text>  </Text>
              <Text color={cap.available ? 'green' : 'red'}>
                {cap.available ? '✓' : '✗'}
              </Text>
              <Text> {cap.name}</Text>
            </Box>
          ))}
          <Text> </Text>
          {capabilities.some((c) => !c.available) ? (
            <Text dimColor>
              Tip: Configure SSH for WP-CLI to unlock all capabilities.
            </Text>
          ) : null}
          <Text> </Text>
          <Text color="green" bold>
            Ready! Try `localpress list` to see your media library.
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
