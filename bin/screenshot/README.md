# Screenshot & Demo GIF Pipeline

Generate deterministic marketing screenshots and demo GIFs of localpress using [Charm VHS](https://github.com/charmbracelet/vhs).

## Prerequisites

```bash
brew install vhs         # terminal recorder (pulls in ffmpeg + ttyd)
brew install gifsicle    # lossless GIF optimization
```

Verify: `vhs --version && gifsicle --version`

## Usage

```bash
# Generate all screenshots and GIFs
bun run screenshot

# Generate a specific recipe
bun run screenshot -- --recipe help-screen

# List all available recipes
bun run screenshot -- --list

# Generate only stills (PNGs)
bun run screenshot -- --stills

# Generate only motion demos (GIFs)
bun run screenshot -- --gifs
```

## Output

- **Stills** → `.www/public/screenshots/<name>.png`
- **GIFs** → `.www/public/screenshots/<name>.gif`

Raw captures land in `bin/screenshot/out/` before optimization and sync.

## Adding a New Recipe

Edit `bin/screenshot/recipes.ts` and add a new entry to `RECIPES`:

```ts
{
  name: 'my-new-shot',
  description: 'Shows the frobnicate feature',
  command: 'localpress frobnicate --site demo',
  actions: [
    { kind: 'sleep', ms: 2000 },
  ],
  emitGif: false, // true for motion, false for still
}
```

Then run `bun run screenshot -- --recipe my-new-shot` to test it.

## Architecture

```
bin/screenshot/
├── README.md           # this file
├── recipes.ts          # declarative scene catalog (data)
├── tape.ts             # recipe → .tape string (pure transform)
├── screenshot.ts       # driver: fixture → tape → vhs → optimize → output
└── out/                # raw VHS output (gitignored)
```

## Determinism

Every capture is reproducible because:

- Fixed `FontSize` (20) — canvas sized by VHS defaults (1200×600)
- Locked theme (`Catppuccin Mocha`)
- `CursorBlink false`
- Generous settle times for Bun cold-start (~3s)
- No reliance on real WordPress sites — uses `--help` and local-only commands

## GIF Optimization

Raw VHS GIFs are 10–20 MB. The driver automatically runs `gifsicle -O3` (lossless
inter-frame optimization) bringing them down 20–30× with zero quality loss. If
gifsicle is missing, it warns but continues with the unoptimized file.

## Tips

- **Stills:** generous sleep before `Screenshot` — you only get one frame
- **GIFs:** keep it short, one story per demo, end on the UI (no trailing quit)
- **Sizing:** bump `fontSize` in the recipe to make text bigger; don't shrink the canvas
- **Debugging:** check `bin/screenshot/out/` for raw output; run VHS directly on a generated `.tape`
