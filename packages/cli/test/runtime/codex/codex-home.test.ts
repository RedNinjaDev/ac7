/**
 * Tests for `setupCodexHome` — verifies the ephemeral CODEX_HOME
 * structure that gets written for `codex app-server` to read.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupCodexHome } from '../../../src/runtime/agents/codex/codex-home.js';

describe('setupCodexHome', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ac7-codex-test-'));
  });
  afterEach(() => {
    // setupCodexHome's handle.remove() handles its own cleanup.
    // workDir holds our fake `realCodexHome` and gets cleaned up
    // automatically when the OS reaps tmpdir.
  });

  it('writes a config.toml with the [mcp_servers.ac7] block', () => {
    const fakeRealHome = join(workDir, 'fake-codex');
    mkdirSync(fakeRealHome);
    writeFileSync(join(fakeRealHome, 'auth.json'), '{"token":"fake"}');

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      bridgeCommand: '/usr/bin/node',
      bridgeArgs: ['/path/to/cli/dist/index.js', 'mcp-bridge'],
      runnerSocketPath: '/tmp/ac7-runner-xyz.sock',
    });

    try {
      expect(existsSync(handle.path)).toBe(true);
      expect(existsSync(handle.configPath)).toBe(true);

      const toml = readFileSync(handle.configPath, 'utf8');
      expect(toml).toContain('[mcp_servers.ac7]');
      expect(toml).toContain('command = "/usr/bin/node"');
      expect(toml).toContain('args = ["/path/to/cli/dist/index.js", "mcp-bridge"]');
      expect(toml).toContain('enabled = true');
      expect(toml).toContain('default_tools_approval_mode = "approve"');
      expect(toml).toContain('[mcp_servers.ac7.env]');
      expect(toml).toContain('AC7_RUNNER_SOCKET = "/tmp/ac7-runner-xyz.sock"');
    } finally {
      handle.remove();
    }
  });

  it('symlinks auth.json from the real codex home', () => {
    const fakeRealHome = join(workDir, 'fake-codex');
    mkdirSync(fakeRealHome);
    const realAuth = join(fakeRealHome, 'auth.json');
    writeFileSync(realAuth, '{"token":"real"}');

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      bridgeCommand: 'node',
      bridgeArgs: ['cli', 'mcp-bridge'],
      runnerSocketPath: '/tmp/sock',
    });

    try {
      expect(handle.authLinked).toBe(true);
      const linkedAuth = join(handle.path, 'auth.json');
      const stat = lstatSync(linkedAuth);
      expect(stat.isSymbolicLink()).toBe(true);
      // Reading through the symlink returns the real file contents.
      expect(readFileSync(linkedAuth, 'utf8')).toBe('{"token":"real"}');
    } finally {
      handle.remove();
    }
  });

  it('reports authLinked=false when no real auth.json exists', () => {
    const fakeRealHome = join(workDir, 'no-codex-here');
    // Don't create the dir.

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      bridgeCommand: 'node',
      bridgeArgs: ['cli', 'mcp-bridge'],
      runnerSocketPath: '/tmp/sock',
    });

    try {
      expect(handle.authLinked).toBe(false);
      expect(existsSync(join(handle.path, 'auth.json'))).toBe(false);
    } finally {
      handle.remove();
    }
  });

  it('remove() deletes the ephemeral dir and is idempotent', () => {
    const fakeRealHome = join(workDir, 'fake-codex');
    mkdirSync(fakeRealHome);
    writeFileSync(join(fakeRealHome, 'auth.json'), '{}');

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      bridgeCommand: 'node',
      bridgeArgs: ['cli', 'mcp-bridge'],
      runnerSocketPath: '/tmp/sock',
    });
    expect(existsSync(handle.path)).toBe(true);

    handle.remove();
    expect(existsSync(handle.path)).toBe(false);

    // Deleting the symlink must not delete the real auth.json.
    expect(existsSync(join(fakeRealHome, 'auth.json'))).toBe(true);

    // Idempotent.
    handle.remove();
    expect(existsSync(handle.path)).toBe(false);
  });

  it('emits model_provider and [model_providers.*] block when modelProvider is set', () => {
    const fakeRealHome = join(workDir, 'fake-codex');
    mkdirSync(fakeRealHome);
    writeFileSync(join(fakeRealHome, 'auth.json'), '{}');

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      bridgeCommand: '/usr/bin/node',
      bridgeArgs: ['/path/to/cli/dist/index.js', 'mcp-bridge'],
      runnerSocketPath: '/tmp/ac7-runner-xyz.sock',
      modelProvider: {
        name: 'qwen',
        baseUrl: 'http://localhost:8000/v1',
        wireApi: 'chat',
      },
    });

    try {
      const toml = readFileSync(handle.configPath, 'utf8');
      expect(toml).toContain('model_provider = "qwen"');
      expect(toml).toContain('[model_providers.qwen]');
      expect(toml).toContain('base_url = "http://localhost:8000/v1"');
      expect(toml).toContain('wire_api = "chat"');
      expect(toml).toContain('env_key = "OPENAI_API_KEY"');
      // mcp block must still be present
      expect(toml).toContain('[mcp_servers.ac7]');
    } finally {
      handle.remove();
    }
  });

  it('defaults wireApi to chat and uses custom envKey when provided', () => {
    const fakeRealHome = join(workDir, 'fake-codex');
    mkdirSync(fakeRealHome);
    writeFileSync(join(fakeRealHome, 'auth.json'), '{}');

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      bridgeCommand: '/usr/bin/node',
      bridgeArgs: ['mcp-bridge'],
      runnerSocketPath: '/tmp/sock',
      modelProvider: {
        name: 'local',
        baseUrl: 'http://localhost:11434/v1',
        envKey: 'MY_API_KEY',
      },
    });

    try {
      const toml = readFileSync(handle.configPath, 'utf8');
      expect(toml).toContain('wire_api = "chat"');
      expect(toml).toContain('env_key = "MY_API_KEY"');
    } finally {
      handle.remove();
    }
  });

  it('does not emit model_provider block when modelProvider is absent', () => {
    const fakeRealHome = join(workDir, 'fake-codex');
    mkdirSync(fakeRealHome);
    writeFileSync(join(fakeRealHome, 'auth.json'), '{}');

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      bridgeCommand: '/usr/bin/node',
      bridgeArgs: ['mcp-bridge'],
      runnerSocketPath: '/tmp/sock',
    });

    try {
      const toml = readFileSync(handle.configPath, 'utf8');
      expect(toml).not.toContain('model_provider');
      expect(toml).not.toContain('[model_providers.');
    } finally {
      handle.remove();
    }
  });

  it('escapes special characters in TOML strings', () => {
    const fakeRealHome = join(workDir, 'fake-codex');
    mkdirSync(fakeRealHome);
    writeFileSync(join(fakeRealHome, 'auth.json'), '{}');

    const handle = setupCodexHome({
      realCodexHome: fakeRealHome,
      parentDir: workDir,
      // Embed a quote and backslash in the bridge command — should be
      // escaped, not break the file.
      bridgeCommand: '/some "weird" path/with\\backslash',
      bridgeArgs: ['mcp-bridge'],
      runnerSocketPath: '/tmp/sock',
    });

    try {
      const toml = readFileSync(handle.configPath, 'utf8');
      expect(toml).toContain('command = "/some \\"weird\\" path/with\\\\backslash"');
    } finally {
      handle.remove();
    }
  });
});
