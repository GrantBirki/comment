# AGENTS.md

Guidance for agents and maintainers working in this repository.

## Project Overview

`comment` is a JavaScript GitHub Action for creating, updating, and reacting to
GitHub issue and pull request comments. It is intended to be used from GitHub
Actions workflows as `GrantBirki/comment@vX.X.X`.

The action supports three primary workflows:

- Creating a new issue or pull request comment from an inline `body`.
- Creating or updating a comment from a Markdown file.
- Rendering a Markdown file as a Nunjucks template using YAML `vars`.

It also supports adding GitHub issue-comment reactions such as `eyes`, `rocket`,
`heart`, `hooray`, `+1`, and `-1`. Reactions can be used while creating a
comment, updating a comment, or as a reaction-only update against an existing
comment.

This is a checked-in bundled GitHub Action. Source lives under `src/`, but
consumers run `dist/index.js` through `action.yml`. Any source or dependency
change that affects runtime behavior must be followed by rebuilding and
committing `dist/`.

## Repository Layout

- `action.yml` - GitHub Action metadata, inputs, outputs, branding, and Node
  runtime. The action currently runs with `using: node24` and points to
  `dist/index.js`.
- `src/main.js` - Minimal entrypoint that imports and invokes `run()` from
  `src/comment.js`.
- `src/comment.js` - Main implementation. This file owns input parsing,
  repository and issue resolution, body/template rendering, comment creation,
  comment updates, reaction validation, and GitHub API calls.
- `test/comment.test.js` - Node test runner unit tests. These tests mock
  `@actions/core`, the GitHub client, and Octokit calls so most behavior can be
  tested without network access.
- `dist/` - Bundled runtime produced by `ncc`. Do not edit this directory by
  hand.
- `demo/` - Example templates and sample workflow material used by the README
  and acceptance workflow.
- `.github/workflows/` - CI, package verification, acceptance, and release-tag
  maintenance workflows.
- `script/release` - Interactive helper for creating and pushing annotated
  release tags.
- `README.md` - User-facing action documentation.
- `CONTRIBUTING.md` - Currently only a placeholder.

## Runtime Flow

The runtime path is intentionally small:

1. GitHub Actions loads `action.yml`.
2. `action.yml` runs `dist/index.js`.
3. `dist/index.js` is generated from `src/main.js`.
4. `src/main.js` calls `run()` from `src/comment.js`.
5. `run()` reads inputs, validates local state, resolves the body, creates an
   authenticated Octokit client, then either creates or updates a comment.

Important functions in `src/comment.js`:

- `getInputs()` reads action inputs via `@actions/core`. The deprecated
  `reaction-type` input is still supported as a fallback when `reactions` is not
  set.
- `sanitizeInputs()` masks the token before debug logging. Keep this behavior
  intact for any future logging changes.
- `resolveIssueNumber()` prefers the explicit `issue-number` input, then falls
  back to issue, pull request, or generic event `number` fields from
  `github.context.payload`.
- `resolveRepository()` validates `owner/repo` form and falls back to
  `GITHUB_REPOSITORY` when the input is empty.
- `parseVars()` parses YAML template variables with `js-yaml` and requires the
  result to be a mapping. Scalars, arrays, dates, and multi-document YAML are not
  accepted as valid template variables.
- `renderComment()` renders the selected file through Nunjucks.
- `SafeTemplateLoader` constrains Nunjucks includes to files inside the selected
  template directory, after resolving real paths. This is a security boundary.
- `resolveBody()` enforces `body` XOR `file`; `vars` requires `file`.
- `createComment()` creates a new issue comment and writes the `comment-id`
  output.
- `updateExistingComment()` updates an existing comment. `append` mode fetches
  the old body first and appends a newline plus the new body. `replace` mode
  skips the fetch and writes the new body directly.
- `validReactions()` trims, validates, filters, and de-duplicates reaction
  inputs.
- `addReactions()` adds reactions concurrently, fails when no valid reactions
  are provided, and fails the action if any GitHub reaction request is rejected.

## Behavioral Rules To Preserve

Preserve these semantics unless the requested change explicitly says otherwise:

- `edit-mode` defaults to `append`.
- Valid `edit-mode` values are only `append` and `replace`.
- Creating a new comment requires `body` or `file`.
- Updating an existing comment requires `body`, `file`, or `reactions`.
- `body` and `file` are mutually exclusive.
- `vars` without `file` is invalid.
- `comment-id` takes the update path; absence of `comment-id` takes the create
  path.
- Missing both `issue-number` and `comment-id` is invalid.
- `reactions` takes precedence over deprecated `reaction-type`.
- Invalid reaction names are skipped, but a reaction input with no valid
  reactions fails.
- The `comment-id` output is set for both created comments and updated comments
  with a body.
- Token values must never be written to debug, info, or error logs.

## Security and Safety Notes

This action runs inside user workflows with a GitHub token, so small input
handling changes can have real impact.

- Treat template path handling as security-sensitive. `SafeTemplateLoader`
  intentionally prevents absolute includes, traversal outside the template
  directory, sibling-prefix escapes, missing-file access, and symlink escapes.
  Add tests for any change in this area.
- Keep the `js-yaml` parser constrained to mappings for `vars`. Accepting other
  YAML shapes changes the public template contract and can surprise users.
- Nunjucks currently renders with `autoescape: true`; tests assert escaping for
  unsafe values. Be explicit and well-tested if changing escaping behavior.
- Avoid logging full input structures unless they pass through
  `sanitizeInputs()`.
- Do not loosen workflow permissions when editing CI. Use least-privilege
  permissions blocks.
- For new GitHub workflow jobs that only read repository content, prefer
  `permissions: contents: read` and avoid persisted checkout credentials unless
  a later step needs to push.
- Existing workflows use pinned action SHAs with comments indicating the
  intended major version. Preserve that style when changing workflow actions.

## Development Environment

Use the Node version declared by `.node-version`:

```bash
24.9.0
```

Install dependencies with:

```bash
npm ci
```

Common commands:

```bash
npm test
npm run lint
npm run format-check
npm run format
npm run package
npm run bundle
npm run all
```

What the commands do:

- `npm test` runs `node --test --experimental-test-coverage test/*.test.js`.
- `npm run ci-test` currently aliases `npm test`.
- `npm run lint` runs ESLint over `src` and `test`.
- `npm run format-check` checks JavaScript formatting with Prettier.
- `npm run format` rewrites JavaScript formatting with Prettier.
- `npm run package` runs `ncc build src/main.js -o dist --source-map --license
  licenses.txt`. It sets `NODE_OPTIONS=--openssl-legacy-provider`.
- `npm run bundle` runs `format` and then `package`.
- `npm run all` runs `format`, `lint`, `test`, and `package`.

Prettier and ESLint intentionally ignore `dist/`, `lib/`, and `node_modules/`.
Generated bundles are verified by rebuilding, not formatted directly.

## Making Code Changes

Use this process for runtime changes:

1. Edit `src/comment.js` or `src/main.js`.
2. Add or update focused tests in `test/comment.test.js`.
3. Run `npm test`.
4. Run `npm run lint` and `npm run format-check`, or run `npm run all` when a
   full local pass is appropriate.
5. Rebuild `dist/` with `npm run package` or `npm run bundle`.
6. Inspect the diff and confirm both source and generated `dist/` changes are
   intentional.

Do not manually patch generated files in `dist/` except in an emergency where
the generated output is being repaired from a known-good build artifact. The
normal path is always to change source and rebuild.

When adding a new input or output:

1. Update `action.yml`.
2. Update `README.md` input/output documentation and examples where relevant.
3. Update `src/comment.js` input parsing and behavior.
4. Add tests for the new contract.
5. Rebuild `dist/`.

When changing public behavior, keep the README, demo files, tests, and
acceptance workflow aligned. This repository is small enough that stale docs are
usually avoidable.

## Testing Strategy

The unit tests are the primary fast feedback path. They cover:

- Input parsing and deprecated input compatibility.
- YAML variable parsing.
- Template rendering and escaping.
- Template include restrictions.
- Symlink and path traversal rejection.
- Issue-number fallback behavior.
- Repository validation.
- Token masking.
- Reaction validation, de-duplication, and failure behavior.
- Create, update, replace, append, and reaction-only action paths.
- Early validation failures before constructing an Octokit client.
- The special README hint for `Resource not accessible by integration`.

Test helpers in `test/comment.test.js` include:

- `makeCore()` for mocked `@actions/core` behavior and call recording.
- `makeOctokit()` for mocked GitHub REST calls.
- `makeGithubClient()` for mocked `@actions/github` behavior.
- `writeTemplate()` and `writeTemplates()` for temporary template files.

Prefer extending these helpers over introducing network-dependent tests.

## CI Workflows

The CI workflows are intentionally separated:

- `.github/workflows/test.yml` runs unit tests on pull requests, pushes to
  `main`, and manual dispatch.
- `.github/workflows/lint.yml` runs Prettier check and ESLint on pull requests
  and pushes to `main`.
- `.github/workflows/package-check.yml` rebuilds `dist/` and fails if generated
  output differs from what is committed. If the diff check fails, it uploads the
  rebuilt `dist/` as an artifact.
- `.github/workflows/acceptance.yml` runs on pull requests and exercises the
  local action with real GitHub API calls. It creates comments, verifies bodies,
  tests deprecated `reaction-type`, validates template rendering, checks append
  and replace modes, checks reaction-only updates, and confirms invalid-only
  reactions fail.
- `.github/workflows/update-latest-release-tag.yml` is manually dispatched to
  move a major release tag such as `v1` to a source tag such as `v1.2.3`.

When changing workflows, follow the pattern used here and in
`/Users/birki/code/branch-deploy`: clear job names, explicit permissions,
pinned or otherwise intentional action versions, `npm ci`, Node from
`.node-version`, and package-diff verification for bundled action output.

## Release Process

This project uses semver-style release tags such as `v1.2.3`.

High-level release flow:

1. Merge the code change with source, tests, docs, and `dist/` updated.
2. Create and push an annotated version tag. The local helper is:

   ```bash
   script/release
   ```

3. Create or update the GitHub release for the new version tag.
4. Test the release as needed.
5. Run the `Update Latest Release Tag` workflow to move the matching major tag
   such as `v1` to the new version tag.

`script/release` is interactive and pushes tags. Verify the requested tag before
confirming it, and prefer an explicit `vX.Y.Z` tag shape.

The `update-latest-release-tag` workflow validates the major tag and source ref,
then force-updates `refs/tags/<major_version_tag>` to the requested source. This
is expected for floating major-version tags, but it is still a release operation
with user-facing impact.

## Documentation

`README.md` is the public contract for action users. Keep it aligned with:

- `action.yml` input names, defaults, required fields, and outputs.
- Actual behavior in `src/comment.js`.
- Demo files in `demo/`.
- Permission requirements in workflows that use this action.

Important README troubleshooting topics:

- `Missing either 'issue-number' or 'comment-id'`.
- `Repository Not Found` when a workflow needs checkout access for template
  files.
- `Resource not accessible by integration`, especially for forked public
  repository pull requests and insufficient write permissions.
- Cross-repository comments requiring a PAT with write access.

## Dependency Notes

Runtime dependencies:

- `@actions/core`
- `@actions/github`
- `js-yaml`
- `nunjucks`

Development dependencies:

- `@vercel/ncc`
- `eslint`
- `prettier`

`package-lock.json` is committed. Use `npm ci` for reproducible installs and
commit lockfile changes when intentionally changing dependencies.

The package currently overrides `undici` to `6.24.1`. Preserve that override
unless you have verified why it is no longer needed.

## Style Guidelines

- Keep implementation changes small and explicit. This action's value is in
  predictable comment behavior, not framework complexity.
- Prefer pure helper functions that can be unit tested without a live GitHub
  token.
- Preserve dependency injection in `run({actionsCore, githubClient, env})`;
  tests rely on it and it keeps behavior easy to verify.
- Keep public error messages stable where practical. README examples and tests
  may rely on them.
- Add tests for all new user-visible validation branches.
- Keep generated output separate from source review. Review source first, then
  confirm `dist/` is the expected bundle output.
- Avoid introducing new build systems or test frameworks unless there is a clear
  maintenance win.

## Common Pitfalls

- Forgetting to rebuild `dist/` after editing `src/`.
- Updating `action.yml` without updating README input tables and tests.
- Adding a template feature that bypasses `SafeTemplateLoader`.
- Logging raw inputs that include `token`.
- Assuming `issue-number` is always present. Many workflows rely on fallback
  from the GitHub event payload.
- Treating invalid reactions as fatal individually. Current behavior skips
  invalid names, but fails when the final valid set is empty.
- Breaking deprecated `reaction-type` compatibility.
- Running acceptance-style checks locally without a real GitHub token and a pull
  request context. Use unit tests for local development.

## Quick Local Checklist

For documentation-only changes:

```bash
git diff --check
```

For source changes:

```bash
npm ci
npm test
npm run lint
npm run format-check
npm run package
git diff --check
```

For source changes that may affect public usage, also review:

```bash
git diff -- README.md action.yml demo/ src/ test/ dist/
```
