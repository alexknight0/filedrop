// File drop: upload files on one device, download them on another.
// Google sign-in (Firebase Auth) + Firestore. Firebase Storage needs billing, so the file
// bytes are split into chunks of up to 1 MB, each stored as a Bytes field in its own doc.
// Only approved Google accounts can use it (see firestore.rules). Data:
//   config/access                      { emails: [...] }  approved accounts besides the admin; admin-only,
//                                      edited from the home page (alexknight0.github.io/home/)
//   profiles/{uid}                     { email, name, seenAt }  written on sign-in; the "Send to" list
//   users/{uid}/files/{id}             { name, type, size, chunks, createdAt (ms), from, done, thumb?,
//                                        sharedWith?: [uid] }  people it was sent to may read it
//   users/{uid}/files/{id}/chunks/{i}  { d: Bytes }   i = "00000", "00001", …
//   users/{uid}/inbox/{sender}_{fileId} { owner, fileId, name, type, size, chunks, thumb, fromName,
//                                        fromEmail, sharedAt }  a link to someone else's file
// `done` is false while the upload is still running (or if it was interrupted).
// Sending links rather than copies: no extra storage, but the sender deleting the file removes it
// for everyone (deleteFile also deletes the recipients' inbox entries).
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  initializeAuth, browserLocalPersistence, browserPopupRedirectResolver, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, collection, doc, query, orderBy, onSnapshot, setDoc, updateDoc, getDoc, getDocs,
  deleteDoc, arrayUnion, arrayRemove, Bytes,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { VERSION } from "./version.js";
import { zipFolder } from "./zip.js";

// Public web-app config (not a secret; access is controlled by firestore.rules).
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDGAvIT1TFSyATymfE8IJt2PY7mOEhUCgQ",
  authDomain: "filedrop-da70b0.firebaseapp.com",
  projectId: "filedrop-da70b0",
  appId: "1:463136665514:web:55272c1996c2d285edc5d3",
};

const CHUNK_BYTES = 1_000_000; // Firestore docs are capped at 1 MiB (1,048,576 bytes incl. names)
const PARALLEL = 4; // chunk reads/writes in flight at once
const QUOTA_BYTES = 1024 ** 3; // free (Spark) plan: 1 GiB of Firestore storage, shared by everyone
const THUMB_SIDE = 160;
const SHARE_CACHE = "filedrop-share"; // filled by sw.js when a file is shared from another app
// The Async Clipboard API only takes PNG images and plain text (Chrome), so only those can be copied.
const TEXT_TYPE = /^text\/|^application\/(json|xml|javascript|x-sh)$/;

const app = initializeApp(FIREBASE_CONFIG);
// Sign-in is kept in localStorage, not Firebase's default IndexedDB: all of Alex's sites share
// one origin and so one sign-in database, and Firebase waits forever if another site's page
// blocks opening it (seen on Android 2026-11-02: blank page until site data was cleared).
const auth = initializeAuth(app, { persistence: browserLocalPersistence, popupRedirectResolver: browserPopupRedirectResolver });
// Default in-memory cache on purpose: a persistent cache would copy every chunk into IndexedDB.
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);

let me = null; // signed-in, approved user
let filesCol = null;
let unsubs = [];
// Each item: {key, ref (file doc), ...data}. Own files have key = id; received ones have
// key = "in:" + inbox id, inbox: true, and ref pointing at the sender's file.
let files = []; // newest first
let inbox = [];
const active = new Map(); // key -> {label, done, total} for jobs running on this device
const blobs = new Map(); // key -> Blob, files already downloaded this session

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

const chunkRef = (fileRef, i) => doc(fileRef, "chunks", String(i).padStart(5, "0"));

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
      await setDoc(chunkRef(ref, i), { d: Bytes.fromUint8Array(bytes) });
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
  if (blobs.has(f.key)) return blobs.get(f.key);
  const job = { label: "Downloading", done: 0, total: f.size };
  active.set(f.key, job);
  render();
  try {
    const parts = new Array(f.chunks);
    await pool(PARALLEL, f.chunks, async (i) => {
      const snap = await getDoc(chunkRef(f.ref, i));
      if (!snap.exists()) throw new Error(`part ${i + 1} of ${f.chunks} is missing`);
      parts[i] = snap.get("d").toUint8Array();
      job.done += parts[i].length;
      render();
    });
    const blob = new Blob(parts, { type: f.type });
    blobs.set(f.key, blob);
    return blob;
  } catch (err) {
    // Rules deny reads once the sender deletes the file (no doc = no sharedWith).
    if (f.inbox && err.code === "permission-denied") throw new Error("the sender has deleted it");
    throw err;
  } finally {
    active.delete(f.key);
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

// Clicking off the image closes the preview; clicking outside the Send or confirmation box closes it.
// Backdrop clicks land on the <dialog> itself, so check the click is outside its box (clicks on
// the Send dialog's padding also target it). Keyboard "clicks" have target = the button, so they
// never close it.
for (const id of ["preview", "send-dialog", "confirm"]) {
  const dialog = $(id);
  dialog.addEventListener("click", (e) => {
    const r = dialog.getBoundingClientRect();
    const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (id === "preview" ? e.target !== $("preview-img") : e.target === dialog && outside) dialog.close();
  });
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

// ---------- confirmations ----------

// Ticking "Don't ask again for 60 seconds" makes Delete / Remove act straight away until then.
// Kept in memory only, so a reload always asks again.
const SKIP_MS = 60_000;
let skipUntil = 0;
let skipTimer = null;

function updateSkipChip() {
  const left = Math.ceil((skipUntil - Date.now()) / 1000);
  $("skip-chip").hidden = left <= 0;
  if (left <= 0) {
    clearInterval(skipTimer);
    skipTimer = null;
    return;
  }
  $("skip-text").textContent = `Deleting without asking · ${left}s`;
}

function startSkip() {
  skipUntil = Date.now() + SKIP_MS;
  clearInterval(skipTimer);
  skipTimer = setInterval(updateSkipChip, 1000);
  updateSkipChip();
}

$("skip-stop").onclick = () => {
  skipUntil = 0;
  updateSkipChip();
};

// Resolves true if the user confirms. Shows the in-page #confirm dialog instead of confirm().
function askConfirm({ title, text, ok = "Delete" }) {
  if (Date.now() < skipUntil) return Promise.resolve(true);
  const dialog = $("confirm");
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = ok;
  $("confirm-skip").checked = false;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const yes = dialog.returnValue === "ok";
      if (yes && $("confirm-skip").checked) startSkip();
      resolve(yes);
    }, { once: true });
  });
}

async function deleteFile(f) {
  if (f.inbox) return removeReceived(f);
  const shared = f.sharedWith?.length ? ` It will also disappear for the ${f.sharedWith.length === 1 ? "person" : `${f.sharedWith.length} people`} you sent it to.` : "";
  if (!(await askConfirm({ title: `Delete ${f.name}?`, text: `It will be removed from all your devices.${shared}` }))) return;
  const job = { label: "Deleting", done: 0, total: f.size };
  active.set(f.key, job);
  render();
  try {
    // Recipients' links first, so nobody is left with an entry that can't be downloaded.
    await Promise.all((f.sharedWith ?? []).map((uid) => deleteDoc(doc(db, "users", uid, "inbox", `${me.uid}_${f.id}`))));
    // One delete per chunk: a write batch is capped at 10 MiB *including the size of deleted
    // docs*, so batching 1 MB chunks fails for files over ~10 MB ("Transaction too big").
    // Chunks first, the file doc last, so a failure part-way still leaves a deletable entry.
    await pool(PARALLEL * 2, f.chunks, async (i) => {
      await deleteDoc(chunkRef(f.ref, i));
      job.done = Math.min(f.size, job.done + CHUNK_BYTES);
      render();
    });
    await deleteDoc(f.ref);
    blobs.delete(f.key);
  } catch (err) {
    setStatus(`Couldn't delete ${f.name}: ${err.message}`, true);
  } finally {
    active.delete(f.key);
    render();
  }
}

async function removeReceived(f) {
  if (!(await askConfirm({ title: `Remove ${f.name}?`, text: `It goes from your list only. ${f.fromName} keeps their copy.`, ok: "Remove" }))) return;
  try {
    await deleteDoc(doc(db, "users", me.uid, "inbox", f.id));
    blobs.delete(f.key);
  } catch (err) {
    setStatus(`Couldn't remove ${f.name}: ${err.message}`, true);
  }
}

// ---------- sending to other people ----------

let sendTarget = null; // the file the Send dialog is for
let profiles = []; // other approved users who have signed in, [{uid, email, name}]

async function openSend(f) {
  sendTarget = f;
  $("send-title").textContent = `Send ${f.name} to…`;
  $("send-list").replaceChildren(el("li", { className: "muted", textContent: "Loading…" }));
  $("send-dialog").showModal();
  try {
    const snap = await getDocs(collection(db, "profiles"));
    profiles = snap.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((p) => p.uid !== me.uid)
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    renderSendList();
  } catch (err) {
    $("send-list").replaceChildren(el("li", { className: "meta error", textContent: `Couldn't load people: ${err.message}` }));
  }
}

function renderSendList() {
  const f = sendTarget;
  if (!profiles.length) {
    $("send-list").replaceChildren(el("li", { className: "muted",
      textContent: "Nobody else has signed in yet. People appear here after their first sign-in." }));
    return;
  }
  $("send-list").replaceChildren(...profiles.map((p) => {
    const sent = f.sharedWith?.includes(p.uid);
    const who = el("div", { className: "info" }, el("div", { className: "name", textContent: p.name || p.email }),
      p.name ? el("div", { className: "meta", textContent: p.email }) : null);
    const btn = sent
      ? button("Unsend", () => unsendFile(f, p))
      : button("Send", () => sendFile(f, p), "small primary");
    return el("li", { className: "person" }, who, sent ? el("span", { className: "meta", textContent: "Sent ✓" }) : null, btn);
  }));
}

async function sendFile(f, p) {
  try {
    await updateDoc(f.ref, { sharedWith: arrayUnion(p.uid) }); // grants read access first
    await setDoc(doc(db, "users", p.uid, "inbox", `${me.uid}_${f.id}`), {
      owner: me.uid, fileId: f.id, name: f.name, type: f.type, size: f.size, chunks: f.chunks,
      thumb: f.thumb ?? null, fromName: me.displayName || me.email, fromEmail: me.email, sharedAt: Date.now(),
    });
    setStatus(`Sent ${f.name} to ${p.name || p.email}.`);
  } catch (err) {
    setStatus(`Couldn't send ${f.name}: ${err.message}`, true);
  }
  sendTarget = { ...f, sharedWith: [...(f.sharedWith ?? []), p.uid] };
  renderSendList();
}

async function unsendFile(f, p) {
  try {
    await deleteDoc(doc(db, "users", p.uid, "inbox", `${me.uid}_${f.id}`));
    await updateDoc(f.ref, { sharedWith: arrayRemove(p.uid) });
    setStatus(`${p.name || p.email} no longer has ${f.name}.`);
  } catch (err) {
    setStatus(`Couldn't unsend ${f.name}: ${err.message}`, true);
  }
  sendTarget = { ...f, sharedWith: (f.sharedWith ?? []).filter((u) => u !== p.uid) };
  renderSendList();
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
  const job = active.get(f.key);
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
  } else if (f.inbox) {
    meta = el("div", { className: "meta", textContent: `${formatSize(f.size)} · from ${f.fromName} · ${relative(f.sharedAt)}` });
  } else {
    const sent = f.sharedWith?.length ? ` · sent to ${f.sharedWith.length}` : "";
    meta = el("div", { className: "meta", textContent: `${formatSize(f.size)} · from ${f.from} · ${relative(f.createdAt)}${sent}` });
  }
  const bar = job ? el("progress", { max: job.total || 1, value: job.done }) : null;

  // Every row gets the same buttons so they line up. One that can't be used for this file is
  // greyed out (aria-disabled, so it can still be tapped) and tapping it says why.
  const actions = el("div", { className: "actions" });
  const offButton = (text, why) => {
    const b = button(text, () => setStatus(why), "small off");
    b.setAttribute("aria-disabled", "true");
    b.title = why;
    return b;
  };
  const unfinished = "That file hasn't finished uploading.";
  if (!job) {
    actions.append(f.done
      ? button("Download", () => withBlob(f, "download", (b) => saveBlob(f, b)), "small primary")
      : offButton("Download", unfinished));
    if (!f.done) actions.append(offButton("Copy", unfinished));
    else if (canCopy(f)) actions.append(button("Copy", () => copyFile(f)));
    else actions.append(offButton("Copy", isImage(f) || isText(f)
      ? "This browser can't copy files to the clipboard." : "Only images and text can be copied."));
    if (canShareFiles()) {
      actions.append(f.done ? button("Share", () => withBlob(f, "share", (b) => shareBlob(f, b))) : offButton("Share", unfinished));
    }
    if (f.inbox) actions.append(offButton("Send", `Only ${f.fromName} can send this file on.`));
    else actions.append(f.done ? button("Send", () => openSend(f)) : offButton("Send", unfinished));
    actions.append(button(f.inbox ? "Remove" : "Delete", () => deleteFile(f), "small del"));
  }

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
    $("inbox").replaceChildren(...inbox.map(renderFile));
    $("inbox-section").hidden = inbox.length === 0;
    $("empty").hidden = files.length > 0;
    const used = usedBytes();
    $("usage").textContent = `You have used ${formatSize(used)} of 1 GB shared storage`;
    $("usage-meter").querySelector("i").style.width = `${Math.min(100, (used / QUOTA_BYTES) * 100)}%`;
    $("usage-meter").classList.toggle("full", used > QUOTA_BYTES * 0.9);
  });
}

// ---------- input: picker, drag and drop, paste ----------

// Every way of adding files ends here. entries: [{path, file}], where path is the file's name, or
// "Folder/sub/name" for something inside a chosen or dropped folder ("Folder/empty/" with
// file: null for an empty folder). Each top-level folder is zipped into "Folder.zip".
async function uploadEntries(entries) {
  if (!filesCol || !entries.length) return;
  const list = [];
  const folders = new Map(); // folder name -> its entries
  for (const e of entries) {
    const slash = e.path.indexOf("/");
    if (slash < 0) list.push(e.file);
    else {
      const top = e.path.slice(0, slash);
      if (!folders.has(top)) folders.set(top, []);
      folders.get(top).push(e);
    }
  }
  for (const [name, inside] of folders) {
    try {
      list.push(await zipFolder(name, inside, (done, total) => setStatus(`Zipping ${name}… ${done} of ${total}`)));
    } catch (err) {
      setStatus(`Couldn't zip ${name}: ${err.message}`, true);
      return;
    }
  }
  await uploadFiles(list);
}

// Plain files have no webkitRelativePath; files from the folder picker do ("Folder/sub/name").
const fileEntries = (list) => [...list].map((file) => ({ path: file.webkitRelativePath || file.name, file }));

// Photos, Camera, Files and the laptop's file and folder buttons (index.html) each wrap their own input.
for (const input of document.querySelectorAll("#drop input[type=file]")) {
  input.addEventListener("change", (e) => {
    const entries = fileEntries(e.target.files);
    e.target.value = "";
    uploadEntries(entries);
  });
}

// Walks a dropped file or folder (File and Directory Entries API) into uploadEntries' format.
async function walkEntry(entry, prefix, out) {
  const path = prefix + entry.name;
  if (entry.isFile) {
    out.push({ path, file: await new Promise((res, rej) => entry.file(res, rej)) });
    return;
  }
  const reader = entry.createReader();
  const children = [];
  for (;;) { // readEntries returns at most ~100 entries per call
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    children.push(...batch);
  }
  if (!children.length) out.push({ path: path + "/", file: null });
  for (const child of children) await walkEntry(child, path + "/", out);
}

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
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  if (!filesCol || !e.dataTransfer) return;
  // Entries must be taken during the event; the DataTransfer is emptied once it returns.
  const roots = [...e.dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!roots.length) return uploadEntries(fileEntries(e.dataTransfer.files));
  const entries = [];
  try {
    for (const root of roots) await walkEntry(root, "", entries);
  } catch (err) {
    setStatus(`Couldn't read the dropped files: ${err.message}`, true);
    return;
  }
  uploadEntries(entries);
});

function pasteStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

const textFile = (text) => new File([text], `Pasted ${pasteStamp()}.txt`, { type: "text/plain" });

document.addEventListener("paste", (e) => {
  if (!filesCol) return;
  const list = [...(e.clipboardData?.files ?? [])];
  if (list.length) {
    e.preventDefault();
    // Pasted screenshots are all called "image.png"; give them a timestamped name.
    const stamp = pasteStamp();
    uploadFiles(list.map((f) => (f.name === "image.png" ? new File([f], `Pasted ${stamp}.png`, { type: f.type }) : f)));
    return;
  }
  // Plain text becomes a .txt file, unless it's being pasted into a text field.
  if (e.target.closest?.("input, textarea, [contenteditable]")) return;
  const text = e.clipboardData?.getData("text/plain");
  if (!text) return;
  e.preventDefault();
  uploadFiles([textFile(text)]);
});

// Phone "Paste" button: upload the clipboard's text as a .txt file. Chrome asks for clipboard
// permission (or shows its own "Paste" bubble) the first time.
$("paste-btn").addEventListener("click", async () => {
  if (!filesCol) return;
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch (err) {
    console.warn("clipboard:", err);
    setStatus("Couldn't read the clipboard (permission denied?).", true);
    return;
  }
  if (!text) {
    setStatus("There's no text on the clipboard.", true);
    return;
  }
  uploadFiles([textFile(text)]);
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

function showSignedIn(user, approved) {
  $("signin").hidden = !!user;
  $("signout").hidden = !user;
  $("user-email").textContent = user?.email ?? "";
  $("app").hidden = !approved;
  $("signed-out-msg").hidden = !!user;
  $("not-approved").hidden = true; // shown only once the approval check fails
}

onAuthStateChanged(auth, async (user) => {
  unsubs.forEach((u) => u());
  unsubs = [];
  me = null;
  filesCol = null;
  files = [];
  inbox = [];
  blobs.clear();
  setStatus("");
  showSignedIn(user, false);
  $("boot").hidden = !user;
  $("boot-text").textContent = "Checking access…";
  if (!user) {
    // Shared while signed out: the files wait in the share cache until sign-in.
    if (new URLSearchParams(location.search).has("shared")) setStatus("Sign in to upload the shared files.");
    return;
  }
  // Writing the profile doubles as the approval check: the rules only allow approved accounts.
  try {
    await setDoc(doc(db, "profiles", user.uid), {
      email: user.email.toLowerCase(), name: user.displayName || "", seenAt: Date.now(),
    });
  } catch (err) {
    if (auth.currentUser?.uid !== user.uid) return;
    $("boot").hidden = true;
    if (err.code !== "permission-denied") setStatus(`Couldn't sign in: ${err.message}`, true);
    $("not-approved-email").textContent = user.email;
    $("not-approved").hidden = false;
    return;
  }
  if (auth.currentUser?.uid !== user.uid) return; // signed out/switched while waiting
  $("boot").hidden = true;
  me = user;
  showSignedIn(user, true);
  filesCol = collection(db, "users", user.uid, "files");
  let first = true;
  unsubs.push(onSnapshot(
    query(filesCol, orderBy("createdAt", "desc")),
    (snap) => {
      files = snap.docs.map((d) => ({ key: d.id, id: d.id, ref: d.ref, ...d.data() }));
      render();
      // Keep the Send dialog's "Sent ✓" marks in step with the file's sharedWith.
      const open = sendTarget && $("send-dialog").open && files.find((x) => x.key === sendTarget.key);
      if (open) {
        sendTarget = open;
        if (profiles.length) renderSendList();
      }
      // Upload anything shared from another app, once the file list (for the quota check) is known.
      if (first) {
        first = false;
        takeShared();
      }
    },
    (err) => setStatus(`Couldn't load files: ${err.message}`, true),
  ));
  unsubs.push(onSnapshot(
    query(collection(db, "users", user.uid, "inbox"), orderBy("sharedAt", "desc")),
    (snap) => {
      inbox = snap.docs.map((d) => {
        const data = d.data();
        return { key: `in:${d.id}`, id: d.id, inbox: true, done: true,
          ref: doc(db, "users", data.owner, "files", data.fileId), ...data };
      });
      render();
    },
    (err) => setStatus(`Couldn't load files sent to you: ${err.message}`, true),
  ));
});

// ---------- version check ----------
// The update light is shared by Alex's Pages sites (github.com/alexknight0/pages-common).
// Loaded dynamically so File drop still works if jsDelivr is unreachable.
import("https://cdn.jsdelivr.net/gh/alexknight0/pages-common@1.0.0/update.js")
  .then(({ initUpdateLight }) => initUpdateLight({
    version: VERSION,
    buttons: "#version",
    report: (text) => setStatus(text),
    serviceWorker: true, // sw.js caches nothing but shared files, so it only needs its own update check
    beforeUpdate() {
      if ([...active.values()].some((j) => j.label === "Uploading")) {
        setStatus("Wait for the upload to finish, then tap Update.");
        return false;
      }
    },
  }))
  .catch((e) => {
    console.warn("update light:", e);
    for (const b of document.querySelectorAll(".version")) {
      b.dataset.state = "unknown";
      b.title = "Couldn't load the update check (offline?).";
    }
  });
