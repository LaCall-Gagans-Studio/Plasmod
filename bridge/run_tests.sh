#!/bin/bash
# bridge のテストをすべて流す。記録は一時フォルダに書く（本物に触らない）
set -e
cd "$(dirname "$0")"
PY=${PY:-python3}
for t in test_*.py; do
  "$PY" "$t" 2>&1 | grep -v -E '^[0-9:]{8} ' | tail -1
done
