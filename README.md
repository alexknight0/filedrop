# File drop

Move files and images between your own devices, and send them to other approved people.

Live site: https://alexknight0.github.io/filedrop/

## Sending files from a Mac's Share menu

Websites can't appear in the macOS Share menu. Chrome only supports `share_target` on Android
and ChromeOS. Instead, a Shortcut called **File drop** runs [`mac/filedrop-upload.py`](mac/filedrop-upload.py),
which uploads straight to Firestore in the same format as the site. Once it's installed you can:

- click **Share → File drop** in Finder, Photos, Preview and other apps, or
- right-click files in Finder and pick **Quick Actions → File drop**.

A notification says when the upload has finished. Uploaded files show up on every device straight
away, marked as from "Mac". Folders are skipped, and the 1 GB storage limit is checked like on the site.

### Requirements

- This repo cloned at `~/projects/filedrop`. The Shortcut runs the script from there.
- The Google Cloud CLI (`gcloud`), signed in with `gcloud auth login` as an owner or editor of the
  Firebase project `filedrop-da70b0`. The script uses that login. Calls with it go through Google
  Cloud permissions instead of the site's security rules, which is why only the project owner can
  use this. Files go to the File drop account with the same email as the gcloud account, so sign in
  to the site with that Google account at least once first.
- `/usr/bin/python3`, which comes with the Xcode Command Line Tools (`xcode-select --install`).
  Only the standard library is used.

### Install

1. Open the Shortcuts app, go to **Shortcuts → Settings → Advanced** and turn on
   **Allow Running Scripts**.
2. Double-click [`mac/File drop.shortcut`](mac/File%20drop.shortcut) and click **Add Shortcut**.
3. Share any file to **File drop** once. macOS asks whether Shortcuts may access the file and send
   notifications. Allow both.

If **File drop** doesn't show in the Share menu, open the shortcut in Shortcuts, click the ⓘ
(Details) button and tick **Use as Quick Action → Finder** and **Show in Share Sheet**.

### Making the Shortcut by hand

If the `.shortcut` file won't import, make a new shortcut called **File drop** with:

1. In ⓘ Details, tick **Use as Quick Action** (Finder) and **Show in Share Sheet**. Set the input
   at the top to receive **Files, Images and PDFs**.
2. One **Run Shell Script** action with Shell `zsh`, Input **Shortcut Input**, Pass Input
   **as arguments**, and this script:

   ```sh
   export PATH="$HOME/google-cloud-sdk/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
   /usr/bin/python3 "$HOME/projects/filedrop/mac/filedrop-upload.py" "$@"
   ```

### Rebuilding the Shortcut file

`python3 mac/make_shortcut.py` rewrites `mac/File drop.shortcut` from the settings in that
script, signed with `shortcuts sign --mode anyone`. After rebuilding, delete the old shortcut in
the Shortcuts app and import the new file.

### From a terminal

```sh
python3 ~/projects/filedrop/mac/filedrop-upload.py FILE...
```

It prints progress for each 1 MB part.
