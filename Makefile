SHELL := /bin/bash

.PHONY: help install lint format test coverage typecheck build check-package smoke check changeset changesets pack clean

# Optional for `make changeset`: Patch | Minor | Major
TYPE ?= Patch

help:
	@echo "@ninjavault/cdn commands:"
	@echo "  make install                 - npm ci (exact versions from package-lock.json)"
	@echo "  make lint                    - ESLint + Prettier check"
	@echo "  make format                  - Apply Prettier"
	@echo "  make typecheck               - tsc --noEmit"
	@echo "  make test                    - Unit tests (vitest)"
	@echo "  make coverage                - Unit tests with coverage (fails under 90%)"
	@echo "  make build                   - Build dist/ (ESM + CJS + .d.ts)"
	@echo "  make check-package           - publint + are-the-types-wrong on the packed package"
	@echo "  make smoke                   - Pack, install into a temp project, run ESM + CJS scripts"
	@echo "  make check                   - Everything CI runs (format, lint, types, coverage, build, package, change-set)"
	@echo "  make changesets              - Check changesets/<version>.md exists for package.json version"
	@echo "  make changeset [TYPE=Patch]  - Create changesets/<version>.md for the current version"
	@echo "  make pack                    - check, then npm pack into ./ (inspect the .tgz)"
	@echo "  make clean                   - Remove dist/, coverage/ and *.tgz"
	@echo ""
	@echo "Release flow: npm version patch --no-git-tag-version -> make changeset -> fill it in -> PR -> merge to main"

install:
	npm ci

lint:
	npm run format:check
	npm run lint

format:
	npm run format

typecheck:
	npm run typecheck

test:
	npm test

coverage:
	npm run test:coverage

build:
	npm run build

check-package: build
	npm run check:package

smoke: build
	npm run test:smoke

check:
	npm run check

changesets:
	@node scripts/check-changeset.mjs

changeset:
	@node scripts/new-changeset.mjs $(TYPE)

pack: check
	npm pack

clean:
	@rm -rf dist coverage *.tgz
