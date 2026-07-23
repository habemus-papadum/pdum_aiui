#!/usr/bin/env bash
#
# publish.sh — build the notebook gallery (the discovered demo packages) as a static site
# and publish it to https://habemus-papadum.net/aiui/.
#
# What it does:
#   1. `vite build` (base is /aiui/ in production — see vite.config.ts) into dist/.
#   2. Syncs dist/ to s3://habemus-papadum.net/aiui with `aws s3 sync --delete`
#      (deletes only under the /aiui prefix, never the bucket root).
#   3. Invalidates the CloudFront edge cache for /aiui/* so the new content is
#      served immediately (the distribution is auto-discovered by domain alias).
#
# SAFETY — dry run is the DEFAULT, mirroring the pattern this is copied from:
#     pnpm run publish                # dry run: shows what would change
#     pnpm run publish -- --publish   # actually upload (or: PUBLISH=1 pnpm run publish)
#
# Credentials, two ways:
#   - Locally: uses AWS_PROFILE if set, else the "personal" profile (the account
#     that owns the habemus-papadum.net bucket).
#   - In CI (release.yml): aws-actions/configure-aws-credentials assumes the
#     pdum-aiui-gallery-publish IAM role over GitHub OIDC and exports ambient
#     credentials (AWS_ACCESS_KEY_ID et al) — no profile, no stored secret. We
#     detect those and DON'T force a profile (which would shadow them and not
#     exist on the runner). CI also sets CF_ID (the least-privilege role can
#     CreateInvalidation but not ListDistributions).
#
# (Invoke via `pnpm run publish` — bare `pnpm publish` is the npm registry
# command, which this private package refuses anyway.)
set -euo pipefail

S3_BUCKET="s3://habemus-papadum.net"
PREFIX="aiui"
S3_DEST="$S3_BUCKET/$PREFIX"
CF_DOMAIN="${S3_BUCKET#s3://}"

# Only default to a named profile when NO ambient credentials are present.
if [ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ -z "${AWS_PROFILE:-}" ]; then
  export AWS_PROFILE="personal"
fi
CRED_DESC="${AWS_PROFILE:+profile $AWS_PROFILE}"
CRED_DESC="${CRED_DESC:-ambient env credentials}"

DO_DRYRUN=1
[ "${PUBLISH:-}" = "1" ] && DO_DRYRUN=0
for arg in "$@"; do
  case "$arg" in
    --) ;; # pnpm forwards the run-script separator literally
    --publish|--no-dry-run) DO_DRYRUN=0 ;;
    --dry-run)              DO_DRYRUN=1 ;;
    -h|--help)              sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "error: unknown argument '$arg' (try --help)" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

for tool in aws npx; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' not found on PATH" >&2; exit 1; }
done
aws sts get-caller-identity >/dev/null 2>&1 || {
  echo "error: no usable AWS credentials ($CRED_DESC)." >&2
  echo "       set AWS_PROFILE or refresh credentials, then retry." >&2
  exit 1
}

echo "==> Building static site -> dist/ (base /aiui/)…"
npx vite build

[ -d dist ] || { echo "error: build did not produce dist/" >&2; exit 1; }
[ -f dist/index.html ] || {
  echo "error: dist/ is missing index.html — refusing to publish a partial site" >&2
  exit 1
}

# SPA deep links on a static host: the app is one document (src/main.tsx) and
# the router reads the path, so every route must resolve to index.html. S3
# behind CloudFront resolves neither folder indexes nor extensionless keys, so
# ship EXPLICIT copies: the clean route URLs (uploaded with content-type
# text/html below, since an extensionless key would sniff as octet-stream) and
# their `.html` twins (the old multi-entry URLs; inbound links keep working —
# the router maps the .html slugs to routes).
#
# The list is DERIVED from the same aiui.sitePage markers the shell's discovery
# plugin reads (demo-discovery.ts) — EVERY marked demo, since the base URL is
# now the landing card grid (not a demo), so each demo needs its own deep-link
# object. A new marked demo publishes its deep link with no edit here.
ROUTES="$(node -e '
  const { readdirSync, readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const root = join(process.cwd(), "..");
  const found = [];
  for (const slug of readdirSync(root)) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, slug, "package.json"), "utf8"));
      const m = pkg.aiui && pkg.aiui.sitePage;
      if (m) found.push({ slug, order: m.order ?? Number.MAX_SAFE_INTEGER });
    } catch {}
  }
  found.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
  console.log(found.map((d) => d.slug).join(" "));
')"
echo "==> Deep-link routes (from aiui.sitePage markers): $ROUTES"
for route in $ROUTES; do
  cp dist/index.html "dist/$route.html"
done

if [ "$DO_DRYRUN" = "1" ]; then
  echo "==> DRY RUN — showing what 'aws s3 sync --delete' would do ($CRED_DESC):"
  echo "    (re-run with --publish, or PUBLISH=1, to upload for real)"
  aws s3 sync dist "$S3_DEST" --delete --dryrun
  for route in $ROUTES; do
    echo "(dryrun) would upload dist/index.html to $S3_DEST/$route (content-type text/html)"
  done
  echo "==> DRY RUN — would then invalidate CloudFront '/$PREFIX/*' for $CF_DOMAIN."
else
  echo "==> PUBLISHING to $S3_DEST (with --delete, $CRED_DESC)…"
  aws s3 sync dist "$S3_DEST" --delete
  # The clean deep-link objects (see the ROUTES note above). After the sync so
  # --delete cannot remove them (they exist in dist/ only as .html twins).
  for route in $ROUTES; do
    aws s3 cp dist/index.html "$S3_DEST/$route" --content-type "text/html"
  done
  echo "==> Invalidating CloudFront cache for /$PREFIX/* …"
  # CI passes CF_ID directly — its least-privilege role can CreateInvalidation on
  # the one distribution but NOT ListDistributions. Locally, auto-discover by alias.
  cf_id="${CF_ID:-$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?contains(Aliases.Items, '$CF_DOMAIN')].Id | [0]" \
    --output text 2>/dev/null || true)}"
  if [ -z "$cf_id" ] || [ "$cf_id" = "None" ]; then
    echo "warning: no CloudFront distribution found for alias '$CF_DOMAIN' — edge caches may stay stale up to a day." >&2
  else
    inv_id="$(aws cloudfront create-invalidation --distribution-id "$cf_id" \
      --paths "/$PREFIX/*" --query "Invalidation.Id" --output text)"
    echo "==> Invalidation $inv_id created on $cf_id (propagates in ~1-2 min)."
  fi
  echo "==> Done: https://habemus-papadum.net/$PREFIX/"
fi
