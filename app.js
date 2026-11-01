// File drop: upload files on one device, download them on another.
// Google sign-in (Firebase Auth) + Firestore. Firebase Storage needs billing, so the file
// bytes are split into chunks of up to 1 MB, each stored as a Bytes field in its own doc.
// Data (owner-only, see firestore.rules):
//   users/{uid}/files/{id}             { name, type, size, chunks, createdAt (ms), from, done, thumb? }
//   users/{uid}/files/{id}/chunks/{i}  { d: Bytes }   i = "00000", "00001", …
// `done` is false while the upload is still running (or if it was interrupted).
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, collection, doc, query, orderBy, onSnapshot, setDoc, updateDoc, getDoc,
  writeBatch, Bytes,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { VERSION } from "./version.js";

// Public web-app config (not a secret; access is controlled by firestore.rules).
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDGAvIT1TFSyATymfE8IJt2PY7mOEhUCgQ",
  authDomain: "filedrop-da70b0.firebaseapp.com",
  projectId: "filedrop-da70b0",
  appId: "1:463136665514:web:55272c1996c2d285edc5d3",
};

const CHUNK_BYTES = 1_000_000; // Firestore docs are capped at 1 MiB (1,048,576 bytes incl. names)
const PARALLEL = 4; // chunk reads/writes in flight at once
const QUOTA_BYTES = 1024 ** 3; // free (Spark) plan: 1 GiB of Firestore storage in total
const THUMB_SIDE = 160;
const DELETE_BATCH = 400; // a write batch holds at most 500 operations
const SHARE_CACHE = "filedrop-share"; // filled by sw.js when a file is shared from another app
// The Async Clipboard API only takes PNG images and plain text (Chrome), so only those can be copied.
const TEXT_TYPE = /^text\/|^application\/(json|xml|javascript|x-sh)$/;

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
// Default in-memory cache on purpose: a persistent cache would copy every chunk into IndexedDB.
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);

let filesCol = null;
let unsub = null;
let files = []; // [{id, ...data}], newest first
const active = new Map(); // id -> {label, done, total} for uploads/downloads running on this device
const blobs = new Map(); // id -> Blob, files already downloaded this session

// ---------- helpers ----------

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

function formatSize(bytes) {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes;
  let u = -1;
  do { n /= 1000; u++; } while (n >= 1000 && u < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function relative(ms) {
  const mins = Math.round((ms - Date.now()) / 60000);
  const abs = Math.abs(mins);
  if (abs < 1) return "just now";
  if (abs < 60) return rtf.format(mins, "minute");
  if (abs < 60 * 24) return rtf.format(Math.round(mins / 60), "hour");
  return rtf.format(Math.round(mins / (60 * 24)), "day");
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad/.test(ua)) return "iPhone";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Linux";
}

const chunkRef = (id, i) => doc(filesCol, id, "chunks", String(i).padStart(5, "0"));

// Runs fn(0..count-1) with at most `limit` calls in flight.
async function pool(limit, count, fn) {
  let next = 0;
  const worker = async () => {
    while (next < count) await fn(next++);
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
}

async function makeThumb(file) {
  if (!file.type.startsWith("image/")) return null;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, THUMB_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    return null; // format the browser can't decode (e.g. HEIC on Chrome)
  }
}

// ---------- upload / download / delete ----------

const usedBytes = () => files.reduce((sum, f) => sum + (f.size || 0), 0);

async function uploadFiles(list) {
  for (const file of list) {
    if (usedBytes() + file.size > QUOTA_BYTES) {
      setStatus(`${file.name} (${formatSize(file.size)}) won't fit in the 1 GB free storage; delete some files first.`, true);
      continue;
    }
    await uploadFile(file);
  }
}

async function uploadFile(file) {
  const ref = doc(filesCol);
  const chunks = Math.ceil(file.size / CHUNK_BYTES);
  const job = { label: "Uploading", done: 0, total: file.size };
  active.set(ref.id, job);
  try {
    await setDoc(ref, {
      name: file.name || "pasted file",
      type: file.type || "application/octet-stream",
      size: file.size,
      chunks,
      createdAt: Date.now(),
      from: deviceName(),
      done: false,
      thumb: await makeThumb(file),
    });
    await pool(PARALLEL, chunks, async (i) => {
      const part = file.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
      const bytes = new Uint8Array(await part.arrayBuffer());
      await setDoc(chunkRef(ref.id, i), { d: Bytes.fromUint8Array(bytes) });
      job.done += bytes.length;
      render();
    });
    await updateDoc(ref, { done: true });
    blobs.set(ref.id, file);
    setStatus(`Uploaded ${file.name}.`);
  } catch (err) {
    setStatus(`Couldn't upload ${file.name}: ${err.message}`, true);
  } finally {
    active.delete(ref.id);
    render();
  }
}

async function fetchBlob(f) {
  if (blobs.has(f.id)) return blobs.get(f.id);
  const job = { label: "Downloading", done: 0, total: f.size };
  active.set(f.id, job);
  render();
  try {
    const parts = new Array(f.chunks);
    await pool(PARALLEL, f.chunks, async (i) => {
      const snap = await getDoc(chunkRef(f.id, i));
      if (!snap.exists()) throw new Error(`part ${i + 1} of ${f.chunks} is missing`);
      parts[i] = snap.get("d").toUint8Array();
      job.done += parts[i].length;
      render();
    });
    const blob = new Blob(parts, { type: f.type });
    blobs.set(f.id, blob);
    return blob;
  } finally {
    active.delete(f.id);
    render();
  }
}

async function withBlob(f, what, fn) {
  try {
    await fn(await fetchBlob(f));
  } catch (err) {
    if (err.name !== "AbortError") setStatus(`Couldn't ${what} ${f.name}: ${err.message}`, true);
  }
}

function saveBlob(f, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = f.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const canShareFiles = () =>
  !!navigator.canShare && navigator.canShare({ files: [new File([""], "x.txt", { type: "text/plain" })] });

async function shareBlob(f, blob) {
  await navigator.share({ files: [new File([blob], f.name, { type: f.type })] });
}

function previewBlob(blob) {
  const img = $("preview-img");
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(blob);
  $("preview").showModal();
}

const isImage = (f) => !!f.type?.startsWith("image/");
const isText = (f) => TEXT_TYPE.test(f.type ?? "");
const canCopy = (f) => !!navigator.clipboard?.write && "ClipboardItem" in window && (isImage(f) || isText(f));

async function toPng(blob) {
  if (blob.type === "image/png") return blob;
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    throw new Error("this browser can't read that image format");
  }
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close();
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function copyFile(f) {
  // write() must be called inside the click, so hand ClipboardItem a promise for the data
  // instead of awaiting the download first (the click's permission would expire).
  const type = isImage(f) ? "image/png" : "text/plain";
  const data = fetchBlob(f).then((b) => (isImage(f) ? toPng(b) : new Blob([b], { type })));
  navigator.clipboard.write([new ClipboardItem({ [type]: data })]).then(
    () => setStatus(`Copied ${f.name}${isImage(f) ? " (as an image)" : ""}.`),
    (err) => setStatus(`Couldn't copy ${f.name}: ${err.message}`, true),
  );
}

async function deleteFile(f) {
  if (!confirm(`Delete ${f.name}?`)) return;
  try {
    // Chunks first, the file doc last, so a failure part-way still leaves a deletable entry.
    for (let start = 0; start < f.chunks; start += DELETE_BATCH) {
      const batch = writeBatch(db);
      for (let i = start; i < Math.min(f.chunks, start + DELETE_BATCH); i++) batch.delete(chunkRef(f.id, i));
      await batch.commit();
    }
    const batch = writeBatch(db);
    batch.delete(doc(filesCol, f.id));
    await batch.commit();
    blobs.delete(f.id);
  } catch (err) {
    setStatus(`Couldn't delete ${f.name}: ${err.message}`, true);
  }
}

// ---------- rendering ----------

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

function button(text, onclick, className = "small") {
  return el("button", { type: "button", className, textContent: text, onclick });
}

function renderFile(f) {
  const job = active.get(f.id);
  const image = isImage(f);
  const ext = (f.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? "file");

  const thumb = el("button", { type: "button", className: "thumb", title: image ? "Preview" : "Download" },
    f.thumb ? el("img", { src: f.thumb, alt: "" }) : ext);
  thumb.disabled = !f.done || !!job;
  thumb.onclick = () => withBlob(f, image ? "open" : "download", (b) => (image ? previewBlob(b) : saveBlob(f, b)));

  let meta;
  if (job) {
    meta = el("div", { className: "meta", textContent: `${job.label}… ${formatSize(job.done)} of ${formatSize(job.total)}` });
  } else if (!f.done) {
    meta = el("div", { className: "meta error", textContent: `Upload from ${f.from} not finished (still running there, or interrupted)` });
  } else {
    meta = el("div", { className: "meta", textContent: `${formatSize(f.size)} · from ${f.from} · ${relative(f.createdAt)}` });
  }
  const bar = job ? el("progress", { max: job.total || 1, value: job.done }) : null;

  const actions = el("div", { className: "actions" });
  if (f.done && !job) {
    actions.append(button("Download", () => withBlob(f, "download", (b) => saveBlob(f, b)), "small primary"));
    if (canCopy(f)) actions.append(button("Copy", () => copyFile(f)));
    if (canShareFiles()) actions.append(button("Share", () => withBlob(f, "share", (b) => shareBlob(f, b))));
  }
  if (!job) actions.append(button("Delete", () => deleteFile(f), "small del"));

  return el("li", { className: "file" }, thumb, el("div", { className: "info" },
    el("div", { className: "name", textContent: f.name }), meta, bar), actions);
}

let renderQueued = false;
function render() {
  // Progress callbacks fire many times a second; redraw at most once per frame.
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    $("files").replaceChildren(...files.map(renderFile));
    $("empty").hidden = files.length > 0;
    $("usage").textContent = `${formatSize(usedBytes())} of 1 GB free storage used`;
  });
}

// ---------- input: picker, drag and drop, paste ----------

$("picker").addEventListener("change", (e) => {
  const list = [...e.target.files];
  e.target.value = "";
  if (filesCol) uploadFiles(list);
});

let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  document.body.classList.add("dragging");
});
document.addEventListener("dragleave", () => {
  if (dragDepth > 0 && --dragDepth === 0) document.body.classList.remove("dragging");
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const list = [...(e.dataTransfer?.files ?? [])];
  if (filesCol && list.length) uploadFiles(list);
});

document.addEventListener("paste", (e) => {
  const list = [...(e.clipboardData?.files ?? [])];
  if (!filesCol || !list.length) return;
  e.preventDefault();
  // Pasted screenshots are all called "image.png"; give them a timestamped name.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  uploadFiles(list.map((f) => (f.name === "image.png" ? new File([f], `Pasted ${stamp}.png`, { type: f.type }) : f)));
});

window.addEventListener("beforeunload", (e) => {
  if ([...active.values()].some((j) => j.label === "Uploading")) e.preventDefault();
});

// Keep "5 min ago" labels fresh.
setInterval(render, 60_000);

// ---------- files shared from other apps (share_target, see sw.js) ----------

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("service worker:", err));
}

let takingShared = false;
async function takeShared() {
  if (takingShared || !("caches" in window)) return;
  takingShared = true;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const keys = await cache.keys();
    const list = [];
    for (const key of keys) {
      const res = await cache.match(key);
      const name = decodeURIComponent(res.headers.get("X-Name") || "shared%20file");
      list.push(new File([await res.blob()], name, { type: res.headers.get("Content-Type") || "" }));
      await cache.delete(key);
    }
    if (location.search) history.replaceState(null, "", location.pathname + location.hash);
    if (list.length) await uploadFiles(list);
  } finally {
    takingShared = false;
  }
}


// ---------- auth ----------

$("signin").onclick = () =>
  signInWithPopup(auth, new GoogleAuthProvider()).catch((err) => setStatus(`Sign-in failed: ${err.message}`, true));
$("signout").onclick = () => signOut(auth);

onAuthStateChanged(auth, (user) => {
  unsub?.();
  unsub = null;
  files = [];
  blobs.clear();
  $("signin").hidden = !!user;
  $("signout").hidden = !user;
  $("user-email").textContent = user?.email ?? "";
  $("app").hidden = !user;
  $("signed-out-msg").hidden = !!user;
  setStatus("");
  if (!user) {
    filesCol = null;
    // Shared while signed out: the files wait in the share cache until sign-in.
    if (new URLSearchParams(location.search).has("shared")) setStatus("Sign in to upload the shared files.");
    return;
  }
  filesCol = collection(db, "users", user.uid, "files");
  let first = true;
  unsub = onSnapshot(
    query(filesCol, orderBy("createdAt", "desc")),
    (snap) => {
      files = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
      // Upload anything shared from another app, once the file list (for the quota check) is known.
      if (first) {
        first = false;
        takeShared();
      }
    },
    (err) => setStatus(`Couldn't load files: ${err.message}`, true),
  );
});

// ---------- version check ----------
// GitHub Pages lets browsers cache files for 10 minutes, so after a deploy this device may run
// a stale copy. version.js is stamped by tools/pre-commit on every commit; compare the running
// VERSION with the live file. Keep APP_FILES complete so Update refreshes every cached file.
const APP_FILES = ["./", "index.html", "app.js", "version.js", "style.css", "manifest.webmanifest"];
const VERSION_CHECK_MS = 5 * 60_000;
const versionBtn = $("version");
let latestVersion = null;

function formatVersion(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function setVersionState(state) {
  const labels = {
    checking: "Checking for updates…",
    ok: `Up to date (version ${formatVersion(VERSION)})`,
    stale: `Update available: running ${formatVersion(VERSION)}, latest is ${formatVersion(latestVersion)}. Tap to update.`,
    unknown: `Couldn't check for updates (offline?). Running ${formatVersion(VERSION)}.`,
    updating: "Updating…",
  };
  versionBtn.dataset.state = state;
  versionBtn.title = labels[state];
  versionBtn.setAttribute("aria-label", labels[state]);
  versionBtn.querySelector("span").textContent = state === "stale" ? "Update" : "";
}

async function checkVersion() {
  try {
    const res = await fetch(`version.js?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    latestVersion = (await res.text()).match(/VERSION = "([^"]+)"/)?.[1];
    if (!latestVersion) throw new Error("no version");
    // ISO timestamps compare as strings; only a newer live copy counts as an update.
    setVersionState(latestVersion > VERSION ? "stale" : "ok");
  } catch {
    setVersionState("unknown");
  }
}

versionBtn.addEventListener("click", async () => {
  const state = versionBtn.dataset.state;
  if (state === "checking" || state === "updating") return;
  if (state !== "stale") {
    // Green or grey: check again now and report the result.
    setVersionState("checking");
    setStatus(versionBtn.title);
    await checkVersion();
    setStatus(versionBtn.title);
    return;
  }
  if ([...active.values()].some((j) => j.label === "Uploading")) {
    setStatus("Wait for the upload to finish, then tap Update.");
    return;
  }
  setVersionState("updating");
  // Refresh every file in the HTTP cache first; a plain reload could still use the stale copies.
  // sw.js caches nothing but shared files, so it only needs its own update check.
  await Promise.all([
    ...APP_FILES.map((f) => fetch(f, { cache: "reload" }).catch(() => {})),
    navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {}),
  ]);
  location.reload();
});

setVersionState("checking");
checkVersion();
setInterval(checkVersion, VERSION_CHECK_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkVersion(); });
window.addEventListener("online", checkVersion);
