#!/usr/bin/env bash
# Runs a one-off ECS task from the migrate task definition, waits for it and
# fails if the container exits non-zero.
#   ./run-task.sh                                  # migrations
#   ./run-task.sh node scripts/seed-demo.ts HOST   # any command, same image + config
set -euo pipefail
cd "$(dirname "$0")"
AWS="${AWS:-aws}"

out() { terraform output -raw "$1"; }
region=$(out region)
cluster=$(out cluster)
family=$(out migrate_task_family)
network="awsvpcConfiguration={subnets=[$(out task_subnets)],securityGroups=[$(out task_security_group)],assignPublicIp=ENABLED}"

args=(--region "$region" --cluster "$cluster" --task-definition "$family" --launch-type FARGATE
  --network-configuration "$network" --query 'tasks[0].taskArn' --output text)
if [ $# -gt 0 ]; then
  cmd=$(printf '%s\n' "$@" | python3 -c 'import json,sys; print(json.dumps([l.rstrip("\n") for l in sys.stdin]))')
  args+=(--overrides "{\"containerOverrides\":[{\"name\":\"app\",\"command\":$cmd}]}")
fi

task=$("$AWS" ecs run-task "${args[@]}")
echo "Started $task"
"$AWS" ecs wait tasks-stopped --region "$region" --cluster "$cluster" --tasks "$task"

read -r code reason < <("$AWS" ecs describe-tasks --region "$region" --cluster "$cluster" --tasks "$task" \
  --query 'tasks[0].[containers[0].exitCode, stoppedReason]' --output text)
id=${task##*/}
echo "Logs: $AWS logs tail $(out log_group) --region $region --log-stream-names ops/app/$id"
"$AWS" logs get-log-events --region "$region" --log-group-name "$(out log_group)" --log-stream-name "ops/app/$id" \
  --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' | tail -20 || true
if [ "$code" != "0" ]; then
  echo "Task failed: exit code $code ($reason)" >&2
  exit 1
fi
echo "Task finished OK"
