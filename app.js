// === CDN (static site friendly) ===
const SEVENZ_BASE = "https://unpkg.com/7z-wasm@1.2.0/";
const SEVENZ_ESM  = SEVENZ_BASE + "7zz.es6.js";
const SEVENZ_WASM = SEVENZ_BASE + "7zz.wasm";

// === DOM ===
const el = (id) => document.getElementById(id);
const keyEl = el("key");
const toggleKeyEl = el("toggleKey");
const textEl = el("text");
const secretInputEl = el("secretInput");
const secretBadgeEl = el("secretBadge");
const filesDetailsEl = el("filesDetails");
const filesSummaryEl = el("filesSummary");
const filesPillEl = el("filesPill");
const fileInputEl = el("fileInput");
const selectedListEl = el("selectedList");
const secretListEl = el("secretList");
const clearFilesEl = el("clearFiles");
const encryptBtn = el("encrypt");
const decryptBtn = el("decrypt");
const download7zBtn = el("download7z");
const statusEl = el("status");

// === State ===
let selectedFiles = [];
let loadedSecret = null; // { name, bytes: Uint8Array, x, list: [{name,size}], noteText, archive7zBytes }
let sevenZipInstance = null;

// === Helpers ===
function setStatus(msg, cls="") {
  statusEl.className = "status";
  statusEl.textContent = msg;
  if (cls) statusEl.classList.add(cls);
}

function formatBytes(n) {
  const units = ["B","KB","MB","GB","TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length-1) { v /= 1024; i++; }
  return (i === 0 ? String(v) : v.toFixed(2)) + " " + units[i];
}

function computeXFromNow() {
  // Equivalent to:
  // for(x='',n=new Date/10,n-=n%1;n;n=(n-n%26)/26)x=String.fromCharCode(97+n%26)+x
  let n = Math.floor(Date.now() / 10);
  let x = "";
  while (n) { x = String.fromCharCode(97 + (n % 26)) + x; n = Math.floor(n / 26); }
  return x || "a";
}

function downloadBytes(bytes, filename, mime="application/octet-stream") {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function u8concat(...parts) {
  const total = parts.reduce((s,p)=>s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function wrapSafetensors(payloadU8, metadata = {}) {
  // Safetensors format: 8 bytes (LE u64) header length, then JSON header, then data buffer. :contentReference[oaicite:4]{index=4}
  const headerObj = {
    "__metadata__": Object.fromEntries(Object.entries(metadata).map(([k,v]) => [String(k), String(v)])),
    "payload": { dtype: "U8", shape: [payloadU8.length], data_offsets: [0, payloadU8.length] },
  };
  const headerJson = JSON.stringify(headerObj);
  const headerBytes = new TextEncoder().encode(headerJson);

  const prefix = new Uint8Array(8);
  const dv = new DataView(prefix.buffer);
  dv.setBigUint64(0, BigInt(headerBytes.length), true);

  return u8concat(prefix, headerBytes, payloadU8);
}

function parseSafetensors(fileBytesU8) {
  if (fileBytesU8.length < 8) throw new Error("Not a safetensors file (too small).");
  const dv = new DataView(fileBytesU8.buffer, fileBytesU8.byteOffset, fileBytesU8.byteLength);
  const headerLen = Number(dv.getBigUint64(0, true));
  if (!Number.isFinite(headerLen) || headerLen <= 0 || headerLen > fileBytesU8.length - 8) {
    throw new Error("Invalid safetensors header length.");
  }
  const headerStart = 8;
  const headerEnd = 8 + headerLen;
  const headerBytes = fileBytesU8.slice(headerStart, headerEnd);
  const headerText = new TextDecoder().decode(headerBytes).trim();
  if (!headerText.startsWith("{")) throw new Error("Invalid safetensors header JSON.");
  const header = JSON.parse(headerText);

  const tensor = header.payload;
  if (!tensor || tensor.dtype !== "U8" || !Array.isArray(tensor.data_offsets)) {
    throw new Error("This safetensors file doesn't contain a U8 tensor named 'payload'.");
  }
  const [begin, end] = tensor.data_offsets;
  const dataBase = headerEnd;
  const absBegin = dataBase + begin;
  const absEnd = dataBase + end;
  if (absBegin < headerEnd || absEnd > fileBytesU8.length || absEnd < absBegin) {
    throw new Error("Invalid payload offsets.");
  }
  const payload = fileBytesU8.slice(absBegin, absEnd);
  return { header, payload };
}

async function ensureSevenZip() {
  if (sevenZipInstance) return sevenZipInstance;

  setStatus("Loading 7z-wasmƒ?İ (first time can take a moment)");
  const mod = await import(SEVENZ_ESM);
  const SevenZipFactory = mod.default;

  const wasmBinary = new Uint8Array(await (await fetch(SEVENZ_WASM)).arrayBuffer());
  const logs = [];
  const sevenZip = await SevenZipFactory({
    wasmBinary,
    locateFile: (p) => SEVENZ_BASE + p,
    print: (t) => logs.push(String(t)),
    printErr: (t) => logs.push(String(t)),
  });

  // Create working dir
  try { sevenZip.FS.mkdir("/work"); } catch {}
  sevenZipInstance = { sevenZip, logs };
  return sevenZipInstance;
}

function resetLogs(sz) { sz.logs.length = 0; }

function resetWorkDir(sz) {
  const { sevenZip } = sz;
  sevenZip.FS.chdir("/");
  try {
    const entries = sevenZip.FS.readdir("/work");
    for (const name of entries) {
      if (name === "." || name === "..") continue;
      const path = "/work/" + name;
      try { sevenZip.FS.unlink(path); } catch {}
      try { sevenZip.FS.rmdir(path); } catch {}
    }
  } catch {}
  sevenZip.FS.chdir("/work");
}

async function writeFileToFS(sz, file, targetName) {
  const { sevenZip } = sz;
  const buf = new Uint8Array(await file.arrayBuffer());
  sevenZip.FS.writeFile("/work/" + targetName, buf);
}

function sanitizeName(name) {
  // Keep original names as much as possible; replace path separators
  return name.replace(/[\\/]/g, "_");
}

async function build7zArchiveBytes({ key, x, text, files }) {
  const sz = await ensureSevenZip();
  resetLogs(sz);
  resetWorkDir(sz);

  const { sevenZip, logs } = sz;

  // Write note file "x"
  sevenZip.FS.writeFile("/work/" + x, new TextEncoder().encode(text ?? ""));

  // Write selected files
  const inNames = [x];
  for (const f of files) {
    const n = sanitizeName(f.name);
    await writeFileToFS(sz, f, n);
    inNames.push(n);
  }

  // Create archive with compression=1, password, and encrypted file names.
  // 7z a -t7z -mx=1 -mhe=on -pPASSWORD archive.7z files... :contentReference[oaicite:5]{index=5}
  const archiveName = "payload.7z";
  const args = ["a", "-t7z", "-mx=1", "-mhe=on", `-p${key}`, "-y", archiveName, ...inNames];

  sevenZip.callMain(args);

  // Read archive bytes
  const out = sevenZip.FS.readFile("/work/" + archiveName);
  return { bytes: out, logs: logs.slice() };
}

function parse7zListSLT(outputText) {
  // Very lightweight parser for "7z l -slt"
  const lines = outputText.split(/\r?\n/);
  const out = [];
  let current = {};
  for (const line of lines) {
    if (!line.trim()) {
      if (current.Path) out.push({ name: current.Path, size: Number(current.Size ?? 0) });
      current = {};
      continue;
    }
    const m = line.match(/^([^=]+) = (.*)$/);
    if (!m) continue;
    const k = m[1].trim();
    const v = m[2];
    if (k === "Path") current.Path = v;
    if (k === "Size") current.Size = v;
  }
  if (current.Path) out.push({ name: current.Path, size: Number(current.Size ?? 0) });
  return out;
}

async function list7zFiles({ key, archiveBytes }) {
  const sz = await ensureSevenZip();
  resetLogs(sz);
  resetWorkDir(sz);

  const { sevenZip, logs } = sz;
  sevenZip.FS.writeFile("/work/payload.7z", archiveBytes);

  sevenZip.callMain(["l", "-slt", `-p${key}`, "-y", "payload.7z"]);

  const text = logs.join("\n");
  return { list: parse7zListSLT(text), raw: text };
}

async function extractSingleFile({ key, archiveBytes, filename }) {
  const sz = await ensureSevenZip();
  resetLogs(sz);
  resetWorkDir(sz);

  const { sevenZip } = sz;
  sevenZip.FS.writeFile("/work/payload.7z", archiveBytes);

  // Extract just one file into /work/out
  try { sevenZip.FS.mkdir("/work/out"); } catch {}
  sevenZip.callMain(["e", `-p${key}`, "-y", "payload.7z", filename, "-oout"]);

  const data = sevenZip.FS.readFile("/work/out/" + filename);
  return new TextDecoder().decode(data);
}

function updateSecretBadge() {
  if (!loadedSecret) {
    secretBadgeEl.textContent = "No secret loaded";
    secretBadgeEl.className = "pill";
    return;
  }
  secretBadgeEl.textContent = `Loaded: ${loadedSecret.name} (${formatBytes(loadedSecret.bytes.length)})`;
  secretBadgeEl.className = "pill ok";
}

function updateFilesUI() {
  const total = selectedFiles.reduce((s,f)=>s + f.size, 0);
  filesSummaryEl.textContent = `${selectedFiles.length} file${selectedFiles.length===1?"":"s"} ƒ?" ${formatBytes(total)}`;
  filesPillEl.textContent = filesDetailsEl.open ? "Expanded" : "Collapsed";

  // Selected list
  selectedListEl.innerHTML = "";
  if (!selectedFiles.length) {
    selectedListEl.innerHTML = `<div class="small">No files selected.</div>`;
  } else {
    for (let i=0;i<selectedFiles.length;i++) {
      const f = selectedFiles[i];
      const row = document.createElement("div");
      row.className = "item";
      row.innerHTML = `
        <div>
          <div class="name">${escapeHtml(f.name)}</div>
          <div class="meta">${formatBytes(f.size)}</div>
        </div>
        <div class="right">
          <button class="btn danger" data-rm="${i}">Remove</button>
        </div>
      `;
      row.querySelector("[data-rm]").addEventListener("click", () => {
        selectedFiles.splice(i,1);
        updateFilesUI();
      });
      selectedListEl.appendChild(row);
    }
  }

  // Secret list (read-only)
  secretListEl.innerHTML = "";
  if (!loadedSecret?.list?.length) {
    secretListEl.innerHTML = `<div class="small">No secret file listing.</div>`;
  } else {
    for (const it of loadedSecret.list) {
      const row = document.createElement("div");
      row.className = "item";
      const isNote = (it.name === loadedSecret.x);
      row.innerHTML = `
        <div>
          <div class="name">${escapeHtml(it.name)} ${isNote ? `<span class="pill">note</span>` : ""}</div>
          <div class="meta">${formatBytes(it.size || 0)}</div>
        </div>
        <div class="right">
          <span class="pill">locked</span>
        </div>
      `;
      secretListEl.appendChild(row);
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function requireKey() {
  const key = keyEl.value || "";
  if (!key.trim()) throw new Error("Key is required.");
  return key;
}

// === UI events ===
toggleKeyEl.addEventListener("click", () => {
  keyEl.type = (keyEl.type === "password") ? "text" : "password";
  toggleKeyEl.textContent = (keyEl.type === "password") ? "dY`?‹,?" : "dYT^";
});

filesDetailsEl.addEventListener("toggle", updateFilesUI);

fileInputEl.addEventListener("change", () => {
  if (fileInputEl.files?.length) {
    selectedFiles.push(...Array.from(fileInputEl.files));
    fileInputEl.value = "";
    updateFilesUI();
  }
});

clearFilesEl.addEventListener("click", () => {
  selectedFiles = [];
  updateFilesUI();
});

secretInputEl.addEventListener("change", async () => {
  const f = secretInputEl.files?.[0];
  loadedSecret = null;
  updateSecretBadge();
  updateFilesUI();
  if (!f) return;
  loadedSecret = { name: f.name, bytes: null, x: null, list: [], noteText: "", archive7zBytes: null };
  updateSecretBadge();
});

encryptBtn.addEventListener("click", async () => {
  try {
    encryptBtn.disabled = true;
    decryptBtn.disabled = true;
    download7zBtn.disabled = true;

    const key = requireKey();
    const x = computeXFromNow();
    setStatus(`Encryptingƒ?İ building 7z (mx=1, mhe=on) and wrapping as ${x}.safetensors`);

    const { bytes: archive7zBytes, logs } = await build7zArchiveBytes({
      key,
      x,
      text: textEl.value,
      files: selectedFiles
    });

    const safetensorsBytes = wrapSafetensors(archive7zBytes, {
      "hail": "secret-v1",
      "wrapped": "7z",
      "note_file": x
    });

    // Save to disk
    downloadBytes(safetensorsBytes, `${x}.safetensors`, "application/octet-stream");

    // Keep in state so "Download as 7z" can re-use without rebuilding
    loadedSecret = {
      name: `${x}.safetensors`,
      bytes: safetensorsBytes,
      x,
      list: [],
      noteText: textEl.value,
      archive7zBytes
    };
    updateSecretBadge();
    updateFilesUI();

    setStatus(`Done.\n\n7z-wasm output:\n${logs.join("\n")}`, "ok");
  } catch (e) {
    setStatus(`Error: ${e?.message || e}`, "bad");
  } finally {
    encryptBtn.disabled = false;
    decryptBtn.disabled = false;
    download7zBtn.disabled = false;
  }
});

decryptBtn.addEventListener("click", async () => {
  try {
    encryptBtn.disabled = true;
    decryptBtn.disabled = true;
    download7zBtn.disabled = true;

    const key = requireKey();
    const f = secretInputEl.files?.[0];
    if (!f) throw new Error("Upload a .safetensors secret first.");

    setStatus("Reading secretƒ?İ");
    const fileBytes = new Uint8Array(await f.arrayBuffer());

    setStatus("Parsing safetensors and extracting payloadƒ?İ");
    const { payload } = parseSafetensors(fileBytes);
    const x = f.name.endsWith(".safetensors") ? f.name.slice(0, -".safetensors".length) : "x";

    setStatus("Listing archive files (no extraction)ƒ?İ");
    const { list, raw } = await list7zFiles({ key, archiveBytes: payload });

    setStatus("Extracting note file onlyƒ?İ");
    const noteText = await extractSingleFile({ key, archiveBytes: payload, filename: x });

    loadedSecret = {
      name: f.name,
      bytes: fileBytes,
      x,
      list,
      noteText,
      archive7zBytes: payload
    };

    textEl.value = noteText;
    updateSecretBadge();
    updateFilesUI();

    setStatus(`Decrypted note file: ${x}\n\nArchive listing:\n${raw}`, "ok");
  } catch (e) {
    setStatus(`Error: ${e?.message || e}`, "bad");
  } finally {
    encryptBtn.disabled = false;
    decryptBtn.disabled = false;
    download7zBtn.disabled = false;
  }
});

download7zBtn.addEventListener("click", async () => {
  try {
    encryptBtn.disabled = true;
    decryptBtn.disabled = true;
    download7zBtn.disabled = true;

    const key = requireKey();

    // If we already have the archive bytes (from decrypt or encrypt), use them.
    if (loadedSecret?.archive7zBytes) {
      const name = (loadedSecret.x || "secret") + ".7z";
      downloadBytes(loadedSecret.archive7zBytes, name, "application/x-7z-compressed");
      setStatus(`Downloaded existing archive as ${name}.`, "ok");
      return;
    }

    // Otherwise build on the spot from current UI state.
    const x = computeXFromNow();
    setStatus("Building 7z on the spotƒ?İ");
    const { bytes: archive7zBytes, logs } = await build7zArchiveBytes({
      key,
      x,
      text: textEl.value,
      files: selectedFiles
    });
    downloadBytes(archive7zBytes, `${x}.7z`, "application/x-7z-compressed");
    setStatus(`Downloaded ${x}.7z\n\n7z-wasm output:\n${logs.join("\n")}`, "ok");
  } catch (e) {
    setStatus(`Error: ${e?.message || e}`, "bad");
  } finally {
    encryptBtn.disabled = false;
    decryptBtn.disabled = false;
    download7zBtn.disabled = false;
  }
});

// Init
updateSecretBadge();
updateFilesUI();
