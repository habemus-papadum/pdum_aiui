# Publishing the gallery to `habemus-papadum.net/aiui`

The gallery is a static site (one SPA document, base `/aiui/`) served from
`s3://habemus-papadum.net/aiui/*` behind CloudFront distribution
`E2OPILUJ3WDTIB` in AWS account **789030644255**. There are two publish paths,
and they share **one script** — `publish.sh` — so there is no drift.

## Local (manual)

```sh
pnpm -C demos/gallery run publish                # DRY RUN (default) — shows the diff
pnpm -C demos/gallery run publish -- --publish   # real upload  (or PUBLISH=1 …)
```

Credentials come from `AWS_PROFILE` (default `personal` — the account that owns
the bucket). Locally the script auto-discovers the CloudFront distribution by
domain alias.

## CI (release.yml → `publish-site` job) — secretless, over OIDC

On a real release, the `publish-site` job publishes the site the same way
`npm-publish` talks to npm: **GitHub OIDC, no stored secret**. The job's
`id-token` lets `aws-actions/configure-aws-credentials` assume an IAM role; the
script then runs with those ambient credentials (it skips the named profile when
`AWS_ACCESS_KEY_ID` is present) and takes `CF_ID` from the environment (the role
may `CreateInvalidation` but not `ListDistributions`).

### The AWS resources (provisioned once, out-of-band)

Not managed by IaC — recorded here so they can be recreated. Run with an admin
profile for account `789030644255` (e.g. `--profile personal`):

**1. GitHub Actions OIDC provider** (one per account):

```sh
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 \
                    1c58a3a8518e8759bf075b76b750d4f2df264fca
```

**2. Role `pdum-aiui-gallery-publish`** — trusts ONLY this repo's release
workflow on `main` (the OIDC `sub` claim). Trust policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::789030644255:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": { "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:habemus-papadum/pdum_aiui:ref:refs/heads/main"
    }}
  }]
}
```

**3. Least-privilege permission policy** `gallery-s3-publish` — write only under
the `/aiui` prefix, list that prefix, invalidate the one distribution. Nothing
else (verified with `aws iam simulate-principal-policy`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ListSiteBucketUnderPrefix", "Effect": "Allow", "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::habemus-papadum.net",
      "Condition": { "StringLike": { "s3:prefix": ["aiui", "aiui/*"] } } },
    { "Sid": "ReadWriteSiteObjects", "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::habemus-papadum.net/aiui/*" },
    { "Sid": "InvalidateSiteCache", "Effect": "Allow", "Action": "cloudfront:CreateInvalidation",
      "Resource": "arn:aws:cloudfront::789030644255:distribution/E2OPILUJ3WDTIB" }
  ]
}
```

The role ARN — `arn:aws:iam::789030644255:role/pdum-aiui-gallery-publish` — is
hardcoded in `release.yml`. It is **not a secret**: it is only assumable through
the OIDC trust above, so nothing is gained by hiding it.

### To tighten further (optional)

Scope the trust to a GitHub **Environment** (`sub` →
`repo:…:environment:production`) and add required reviewers, turning the deploy
into a manually-approved gate. That needs a `production` environment in the repo
settings and `environment: production` on the `publish-site` job.
