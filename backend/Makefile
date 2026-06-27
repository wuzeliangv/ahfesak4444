# =============================================================================
# AWS Panel — backend Makefile
# =============================================================================
# User-facing targets (run from backend/):
#   make build          — sam build (uses build-PanelFunction below)
#   make local          — start local API on :3000 (uses env.json if present)
#   make deploy         — deploy to AWS (assumes samconfig.toml is set)
#   make deploy-guided  — first-time interactive deploy
#   make logs           — tail CloudWatch logs of the deployed function
#   make invoke         — sample local invoke (verify event)
#   make clean          — remove .aws-sam/ build artifacts
#   make lint           — ruff check + mypy on src/
#   make fmt            — ruff format src/
#
# SAM-internal target (called by `sam build`):
#   make build-PanelFunction — copies src/ + installs requirements into $ARTIFACTS_DIR
# =============================================================================

SHELL := /bin/bash

STACK_NAME ?= aws-panel
REGION ?= us-east-1
PORT ?= 3000

# Use the project venv's pip if available, otherwise system python.
PIP := $(shell command -v uv >/dev/null && echo "uv pip" || echo "python3 -m pip")

# -----------------------------------------------------------------------------
# Build target invoked by `sam build` (because template has BuildMethod: makefile)
# -----------------------------------------------------------------------------
.PHONY: build-PanelFunction
build-PanelFunction:
	@echo ">>> Building Lambda artifact into $(ARTIFACTS_DIR)"
	@# Copy only src/ — never .venv/, scripts/, tests/, __pycache__/
	@rsync -a --exclude='__pycache__' --exclude='*.pyc' --exclude='*.pyo' \
		src $(ARTIFACTS_DIR)/
	@# Install runtime deps into the artifact dir using uv (much faster than pip).
	@# Host is Linux aarch64 (same as Lambda arm64 runtime) so native wheels work.
	@uv pip install \
		--target $(ARTIFACTS_DIR) \
		--no-compile-bytecode \
		--quiet \
		-r requirements.txt
	@# Strip caches/tests pip leaves behind
	@find $(ARTIFACTS_DIR) -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true
	@find $(ARTIFACTS_DIR) -type d -name 'tests' -path '*/site-packages/*' -exec rm -rf {} + 2>/dev/null || true
	@du -sh $(ARTIFACTS_DIR) | awk '{print ">>> Artifact size: " $$1}'

# -----------------------------------------------------------------------------
# User commands
# -----------------------------------------------------------------------------
.PHONY: build
build:
	sam build

.PHONY: local
local: build
	@if [ -f env.json ]; then \
		sam local start-api --port $(PORT) --env-vars env.json; \
	else \
		echo "WARN: env.json not found — running without PANEL_API_KEY (auth disabled)"; \
		sam local start-api --port $(PORT); \
	fi

.PHONY: invoke
invoke: build
	@if [ ! -f events/health.json ]; then \
		echo "ERROR: events/health.json not found"; exit 1; \
	fi
	sam local invoke PanelFunction -e events/health.json

.PHONY: deploy
deploy: build
	sam deploy

.PHONY: deploy-guided
deploy-guided: build
	sam deploy --guided

.PHONY: logs
logs:
	sam logs -n PanelFunction --stack-name $(STACK_NAME) --tail

.PHONY: clean
clean:
	rm -rf .aws-sam/

.PHONY: lint
lint:
	uv run ruff check src/
	uv run mypy src/ --ignore-missing-imports || true

.PHONY: fmt
fmt:
	uv run ruff format src/
	uv run ruff check src/ --fix

.PHONY: help
help:
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Common workflows:"
	@echo "  Local dev:    make local"
	@echo "  First deploy: make deploy-guided"
	@echo "  Re-deploy:    make deploy"
	@echo "  Tail logs:    make logs"
