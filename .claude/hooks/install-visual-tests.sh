#!/usr/bin/env bash
# SessionStart hook: prime the Playwright-based visual-testing surface
# (npm run screenshots:* — see scripts/screenshots/ and
# docs/VISUAL_REPORT_PLAN.md) so a fresh web-session container is
# screenshot-ready without manual setup.
#
# What it does, all idempotent and best-effort:
#   1. `npm install` if node_modules is missing (also runs the
#      postinstall tokens + locales codegen).
#   2. `npx playwright install chromium` if the browser binary is not
#      already present (the 175MB+ download is the slow part — guarded
#      so a warm container skips it).
#   3. Optionally background-start the dev server on :4173 (the port the
#      capture commands target) when SCREENSHOT_PRESTART=1 and nothing is
#      already listening there.
#
# Like install-graphify.sh this MUST never fail a session: every path is
# best-effort and we exit 0 unconditionally. Network-restricted
# environments simply skip the downloads.
set +e

cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

# 1. Dependencies — only when missing, so warm containers are instant.
if [ ! -d node_modules ]; then
  npm install >/dev/null 2>&1 || true
fi

# 2. Playwright Chromium — only when the binary is absent. Honour
#    PLAYWRIGHT_BROWSERS_PATH (set to /opt/pw-browsers in this env),
#    falling back to Playwright's default cache location. The special
#    value "0" means "install inside the npm package" — point the check
#    there so a warm container in that config isn't re-downloaded.
case "${PLAYWRIGHT_BROWSERS_PATH:-}" in
  0)  browsers_dir="node_modules/playwright-core/.local-browsers" ;;
  "") browsers_dir="$HOME/.cache/ms-playwright" ;;
  *)  browsers_dir="$PLAYWRIGHT_BROWSERS_PATH" ;;
esac
if ! ls "$browsers_dir"/chromium-* >/dev/null 2>&1; then
  npx --yes playwright install chromium >/dev/null 2>&1 || true
fi

# 3. Optional dev-server prestart (off by default — opt in with
#    SCREENSHOT_PRESTART=1). Backgrounded so the hook returns
#    immediately; guarded so we never double-start.
if [ "${SCREENSHOT_PRESTART:-0}" = "1" ]; then
  if ! curl -s -o /dev/null --max-time 2 http://localhost:4173/ 2>/dev/null; then
    nohup npm run dev -- --port 4173 >/tmp/terraviz-dev-4173.log 2>&1 &
    disown 2>/dev/null || true
  fi
fi

exit 0
