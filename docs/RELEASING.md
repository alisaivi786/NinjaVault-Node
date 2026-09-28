# Releasing @ninjavault/cdn

## Every release

1. Bump the version (this also updates `src/version.ts` through the `version` npm script):

   ```bash
   npm version patch --no-git-tag-version   # or minor / major
   ```

2. Create and fill in the change-set for the new version:

   ```bash
   make changeset TYPE=Patch                # creates changesets/<version>.md
   ```

3. Run everything CI runs:

   ```bash
   make check                               # format, lint, types, coverage, build, publint, attw, change-set
   make smoke                               # pack, install into a temp project, run ESM + CJS scripts
   ```

4. Open a pull request against `main`. The **CI** workflow runs the full toolchain on Node 22 and 24
   (Linux and Windows) and installs the packed tarball on Node 18, 20, 22 and 24.
5. Merge. The **Publish** workflow checks whether `package.json`'s version is on npm. If it is not, it runs
   the checks again, publishes with provenance, tags `v<version>` and creates a GitHub release with the
   change-set as notes and the tarball attached.

npm never lets a version be published twice. Always bump the version for a new release.

### One version number for every SDK

All NinjaVault SDKs share the same three-part version (npm only allows three parts): `@ninjavault/cdn`,
`ninjavault-cdn` (PyPI) and `NinjaVault.Cdn` (NuGet) are all `100.42.1`. When a release changes the shared
feature set, release every SDK with the same new number.

## One-time setup

### 1. npm organization

Create the **`@ninjavault`** organization on <https://www.npmjs.com/org/create> (the free plan is enough for
public packages). The account that publishes must be an owner or member with publish rights.

### 2. GitHub environment

In the repository: **Settings > Environments > New environment** named **`npm`**. Optionally add required
reviewers so every release needs an approval.

### 3. First publish (token, once)

npm configures trusted publishers on an existing package's settings page, so the first version has to be
published with a token:

1. On npmjs.com: **Access Tokens > Generate New Token > Granular Access Token** with _Read and write_ on
   packages in the `@ninjavault` scope, short expiry (for example 7 days). If the package does not exist yet,
   grant it on the organization/scope.
2. In GitHub: **Settings > Secrets and variables > Actions > New repository secret** `NPM_TOKEN` with that
   token. (Or add it as an environment secret on `npm`.)
3. Merge to `main` (or run **Actions > Publish > Run workflow**). The workflow sees `NPM_TOKEN` and publishes
   with it, still with provenance.

Alternative: publish the first version from your machine with `npm login` and
`npm publish --access public --provenance=false` from a clean checkout after `make check` (`publishConfig`
turns provenance on, which only works in CI). Provenance is then not attached to
that one version.

### 4. Configure the trusted publisher and remove the token

1. On npmjs.com: **Packages > @ninjavault/cdn > Settings > Trusted publishing > GitHub Actions**:

   | Field                | Value             |
   | -------------------- | ----------------- |
   | Organization or user | `alisaivi786`     |
   | Repository           | `NinjaVault-Node` |
   | Workflow filename    | `publish.yml`     |
   | Environment name     | `npm`             |

2. Delete the `NPM_TOKEN` secret in GitHub and revoke the token on npmjs.com.
3. Recommended: **Settings > Publishing access > Require two-factor authentication and disallow tokens**.
   Trusted publishing keeps working; stolen tokens cannot publish.

From now on every release uses OIDC: no stored npm credentials.

### Requirements for trusted publishing

- npm CLI 11.5.1 or later and Node 22.14.0 or later in the publish job (the workflow uses Node 24 and
  installs npm `^11.5.1`).
- `permissions: id-token: write` on the job (already set).
- GitHub-hosted runners only; self-hosted runners are not supported.
- `package.json` `repository.url` must match the GitHub repository exactly
  (`git+https://github.com/alisaivi786/NinjaVault-Node.git`).
- Provenance is generated automatically for trusted publishing.

Reference: <https://docs.npmjs.com/trusted-publishers>
