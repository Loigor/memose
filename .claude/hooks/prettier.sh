#!/bin/bash
file=$(node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const p=j.file_path||(j.tool_input&&j.tool_input.file_path);if(p)process.stdout.write(p)}catch{}})')
root="${CLAUDE_PROJECT_DIR:-.}"
[ -n "$file" ] && [ -f "$file" ] || exit 0
[ -x "$root/node_modules/.bin/prettier" ] || exit 0
"$root/node_modules/.bin/prettier" --write "$file" >/dev/null 2>&1
exit 0
