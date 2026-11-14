---
description: A described diff should fire the commit-message skill and produce a Conventional Commits header.
tags: [trigger]
max_turns: 6
allowed_tools: [Read, Glob, Grep, Skill]
---

Write me a commit message for this change:

```diff
--- a/src/date.js
+++ b/src/date.js
@@ -10,7 +10,10 @@ export function parseDate(input) {
-  return new Date(input);
+  if (typeof input !== 'string' || input.trim() === '') {
+    return null;
+  }
+  return new Date(input.trim());
 }
```

Before this, calling `parseDate('')` returned an "Invalid Date" object that crashed the report page.
