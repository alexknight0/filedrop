#!/usr/bin/env python3
"""Upload files to File drop from a Mac without opening the site.

Used by the "File drop" shortcut (so it shows in the macOS Share menu and Finder's Quick
Actions), and works from a terminal too:  python3 filedrop-upload.py FILE...

It writes the same Firestore documents as app.js's uploadFile(): a file doc in
users/{uid}/files/{id} plus 1 MB chunk docs, so the files appear on every device straight away.

Auth: your gcloud login (`gcloud auth login`). That account must be an owner/editor of the
Firebase project, so these REST calls go through IAM and skip the security rules. The File drop
user is found by looking up the gcloud account's email in profiles/, which means you must have
signed in to the site with the same Google account at least once.

Only the Python standard library and macOS's own tools (sips, osascript) are used.
"""

import base64
import json
import mimetypes
import os
import secrets
import shutil
import string
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor

PROJECT = "filedrop-da70b0"
BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"
CHUNK_BYTES = 1_000_000  # same as app.js: Firestore docs are capped at 1 MiB
PARALLEL = 4  # chunk writes in flight at once
QUOTA_BYTES = 1024**3  # free (Spark) plan: 1 GiB of Firestore storage
THUMB_SIDE = 160
ID_CHARS = string.ascii_letters + string.digits
# Shortcuts runs scripts with a bare PATH, so look in the usual install places too.
GCLOUD_PLACES = ["~/google-cloud-sdk/bin/gcloud", "/opt/homebrew/bin/gcloud", "/usr/local/bin/gcloud"]

mimetypes.add_type("image/heic", ".heic")
mimetypes.add_type("image/heif", ".heif")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("text/markdown", ".md")


class Failed(Exception):
    pass


def notify(message):
    # Values go in as arguments, so quotes in file names can't break the AppleScript.
    subprocess.run(
        ["osascript", "-e", "on run argv", "-e",
         "display notification (item 1 of argv) with title \"File drop\"", "-e", "end run", message],
        check=False, capture_output=True,
    )


def format_size(n):
    for unit in ("B", "KB", "MB"):
        if n < 1000:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1000
    return f"{n:.2f} GB"


def find_gcloud():
    found = shutil.which("gcloud")
    if found:
        return found
    for place in GCLOUD_PLACES:
        place = os.path.expanduser(place)
        if os.access(place, os.X_OK):
            return place
    raise Failed("gcloud isn't installed (looked in PATH and " + ", ".join(GCLOUD_PLACES) + ").")


class Firestore:
    def __init__(self):
        self.gcloud = find_gcloud()
        self.token = None
        self.refresh()

    def gcloud_out(self, *args):
        res = subprocess.run([self.gcloud, *args], capture_output=True, text=True)
        if res.returncode != 0:
            raise Failed(f"gcloud {' '.join(args)} failed: {res.stderr.strip()}. Try `gcloud auth login`.")
        return res.stdout.strip()

    def refresh(self):
        self.token = self.gcloud_out("auth", "print-access-token")

    def call(self, method, url, body=None, retry=True):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}",
            "x-goog-user-project": PROJECT,
            "Content-Type": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as err:
            if err.code == 401 and retry:  # access tokens last an hour
                self.refresh()
                return self.call(method, url, body, retry=False)
            raise Failed(f"Firestore said {err.code}: {err.read().decode(errors='replace')[:300]}")

    def put(self, path, fields):
        self.call("PATCH", f"{BASE}/{path}", {"fields": fields})


def find_uid(db):
    email = db.gcloud_out("config", "get", "account").lower()
    if not email:
        raise Failed("gcloud has no account set. Run `gcloud auth login`.")
    body = {"structuredQuery": {
        "from": [{"collectionId": "profiles"}],
        "where": {"fieldFilter": {"field": {"fieldPath": "email"}, "op": "EQUAL",
                                  "value": {"stringValue": email}}},
        "limit": 1,
    }}
    rows = db.call("POST", f"{BASE}:runQuery", body)
    docs = [r["document"] for r in rows if "document" in r]
    if not docs:
        raise Failed(f"No File drop user for {email}. Sign in to the site with that account once first.")
    return docs[0]["name"].rsplit("/", 1)[1]


def used_bytes(db, uid):
    total, page = 0, ""
    while True:
        query = urllib.parse.urlencode({"pageSize": 300, "mask.fieldPaths": "size", "pageToken": page})
        res = db.call("GET", f"{BASE}/users/{uid}/files?{query}")
        for d in res.get("documents", []):
            total += int(d.get("fields", {}).get("size", {}).get("integerValue", 0))
        page = res.get("nextPageToken")
        if not page:
            return total


def make_thumb(path, mime):
    """≤160 px JPEG data URL like app.js's makeThumb(). sips also reads HEIC, which Chrome can't."""
    if not mime.startswith("image/"):
        return None
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "thumb.jpg")
        res = subprocess.run(
            ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", str(THUMB_SIDE), path, "--out", out],
            capture_output=True,
        )
        if res.returncode != 0 or not os.path.exists(out):
            return None
        with open(out, "rb") as f:
            return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()


def upload(db, uid, path, index, total):
    name = os.path.basename(path)
    size = os.path.getsize(path)
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    chunks = -(-size // CHUNK_BYTES)
    file_id = "".join(secrets.choice(ID_CHARS) for _ in range(20))  # like Firestore's auto ids
    doc = f"users/{uid}/files/{file_id}"
    thumb = make_thumb(path, mime)
    fields = {
        "name": {"stringValue": name},
        "type": {"stringValue": mime},
        "size": {"integerValue": str(size)},
        "chunks": {"integerValue": str(chunks)},
        "createdAt": {"integerValue": str(int(time.time() * 1000))},
        "from": {"stringValue": "Mac"},
        "done": {"booleanValue": False},
        "thumb": {"stringValue": thumb} if thumb else {"nullValue": None},
    }
    db.put(doc, fields)

    sent = [0]

    def put_chunk(i):
        with open(path, "rb") as f:
            f.seek(i * CHUNK_BYTES)
            data = f.read(CHUNK_BYTES)
        db.put(f"{doc}/chunks/{i:05d}", {"d": {"bytesValue": base64.b64encode(data).decode()}})
        sent[0] += 1
        print(f"{index}/{total}: {name}: part {sent[0]}/{chunks}", flush=True)

    with ThreadPoolExecutor(PARALLEL) as pool:
        list(pool.map(put_chunk, range(chunks)))  # list() re-raises the first failure
    fields["done"] = {"booleanValue": True}
    db.put(doc, fields)


def log_args(paths):
    # Records what Shortcuts passed, to debug inputs the script can't read.
    log = os.path.expanduser("~/.tmp/filedrop-mac/last-run.log")
    os.makedirs(os.path.dirname(log), exist_ok=True)
    with open(log, "w") as f:
        f.write(f"cwd={os.getcwd()!r}\n")
        for p in paths:
            try:
                st = os.stat(p)
                info = f"mode={oct(st.st_mode)} size={st.st_size}"
            except OSError as err:
                info = f"stat error: {err}"
            f.write(f"{p!r}: {info}\n")


def to_paths(args):
    """Finder's Share menu passes file reference URLs (file:///.file/id=…), not paths.
    Foundation's NSURL resolves those (and plain file:// URLs) to the real path."""
    urls = [a for a in args if a.startswith("file://")]
    if not urls:
        return args
    res = subprocess.run(
        ["osascript", "-l", "JavaScript", "-e",
         "function run(a){return a.map(s=>{const u=$.NSURL.URLWithString(s);"
         "const p=u.isNil()?null:u.filePathURL;return p&&!p.isNil()?p.path.js:''}).join('\\n')}", *urls],
        capture_output=True, text=True,
    )
    resolved = dict(zip(urls, res.stdout.rstrip("\n").split("\n"))) if res.returncode == 0 else {}
    return [resolved.get(a) or a for a in args]


def zip_folder(folder, tmp):
    """Zips a folder to tmp/<name>.zip, with the folder itself as the top level like Finder's
    Compress. Leaves out Finder's .DS_Store files."""
    name = os.path.basename(folder.rstrip("/")) or "folder"
    out = os.path.join(tmp, name + ".zip")
    parent = os.path.dirname(folder.rstrip("/"))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, names in os.walk(folder):
            dirs.sort()
            rel_root = os.path.relpath(root, parent)
            if not names and not dirs:
                z.write(root, rel_root + "/")  # keep empty folders
            for n in sorted(names):
                if n == ".DS_Store":
                    continue
                full = os.path.join(root, n)
                if os.path.isfile(full):  # skips broken symlinks, sockets, etc.
                    z.write(full, os.path.join(rel_root, n))
    return out


def main(args):
    log_args(args)
    paths = to_paths(args)
    items = [p for p in paths if os.path.isfile(p) or os.path.isdir(p)]
    skipped = [f"can't read {p}" for p in paths if p not in items]
    if not items:
        raise Failed("Nothing to upload" + (f" ({'; '.join(skipped)})" if skipped else "."))
    db = Firestore()
    uid = find_uid(db)
    used = used_bytes(db, uid)
    done, too_big = [], []
    for i, item in enumerate(items, 1):
        with tempfile.TemporaryDirectory() as tmp:
            if os.path.isdir(item):
                print(f"{i}/{len(items)}: zipping {os.path.basename(item.rstrip('/'))}", flush=True)
                path = zip_folder(item, tmp)
            else:
                path = item
            size = os.path.getsize(path)
            name = os.path.basename(path)
            if used + size > QUOTA_BYTES:
                too_big.append(name)
                continue
            print(f"{i}/{len(items)}: {name} ({format_size(size)})", flush=True)
            if size > 20 * CHUNK_BYTES:  # big uploads take a while; say it has started
                notify(f"Uploading {name} ({format_size(size)})…")
            upload(db, uid, path, i, len(items))
            used += size
            done.append(name)

    parts = []
    if done:
        parts.append(f"Uploaded {done[0]}" if len(done) == 1 else f"Uploaded {len(done)} files")
    if too_big:
        parts.append(f"{', '.join(too_big)} won't fit in the 1 GB free storage")
    if skipped:
        parts.append(f"skipped {', '.join(skipped)}")
    message = "; ".join(parts) + "."
    print(message)
    notify(message)
    if not done:
        sys.exit(1)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Failed as err:
        print(err, file=sys.stderr)
        notify(f"Upload failed: {err}")
        sys.exit(1)
