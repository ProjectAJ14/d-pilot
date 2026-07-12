#!/usr/bin/env bash
# PostToolUse hook: when a backend route file is edited, remind Claude to keep
# the Bruno collection (docs/bruno/) in sync with the API surface.
#
# Fires only for changes under server/routes/ or to server/index.ts. For any
# other file it prints nothing (exit 0) — a silent pass. When it matches, it
# emits JSON that (a) shows the user a short note and (b) injects a reminder
# back into Claude's context so the collection gets updated in the same change.
#
# Wired up in .claude/settings.json (PostToolUse, matcher Edit|Write|MultiEdit).

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)

case "$file" in
  */server/routes/*.ts | */server/index.ts | server/routes/*.ts | server/index.ts)
    jq -n --arg f "$file" '{
      systemMessage: ("Bruno sync: \($f) is a backend route — update the docs/bruno collection to match."),
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: ("You modified \($f), which is part of the D-Pilot HTTP API. Before finishing, update the Bruno collection in docs/bruno/ so it still mirrors every endpoint: add, rename, or remove the matching \"<VERB> <Action>.bru\" file(s) using the naming system in docs/bruno/CLAUDE.md, sync each request'"'"'s body / params:query / headers / docs with the handler, fix seq if you inserted or removed a request, and keep it formatted. Do it as part of this change, not later.")
      }
    }'
    ;;
esac
