# Reservo on AWS. Run from deploy/aws with an `aws login` session.
#   make plan / make apply      infrastructure (always review the plan)
#   make release                build + push, migrate, roll out (prompts before each apply)
#   make seed / make smoke      demo studio on the ALB hostname, smoke test

AWS ?= aws
export AWS
TAG ?= $(shell git rev-parse --short HEAD)
TF_VARS = -var image_tag=$(TAG)
out = $(shell terraform output -raw $(1))
# Paths baked into the image (everything else is in .dockerignore)
IMAGE_PATHS = src scripts migrations public package.json package-lock.json Dockerfile

.PHONY: init plan apply login build push migrate-def migrate release seed smoke

init:
	terraform init

plan:
	terraform plan $(TF_VARS) -out=tfplan

apply:
	terraform apply tfplan
	rm -f tfplan

login:
	$(AWS) ecr get-login-password --region $(call out,region) | \
	  docker login --username AWS --password-stdin $(firstword $(subst /, ,$(call out,ecr_repository_url)))

build:
	@cd ../.. && git diff --quiet HEAD -- $(IMAGE_PATHS) && test -z "$$(git ls-files --others --exclude-standard -- $(IMAGE_PATHS))" || \
	  { echo "Uncommitted changes in the image sources; commit first so the tag matches the code"; exit 1; }
	# No attestations: with immutable tags ECR rejects the extra index Docker pushes.
	docker build --platform linux/arm64 --provenance=false --sbom=false -t $(call out,ecr_repository_url):$(TAG) ../..

push: login build
	docker push $(call out,ecr_repository_url):$(TAG)

# Point only the migrate task definition at the new image, so the schema is
# migrated before the service starts running the new code.
migrate-def:
	terraform apply $(TF_VARS) -target=aws_ecs_task_definition.migrate

migrate:
	./run-task.sh

release: push migrate-def migrate
	$(MAKE) plan
	$(MAKE) apply
	$(AWS) ecs wait services-stable --region $(call out,region) --cluster $(call out,cluster) --services $(call out,service)
	$(MAKE) smoke

# Recreates the demo studio "Maré" (wipes its bookings). Add
# SEED_ARGS=--with-bookings for sample bookings.
seed:
	./run-task.sh node scripts/seed-demo.ts $(call out,seed_extra_domains) $(SEED_ARGS)

smoke:
	@fail=0; \
	for u in $(call out,url)/healthz $(call out,demo_url)/ $(call out,demo_url)/marcar $(call out,demo_url)/admin/login; do \
	  code=$$(curl -s -o /dev/null -w '%{http_code}' "$$u"); echo "$$code $$u"; \
	  [ "$$code" = 200 ] || fail=1; \
	done; exit $$fail
