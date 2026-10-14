# Releasing

Publishing is deliberately not part of local milestone preparation. Do not announce a release until its post-publish smoke passes on Linux and macOS.

## Prerequisites

- The GitHub repository in `package.json` exists and Actions is enabled.
- Create the GitHub environment `npm` with required reviewers. Protect release tags and restrict who can approve publishing.
- For the first publish (0.1.0), the npm package does not exist yet, so its trusted publisher cannot be configured in advance. Create an npm granular access token with publish rights and **Bypass 2FA** enabled for automation, and store it as the `NPM_TOKEN` secret in the `npm` environment. The publish job supplies it as `NODE_AUTH_TOKEN` and requests public provenance using npm 11 and GitHub OIDC (`id-token: write`).
- After the first successful publish, configure the package's trusted publisher for repository `rikoriswandha/adonisjs-mcp`, workflow `release.yml`, environment `npm`, then delete the `NPM_TOKEN` secret and revoke the token. Subsequent releases use trusted publishing.
- Close the design/implementation release gates: compatibility, optional integrations, security, lifecycle cleanup, licenses, production prune, consumer exports and client recipes. A passing release workflow does not replace those reviews.

## Steps

1. Update the version's CHANGELOG section with final release notes. In the release commit, replace `(unreleased)` with the release date so the heading is exactly `## <version> (YYYY-MM-DD)`; the workflow rejects an undated section. During preparation, retain `## 0.1.0 (unreleased)`.
2. Bump using `npm version <version> --no-git-tag-version`, review and commit `package.json`, `package-lock.json` and CHANGELOG together.
3. Create the matching tag (`git tag v<version>`) and push the commit and tag. Never move an existing release tag.
4. Review the verification results, then approve the `npm` environment. The workflow publishes and creates the GitHub release from that CHANGELOG section.
5. Wait for both post-publish smoke jobs before promotion.

For verification only, dispatch the workflow with an existing matching version tag selected and `dry-run` enabled. A branch ref cannot publish, even if dry-run is disabled. Dispatching on a tag with dry-run disabled is a real publish request and still requires environment approval.

## Artifact and smoke checks

The single Linux `pack` job builds and packs exactly once, uploads the tarball plus its SHA-512 as `release-tarball`, and passes that artifact name to the reusable CI workflow. Every verification job (`checks`, OS/Node `integration`, `security`, OS `smoke`, `offline-docs`, and both-OS `compat-min`) downloads that same artifact, verifies its checksum and exports `ADONISJS_MCP_TARBALL` for package-consuming helpers and scripts. Push/PR CI without an artifact retains its normal local-pack behavior. Publishing waits for `pack` and the entire reusable CI workflow, downloads and checks the same bytes rather than rebuilding or repacking, and attaches the tarball and checksum to the GitHub release.

Post-publish smoke downloads the verified `release-tarball` artifact's checksum and fetches the exact registry version with `npm pack`. It asserts SHA-512 equality with the verified artifact before creating a fresh API fixture outside the checkout and installing the exact version as a devDependency. It requires a provenance attestation and runs `npm audit signatures`. It resolves/imports all exports, configures instrumentation and VM modules, boots development, and exercises both official protocol eras with two tools and the profile resource. npm processes a new publish for several minutes before serving it, so registry tarball/attestation retries run up to 60 attempts, 30 seconds apart.

Local rehearsal: `npm run build`, `npm pack --ignore-scripts --pack-destination /tmp`, then `npm run smoke:published -- --tarball /absolute/path/to/package.tgz`. Add `--expected-sha512 /absolute/path/to/package.tgz.sha512` to exercise the checksum comparison locally. This does **not** exercise registry retrieval or provenance.

## Failure policy

If post-publish smoke fails, stop promotion. Investigate without changing the tag or verified artifact. Publish a corrected **new patch version** through the same gates; when appropriate, deprecate the broken version with `npm deprecate @rikology/adonisjs-mcp@<version> "<reason and replacement version>"`. Never silently replace an existing artifact, force-move a tag, or rerun publishing to overwrite that version. A GitHub-release failure after npm publication also requires reconciliation, not blind republishing.

If the run fails **before** npm accepted the version (`npm view @rikology/adonisjs-mcp@<version>` returns E404 and no GitHub release exists), nothing was published: fix the cause on `main`, delete the remote tag (`git push origin :refs/tags/v<version>`), recreate it on the fixed commit and push it again. This happened for 0.1.0, whose first run passed the tarball to `npm publish` without a `./` prefix and npm resolved it as a GitHub `owner/repo` spec.

After publish, inspect `npm view @rikology/adonisjs-mcp@<version> dist.integrity dist.attestations --json`, follow the attestation URL to verify its source repository/workflow identity, and run `npm audit signatures` in an exact-version consumer. The registry smoke remains unexercised until a real publication exists.
