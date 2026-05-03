/**
 * Self-contained HTML UI for the remove-bg preview.
 *
 * This is served as a single HTML page — no external dependencies,
 * no build step. All CSS and JS are inlined.
 */

export function buildRemoveBgHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>localpress — Background Removal Preview</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface-hover: #242836;
    --border: #2e3345;
    --text: #e4e6ef;
    --text-dim: #8b8fa3;
    --accent: #22c55e;
    --accent-hover: #16a34a;
    --danger: #ef4444;
    --danger-hover: #dc2626;
    --radius: 8px;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    min-height: 100vh;
  }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .header-left { display: flex; align-items: center; gap: 12px; }
  .header h1 { font-size: 16px; font-weight: 600; }
  .header h1 span { color: var(--accent); }
  .header .filename { color: var(--text-dim); font-size: 14px; }
  .header .meta { color: var(--text-dim); font-size: 13px; }

  /* ── Layout ── */
  .main {
    display: grid;
    grid-template-columns: 1fr 320px;
    height: calc(100vh - 53px);
  }

  /* ── Canvas area ── */
  .canvas-area {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background:
      repeating-conic-gradient(#1e2130 0% 25%, #252838 0% 50%) 50% / 20px 20px;
  }
  .canvas-area img {
    max-width: 90%;
    max-height: 90%;
    object-fit: contain;
    border-radius: 4px;
    transition: opacity 0.2s;
  }
  .canvas-area .placeholder {
    color: var(--text-dim);
    font-size: 14px;
    text-align: center;
  }

  /* ── View toggle ── */
  .view-toggle {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 2px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 2px;
  }
  .view-toggle button {
    padding: 6px 16px;
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-size: 13px;
    cursor: pointer;
    border-radius: 4px;
    transition: all 0.15s;
  }
  .view-toggle button.active {
    background: var(--accent);
    color: #fff;
  }
  .view-toggle button:hover:not(.active) {
    background: var(--surface-hover);
    color: var(--text);
  }

  /* ── Slider comparison ── */
  .compare-container {
    position: relative;
    max-width: 90%;
    max-height: 90%;
    overflow: hidden;
    cursor: ew-resize;
    user-select: none;
  }
  .compare-container img {
    max-width: 100%;
    max-height: calc(100vh - 160px);
    display: block;
  }
  .compare-overlay {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    overflow: hidden;
  }
  .compare-overlay img {
    max-height: calc(100vh - 160px);
  }
  .compare-divider {
    position: absolute;
    top: 0;
    width: 3px;
    height: 100%;
    background: var(--accent);
    cursor: ew-resize;
    z-index: 2;
  }
  .compare-divider::after {
    content: '⟨⟩';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: var(--accent);
    color: #fff;
    font-size: 11px;
    padding: 8px 4px;
    border-radius: 4px;
    letter-spacing: -2px;
  }
  .compare-label {
    position: absolute;
    top: 8px;
    padding: 3px 10px;
    background: rgba(0,0,0,0.7);
    color: #fff;
    font-size: 12px;
    border-radius: 4px;
    pointer-events: none;
    z-index: 3;
  }
  .compare-label.left { left: 8px; }
  .compare-label.right { right: 8px; }

  /* ── Sidebar ── */
  .sidebar {
    background: var(--surface);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  .sidebar-section {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
  }
  .sidebar-section h3 {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    margin-bottom: 12px;
  }

  /* ── Controls ── */
  .control-group {
    margin-bottom: 14px;
  }
  .control-group:last-child { margin-bottom: 0; }
  .control-group label {
    display: block;
    font-size: 13px;
    color: var(--text-dim);
    margin-bottom: 6px;
  }
  .control-group label span {
    float: right;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  select, input[type="text"], input[type="number"] {
    width: 100%;
    padding: 8px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s;
  }
  select:focus, input:focus {
    border-color: var(--accent);
  }

  input[type="range"] {
    width: 100%;
    accent-color: var(--accent);
    cursor: pointer;
  }

  input[type="color"] {
    width: 40px;
    height: 32px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    cursor: pointer;
    padding: 2px;
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
  }
  .checkbox-row input[type="checkbox"] {
    accent-color: var(--accent);
    width: 16px;
    height: 16px;
    cursor: pointer;
  }

  .color-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .color-row input[type="text"] {
    flex: 1;
  }

  /* ── Stats ── */
  .stats-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .stat-card {
    background: var(--bg);
    border-radius: var(--radius);
    padding: 10px 12px;
  }
  .stat-card .stat-label {
    font-size: 11px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .stat-card .stat-value {
    font-size: 18px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .stat-card .stat-value.positive { color: var(--accent); }
  .stat-card .stat-value.negative { color: var(--danger); }

  /* ── Buttons ── */
  .actions {
    padding: 16px 20px;
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-top: 1px solid var(--border);
  }
  .btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 16px;
    border: none;
    border-radius: var(--radius);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-primary {
    background: var(--accent);
    color: #fff;
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-secondary {
    background: var(--surface-hover);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn-secondary:hover:not(:disabled) { background: var(--border); }
  .btn-danger {
    background: transparent;
    color: var(--text-dim);
  }
  .btn-danger:hover { color: var(--danger); }

  /* ── Processing overlay ── */
  .processing-overlay {
    position: absolute;
    inset: 0;
    background: rgba(15, 17, 23, 0.85);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    z-index: 10;
  }
  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .processing-text { color: var(--text-dim); font-size: 14px; }

  /* ── Toast ── */
  .toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 12px 20px;
    border-radius: var(--radius);
    font-size: 14px;
    z-index: 100;
    animation: slideIn 0.3s ease;
  }
  .toast.success { background: var(--accent); color: #fff; }
  .toast.error { background: var(--danger); color: #fff; }
  @keyframes slideIn {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <h1><span>local</span>press</h1>
    <span class="filename" id="filename">Loading...</span>
  </div>
  <span class="meta" id="meta"></span>
</div>

<div class="main">
  <div class="canvas-area" id="canvas">
    <div class="processing-overlay" id="loading-overlay">
      <div class="spinner"></div>
      <div class="processing-text">Loading image...</div>
    </div>
  </div>

  <div class="sidebar">
    <div class="sidebar-section">
      <h3>Model</h3>
      <div class="control-group">
        <label>U2-Net variant</label>
        <select id="model">
          <option value="u2net">u2net — full (~176 MB, best quality)</option>
          <option value="u2netp">u2netp — lightweight (~4.7 MB, fast)</option>
          <option value="silueta">silueta — optimized (~44 MB, balanced)</option>
        </select>
      </div>
    </div>

    <div class="sidebar-section">
      <h3>Mask Controls</h3>
      <div class="control-group">
        <label>Alpha threshold <span id="threshold-value">10</span></label>
        <input type="range" id="threshold" min="0" max="255" value="10" />
      </div>
      <div class="control-group">
        <label class="checkbox-row">
          <input type="checkbox" id="trim" />
          Trim transparent borders
        </label>
      </div>
    </div>

    <div class="sidebar-section">
      <h3>Background</h3>
      <div class="control-group">
        <label class="checkbox-row">
          <input type="checkbox" id="use-bg-color" />
          Replace with solid color
        </label>
      </div>
      <div class="control-group color-row" id="bg-color-row" style="display:none">
        <input type="color" id="bg-color" value="#ffffff" />
        <input type="text" id="bg-color-text" value="#ffffff" placeholder="#ffffff" />
      </div>
    </div>

    <div class="sidebar-section" id="stats-section" style="display:none">
      <h3>Result</h3>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Inference</div>
          <div class="stat-value" id="stat-inference">—</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total</div>
          <div class="stat-value" id="stat-total">—</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Original</div>
          <div class="stat-value" id="stat-original">—</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Result</div>
          <div class="stat-value" id="stat-result">—</div>
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-secondary" id="btn-process" onclick="runProcess()">
        Generate Preview
      </button>
      <button class="btn btn-primary" id="btn-apply" onclick="applyResult()" disabled>
        Apply &amp; Upload to WordPress
      </button>
      <button class="btn btn-danger" id="btn-cancel" onclick="cancelPreview()">
        Cancel
      </button>
    </div>
  </div>
</div>

<script>
  // ── State ──
  let meta = null;
  let sourceLoaded = false;
  let hasResult = false;
  let processing = false;
  let viewMode = 'source'; // 'source' | 'result' | 'compare'
  let comparePos = 0.5;
  let dragging = false;

  // ── DOM refs ──
  const canvas = document.getElementById('canvas');
  const loadingOverlay = document.getElementById('loading-overlay');
  const filenameEl = document.getElementById('filename');
  const metaEl = document.getElementById('meta');
  const thresholdInput = document.getElementById('threshold');
  const thresholdValue = document.getElementById('threshold-value');
  const trimInput = document.getElementById('trim');
  const useBgColor = document.getElementById('use-bg-color');
  const bgColorRow = document.getElementById('bg-color-row');
  const bgColorInput = document.getElementById('bg-color');
  const bgColorText = document.getElementById('bg-color-text');
  const statsSection = document.getElementById('stats-section');
  const btnProcess = document.getElementById('btn-process');
  const btnApply = document.getElementById('btn-apply');

  // ── Init ──
  async function init() {
    const res = await fetch('/api/meta');
    meta = await res.json();
    filenameEl.textContent = meta.filename;
    metaEl.textContent = [
      '#' + meta.wpId,
      meta.mimeType,
      meta.width && meta.height ? meta.width + '×' + meta.height + 'px' : '',
      formatBytes(meta.sizeBytes),
    ].filter(Boolean).join('  ·  ');

    // Show source image.
    showSourceImage();
  }

  function showSourceImage() {
    clearCanvas();
    const img = document.createElement('img');
    img.src = '/api/source';
    img.alt = 'Original image';
    img.onload = () => {
      loadingOverlay.style.display = 'none';
      sourceLoaded = true;
    };
    canvas.appendChild(img);
    addViewToggle();
  }

  function showResultImage() {
    clearCanvas();
    const img = document.createElement('img');
    img.src = '/api/result?t=' + Date.now();
    img.alt = 'Processed result';
    canvas.appendChild(img);
    addViewToggle();
  }

  function showCompareView() {
    clearCanvas();

    const container = document.createElement('div');
    container.className = 'compare-container';

    // Bottom layer: result
    const resultImg = document.createElement('img');
    resultImg.src = '/api/result?t=' + Date.now();
    resultImg.alt = 'Result';
    container.appendChild(resultImg);

    // Overlay: source (clipped)
    const overlay = document.createElement('div');
    overlay.className = 'compare-overlay';
    const sourceImg = document.createElement('img');
    sourceImg.src = '/api/source';
    sourceImg.alt = 'Original';
    overlay.appendChild(sourceImg);
    container.appendChild(overlay);

    // Divider line
    const divider = document.createElement('div');
    divider.className = 'compare-divider';
    container.appendChild(divider);

    // Labels
    const labelLeft = document.createElement('div');
    labelLeft.className = 'compare-label left';
    labelLeft.textContent = 'Original';
    container.appendChild(labelLeft);

    const labelRight = document.createElement('div');
    labelRight.className = 'compare-label right';
    labelRight.textContent = 'Result';
    container.appendChild(labelRight);

    canvas.appendChild(container);

    // Wait for images to load, then set up slider.
    resultImg.onload = () => {
      const w = resultImg.naturalWidth;
      const displayW = resultImg.clientWidth;
      sourceImg.style.width = displayW + 'px';
      updateCompare(container, overlay, divider, comparePos);
    };

    // Mouse/touch drag.
    const onMove = (e) => {
      if (!dragging) return;
      const rect = container.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      comparePos = Math.max(0, Math.min(1, x / rect.width));
      updateCompare(container, overlay, divider, comparePos);
    };
    const onUp = () => { dragging = false; };

    container.addEventListener('mousedown', (e) => { dragging = true; onMove(e); });
    container.addEventListener('touchstart', (e) => { dragging = true; onMove(e); });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);

    addViewToggle();
  }

  function updateCompare(container, overlay, divider, pos) {
    const w = container.clientWidth;
    const px = Math.round(w * pos);
    overlay.style.width = px + 'px';
    divider.style.left = px + 'px';
  }

  function addViewToggle() {
    // Remove existing toggle.
    const existing = canvas.querySelector('.view-toggle');
    if (existing) existing.remove();

    if (!hasResult) return;

    const toggle = document.createElement('div');
    toggle.className = 'view-toggle';

    const views = [
      { id: 'source', label: 'Original' },
      { id: 'result', label: 'Result' },
      { id: 'compare', label: 'Compare' },
    ];

    for (const v of views) {
      const btn = document.createElement('button');
      btn.textContent = v.label;
      btn.className = v.id === viewMode ? 'active' : '';
      btn.onclick = () => {
        viewMode = v.id;
        if (v.id === 'source') showSourceImage();
        else if (v.id === 'result') showResultImage();
        else showCompareView();
      };
      toggle.appendChild(btn);
    }

    canvas.appendChild(toggle);
  }

  function clearCanvas() {
    // Keep the loading overlay, remove everything else.
    const children = Array.from(canvas.children);
    for (const child of children) {
      if (child.id !== 'loading-overlay') child.remove();
    }
  }

  // ── Processing ──
  async function runProcess() {
    if (processing) return;
    processing = true;
    btnProcess.disabled = true;
    btnProcess.textContent = 'Processing...';

    // Show overlay.
    const overlay = document.createElement('div');
    overlay.className = 'processing-overlay';
    overlay.id = 'process-overlay';
    overlay.innerHTML = '<div class="spinner"></div><div class="processing-text">Running background removal...</div>';
    canvas.appendChild(overlay);

    const params = {
      model: document.getElementById('model').value,
      alphaThreshold: parseInt(thresholdInput.value, 10),
      trim: trimInput.checked,
      backgroundColor: useBgColor.checked ? bgColorText.value : null,
    };

    try {
      const res = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json();

      if (data.error) {
        showToast(data.error, 'error');
        return;
      }

      hasResult = true;
      btnApply.disabled = false;
      btnProcess.textContent = 'Re-generate Preview';

      // Update stats.
      statsSection.style.display = '';
      document.getElementById('stat-inference').textContent = data.stats.inferenceMs + 'ms';
      document.getElementById('stat-total').textContent = data.stats.totalMs + 'ms';
      document.getElementById('stat-original').textContent = formatBytes(meta.sizeBytes);
      document.getElementById('stat-result').textContent = formatBytes(data.sizeBytes);

      // Show result.
      viewMode = 'compare';
      showCompareView();
    } catch (err) {
      showToast('Processing failed: ' + err.message, 'error');
    } finally {
      processing = false;
      btnProcess.disabled = false;
      const po = document.getElementById('process-overlay');
      if (po) po.remove();
    }
  }

  // ── Apply ──
  async function applyResult() {
    if (!hasResult) return;
    btnApply.disabled = true;
    btnApply.textContent = 'Uploading...';

    try {
      const res = await fetch('/api/apply', { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        showToast(data.error, 'error');
        btnApply.disabled = false;
        btnApply.textContent = 'Apply & Upload to WordPress';
        return;
      }
      showToast('Uploaded to WordPress as #' + data.wpId, 'success');
      btnApply.textContent = 'Applied ✓';
      // Server will shut down — show a message after a moment.
      setTimeout(() => {
        document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;color:#e4e6ef;font-family:sans-serif"><h2 style="color:#22c55e">✓ Applied successfully</h2><p style="color:#8b8fa3">Uploaded to WordPress as #' + data.wpId + '. You can close this tab.</p></div>';
      }, 1500);
    } catch (err) {
      showToast('Upload failed: ' + err.message, 'error');
      btnApply.disabled = false;
      btnApply.textContent = 'Apply & Upload to WordPress';
    }
  }

  // ── Cancel ──
  async function cancelPreview() {
    try { await fetch('/api/cancel', { method: 'POST' }); } catch {}
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;color:#e4e6ef;font-family:sans-serif"><h2>Preview cancelled</h2><p style="color:#8b8fa3">You can close this tab.</p></div>';
  }

  // ── UI wiring ──
  thresholdInput.addEventListener('input', () => {
    thresholdValue.textContent = thresholdInput.value;
  });

  useBgColor.addEventListener('change', () => {
    bgColorRow.style.display = useBgColor.checked ? 'flex' : 'none';
  });

  bgColorInput.addEventListener('input', () => {
    bgColorText.value = bgColorInput.value;
  });
  bgColorText.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(bgColorText.value)) {
      bgColorInput.value = bgColorText.value;
    }
  });

  // ── Helpers ──
  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ── Boot ──
  init();
</script>
</body>
</html>`;
}
