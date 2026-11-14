---
# The only grader of this config case, so the case score is the rate of runs that honour the
# project setting: "Context" and "Next steps" present, the default "Action items" absent.
type: regex
target: last_message
pattern: '^(?![\s\S]*Action items)(?=[\s\S]*Context)[\s\S]*Next steps'
---
