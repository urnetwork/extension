#!/usr/bin/env sh
# Top-level test entry point for the extension (same convention as
# server/test.sh): run it from anywhere, it runs the whole suite and exits
# with the suite's status.
#
#   ./test.sh                # type-check tests + run the full vitest suite
#   ./test.sh -t refreshed   # extra args are passed through to vitest
set -e
cd "$(dirname "$0")"

# make sure the toolchain is present (fresh checkout / CI); prefer the
# lockfile-exact install
if [ ! -d node_modules ]; then
	npm ci || npm install
fi

npm run test:types
npm test -- "$@"
