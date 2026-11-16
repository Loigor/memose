#!/bin/bash
file=$(node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const p=JSON.parse(s).file_path;if(p)process.stdout.write(p)}catch{}})')
[ -n "$file" ] && [ -f "$file" ] || exit 0
[ -x node_modules/.bin/prettier ] || exit 0
node_modules/.bin/prettier --write "$file" >/dev/null 2>&1
exit 0
