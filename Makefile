# Besonc — common tasks.
#
# `make help` lists everything. The Docker targets always pass
# `--env-file .env`, because Compose otherwise looks for a .env next to the
# compose file (infra/docker/) rather than the one you actually edited at
# the repository root. That mismatch silently leaves NODE_ENV=production and
# every guardrail fires.

SHELL := /bin/bash
COMPOSE_FILE := infra/docker/compose.yml
DEV_COMPOSE_FILE := infra/docker/compose.dev.yml

# Docker needs sudo where the user is not in the docker group.
DOCKER := $(shell if docker info >/dev/null 2>&1; then echo docker; else echo "sudo -n docker"; fi)
COMPOSE := $(DOCKER) compose --env-file .env -f $(COMPOSE_FILE)

.DEFAULT_GOAL := help
.PHONY: help setup env test test-db s3-up s3-down test-mobile test-platform test-all run stop status logs \
        build up down ps migrate clean

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

## ---------------------------------------------------------------- setup

setup: ## Install toolchain and dependencies
	bash infra/scripts/bootstrap.sh
	npm ci

env: ## Create .env from the template if it does not exist
	@test -f .env || { cp .env.example .env; echo "Created .env — fill it in."; }
	@test -f .env && echo ".env is present."

## ---------------------------------------------------------------- tests

test: ## Unit specs (no containers, ~45s)
	bash infra/scripts/test-all.sh

test-db: ## Integration specs (spins Postgres/Redis/RabbitMQ)
	bash infra/scripts/test-db.sh

s3-up: ## Start a local MinIO for media-svc (real presigned uploads in dev)
	@$(DOCKER) rm -f besonc-minio >/dev/null 2>&1 || true
	@$(DOCKER) run -d --name besonc-minio -p 9000:9000 -p 9001:9001 \
	  -e MINIO_ROOT_USER=besonc -e MINIO_ROOT_PASSWORD=besonc_dev_secret \
	  minio/minio:latest server /data --console-address ":9001" >/dev/null
	@echo "MinIO on http://127.0.0.1:9000 (console :9001, besonc / besonc_dev_secret)"

s3-down: ## Stop the local MinIO
	@$(DOCKER) rm -f besonc-minio >/dev/null 2>&1 || true

test-mobile: ## Dart and Flutter specs
	bash infra/scripts/test-mobile.sh

test-platform: ## FULL-PLATFORM e2e — real services, real Postgres, one order
	bash infra/scripts/test-platform.sh

test-all: test test-db test-platform test-mobile ## Everything

## ------------------------------------------------- local (plain processes)

run: env ## Start the backend as local processes (low memory)
	bash infra/scripts/run-stack.sh

stop: ## Stop the local processes
	bash infra/scripts/run-stack.sh stop

status: ## Health of every local service
	bash infra/scripts/run-stack.sh status

logs: ## Tail one service, e.g. `make logs SVC=identity`
	bash infra/scripts/run-stack.sh logs $(or $(SVC),gateway)

## ---------------------------------------------------------------- docker

build: ## Build the service image
	$(DOCKER) build -f infra/docker/Dockerfile -t besonc:latest .

up: env ## Start the whole platform in Docker (needs ~4GB)
	$(COMPOSE) up -d --build
	@echo "Public API: http://127.0.0.1:$${GATEWAY_PORT:-3000}"

down: ## Stop the Docker stack (volumes are kept)
	$(COMPOSE) down

ps: ## Container status
	$(COMPOSE) ps

# Migrations are not yet idempotent (no CREATE ... IF NOT EXISTS on the
# enums), so re-running reports "already exists" errors. Those are noise;
# anything else is real. The filter below says which is which rather than
# printing a scary count.
migrate: ## Apply every service migration to the Docker Postgres
	@for entry in identity:identity catalogue:catalogue order:orders payment:payment \
	              dispatch:dispatch tracking:tracking messaging:messaging \
	              media:media admin:admin; do \
	  svc=$${entry%%:*}; db=$${entry##*:}; \
	  f=$$(ls apps/svc-$$svc/migrations/001_*.sql 2>/dev/null | head -1); \
	  [ -z "$$f" ] && continue; \
	  out=$$($(DOCKER) exec -i besonc-postgres-1 psql -U besonc -d $$db -q < "$$f" 2>&1 \
	         | grep '^ERROR' | grep -v 'already exists' || true); \
	  if [ -z "$$out" ]; then printf '  \033[32mOK\033[0m   %-11s\n' "$$db"; \
	  else printf '  \033[31mFAIL\033[0m %-11s\n%s\n' "$$db" "$$out"; fi; \
	done

clean: ## Stop everything and DELETE the Docker volumes
	$(COMPOSE) down -v
	rm -rf .run
