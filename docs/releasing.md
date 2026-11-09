# Releasing FixLab

FixLab uses GitHub Actions for continuous integration and tagged releases.

## Repository settings

1. Protect `main` and require the `CI / test` check.
2. Enable GitHub Actions with read access to repository contents.
3. Create an `npm` environment and require the desired reviewers.
4. Configure npm trusted publishing for:
   - Repository: `microsoft/FixLab`
   - Workflow: `.github/workflows/release.yml`
   - Environment: `npm`
5. Confirm that the npm organization owns the `@fixlab` scope.
6. Set the repository Actions variable `NPM_PUBLISH_ENABLED` to `true` only
   after the scope, package, and trusted publisher are ready.

Do not commit npm tokens. The release workflow requests an OpenID Connect token
and publishes with npm provenance.

## Create a release

1. Update `package.json`, `plugin.json`, and `CHANGELOG.md` to the same version.
2. Merge the release change to `main`.
3. Create and push the matching tag:

   ```shell
   git tag v<version>
   git push origin v<version>
   ```

The workflow verifies that the tag matches the package and plugin versions,
runs tests, validates the package contents, and creates the GitHub release.
It publishes `@fixlab/cli` only when `NPM_PUBLISH_ENABLED` is explicitly set to
`true`; otherwise the job records that npm publication was skipped.

As of `v0.7.3`, the GitHub release is published, npm publication remains
disabled, and the generated GitHub release has no attached `.tgz` asset.
Install the current CLI directly from `github:microsoft/FixLab`.

## Publish through the GitHub Copilot plugin marketplace

FixLab uses the Agent Plugins 1.0 layout and remains hosted in this repository.
Submit it to
[`github/copilot-plugins`](https://github.com/github/copilot-plugins) as an
external GitHub source by adding an entry like this to
`.github/plugin/marketplace.json`:

```json
{
  "name": "fixlab",
  "source": {
    "source": "github",
    "repo": "microsoft/FixLab"
  },
  "description": "Evidence-backed defect diagnosis, repair, and validation for React and .NET repositories.",
  "version": "0.7.4",
  "author": {
    "name": "MonaDevAI",
    "url": "https://github.com/MonaDevAI"
  },
  "homepage": "https://github.com/microsoft/FixLab",
  "repository": "https://github.com/microsoft/FixLab",
  "keywords": [
    "testing",
    "validation",
    "github-copilot",
    "ai-agent",
    "developer-tools",
    "react",
    "dotnet",
    "playwright",
    "pull-requests"
  ],
  "license": "MIT"
}
```

Before opening the marketplace pull request:

1. Confirm the release tag, `package.json`, `package-lock.json`, `plugin.json`,
   and changelog version match.
2. Run `npm run validate`.
3. Verify discovery with
   `copilot --plugin-dir . plugin list`.
4. Install the GitHub-hosted release with
   `copilot plugin install microsoft/FixLab`.
5. Run a non-destructive smoke prompt through
   `copilot --agent fixlab:fixlab`.
6. Include the validation results, supported operating systems, required local
   tools, and the security and data-handling boundaries in the pull request.

Marketplace publication is independent of merging changes into
`microsoft/FixLab`. Until the separate `github/copilot-plugins` pull request is
accepted, users must install from the FixLab repository. After that marketplace
change is merged, users install FixLab with:

```shell
copilot plugin install fixlab@copilot-plugins
```
