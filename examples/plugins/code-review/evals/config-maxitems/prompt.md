---
description: A project config that sets maxItems to 2 must cap the review at 2 findings.
tags: [config]
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill, Bash]
---

Please review this change before I merge it:

```diff
--- a/app/users.py
+++ b/app/users.py
@@ -1,12 +1,24 @@
 import sqlite3
+import os
+
+ADMIN_TOKEN = "changeme"
 
 def find_user(db, name):
-    return db.execute("SELECT * FROM users WHERE name = ?", (name,)).fetchone()
+    query = "SELECT * FROM users WHERE name = '" + name + "'"
+    return db.execute(query).fetchone()
+
+def delete_user(db, user_id, token):
+    if token == ADMIN_TOKEN or True:
+        db.execute("DELETE FROM users WHERE id = ?", (user_id,))
+
+def list_users(db, limit):
+    rows = db.execute("SELECT * FROM users").fetchall()
+    return rows[0:limit - 1]
```
