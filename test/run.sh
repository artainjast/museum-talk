#!/bin/sh
# Starts a throwaway server on :3917 and runs the headless tests against it.
cd "$(dirname "$0")/.."
for t in abyss seats tour; do
  lsof -ti tcp:3917 | xargs kill -9 2>/dev/null
  HOST_TOKEN=dev PORT=3917 node server.js > /dev/null 2>&1 &
  SRV=$!
  sleep 1.2
  echo "== $t"
  node test/$t.mjs || FAILED=1
  kill $SRV 2>/dev/null
done
exit ${FAILED:-0}
