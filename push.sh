#!/bin/bash
# copy latest data to repo and push every 60s
cd /workspace/race-pages
while true; do
  cp /workspace/race/index.html /workspace/race/data.json /workspace/race/history.json /workspace/race/deposits.json . 2>/dev/null
  git add -A >/dev/null 2>&1
  git -c user.name=race-bot -c user.email=race-bot@users.noreply.github.com commit -qm "update $(date +%H:%M)" >/dev/null 2>&1
  # skip pushing while a Pages build is still queued/running, so it isn't cancelled (GitHub runner queue can be slow)
  st=$(timeout 20 curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}" "https://api.github.com/repos/wuyulun0823-lab/race/actions/runs?per_page=1" | python3 -c "import sys,json;print(json.load(sys.stdin)['workflow_runs'][0]['status'])" 2>/dev/null)
  if [ "$st" = "queued" ] || [ "$st" = "in_progress" ] || [ "$st" = "waiting" ] || [ "$st" = "pending" ]; then sleep 30; continue; fi
  # timeout so a hung push cannot stall the loop (seen ~14:50 TW)
  timeout 60 git push -q "https://x-access-token:${GITHUB_TOKEN}@github.com/wuyulun0823-lab/race.git" main >/dev/null 2>&1 \
    || timeout 60 git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/wuyulun0823-lab/race.git" main >/dev/null 2>&1
  sleep 60
done
