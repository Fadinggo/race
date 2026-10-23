#!/bin/bash
# copy latest data to repo and push every 60s
cd /workspace/race-pages
while true; do
  cp /workspace/race/index.html /workspace/race/data.json /workspace/race/history.json . 2>/dev/null
  git add -A >/dev/null 2>&1
  git -c user.name=race-bot -c user.email=race-bot@users.noreply.github.com commit -qm "update $(date +%H:%M)" >/dev/null 2>&1
  git push -q "https://x-access-token:${GITHUB_TOKEN}@github.com/wuyulun0823-lab/race.git" main >/dev/null 2>&1 || git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/wuyulun0823-lab/race.git" main >/dev/null 2>&1
  sleep 60
done
