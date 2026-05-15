#!/usr/bin/env bash
set -e

echo "=== Installing npm dependencies ==="
npm install

echo "=== Downloading Playwright Chromium ==="
export PLAYWRIGHT_BROWSERS_PATH=/opt/render/project/src/.playwright-browsers
npx playwright install chromium

echo "=== Verifying Chromium download ==="
if [ -d "$PLAYWRIGHT_BROWSERS_PATH" ]; then
  find "$PLAYWRIGHT_BROWSERS_PATH" -name "chrome" -o -name "chrome-linux" | head -5
  echo "Chromium verified at $PLAYWRIGHT_BROWSERS_PATH"
else
  echo "ERROR: $PLAYWRIGHT_BROWSERS_PATH does not exist after install"
  exit 1
fi
