/**
 * `ac7` — operator CLI for ac7.
 *
 * Subcommands:
 *   ac7 setup       — first-run wizard: create team config + enroll TOTP
 *   ac7 member        — list / create / update / delete team users
 *   ac7 enroll      — (re-)enroll a user for web UI login (TOTP)
 *   ac7 rotate      — rotate a user's bearer token
 *   ac7 claude-code — spawn claude-code wrapped in a ac7 runner
 *   ac7 push        — push an event to a teammate or broadcast
 *   ac7 roster      — list users and connection state
 *   ac7 objectives  — list / view / mutate team objectives
 *   ac7 serve       — run a local broker (optional peer: @agentc7/server)
 *
 * The internal `ac7 mcp-bridge` verb is hidden from the top-level
 * help; agents spawn it via `.mcp.json` and it connects back to the
 * runner over UDS.
 *
 * Global env vars (defaults):
 *   AC7_URL       = http://127.0.0.1:8717
 *   AC7_TOKEN     (required for claude-code / push / roster / objectives)
 */

import { Client } from '@agentc7/sdk/client';
import { DEFAULT_PORT, ENV } from '@agentc7/sdk/protocol';
import { parseDataFlag, parseSubcommandArgs } from './args.js';
import { findAuthEntry } from './commands/auth-config.js';
import { runClaudeCodeCommand } from './commands/claude-code.js';
import { runCodexCommand } from './commands/codex.js';
import { runConnectCommand } from './commands/connect.js';
import { formatReport, runDoctor } from './commands/doctor.js';
import { runEnrollCommand } from './commands/enroll.js';
import { UsageError } from './commands/errors.js';
import { runMemberCommand } from './commands/member.js';
import { runObjectivesCommand } from './commands/objectives.js';
import { runPresetsCommand } from './commands/presets.js';
import { runPruneTracesCommand } from './commands/prune-traces.js';
import { type PushCommandInput, runPushCommand } from './commands/push.js';
import { QuickstartError, runQuickstartCommand } from './commands/quickstart.js';
import { runRosterCommand } from './commands/roster.js';
import { type RotateCommandInput, runRotateCommand } from './commands/rotate.js';
import { runServeCommand } from './commands/serve.js';
import { runSetupCommand } from './commands/setup.js';
import { runTeamCommand } from './commands/team.js';
import { runTelemetryCommand, type TelemetryEventKind } from './commands/telemetry.js';
import { CLI_VERSION } from './version.js';

const USAGE = `ac7 cli v${CLI_VERSION}

usage:
  ac7 setup       [--config-path <path>]                 first-run wizard (team + first admin + TOTP)
  ac7 member        list|create|update|delete [--config-path <path>]   offline user management (runs without the broker)
  ac7 connect     [--url <broker>] [--label <hint>] [--no-write] [--quiet]
                                    enroll this device with the broker (device-code flow); writes ~/.config/ac7/auth.json on approval
  ac7 enroll      --member <name> [--config-path <path>]   (re-)enroll a user for web UI login (TOTP — separate from 'ac7 connect')
  ac7 rotate      --member <name> [--config-path <path>]   rotate a user's bearer token (atomic; prints new token once)
  ac7 quickstart  [--skip-browser] [--assignee <name>]   seed a demo objective + open the web UI
  ac7 telemetry   enable|disable|preview|rotate|status       opt-in, zero-PII, off-by-default install telemetry
  ac7 claude-code [--no-trace] [--doctor] [--skip-doctor] [--unsafe-tls] [-- <claude args>...]   spawn claude-code wrapped in a ac7 runner
  ac7 codex       [--no-trace] [--cwd <dir>] [--model <name>] [-- <codex args>...]   spawn OpenAI Codex CLI as a headless agent member of a ac7 team
  ac7 push        --body <text> (--agent <id> | --broadcast) [--title <t>] [--level <lvl>] [--data key=value]...
  ac7 roster      [--reveal-token --member <name> [--config-path <path>]]
                                    list teammates (no flags) or rotate+print a user's token (alias over 'ac7 rotate')
  ac7 objectives  list|view|create|update|complete|cancel|reassign   team objectives
  ac7 serve       [--config-path <path>] [--port <n>] [--host <h>] [--db <path>]
  ac7 prune-traces --older-than <duration> [--activity-db <path>] [--yes]   delete activity rows older than the cutoff

global options (or via env):
  --url <url>       broker base URL (env: ${ENV.url}, default: http://127.0.0.1:${DEFAULT_PORT})
  --token <secret>  broker bearer token (env: ${ENV.token})
  -h, --help        print this message
  -v, --version     print the installed CLI version and exit
`;

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`ac7: ${message}\n`);
  process.exit(code);
}

function getString(values: Record<string, unknown>, key: string): string | undefined {
  const v = values[key];
  return typeof v === 'string' ? v : undefined;
}

function getBoolean(values: Record<string, unknown>, key: string): boolean {
  return values[key] === true;
}

function makeClient(values: Record<string, unknown>): Client {
  const { url, token } = resolveAuth({
    url: getString(values, 'url'),
    token: getString(values, 'token'),
  });
  return new Client({ url, token });
}

/**
 * Three-step token resolution: explicit flag → env var → saved
 * auth.json entry for this URL. Used by every verb that needs to
 * authenticate to the broker — including the runner verbs (`ac7
 * claude-code`, `ac7 codex`), so `ac7 connect` actually closes the
 * loop and the runner picks up the saved token without touching env
 * vars. Returns `null` for `token` only if the caller explicitly
 * opted out of failing (none currently); the normal path fails the
 * process with a clear message if no source provides a token.
 */
function resolveAuth(input: { url?: string; token?: string }): {
  url: string;
  token: string;
} {
  const url = input.url ?? process.env[ENV.url] ?? `http://127.0.0.1:${DEFAULT_PORT}`;
  let token = input.token ?? process.env[ENV.token];
  if (!token) {
    const saved = findAuthEntry(url);
    if (saved) token = saved.token;
  }
  if (!token) {
    fail(`--token or ${ENV.token} is required (or run \`ac7 connect\` to enroll this device).`);
  }
  return { url, token };
}

/**
 * Same as `resolveAuth` but runs the device-code `ac7 connect` flow
 * inline when no token can be resolved, returning the freshly-minted
 * token instead of failing. Used by the long-running runner verbs
 * (`ac7 claude-code`, `ac7 codex`) where the natural UX on first run
 * is "set me up, then start the session" rather than bouncing the
 * operator out to a separate command.
 *
 * Single-use verbs (push, roster, objectives) keep the hard fail —
 * those are typically scripted, and prompting from the middle of a
 * pipeline would be surprising.
 */
async function resolveAuthOrConnect(input: { url?: string; token?: string }): Promise<{
  url: string;
  token: string;
}> {
  const url = input.url ?? process.env[ENV.url] ?? `http://127.0.0.1:${DEFAULT_PORT}`;
  let token = input.token ?? process.env[ENV.token];
  if (!token) {
    const saved = findAuthEntry(url);
    if (saved) token = saved.token;
  }
  if (token) return { url, token };

  // No auth in this project. Fall through to the device-code flow.
  // Pass `input.url` through (not the resolved fallback) so connect
  // re-runs its own resolution — that way an unset `--url` still
  // triggers connect's own prompt path with the right default.
  process.stdout.write('ac7: no saved auth for this directory — running `ac7 connect`...\n');
  try {
    const result = await runConnectCommand(
      input.url !== undefined ? { url: input.url } : {},
      (line) => process.stdout.write(`${line}\n`),
      (line) => process.stderr.write(`${line}\n`),
    );
    return { url: result.url, token: result.token };
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  if (argv[0] === '-v' || argv[0] === '--version') {
    process.stdout.write(`ac7 ${CLI_VERSION}\n`);
    return;
  }

  const subcommand = argv[0];
  const rest = argv.slice(1);

  switch (subcommand) {
    case 'setup':
      await handleSetup(rest);
      return;
    case 'member':
      await handleUser(rest);
      return;
    case 'enroll':
      await handleEnroll(rest);
      return;
    case 'connect':
      await handleConnect(rest);
      return;
    case 'rotate':
      await handleRotate(rest);
      return;
    case 'quickstart':
      await handleQuickstart(rest);
      return;
    case 'telemetry':
      await handleTelemetry(rest);
      return;
    case 'push':
      await handlePush(rest);
      return;
    case 'roster':
      await handleRoster(rest);
      return;
    case 'objectives':
      await handleObjectives(rest);
      return;
    case 'team':
      await handleTeam(rest);
      return;
    case 'presets':
      await handlePresets(rest);
      return;
    case 'serve':
      await handleServe(rest);
      return;
    case 'prune-traces':
      await handlePruneTraces(rest);
      return;
    case 'mcp-bridge':
      await handleMcpBridge(rest);
      return;
    case 'claude-code':
      await handleClaudeCode(rest);
      return;
    case 'codex':
      await handleCodex(rest);
      return;
    default:
      process.stderr.write(USAGE);
      fail(`unknown subcommand: ${subcommand}`);
  }
}

async function handleSetup(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    'config-path': { type: 'string' },
    config: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    await runSetupCommand(
      {
        configPath: getString(values, 'config-path') ?? getString(values, 'config'),
      },
      (line) => log(line),
    );
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleEnroll(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    user: { type: 'string', short: 'u' },
    url: { type: 'string' },
    token: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    const client = makeClient(values);
    await runEnrollCommand({ user: getString(values, 'user') }, client, (line) => log(line));
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleConnect(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    url: { type: 'string' },
    label: { type: 'string', short: 'l' },
    'no-write': { type: 'boolean' },
    quiet: { type: 'boolean', short: 'q' },
    'auth-config': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  try {
    await runConnectCommand(
      {
        url: getString(values, 'url'),
        label: getString(values, 'label'),
        noWrite: getBoolean(values, 'no-write'),
        quiet: getBoolean(values, 'quiet'),
        authConfigPath: getString(values, 'auth-config'),
      },
      (line) => process.stdout.write(`${line}\n`),
      (line) => process.stderr.write(`${line}\n`),
    );
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleRotate(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    user: { type: 'string', short: 'u' },
    url: { type: 'string' },
    token: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    const client = makeClient(values);
    await runRotateCommand(
      {
        user: getString(values, 'user'),
      },
      client,
      (line) => log(line),
    );
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleUser(args: string[]): Promise<void> {
  // `member` has internal subcommand routing (list/create/update/delete)
  // with flags that differ per-subcommand — parse out the client opts
  // here, then pass everything else through.
  if (args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  const { clientOpts, passthrough } = splitClientOpts(args);
  try {
    const client = makeClient(clientOpts);
    await runMemberCommand(passthrough, client, (line) => log(line));
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handlePruneTraces(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    'older-than': { type: 'string' },
    'activity-db': { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  try {
    await runPruneTracesCommand(
      {
        olderThan: getString(values, 'older-than'),
        activityDbPath: getString(values, 'activity-db'),
        yes: getBoolean(values, 'yes'),
      },
      (line) => log(line),
    );
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handlePush(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    agent: { type: 'string', short: 'a' },
    body: { type: 'string', short: 'b' },
    title: { type: 'string', short: 't' },
    level: { type: 'string', short: 'l' },
    broadcast: { type: 'boolean' },
    data: { type: 'string', multiple: true },
    url: { type: 'string' },
    token: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const dataRaw = values.data as string[] | undefined;
  let data: Record<string, unknown> | undefined;
  try {
    data = parseDataFlag(dataRaw);
  } catch (err) {
    fail((err as Error).message);
  }

  const input: PushCommandInput = {
    to: getString(values, 'agent'),
    body: getString(values, 'body') ?? '',
    title: getString(values, 'title'),
    level: getString(values, 'level'),
    broadcast: getBoolean(values, 'broadcast'),
    data,
  };

  try {
    const client = makeClient(values);
    const output = await runPushCommand(input, client);
    log(output);
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleTelemetry(args: string[]): Promise<void> {
  // Sub-subcommand is the first positional. Everything else is an
  // optional flag (currently just --event for preview and --path for
  // the state-file override).
  const action = args[0];
  if (action === undefined || action === '-h' || action === '--help') {
    process.stdout.write(USAGE);
    return;
  }

  const { values } = parseSubcommandArgs(args.slice(1), {
    event: { type: 'string' },
    path: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  const eventRaw = getString(values, 'event');
  let event: TelemetryEventKind | undefined;
  if (eventRaw !== undefined) {
    if (eventRaw !== 'boot' && eventRaw !== 'directive-complete') {
      fail(`invalid --event value: ${eventRaw} (valid: boot | directive-complete)`, 2);
    }
    event = eventRaw;
  }

  try {
    await runTelemetryCommand(
      {
        action,
        statePath: getString(values, 'path'),
        event,
        ac7Version: CLI_VERSION,
      },
      (line) => log(line),
    );
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleQuickstart(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    url: { type: 'string' },
    token: { type: 'string' },
    'skip-browser': { type: 'boolean' },
    assignee: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    const client = makeClient(values);
    const url =
      getString(values, 'url') ?? process.env[ENV.url] ?? `http://127.0.0.1:${DEFAULT_PORT}`;
    const token = getString(values, 'token') ?? process.env[ENV.token] ?? '';
    await runQuickstartCommand(
      {
        url,
        token,
        skipBrowser: getBoolean(values, 'skip-browser'),
        assignee: getString(values, 'assignee'),
      },
      client,
      (line) => log(line),
    );
  } catch (err) {
    if (err instanceof QuickstartError) fail(err.message);
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleRoster(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    url: { type: 'string' },
    token: { type: 'string' },
    'reveal-token': { type: 'boolean' },
    user: { type: 'string', short: 'u' },
    'config-path': { type: 'string' },
    config: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  // `--reveal-token` is an alias over `ac7 rotate --user X`: the only
  // honest way to surface a user's bearer plaintext is to mint a fresh
  // one, since hash-on-disk (I1 posture) means the existing plaintext
  // was never persisted. Invoking this command therefore has a visible
  // side effect — the previous token is invalidated. We disclose that
  // up front so it's impossible to miss, then delegate to the exact
  // same code path `ac7 rotate` uses.
  if (getBoolean(values, 'reveal-token')) {
    const user = getString(values, 'user');
    if (!user) {
      fail('roster --reveal-token: --member <name> is required', 2);
    }
    log('');
    log(`ac7 roster --reveal-token → rotating '${user}' token.`);
    log('  (ac7 never persists token plaintext; the only honest "reveal"');
    log('   is to mint a fresh token and print it once. This invalidates');
    log('   any previous token for this user.)');
    const rotateInput: RotateCommandInput = { user };
    try {
      const client = makeClient(values);
      await runRotateCommand(rotateInput, client, (line) => log(line));
    } catch (err) {
      if (err instanceof UsageError) fail(err.message, 2);
      fail(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  try {
    const client = makeClient(values);
    const output = await runRosterCommand(client);
    log(output);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleServe(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    'config-path': { type: 'string' },
    config: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    db: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const portStr = getString(values, 'port');
  let port: number | undefined;
  if (portStr !== undefined) {
    const parsed = Number(portStr);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 65_535) {
      fail(`invalid --port: ${portStr}`, 2);
    }
    port = parsed;
  }

  let running: Awaited<ReturnType<typeof runServeCommand>> | null = null;
  try {
    running = await runServeCommand(
      {
        configPath: getString(values, 'config-path') ?? getString(values, 'config'),
        port,
        host: getString(values, 'host'),
        dbPath: getString(values, 'db'),
      },
      (line) => log(line),
    );
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }

  const shutdown = async (signal: NodeJS.Signals) => {
    process.stderr.write(`\nac7 serve: stopping (${signal})...\n`);
    await running?.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function handleObjectives(args: string[]): Promise<void> {
  // Objectives has its own internal subcommand routing that parses
  // flags per-subcommand. We still pull `--url` / `--token` out of
  // argv here so `ac7 objectives list --url http://...` works the
  // same way the other subcommands do.
  //
  // Strategy: extract --url and --token pairs from argv, passing the
  // rest through to runObjectivesCommand. parseArgs would reject
  // unknown options, so we do this by hand with a tight loop.
  const clientOpts: Record<string, string> = {};
  const passthrough: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return;
    }
    if (arg === '--url' || arg === '--token') {
      const next = args[i + 1];
      if (next === undefined) {
        fail(`${arg} requires a value`, 2);
      }
      clientOpts[arg.slice(2)] = next as string;
      i++;
      continue;
    }
    if (arg === undefined) continue;
    passthrough.push(arg);
  }

  try {
    const client = makeClient(clientOpts);
    const output = await runObjectivesCommand(client, passthrough);
    log(output);
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Split off `--url` / `--token` for `makeClient`, pass everything else
 * through to the subcommand. Same pattern as `handleObjectives`.
 */
function splitClientOpts(args: string[]): {
  clientOpts: Record<string, string>;
  passthrough: string[];
} {
  const clientOpts: Record<string, string> = {};
  const passthrough: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--url' || arg === '--token') {
      const next = args[i + 1];
      if (next === undefined) fail(`${arg} requires a value`, 2);
      clientOpts[arg.slice(2)] = next as string;
      i++;
      continue;
    }
    if (arg === undefined) continue;
    passthrough.push(arg);
  }
  return { clientOpts, passthrough };
}

async function handleTeam(args: string[]): Promise<void> {
  const { clientOpts, passthrough } = splitClientOpts(args);
  try {
    const client = makeClient(clientOpts);
    await runTeamCommand(passthrough, client, (line) => log(line));
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handlePresets(args: string[]): Promise<void> {
  const { clientOpts, passthrough } = splitClientOpts(args);
  try {
    const client = makeClient(clientOpts);
    await runPresetsCommand(passthrough, client, (line) => log(line));
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * `ac7 claude-code` — spawn claude-code as a child of a ac7 runner.
 *
 * Arg handling is a little custom: we accept `--url` and `--token` as
 * ac7 knobs (with env fallback), then everything after a literal `--`
 * is forwarded verbatim to claude. Without a `--`, any unrecognized
 * args also flow through to claude, so `ac7 claude-code --model opus`
 * works the same as `ac7 claude-code -- --model opus`.
 */
async function handleClaudeCode(args: string[]): Promise<void> {
  let url: string | undefined;
  let token: string | undefined;
  let noTrace = false;
  let doctor = false;
  let skipDoctor = false;
  let unsafeTls = false;
  const claudeArgs: string[] = [];
  let seenDashDash = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (seenDashDash) {
      claudeArgs.push(arg);
      continue;
    }
    if (arg === '--') {
      seenDashDash = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return;
    }
    if (arg === '--no-trace') {
      noTrace = true;
      continue;
    }
    if (arg === '--doctor') {
      doctor = true;
      continue;
    }
    if (arg === '--skip-doctor') {
      skipDoctor = true;
      continue;
    }
    if (arg === '--unsafe-tls') {
      unsafeTls = true;
      continue;
    }
    if (arg === '--url' || arg === '--token') {
      const next = args[i + 1];
      if (next === undefined) {
        fail(`${arg} requires a value`, 2);
      }
      if (arg === '--url') url = next as string;
      else token = next as string;
      i++;
      continue;
    }
    // Anything else we don't recognize flows to claude. This lets
    // `ac7 claude-code --model opus` work the same as with a `--`.
    claudeArgs.push(arg);
  }

  // Explicit `--doctor` is the "run doctor, print the full report, exit"
  // mode. Unchanged.
  if (doctor) {
    const report = await runDoctor();
    log(formatReport(report));
    process.exit(report.anyFail ? 1 : 0);
  }

  // Default preflight: run doctor silently before spawning claude so a
  // broken environment surfaces as a readable report instead of a
  // cryptic runtime error three seconds into the session. `--skip-doctor`
  // opts out for individual-contributors who know the environment is fine (CI,
  // scripted reruns, etc.). WARNs are advisory — we proceed. Only FAILs
  // abort, and when they do we dump the full report so the individual-contributor can
  // see which check tripped.
  if (!skipDoctor) {
    const report = await runDoctor();
    if (report.anyFail) {
      process.stderr.write(formatReport(report));
      process.stderr.write(
        `\nac7 claude-code: preflight FAILED — fix the above or pass --skip-doctor to bypass\n`,
      );
      process.exit(1);
    }
  }

  try {
    const resolved = await resolveAuthOrConnect({ url, token });
    const code = await runClaudeCodeCommand({
      url: resolved.url,
      token: resolved.token,
      claudeArgs,
      noTrace,
      unsafeTls,
    });
    process.exit(code);
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * `ac7 codex` — spawn OpenAI Codex CLI as a headless team member.
 *
 * No interactive TUI: codex runs as `codex app-server` (a JSON-RPC
 * daemon) under our control. The director communicates with the
 * agent through the broker (chat / DMs / objectives / `ac7 push`).
 * Channel events arrive at codex as `turn/start` (when idle) or
 * `turn/steer` (mid-turn) — the structural equivalent of claude-code's
 * `notifications/claude/channel` ambient injection.
 *
 * Arg handling: `--url` and `--token` are ac7 knobs; `--no-trace`,
 * `--cwd`, and `--model` are runner knobs. Everything after a literal
 * `--` is forwarded verbatim to `codex app-server`. Unrecognized args
 * before `--` also fall through to codex (same pattern as claude-code).
 *
 * Use codex's own -c key=value syntax to override config.toml entries:
 *   ac7 codex -- -c 'model_provider="qwen"' \
 *               -c 'model_providers.qwen.base_url="http://localhost:8000/v1"'
 */
async function handleCodex(args: string[]): Promise<void> {
  let url: string | undefined;
  let token: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let noTrace = false;
  const codexArgs: string[] = [];
  let seenDashDash = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (seenDashDash) {
      codexArgs.push(arg);
      continue;
    }
    if (arg === '--') {
      seenDashDash = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return;
    }
    if (arg === '--no-trace') {
      noTrace = true;
      continue;
    }
    if (arg === '--url' || arg === '--token' || arg === '--cwd' || arg === '--model') {
      const next = args[i + 1];
      if (next === undefined) {
        fail(`${arg} requires a value`, 2);
      }
      switch (arg) {
        case '--url':
          url = next as string;
          break;
        case '--token':
          token = next as string;
          break;
        case '--cwd':
          cwd = next as string;
          break;
        case '--model':
          model = next as string;
          break;
      }
      i++;
      continue;
    }
    // Anything unrecognized falls through to codex — same pattern as
    // handleClaudeCode. This lets `ac7 codex -c 'key=value'` work the
    // same as `ac7 codex -- -c 'key=value'`.
    codexArgs.push(arg);
  }

  try {
    const resolved = await resolveAuthOrConnect({ url, token });
    const code = await runCodexCommand({
      url: resolved.url,
      token: resolved.token,
      cwd,
      model,
      noTrace,
      codexArgs: codexArgs.length > 0 ? codexArgs : undefined,
    });
    process.exit(code);
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * `ac7 mcp-bridge` — internal verb spawned by agents via `.mcp.json`.
 *
 * Hidden from the top-level `--help` usage because individual-contributors never
 * invoke it directly; the `ac7 claude-code` runner generates the
 * `.mcp.json` entry that points here. If an individual-contributor does run it by
 * hand, the bridge will immediately error out with "AC7_RUNNER_SOCKET
 * is required" which is the closest thing we can give them to a
 * useful message.
 */
async function handleMcpBridge(_args: string[]): Promise<void> {
  // The bridge ignores args entirely — it reads config only from
  // env vars (`AC7_RUNNER_SOCKET`) and stdio. The `_args` param is
  // kept to match the subcommand handler shape.
  const bridgeModule = await import('./runtime/bridge.js');
  try {
    await bridgeModule.runBridge();
  } catch (err) {
    if (err instanceof bridgeModule.BridgeStartupError) {
      process.stderr.write(`ac7 mcp-bridge: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
