/**
 * `localpress completions` — generate shell completion scripts.
 *
 * Outputs completion scripts for bash, zsh, or fish to stdout.
 * Users pipe the output to the appropriate shell config file or fpath directory.
 *
 * Command/flag lists are introspected from the live `program` command tree
 * (see `collectCommandSpecs`) rather than hand-maintained, so newly registered
 * commands and flags can't silently drift out of sync with what's generated
 * here. `OPTION_HINTS`/`ARG_HINTS` below are a small supplementary map of
 * cosmetic value-completion hints (e.g. `--to webp|avif|...`) that commander's
 * introspection can't derive on its own — those are the only pieces that can
 * still go stale.
 *
 * Usage:
 *   localpress completions bash >> ~/.bashrc
 *   localpress completions zsh > ~/.zsh/completions/_localpress  (then add to fpath)
 *   localpress completions fish > ~/.config/fish/completions/localpress.fish
 */

import type { Command } from 'commander';
import { error } from '../utils/output.ts';

const SHELLS = ['bash', 'zsh', 'fish'] as const;
type Shell = (typeof SHELLS)[number];

export function registerCompletionsCommand(program: Command): void {
  program
    .command('completions')
    .description('Generate shell completion scripts (bash, zsh, fish)')
    .argument('<shell>', `shell to generate completions for (${SHELLS.join(', ')})`)
    .action((shell: string) => {
      const normalized = shell.toLowerCase() as Shell;

      if (!SHELLS.includes(normalized)) {
        error(`Unknown shell: "${shell}". Supported: ${SHELLS.join(', ')}`);
        process.exit(2);
      }

      const specs = collectCommandSpecs(program);
      // -h/--help and -v/--version are handled explicitly by each generator
      // (commander wires them up specially, not as ordinary "flags to complete").
      const globalFlags = program.options
        .map(toFlagSpec)
        .filter((f) => f.long !== '--help' && f.long !== '--version');
      const script = generateCompletions(normalized, specs, globalFlags);
      // Write directly to stdout (bypass info() which respects --quiet/--json —
      // completions output must be pipeable regardless of those flags).
      process.stdout.write(script);
    });
}

function generateCompletions(shell: Shell, specs: CommandSpec[], globalFlags: FlagSpec[]): string {
  switch (shell) {
    case 'bash':
      return generateBash(specs, globalFlags);
    case 'zsh':
      return generateZsh(specs, globalFlags);
    case 'fish':
      return generateFish(specs, globalFlags);
  }
}

// -- Introspection -------------------------------------------------------------
// Walks the commander `program` tree so completions can't drift from the real
// CLI surface. One level of recursion covers `sites`, `posts`, and `config`,
// the only commands that register nested subcommands.

interface FlagSpec {
  long?: string;
  short?: string;
  description: string;
  takesValue: boolean;
}

interface ArgSpec {
  name: string;
  variadic: boolean;
}

interface CommandSpec {
  name: string;
  /** Dot-joined path (e.g. `config.set-profile`) — used as an OPTION_HINTS/ARG_HINTS key. */
  path: string;
  description: string;
  flags: FlagSpec[];
  args: ArgSpec[];
  subcommands: CommandSpec[];
}

function toFlagSpec(o: {
  long?: string;
  short?: string;
  description: string;
  required: boolean;
  optional: boolean;
}): FlagSpec {
  return {
    long: o.long,
    short: o.short,
    description: o.description,
    takesValue: o.required || o.optional,
  };
}

function collectCommandSpecs(program: Command): CommandSpec[] {
  return program.commands.map((cmd) => toCommandSpec(cmd, cmd.name()));
}

function toCommandSpec(cmd: Command, path: string): CommandSpec {
  return {
    name: cmd.name(),
    path,
    description: cmd.description(),
    flags: cmd.options.map(toFlagSpec),
    args: cmd.registeredArguments.map((a) => ({ name: a.name(), variadic: a.variadic })),
    subcommands: cmd.commands.map((sub) => toCommandSpec(sub, `${path}.${sub.name()}`)),
  };
}

// -- Cosmetic value hints -------------------------------------------------------
// Flag *existence* always comes from introspection above, so it can't go
// stale. These hints only decorate known enum-style values/paths for nicer
// completions — if a hint here drifts (or a new enum flag is added without
// one), the flag still completes correctly, just without a value hint.

type Hint = { kind: 'choices'; values: string[] } | { kind: 'dir' } | { kind: 'file' };

const OPTION_HINTS: Record<string, Hint> = {
  'list:--type': {
    kind: 'choices',
    values: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'],
  },
  'list:--sort': { kind: 'choices', values: ['date', 'name', 'size', 'id'] },
  'list:--order': { kind: 'choices', values: ['asc', 'desc'] },
  'export:--type': {
    kind: 'choices',
    values: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'],
  },
  'export:--to': { kind: 'dir' },
  'optimize:--to': { kind: 'choices', values: ['webp', 'avif', 'jpeg'] },
  'optimize:--mode': { kind: 'choices', values: ['lossy', 'lossless'] },
  'optimize:--encoder': { kind: 'choices', values: ['sharp', 'jsquash'] },
  'convert:--to': { kind: 'choices', values: ['webp', 'avif', 'jpeg', 'png'] },
  'import:--to': { kind: 'choices', values: ['webp', 'avif', 'jpeg', 'png'] },
  'watch:--to': { kind: 'choices', values: ['webp', 'avif', 'jpeg', 'png'] },
  'remove-bg:--model': {
    kind: 'choices',
    values: ['u2net', 'u2netp', 'silueta', 'isnet-general-use', 'birefnet-lite'],
  },
  'references:--scope': { kind: 'choices', values: ['fast', 'full'] },
  'edit:--to': { kind: 'dir' },
  'pull:--to': { kind: 'dir' },
  'config.set-profile:--format': { kind: 'choices', values: ['webp', 'avif', 'jpeg', 'png'] },
  'config.set-profile:--encoder': { kind: 'choices', values: ['sharp', 'jsquash'] },
  'a11y:--type': { kind: 'choices', values: ['post', 'page'] },
  'a11y:--status': {
    kind: 'choices',
    values: ['publish', 'draft', 'pending', 'private', 'trash'],
  },
  'posts.list:--status': {
    kind: 'choices',
    values: ['publish', 'draft', 'pending', 'private', 'trash'],
  },
  'posts.list:--orderby': { kind: 'choices', values: ['date', 'title', 'id', 'modified', 'slug'] },
  'posts.list:--order': { kind: 'choices', values: ['asc', 'desc'] },
  'posts.create:--status': { kind: 'choices', values: ['draft', 'publish', 'pending', 'private'] },
  'posts.update:--status': {
    kind: 'choices',
    values: ['publish', 'draft', 'pending', 'private', 'trash'],
  },
};

/** Value hints for positional (not flag) arguments — only zsh uses these. */
const ARG_HINTS: Record<string, Hint> = {
  push: { kind: 'file' },
  watch: { kind: 'dir' },
  completions: { kind: 'choices', values: [...SHELLS] },
};

/** Friendlier zsh labels for positional args, keyed by command path (in argument order). */
const ARG_LABELS: Record<string, string[]> = {
  'sites.add': ['site URL'],
  'sites.use': ['site name'],
  'sites.remove': ['site name'],
  'sites.run': ['shell command'],
  'posts.show': ['post ID'],
  'posts.update': ['post ID'],
  'posts.delete': ['post ID'],
  'config.get': ['config key'],
  'config.set': ['config key', 'config value'],
  'config.set-profile': ['profile name'],
  'config.get-profile': ['profile name'],
  'config.remove-profile': ['profile name'],
  'history.show': ['session or snapshot ID'],
  undo: ['session ID'],
  completions: ['shell'],
  watch: ['directory'],
  push: ['file'],
};

const GLOBAL_ARG_LABELS: Record<string, string> = {
  '--site': 'site name',
  '--concurrency': 'number',
};

function hintAction(hint: Hint): string {
  if (hint.kind === 'choices') return `(${hint.values.join(' ')})`;
  if (hint.kind === 'dir') return '_directories';
  return '_files';
}

// -- Zsh completions ----------------------------------------------------------
// zsh descriptions live inside single-quoted `_arguments` spec strings whose
// `[...]` bracket is terminated by the first unescaped `]`. Escape both that
// and any embedded `'` before interpolating free-text descriptions.
function zshEsc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\]/g, '\\]').replace(/'/g, "'\\''");
}

const ZSH_HELP_ARG = "'(-h --help)'{-h,--help}'[Display help]'";

function zshFlagEntry(path: string, flag: FlagSpec): string {
  const desc = zshEsc(flag.description || '');
  const hint = flag.long ? OPTION_HINTS[`${path}:${flag.long}`] : undefined;
  const label = (flag.long ?? flag.short ?? '').replace(/^--?/, '');
  const suffix = flag.takesValue ? `:${label}:${hint ? hintAction(hint) : ''}` : '';

  if (flag.short && flag.long) {
    return `'(${flag.short} ${flag.long})'{${flag.short},${flag.long}}'[${desc}]${suffix}'`;
  }
  return `'${flag.long ?? flag.short ?? ''}[${desc}]${suffix}'`;
}

function zshArgEntry(path: string, arg: ArgSpec, index: number): string {
  const hint = index === 0 ? ARG_HINTS[path] : undefined;
  const label = zshEsc(ARG_LABELS[path]?.[index] ?? arg.name);
  const star = arg.variadic ? '*' : '';
  return `'${star}:${label}:${hint ? hintAction(hint) : ''}'`;
}

function zshLeafCase(spec: CommandSpec, indent: string): string {
  const parts = [
    ...spec.flags.map((f) => zshFlagEntry(spec.path, f)),
    ZSH_HELP_ARG,
    ...spec.args.map((a, i) => zshArgEntry(spec.path, a, i)),
  ];
  return `${indent}${spec.name})
${indent}  _arguments -s \\
${indent}    ${parts.join(` \\\n${indent}    `)}
${indent}  ;;`;
}

function zshCaseForCommand(spec: CommandSpec, wordIndex: number, indent = '    '): string {
  if (spec.subcommands.length === 0) {
    return zshLeafCase(spec, indent);
  }

  const nextWordIndex = wordIndex + 1;
  const innerIndent = `${indent}    `;
  const subEntries = spec.subcommands
    .map((s) => `${innerIndent}  '${s.name}:${zshEsc(s.description || '')}'`)
    .join('\n');
  const subCases = spec.subcommands
    .map((s) => zshCaseForCommand(s, nextWordIndex, innerIndent))
    .join('\n');

  return `${indent}${spec.name})
${indent}  if (( CURRENT == ${nextWordIndex} )); then
${indent}    local -a subcmds
${indent}    subcmds=(
${subEntries}
${indent}    )
${indent}    _describe -t commands '${spec.name} subcommand' subcmds
${indent}    return
${indent}  fi
${indent}  case $words[${nextWordIndex}] in
${subCases}
${innerIndent}*)
${innerIndent}  _arguments -s $global_opts
${innerIndent}  ;;
${indent}  esac
${indent}  ;;`;
}

function zshGlobalOptEntry(flag: FlagSpec): string {
  const desc = zshEsc(flag.description || '');
  const label = GLOBAL_ARG_LABELS[flag.long ?? ''] ?? (flag.long ?? '').replace(/^--/, '');
  const suffix = flag.takesValue ? `:${label}:` : '';
  return `    '${flag.long}[${desc}]${suffix}'`;
}

function generateZsh(specs: CommandSpec[], globalFlags: FlagSpec[]): string {
  const commandEntries = specs
    .map((s) => `    '${s.name}:${zshEsc(s.description || '')}'`)
    .concat(`    'help:Display help for a command'`)
    .join('\n');

  const globalOptEntries = globalFlags
    .map(zshGlobalOptEntry)
    .concat(
      `    '(-h --help)'{-h,--help}'[Display help]'`,
      `    '(-v --version)'{-v,--version}'[Output version]'`,
    )
    .join('\n');

  const topCases = specs.map((s) => zshCaseForCommand(s, 2)).join('\n');

  return `#compdef localpress
# localpress zsh completion
# Generated by: localpress completions zsh
#
# Install (recommended — fpath):
#   mkdir -p ~/.zsh/completions
#   localpress completions zsh > ~/.zsh/completions/_localpress
#   # Then ensure ~/.zshrc contains (before compinit):
#   #   fpath=(~/.zsh/completions $fpath)
#   #   autoload -Uz compinit && compinit
#
# Or use eval (simpler but slightly slower shell startup):
#   eval "$(localpress completions zsh)"

_localpress() {
  local -a commands global_opts

  commands=(
${commandEntries}
  )

  global_opts=(
${globalOptEntries}
  )

  if (( CURRENT == 2 )); then
    _describe -t commands 'localpress command' commands
    _arguments -s $global_opts
    return
  fi

  case $words[2] in
${topCases}
    *)
      _arguments -s $global_opts
      ;;
  esac
}

_localpress "$@"
`;
}

// -- Bash completions ---------------------------------------------------------

function bashWords(flags: FlagSpec[], includeHelp = true): string {
  const words: string[] = [];
  for (const f of flags) {
    if (f.short) words.push(f.short);
    if (f.long) words.push(f.long);
  }
  if (includeHelp) words.push('--help');
  return words.join(' ');
}

function bashCaseForCommand(spec: CommandSpec): string {
  if (spec.subcommands.length === 0) {
    return `    ${spec.name})
      COMPREPLY=( $(compgen -W "${bashWords(spec.flags)}" -- "\${cur}") )
      ;;`;
  }

  const subNames = spec.subcommands
    .map((s) => s.name)
    .concat('--help')
    .join(' ');
  const subCases = spec.subcommands
    .map(
      (s) =>
        `          ${s.name}) COMPREPLY=( $(compgen -W "${bashWords(s.flags)}" -- "\${cur}") ) ;;`,
    )
    .join('\n');

  return `    ${spec.name})
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "${subNames}" -- "\${cur}") )
      else
        case "\${COMP_WORDS[2]}" in
${subCases}
          *) COMPREPLY=( $(compgen -W "--help" -- "\${cur}") ) ;;
        esac
      fi
      ;;`;
}

function generateBash(specs: CommandSpec[], globalFlags: FlagSpec[]): string {
  const commandNames = specs
    .map((s) => s.name)
    .concat('help')
    .join(' ');
  const globalWords = bashWords(globalFlags, false);
  const cases = specs.map(bashCaseForCommand).join('\n');

  return `# localpress bash completion
# Generated by: localpress completions bash
# Add to ~/.bashrc or ~/.bash_profile:
#   eval "$(localpress completions bash)"
# Or:
#   localpress completions bash >> ~/.bashrc

_localpress() {
  local cur prev commands global_opts
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="${commandNames}"
  global_opts="${globalWords} --help --version"

  # Complete commands at position 1
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands} \${global_opts}" -- "\${cur}") )
    return 0
  fi

  # Complete global options and subcommand-specific options
  local cmd="\${COMP_WORDS[1]}"
  case "\${cmd}" in
${cases}
    *)
      COMPREPLY=( $(compgen -W "\${global_opts}" -- "\${cur}") )
      ;;
  esac

  return 0
}

complete -F _localpress localpress
`;
}

// -- Fish completions ---------------------------------------------------------

function fishEsc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function fishFlagParts(flag: FlagSpec): string {
  const parts: string[] = [];
  if (flag.short) parts.push(`-s ${flag.short.replace(/^-/, '')}`);
  if (flag.long) parts.push(`-l ${flag.long.replace(/^--/, '')}`);
  return parts.join(' ');
}

function fishGlobalLine(flag: FlagSpec): string {
  const desc = flag.description ? ` -d "${fishEsc(flag.description)}"` : '';
  const extra = flag.takesValue ? ' -r' : '';
  return `complete -c localpress ${fishFlagParts(flag)}${desc}${extra}`;
}

function fishFlagLine(cond: string, path: string, flag: FlagSpec): string {
  const desc = flag.description ? ` -d "${fishEsc(flag.description)}"` : '';
  const hint = flag.long ? OPTION_HINTS[`${path}:${flag.long}`] : undefined;
  let extra = '';
  if (flag.takesValue) {
    extra = hint?.kind === 'choices' ? ` -r -a "${hint.values.join(' ')}"` : ' -r';
  }
  return `complete -c localpress -n "${cond}" ${fishFlagParts(flag)}${desc}${extra}`;
}

/** Flag completions for `spec` plus its subcommands' names and flags (one level deep). */
function fishOptionLines(spec: CommandSpec): string[] {
  const selfCond = `__fish_seen_subcommand_from ${spec.name}`;
  const lines = spec.flags.map((f) => fishFlagLine(selfCond, spec.path, f));

  for (const sub of spec.subcommands) {
    lines.push(
      `complete -c localpress -n "${selfCond}" -a "${sub.name}" -d "${fishEsc(sub.description || '')}"`,
    );
    const subCond = `${selfCond}; and __fish_seen_subcommand_from ${sub.name}`;
    lines.push(...sub.flags.map((f) => fishFlagLine(subCond, sub.path, f)));
  }

  return lines;
}

function generateFish(specs: CommandSpec[], globalFlags: FlagSpec[]): string {
  const lines: string[] = [
    '# localpress fish completion',
    '# Generated by: localpress completions fish',
    '# Save to: ~/.config/fish/completions/localpress.fish',
    '#   localpress completions fish > ~/.config/fish/completions/localpress.fish',
    '',
    '# Disable file completions by default',
    'complete -c localpress -f',
    '',
    '# Global options',
    ...globalFlags.map(fishGlobalLine),
    'complete -c localpress -s h -l help -d "Display help"',
    'complete -c localpress -s v -l version -d "Output version"',
    '',
    '# Commands',
    ...specs.map(
      (s) =>
        `complete -c localpress -n "__fish_use_subcommand" -a "${s.name}" -d "${fishEsc(s.description || '')}"`,
    ),
    'complete -c localpress -n "__fish_use_subcommand" -a "help" -d "Display help for a command"',
    '',
    '# Subcommand options',
    ...specs.flatMap((s) => fishOptionLines(s)),
    '',
  ];

  return lines.join('\n');
}
