#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Smoketest build for the browser extension. The pipeline (build/all/run.sh)
# republishes @urnetwork/localizations and repoints the dependency before
# running `make`. Locally, npm ci installs the *published* package, which can
# lag the sibling localizations checkout — so after install this overlays the
# local store into node_modules, then builds both targets like `make` does.
# The prebuild step (scripts/build-locales.js) regenerates public/_locales
# from the overlaid store.
#
# Usage:
#   ./build.sh
#   URNETWORK_ROOT=<dir>   sibling-repo root (default: parent of this repo)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="${URNETWORK_ROOT:-$(dirname "$here")}"

echo "== npm ci"
(cd "$here" && npm ci --no-audit --no-fund)

echo "== overlay the local localization store over the installed package"
rsync -a --delete "$root/localizations/keys/" \
    "$here/node_modules/@urnetwork/localizations/keys/"
cp "$root/localizations/index.js" \
    "$here/node_modules/@urnetwork/localizations/index.js"

echo "== build (chrome + firefox)"
(cd "$here" && npm run build && npm run build:firefox)

echo "== extension build OK"
