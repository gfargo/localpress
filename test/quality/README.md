# Background-removal quality regression

This opt-in suite runs the real bundled ONNX pipeline against four original,
photorealistic cutouts: curly hair, long fur, clear glass, and a product image.
The checked-in transparent fixture supplies an exact foreground mask and avoids
third-party photo licensing concerns.

Run it before a background-removal release:

```bash
LOCALPRESS_RUN_MODEL_QUALITY=1 bun test test/quality/remove-bg-photorealistic.test.ts
```

The first run downloads the small `u2netp` model. The test composites each
subject onto a deterministic, visually busy background and enforces per-subject
IoU quality floors. Normal unit-test runs skip this slower model-backed check.
