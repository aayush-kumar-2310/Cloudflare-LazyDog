# Used only by `wrangler deploy --env paid` (Containers require Workers Paid).
# Keep the tag in sync with the @cloudflare/sandbox package version.
FROM docker.io/cloudflare/sandbox:0.12.9-python
