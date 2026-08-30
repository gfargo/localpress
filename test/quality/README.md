# Background-removal quality regression

This opt-in suite runs the real bundled ONNX pipeline against four original,
photorealistic cutouts: curly hair, long fur, clear glass, and a product image.
The checked-in transparent fixture supplies an exact foreground mask and avoids
third-party photo licensing concerns.

```bash
bun run test:quality
```

The suite composites each subject onto a deterministic, visually busy background
and enforces per-model, per-subject IoU floors. Models download on first use
(~620 MB for the full set) and are cached in the localpress config dir.

To narrow the sweep while iterating:

```bash
LOCALPRESS_QUALITY_MODELS=u2netp,isnet-general-use bun run test:quality
```

## Why every model is measured

This gate previously tested only `u2netp` while `DEFAULT_MODEL` was `u2net`, so
it stayed green while the model users actually got by default failed the very
floors defined here (localpress#336). Each model now carries its own floors,
set ~0.02–0.03 below measured values — ONNX CPU inference is deterministic, so
the margin absorbs library drift rather than model noise.

Floors for `u2net` and `silueta` on the portrait subject are deliberately low
and tagged `knownWeakness`. Both models judge saliency in a way that discards
low-contrast clothing: the cream sweater is dropped and the subject is cut off
at the neck (recall ~0.78 and ~0.75). Recording that as an asserted floor keeps
a regression detectable while the `⚠ KNOWN WEAKNESS` line in the output stops
the number from reading as an endorsement.

One check runs on every `bun test`, with no models required: the default model
must have no known weaknesses and must clear a 0.85 portrait floor. That is the
assertion that would have caught the original bug.

## When it runs

- **Nightly** and **on release** via `.github/workflows/quality-gate.yml` — too
  slow and bandwidth-hungry for per-PR CI, but no longer dependent on someone
  remembering to run it.
- **On demand** from the Actions tab (`workflow_dispatch`), optionally scoped to
  a subset of models.
