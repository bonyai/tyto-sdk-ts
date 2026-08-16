.PHONY: install proto build typecheck test check clean

# Thin wrappers over the npm scripts, so `make test` and `make check` mean the
# same thing in all three SDKs regardless of which language you are in.

NPM ?= npm

install:
	$(NPM) install

proto:
	$(NPM) run proto

build:
	$(NPM) run build

# Covers src, tests, and examples -- see tsconfig.check.json for why examples
# cannot ride along with the publish build.
typecheck:
	$(NPM) run typecheck

test:
	$(NPM) run test

check: typecheck test

clean:
	rm -rf dist .proto-export
