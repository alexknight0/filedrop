#!/usr/bin/env python3
"""Build "File drop.shortcut", a Shortcut that sends the files it's given to filedrop-upload.py.

It shows in the macOS Share menu and in Finder's Quick Actions (right-click a file).
Run from anywhere:  python3 make_shortcut.py   (writes "File drop.shortcut" next to this file)
Then double-click the .shortcut file to add it to the Shortcuts app.
The script path is baked in as $HOME/projects/filedrop/mac/filedrop-upload.py; edit SCRIPT_PATH
if the repo lives somewhere else.
"""

import os
import plistlib
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "File drop.shortcut")
SCRIPT_PATH = '"$HOME/projects/filedrop/mac/filedrop-upload.py"'

# Shortcuts runs scripts with PATH=/usr/bin:/bin:/usr/sbin:/sbin, so add where gcloud lives.
SCRIPT = f"""export PATH="$HOME/google-cloud-sdk/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
/usr/bin/python3 {SCRIPT_PATH} "$@"
"""

shortcut = {
    "WFWorkflowClientVersion": "2607.0.2",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowIcon": {
        "WFWorkflowIconStartColor": 463140863,  # blue
        "WFWorkflowIconGlyphNumber": 59803,  # arrow
    },
    "WFWorkflowImportQuestions": [],
    "WFWorkflowTypes": ["ActionExtension", "QuickActions"],
    "WFQuickActionSurfaces": ["Finder"],
    "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowInputContentItemClasses": ["WFGenericFileContentItem", "WFImageContentItem", "WFPDFContentItem"],
    "WFWorkflowOutputContentItemClasses": [],
    "WFWorkflowActions": [
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.runshellscript",
            "WFWorkflowActionParameters": {
                "Script": SCRIPT,
                "Shell": "/bin/zsh",
                "InputMode": "as arguments",
                "Input": {
                    "Value": {"Type": "ExtensionInput"},
                    "WFSerializationType": "WFTextTokenAttachment",
                },
            },
        },
    ],
}

with tempfile.TemporaryDirectory() as tmp:
    unsigned = os.path.join(tmp, "unsigned.shortcut")
    with open(unsigned, "wb") as f:
        plistlib.dump(shortcut, f, fmt=plistlib.FMT_BINARY)
    # macOS only imports signed shortcut files. "anyone" signing goes through Apple's servers.
    subprocess.run(["shortcuts", "sign", "--mode", "anyone", "--input", unsigned, "--output", OUT], check=True)
print(f"Wrote {OUT}")
