# Releasing

Publishing is deliberately not part of local milestone preparation. Do not announce a release until its post-publish smoke passes on Linux and macOS.

## Prerequisites

- The GitHub repository in `package.json` exists and Actions is enabled.
- Configure the npm package's trusted publisher for this repository, `release.yml`, and the `npm` environment. The publish job requests GitHub OIDC (`id-token: write`) and uses npm 11. Alternatively, set the repository/environment `NPM_TOKEN` secret to an npm automation token permitted to publish this package; the job supplies it as `NODE_AUTH_TOKEN`. Both paths request public provenance.
- Create the GitHub environment `npm` with required reviewers. Protect release tags and restrict who can approve publishing.
- Close the design/implementation release gates: compatibility, optional integrations, security, lifecycle cleanup, licenses, production prune, consumer exports and client recipes. A passing release workflow does not replace those reviews.

## Steps

1. Update the version's CHANGELOG section with final release notes and its release date. During preparation, retain `## 0.1.0 (unreleased)`.
2. Bump using `npm version <version> --no-git-tag-version`, review and commit `package.json`, `package-lock.json` and CHANGELOG together.
3. Create the matching tag (`git tag v<version>`) and push the commit and tag. Never move an existing release tag.
4. Review the verification results, then approve the `npm` environment. The workflow publishes and creates the GitHub release from that CHANGELOG section.
5. Wait for both post-publish smoke jobs before promotion.

For verification only, dispatch the workflow with an existing matching version tag selected and `dry-run` enabled. A branch ref cannot publish, even if dry-run is disabled. Dispatching on a tag with dry-run disabled is a real publish request and still requires environment approval.

## Artifact and smoke checks

Each OS builds once and packs once. Tests consume that exact tarball: package/install/prune smoke, official modern and legacy MCP clients, strict export verification, lint, types, unit and security suites. The Linux tarball and SHA-512 are retained as the publish artifact; publishing downloads and checks those bytes rather than rebuilding or repacking. The GitHub release attaches the same tarball and checksum.

Post-publish smoke uses a fresh API fixture outside the checkout, installs the exact registry version as a devDependency, checks installed lockfile integrity against `npm view` metadata, requires a provenance attestation and runs `npm audit signatures`. It resolves/imports all exports, configures instrumentation and VM modules, boots development, and exercises both official protocol eras with two tools and the profile resource. Registry/attestation propagation retries are bounded to six attempts, ten seconds apart.

Local rehearsal: `npm run build`, `npm pack --ignore-scripts`, then `npm run smoke:published -- --tarball /absolute/path/to/package.tgz`. This does **not** exercise registry integrity or provenance.

## Failure policy

If post-publish smoke fails, stop promotion. Investigate without changing the tag or verified artifact. Publish a corrected **new patch version** through the same gates; when appropriate, deprecate the broken version with `npm deprecate @rikology/adonisjs-mcp@<version> "<reason and replacement version>"`. Never silently replace an existing artifact, force-move a tag, or rerun publishing to overwrite that version. A GitHub-release failure after npm publication also requires reconciliation, not blind republishing.

After publish, inspect `npm view @rikology/adonisjs-mcp@<version> dist.integrity dist.attestations --json`, follow the attestation URL to verify its source repository/workflow identity, and run `npm audit signatures` in an exact-version consumer. The registry smoke remains unexercised until a real publication exists.
