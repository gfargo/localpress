/**
 * Self-contained HTML UI for the optimize preview.
 *
 * Controls: format picker, quality slider, max-width/height, encoder backend.
 * Shows before/after file size, compression ratio, and applied steps.
 */

export function buildOptimizeHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>localpress — Optimize Preview</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0f1117; --surface: #1a1d27; --surface-hover: #242836;
    --border: #2e3345; --text: #e4e6ef; --text-dim: #8b8fa3;
    --accent: #22c55e; --accent-hover: #16a34a;
    --danger: #ef4444; --radius: 8px;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.5; min-height: 100vh;
  }
  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 24px; border-bottom: 1px solid var(--border); background: var(--surface);
  }
  .header-left { display: flex; align-items: center; gap: 12px; }
  .header h1 { font-size: 16px; font-weight: 600; }
  .header h1 span { color: var(--accent); }
  .header .filename { color: var(--text-dim); font-size: 14px; }
  .header .meta { color: var(--text-dim); font-size: 13px; }
  .main { display: grid; grid-template-columns: 1fr 320px; height: calc(100vh - 53px); }

  .canvas-area {
    position: relative; display: flex; align-items: center; justify-content: center;
    overflow: hidden;
    background: repeating-conic-gradient(#1e2130 0% 25%, #252838 0% 50%) 50% / 20px 20px;
  }
  .canvas-area img.single-view {
    max-width: 90%; max-height: 90%; object-fit: contain; border-radius: 4px;
  }
  .view-toggle {
    position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
    display: flex; gap: 2px; background: var(--surface); border: 1px solid var(--border);
    border-radius: 6px; padding: 2px; z-index: 5;
  }
  .view-toggle button {
    padding: 6px 16px; border: none; background: transparent; color: var(--text-dim);
    font-size: 13px; cursor: pointer; border-radius: 4px; transition: all 0.15s;
  }
  .view-toggle button.active { background: var(--accent); color: #fff; }
  .view-toggle button:hover:not(.active) { background: var(--surface-hover); color: var(--text); }

  .compare-wrapper {
    position: relative; display: inline-block; max-width: 90%; max-height: 90%;
    user-select: none; cursor: ew-resize; line-height: 0;
  }
  .compare-wrapper img {
    display: block; max-width: calc(100vw - 380px); max-height: calc(100vh - 120px);
    object-fit: contain;
  }
  .compare-wrapper .compare-clip {
    position: absolute; top: 0; left: 0; height: 100%; overflow: hidden; z-index: 1;
  }
  .compare-divider {
    position: absolute; top: 0; width: 3px; height: 100%; background: var(--accent);
    z-index: 2; pointer-events: none;
  }
  .compare-divider::after {
    content: '⟨⟩'; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    background: var(--accent); color: #fff; font-size: 11px; padding: 8px 4px;
    border-radius: 4px; letter-spacing: -2px;
  }
  .compare-label {
    position: absolute; top: 8px; padding: 3px 10px; background: rgba(0,0,0,0.7);
    color: #fff; font-size: 12px; border-radius: 4px; pointer-events: none; z-index: 3;
  }
  .compare-label.left { left: 8px; }
  .compare-label.right { right: 8px; }

  .sidebar {
    background: var(--surface); border-left: 1px solid var(--border);
    display: flex; flex-direction: column; overflow-y: auto;
  }
  .sidebar-section { padding: 16px 20px; border-bottom: 1px solid var(--border); }
  .sidebar-section h3 {
    font-size: 12px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--text-dim); margin-bottom: 12px;
  }
  .control-group { margin-bottom: 14px; }
  .control-group:last-child { margin-bottom: 0; }
  .control-group label {
    display: block; font-size: 13px; color: var(--text-dim); margin-bottom: 6px;
  }
  .control-group label span {
    float: right; color: var(--text); font-variant-numeric: tabular-nums;
  }
  select, input[type="text"], input[type="number"] {
    width: 100%; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border);
    border-radius: var(--radius); color: var(--text); font-size: 13px; outline: none;
  }
  select:focus, input:focus { border-color: var(--accent); }
  input[type="range"] { width: 100%; accent-color: var(--accent); cursor: pointer; }

  .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .stat-card { background: var(--bg); border-radius: var(--radius); padding: 10px 12px; }
  .stat-card .stat-label {
    font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.03em;
  }
  .stat-card .stat-value { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat-card .stat-value.positive { color: var(--accent); }
  .stat-card .stat-value.negative { color: var(--danger); }
  .steps-list { font-size: 12px; color: var(--text-dim); margin-top: 8px; }

  .actions {
    padding: 16px 20px; margin-top: auto; display: flex; flex-direction: column;
    gap: 8px; border-top: 1px solid var(--border);
  }
  .btn {
    display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 10px 16px; border: none; border-radius: var(--radius);
    font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.15s;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-secondary { background: var(--surface-hover); color: var(--text); border: 1px solid var(--border); }
  .btn-secondary:hover:not(:disabled) { background: var(--border); }
  .btn-danger { background: transparent; color: var(--text-dim); }
  .btn-danger:hover { color: var(--danger); }

  .processing-overlay {
    position: absolute; inset: 0; background: rgba(15,17,23,0.85);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; z-index: 10;
  }
  .spinner {
    width: 32px; height: 32px; border: 3px solid var(--border);
    border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .processing-text { color: var(--text-dim); font-size: 14px; }
  .toast {
    position: fixed; bottom: 20px; right: 20px; padding: 12px 20px;
    border-radius: var(--radius); font-size: 14px; z-index: 100; animation: slideIn 0.3s ease;
  }
  .toast.success { background: var(--accent); color: #fff; }
  .toast.error { background: var(--danger); color: #fff; }
  @keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
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
      <h3>Profile</h3>
      <div class="control-group">
        <label>Optimization profile</label>
        <select id="profile" onchange="applyProfile()">
          <option value="">— None (manual settings) —</option>
        </select>
      </div>
    </div>
    <div class="sidebar-section">
      <h3>Format</h3>
      <div class="control-group">
        <label>Output format</label>
        <select id="format">
          <option value="keep">Keep original format</option>
          <option value="webp">WebP — browser-native, good compression</option>
          <option value="avif">AVIF — best compression, broad support</option>
          <option value="jpeg">JPEG — universal compatibility</option>
          <option value="png">PNG — lossless, supports transparency</option>
        </select>
      </div>
      <div class="control-group">
        <label>Encoder</label>
        <select id="encoder">
          <option value="sharp">sharp (libvips) — fast, good quality</option>
          <option value="jsquash">jSquash (WASM) — finer codec control</option>
        </select>
      </div>
    </div>
    <div class="sidebar-section">
      <h3>Quality</h3>
      <div class="control-group">
        <label>Quality <span id="quality-value">80</span></label>
        <input type="range" id="quality" min="1" max="100" value="80" />
      </div>
    </div>
    <div class="sidebar-section">
      <h3>Resize</h3>
      <div class="control-group">
        <label>Max width (px)</label>
        <input type="number" id="max-width" placeholder="No limit" min="1" />
      </div>
      <div class="control-group">
        <label>Max height (px)</label>
        <input type="number" id="max-height" placeholder="No limit" min="1" />
      </div>
    </div>
    <div class="sidebar-section" id="stats-section" style="display:none">
      <h3>Result</h3>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Original</div>
          <div class="stat-value" id="stat-original">—</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Optimized</div>
          <div class="stat-value" id="stat-result">—</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Saved</div>
          <div class="stat-value" id="stat-saved">—</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Reduction</div>
          <div class="stat-value" id="stat-ratio">—</div>
        </div>
      </div>
      <div class="steps-list" id="steps-list"></div>
    </div>
    <div class="actions">
      <button class="btn btn-secondary" id="btn-process" onclick="runProcess()">Generate Preview</button>
      <button class="btn btn-primary" id="btn-apply" onclick="applyResult()" disabled>Apply &amp; Upload to WordPress</button>
      <button class="btn btn-danger" id="btn-cancel" onclick="cancelPreview()">Cancel</button>
    </div>
  </div>
</div>
<script>
  let meta = null, hasResult = false, processing = false, viewMode = 'source';
  let comparePos = 0.5, dragging = false;
  const canvas = document.getElementById('canvas');
  const loadingOverlay = document.getElementById('loading-overlay');
  const qualityInput = document.getElementById('quality');
  const qualityValue = document.getElementById('quality-value');
  const statsSection = document.getElementById('stats-section');
  const btnProcess = document.getElementById('btn-process');
  const btnApply = document.getElementById('btn-apply');

  let ws = null;
  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.onopen = () => { setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 5000); };
  }

  async function init() {
    connectWs();
    const res = await fetch('/api/meta');
    meta = await res.json();
    document.getElementById('filename').textContent = meta.filename;
    document.getElementById('meta').textContent = [
      '#' + meta.wpId, meta.mimeType,
      meta.width && meta.height ? meta.width + '×' + meta.height + 'px' : '',
      formatBytes(meta.sizeBytes),
    ].filter(Boolean).join('  ·  ');

    // Populate profile dropdown if profiles are available.
    if (meta.profiles && meta.profiles.length > 0) {
      const sel = document.getElementById('profile');
      for (const p of meta.profiles) {
        const opt = document.createElement('option');
        opt.value = p.name;
        const parts = [p.name];
        if (p.description) parts[0] += ' — ' + p.description;
        else {
          const hints = [];
          if (p.quality) hints.push('q' + p.quality);
          if (p.format) hints.push(p.format);
          if (p.maxWidth) hints.push(p.maxWidth + 'px');
          if (hints.length) parts[0] += ' (' + hints.join(', ') + ')';
        }
        opt.textContent = parts[0];
        sel.appendChild(opt);
      }
      // Pre-select active profile if one was passed via CLI.
      if (meta.activeProfile) {
        sel.value = meta.activeProfile;
        applyProfile();
      }
    } else {
      // Hide profile section if no profiles exist.
      document.getElementById('profile').closest('.sidebar-section').style.display = 'none';
    }

    showSourceImage();
  }

  function applyProfile() {
    const sel = document.getElementById('profile');
    const name = sel.value;
    if (!name || !meta.profiles) return;
    const profile = meta.profiles.find(p => p.name === name);
    if (!profile) return;
    if (profile.quality) { qualityInput.value = profile.quality; qualityValue.textContent = profile.quality; }
    if (profile.format) { document.getElementById('format').value = profile.format; }
    else { document.getElementById('format').value = 'keep'; }
    if (profile.encoder) { document.getElementById('encoder').value = profile.encoder; }
    if (profile.maxWidth) { document.getElementById('max-width').value = profile.maxWidth; }
    else { document.getElementById('max-width').value = ''; }
    if (profile.maxHeight) { document.getElementById('max-height').value = profile.maxHeight; }
    else { document.getElementById('max-height').value = ''; }
  }

  function clearCanvas() {
    for (const c of Array.from(canvas.children)) if (c.id !== 'loading-overlay') c.remove();
  }
  function showSourceImage() {
    clearCanvas();
    const img = document.createElement('img');
    img.src = '/api/source'; img.alt = 'Original'; img.className = 'single-view';
    img.onload = () => { loadingOverlay.style.display = 'none'; };
    canvas.appendChild(img); addViewToggle();
  }
  function showResultImage() {
    clearCanvas();
    const img = document.createElement('img');
    img.src = '/api/result?t=' + Date.now(); img.alt = 'Optimized'; img.className = 'single-view';
    canvas.appendChild(img); addViewToggle();
  }
  function showCompareView() {
    clearCanvas();
    const w = document.createElement('div'); w.className = 'compare-wrapper';
    const rImg = document.createElement('img');
    rImg.src = '/api/result?t=' + Date.now(); rImg.alt = 'Optimized'; rImg.className = 'compare-result';
    w.appendChild(rImg);
    const clip = document.createElement('div'); clip.className = 'compare-clip';
    const sImg = document.createElement('img'); sImg.src = '/api/source'; sImg.alt = 'Original';
    clip.appendChild(sImg); w.appendChild(clip);
    const div = document.createElement('div'); div.className = 'compare-divider'; w.appendChild(div);
    const lL = document.createElement('div'); lL.className = 'compare-label left'; lL.textContent = 'Original'; w.appendChild(lL);
    const lR = document.createElement('div'); lR.className = 'compare-label right'; lR.textContent = 'Optimized'; w.appendChild(lR);
    canvas.appendChild(w);
    rImg.onload = () => {
      sImg.style.width = rImg.clientWidth + 'px'; sImg.style.height = rImg.clientHeight + 'px';
      sImg.style.objectFit = 'contain';
      updateSlider(w, clip, div, comparePos);
    };
    const onMove = (e) => {
      if (!dragging) return; e.preventDefault();
      const rect = w.getBoundingClientRect();
      comparePos = Math.max(0, Math.min(1, ((e.touches ? e.touches[0].clientX : e.clientX) - rect.left) / rect.width));
      updateSlider(w, clip, div, comparePos);
    };
    w.addEventListener('mousedown', (e) => { dragging = true; onMove(e); });
    w.addEventListener('touchstart', (e) => { dragging = true; onMove(e); }, { passive: false });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', () => { dragging = false; });
    document.addEventListener('touchend', () => { dragging = false; });
    addViewToggle();
  }
  function updateSlider(wrapper, clip, divider, pos) {
    const px = Math.round(wrapper.clientWidth * pos);
    clip.style.width = px + 'px'; divider.style.left = px + 'px';
  }
  function addViewToggle() {
    const ex = canvas.querySelector('.view-toggle'); if (ex) ex.remove();
    if (!hasResult) return;
    const t = document.createElement('div'); t.className = 'view-toggle';
    for (const v of [{id:'source',label:'Original'},{id:'result',label:'Optimized'},{id:'compare',label:'Compare'}]) {
      const b = document.createElement('button'); b.textContent = v.label;
      b.className = v.id === viewMode ? 'active' : '';
      b.onclick = () => { viewMode = v.id; if (v.id==='source') showSourceImage(); else if (v.id==='result') showResultImage(); else showCompareView(); };
      t.appendChild(b);
    }
    canvas.appendChild(t);
  }

  async function runProcess() {
    if (processing) return;
    processing = true; btnProcess.disabled = true; btnProcess.textContent = 'Processing...';
    const overlay = document.createElement('div'); overlay.className = 'processing-overlay'; overlay.id = 'process-overlay';
    overlay.innerHTML = '<div class="spinner"></div><div class="processing-text">Optimizing image...</div>';
    canvas.appendChild(overlay);
    const fmt = document.getElementById('format').value;
    const params = {
      toFormat: fmt === 'keep' ? null : fmt,
      quality: parseInt(qualityInput.value, 10),
      encoder: document.getElementById('encoder').value,
      maxWidth: parseInt(document.getElementById('max-width').value, 10) || null,
      maxHeight: parseInt(document.getElementById('max-height').value, 10) || null,
    };
    try {
      const res = await fetch('/api/process', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(params) });
      const data = await res.json();
      if (data.error) { showToast(data.error, 'error'); return; }
      hasResult = true; btnApply.disabled = false; btnProcess.textContent = 'Re-generate Preview';
      statsSection.style.display = '';
      document.getElementById('stat-original').textContent = formatBytes(meta.sizeBytes);
      document.getElementById('stat-result').textContent = formatBytes(data.sizeBytes);
      const saved = meta.sizeBytes - data.sizeBytes;
      const el = document.getElementById('stat-saved');
      el.textContent = (saved >= 0 ? '-' : '+') + formatBytes(Math.abs(saved));
      el.className = 'stat-value ' + (saved >= 0 ? 'positive' : 'negative');
      const ratio = meta.sizeBytes > 0 ? ((saved / meta.sizeBytes) * 100).toFixed(1) : '0';
      const rEl = document.getElementById('stat-ratio');
      rEl.textContent = ratio + '%'; rEl.className = 'stat-value ' + (saved >= 0 ? 'positive' : 'negative');
      if (data.stats.appliedSteps) {
        document.getElementById('steps-list').textContent = 'Steps: ' + data.stats.appliedSteps.join(' → ');
      }
      viewMode = 'compare'; showCompareView();
    } catch (err) { showToast('Processing failed: ' + err.message, 'error'); }
    finally { processing = false; btnProcess.disabled = false; const po = document.getElementById('process-overlay'); if (po) po.remove(); }
  }

  async function applyResult() {
    if (!hasResult) return; btnApply.disabled = true; btnApply.textContent = 'Uploading...';
    try {
      const res = await fetch('/api/apply', { method: 'POST' }); const data = await res.json();
      if (data.error) { showToast(data.error, 'error'); btnApply.disabled = false; btnApply.textContent = 'Apply & Upload to WordPress'; return; }
      showToast('Uploaded as #' + data.wpId, 'success'); btnApply.textContent = 'Applied ✓';
      // Build success message with fresh metadata if available
      let successDetails = 'Uploaded as #' + data.wpId + '.';
      if (data.freshItem) {
        const fi = data.freshItem;
        const sizeStr = fi.sizeBytes ? ' · ' + formatBytes(fi.sizeBytes) : '';
        const dimsStr = (fi.width && fi.height) ? ' · ' + fi.width + '×' + fi.height : '';
        const fmtStr = fi.mimeType ? ' · ' + fi.mimeType.replace('image/', '').toUpperCase() : '';
        successDetails = 'Uploaded as #' + data.wpId + fmtStr + sizeStr + dimsStr + '.';
      }
      setTimeout(() => { document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;color:#e4e6ef;font-family:sans-serif"><h2 style="color:#22c55e">✓ Applied</h2><p style="color:#8b8fa3">' + successDetails + ' You can close this tab.</p></div>'; }, 1500);
    } catch (err) { showToast('Upload failed: ' + err.message, 'error'); btnApply.disabled = false; btnApply.textContent = 'Apply & Upload to WordPress'; }
  }
  async function cancelPreview() {
    try { await fetch('/api/cancel', { method: 'POST' }); } catch {}
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;color:#e4e6ef;font-family:sans-serif"><h2>Cancelled</h2><p style="color:#8b8fa3">You can close this tab.</p></div>';
  }

  qualityInput.addEventListener('input', () => { qualityValue.textContent = qualityInput.value; });
  function formatBytes(b) { if (b<1024) return b+' B'; if (b<1048576) return (b/1024).toFixed(1)+' KB'; return (b/1048576).toFixed(1)+' MB'; }
  function showToast(msg, type) { const t = document.createElement('div'); t.className='toast '+type; t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(),4000); }
  init();
</script>
</body>
</html>`;
}
