#!/bin/bash
# copy latest data to repo and push every 60s
cd /workspace/race-pages
while true; do
  cp /workspace/race/index.html /workspace/race/data.json /workspace/race/history.json /workspace/race/deposits.json . 2>/dev/null
  git add -A >/dev/null 2>&1
  git -c user.name=race-bot -c user.email=race-bot@users.noreply.github.com commit -qm "update $(date +%H:%M)" >/dev/null 2>&1
  # timeout so a hung push cannot stall the loop (seen ~14:50 TW)
  timeout 60 git push -q "https://x-access-token:${GITHUB_TOKEN}@github.com/wuyulun0823-lab/race.git" main >/dev/null 2>&1 \
    || timeout 60 git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/wuyulun0823-lab/race.git" main >/dev/null 2>&1
  sleep 150  # >build time so Pages deploys are not cancelled by the next push
done
