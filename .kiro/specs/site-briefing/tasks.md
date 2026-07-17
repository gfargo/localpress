# Site Briefing - Implementation Plan

- [ ] 1. Export reusable detection helpers from `audit.ts`
  - Export `detectBrokenRefs` from `src/cli/commands/audit.ts` (currently
    module-private) so `briefing.ts` can reuse it without duplicating logic
  - _Requirements: 1.1_

- [ ] 2. Add a text-only Ollama generation helper
  - Add `generateText(prompt, options)` to `src/engine/caption/ollama.ts` —
    text-only sibling of `generateCaption`, same endpoint/timeout handling,
    no image payload
  - _Requirements: 3.1_

- [ ] 3. Implement the `briefing` CLI command
  - [ ] 3.1 Aggregate unoptimized / missing-alt / broken-refs (reusing
        `audit.ts` helpers) + orphans (via `AdapterResolver`, graceful skip)
        + a11y (via `runA11yScan`)
    - _Requirements: 1.1, 1.2, 2.1_
  - [ ] 3.2 Wire the per-site cache through `SiteDb.getPref`/`setPref`,
        including `--fresh` to bypass it
    - _Requirements: 4.1, 4.2_
  - [ ] 3.3 Add the Ollama narrative pass with graceful degradation
        (clean-site canned message with no Ollama call; unavailable, not
        an error, when Ollama is unreachable)
    - _Requirements: 3.1, 3.2, 3.3_
  - [ ] 3.4 Confirm no write path exists anywhere in the command (read-only)
    - _Requirements: 5.1_

- [ ] 4. Register the command in `src/cli/index.ts`
  - _Requirements: 1.1_

- [ ] 5. Add the `site_briefing` MCP tool in `src/cli/mcp/tools.ts`
  - _Requirements: 1.1, 4.1, 4.2_

- [ ] 6. Add unit tests in `test/unit/briefing.test.ts`
  - Cover aggregation correctness, capability-unavailable paths, and
    Ollama-unreachable degradation per design.md's Testing Strategy
  - _Requirements: 1.2, 2.1, 3.2, 3.3_

- [ ] 7. Run `bun run typecheck && bun run lint && bun test`
  - _Requirements: 1.1, 1.2, 2.1, 3.1, 3.2, 3.3, 4.1, 4.2, 5.1_

- [ ] 8. Manual smoke test against a real site (`wp.griffen.codes`)
  - Both cache-miss (`--fresh`) and cache-hit paths, before calling this
    done
  - _Requirements: 1.1, 2.1, 2.2, 3.1, 4.1, 4.2_

- [ ] 9. Update documentation
  - README (commands table + MCP section + tool count + Kiro config example
    + challenge callout), SKILL.md (command reference parity), CLAUDE.md
    (command count)
  - _Requirements: 1.1_
