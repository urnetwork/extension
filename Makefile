all: clean build

clean:
	rm -rf release

# The Licenses screen lists sdk/license.yml (embedded in the sdk wasm). Fail
# the build when the extension's runtime npm dependencies (package-lock.json)
# drift from that list: regenerate it in the sdk with `go run ./licenses`.
# ~/urnetwork is a monoroot of sibling repos; skipped only when ../sdk is not
# checked out next to this one.
license-check:
	@if [ -d ../sdk ]; then \
		go -C ../sdk run ./licenses -check extension; \
	else \
		echo "license-check: ../sdk not checked out, skipping"; \
	fi

build: license-check
	npm ci
	npm run build
	npm run build:firefox

.PHONY: all clean license-check build
