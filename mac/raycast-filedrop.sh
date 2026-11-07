#!/bin/bash

# Raycast Script Command: upload the files selected in Finder to File drop.
# Give it a hotkey in Raycast (Settings → Extensions → "Upload to File drop" → Hotkey).
# Install: ln -s ~/projects/filedrop/mac/raycast-filedrop.sh ~/.config/raycast/scripts/
#
# Required Raycast metadata:
# @raycast.schemaVersion 1
# @raycast.title Upload to File drop
# @raycast.mode silent
#
# Optional:
# @raycast.icon 📤
# @raycast.packageName File drop
# @raycast.description Upload the selected Finder files to File drop

export PATH="$HOME/google-cloud-sdk/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
UPLOAD="$HOME/projects/filedrop/mac/filedrop-upload.py"

# POSIX paths of every selected item in Finder, one per line.
LIST="$(osascript -e 'tell application "Finder"
    set out to ""
    repeat with f in (selection as list)
        set out to out & POSIX path of (f as alias) & linefeed
    end repeat
    return out
end tell')"

FILES=()
while IFS= read -r line; do
    [ -n "$line" ] && FILES+=("$line")
done <<< "$LIST"

if [ ${#FILES[@]} -eq 0 ]; then
    echo "No files selected in Finder"
    exit 0
fi

# Silent mode shows the last line of output, which is the script's summary.
/usr/bin/python3 "$UPLOAD" "${FILES[@]}" 2>&1 | tail -1
