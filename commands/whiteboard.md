---
description: Open the STE whiteboard for this project (starts its server if needed)
argument-hint: "[status | stop | stop all]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/whiteboard.mjs:*)"]
---

# STE Whiteboard

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/whiteboard.mjs" $ARGUMENTS
```

Tell the user the result above in one or two short lines: the URL (as a link) and the project it tracks.
If it says ERROR, explain the cause in plain words and give the fix. Do not run other commands.
