all: clean build

clean:
	rm -rf release

# The Licenses screen lists sdk/license.yml (embedded in the sdk wasm). Fail
# the build when the extension's runtime npm dependencies (package-lock.json)
# drift from that list: regenerate it in the sdk with `go run ./licenses`.
# ~/urnetwork is a monoroot of sibling repos; skipped only when ../sdk is not
# checked out next to this one. The release harness forks its Go module into
# ../sdk/vNNNN while leaving the JS SDK at ../sdk/js.
license-check:
	node scripts/check-licenses.js

build: license-check
	npm ci
	npm run build
	npm run build:firefox

.PHONY: all clean license-check build
