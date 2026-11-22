#!/usr/bin/env bash
# Fetch the migration target: Express at the commit Overnight was measured on, with its deps.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p targets
if [ ! -d targets/express-cjs ]; then
  git clone https://github.com/expressjs/express.git targets/express-cjs
  git -C targets/express-cjs checkout 43fca52
fi
(cd targets/express-cjs && npm install --no-audit --no-fund)
echo "Ready. Put CEREBRAS_API_KEY=... in .env, then: npm start"
