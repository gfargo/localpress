# Tech Stack

## Runtime & Language

- **Runtime:** Bun (>=1.1.0) — used for execution, bundling, testing, and SQLite
- **Language:** TypeScript (strict mode, ESNext target, ESM modules)
- **Module system:** ES modules (`"type": "module"` in package.json)
- **License:** MIT — matches the rembg/Squoosh/sharp ecosystem

## Core Dependencies

- **CLI framework:** Commander.js — command registration and option parsing
- **Terminal UI:** Ink (React for CLIs) + React 18 — interactive wizards and progress displays
- **Image processing:** sharp (libvips) + @jsquash/{jpeg,png,webp,avif,oxipng,resize} (WASM codecs)
- **AI background removal:** onnxruntime-node (MIT) + U2-Net ONNX models (Apache-2.0)
- **HTTP client:** Bun built-in `fetch`
- **File watching:** chokidar
- **Logging:** pino
- **Database:** bun:sqlite (built-in, no external dep)
- **Hashing:** Node's `crypto` (built-in)

## Dev Tooling

- **Linter/Formatter:** Biome (single tool for both)
- **Type checking:** TypeScript compiler (`tsc --noEmit`)
- **Test runner:** `bun test` (built-in, runs .ts directly)
- **Build:** `bun build` + `npm install --production` produces distribution tarballs per platform (~100MB each, bundled deps)
- **CI:** GitHub Actions — lint + typecheck + test on PR; build binaries on v* tag

## Common Commands

```bash
bun install              # install dependencies
bun run dev -- --help    # run CLI from source
bun run typecheck        # tsc --noEmit
bun run lint             # biome check .
bun run lint:fix         # biome check --write .
bun run format           # biome format --write .
bun test                 # run all tests
bun test test/unit/      # unit tests only
bun run build            # build tarball at ./dist/localpress-<platform>.tar.gz
bun run build:all        # build tarballs for darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64
```

## Code Style (enforced by Biome)

- 2-space indentation, LF line endings, line width 100
- Single quotes, semicolons always, trailing commas everywhere
- Arrow parens always, JSX double quotes
- Imports organized automatically
- `useImportType` and `useNodejsImportProtocol` enforced as errors
- `noExplicitAny` and `noNonNullAssertion` are warnings (not errors)

## TypeScript Conventions

- Strict mode with `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`
- Path alias: `@/*` maps to `./src/*`
- File imports use `.ts` extension (Bun-native resolution)
- JSX configured as `react-jsx`

## WordPress Integration

- **Auth:** Application Passwords (built into WP core since 5.6) via HTTP Basic: `Authorization: Basic base64(username:app_password)`
- **REST endpoints:** `/wp-json/wp/v2/media`, `/wp-json/wp/v2/posts`, `/wp-json/wp/v2/pages`
- **Replace-in-place:** Stock WP REST API cannot replace attachment file bytes. True replacement requires WP-CLI over SSH or the "Enable Media Replace" plugin. Default behavior: try WP-CLI → try Enable Media Replace → fall back to new attachment + references report. `--strict` fails loudly instead of falling back.

## Error Handling

- Never silently continue past a failure
- Bulk ops: log error per item, continue to next, exit non-zero with summary
- All errors logged with full context to stderr; `--json` mode emits structured error records
- Use structured `ExitCode` enum from `src/types.ts` for known failure modes
- Let unhandled errors bubble to `main()` in `src/cli/index.ts`

## Idempotency

The CLI re-processes an attachment only if `source_hash` differs from what it last saw. Re-running `localpress optimize --all` after no source changes is a fast no-op (hash verification only). Same model as `make`.

## Concurrency

Default: `os.cpus().length - 1` parallel workers for bulk ops. Override with `--concurrency N`.

## Hard Constraints

- Do NOT use `console.log` directly — use `info()`, `warn()`, `error()`, `printJson()` from `src/cli/utils/output.ts`
- Do NOT bundle `@imgly/background-removal-node` — it is AGPL-3.0 and would force the project to AGPL
- Do NOT build a custom MCP server — ship a markdown skill instead
- Do NOT ship a companion WordPress plugin — use REST API + Application Passwords + opt-in WP-CLI
- Do NOT add npm distribution prematurely — Bun-bundled tarballs via Homebrew tap and GitHub Releases

## Terminal & CLI Workflow

- The terminal paste buffer overflows easily with long text. For long content (PR bodies, commit messages, issue bodies, multi-line scripts), write to a temp file and pipe it in rather than passing inline. Example: `gh issue create --body-file ./tmp/issue.md` instead of `--body "...long text..."`.
- Same applies to `gh pr create`, `git commit`, and any command accepting large text arguments.
