set -euo pipefail
: "${WORKER_URL:?Set WORKER_URL}"
: "${SEED_SECRET:?Set SEED_SECRET}"
curl -fsS -X POST "${WORKER_URL%/}/api/seed" \
  -H "Authorization: Bearer ${SEED_SECRET}" \
  -H "Content-Type: application/json"
