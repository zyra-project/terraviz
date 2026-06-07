# Contributing to TerraViz

Thanks for your interest in contributing!
TerraViz is an open-source project, and we welcome improvements of all kinds —
bug fixes, new features, documentation, tests, dataset metadata, and accessibility
work.

---

## License and Contributor Terms

- TerraViz is licensed under the Apache License, Version 2.0. See `LICENSE` at the repository root.
- By submitting a pull request, issue suggestion, or any code/documentation/artwork ("Contribution"),
  you agree to license your Contribution under the Apache License, Version 2.0, and you represent that you have the
  right to do so.
- Do not contribute code or assets you don't have rights to. If you include third-party code, data, or media,
  ensure it is compatible with the Apache License, Version 2.0 and include proper attribution as required by the original license.
- No CLA is required at this time; contributions are accepted under the project's Apache License terms.
- This project enforces the Developer Certificate of Origin (DCO). All commits must include a Signed-off-by trailer.

If you have questions about licensing or attribution, please open an issue before submitting your PR.

### Contributing on behalf of an employer or institution

If you are creating contributions as part of your employment (e.g., as a
university researcher, corporate developer, or federal employee acting in your
official duties), please ensure that your employer permits contributions to
Apache-2.0 licensed open-source projects before submitting. The DCO
`Signed-off-by` line is a certification that you have the right to submit the
work — for employees, that right typically depends on employer policy.

A few common cases:

- **US federal employees** working in their official duties: contributions are
  generally in the public domain in the United States under 17 USC § 105;
  sign-off is still required to attest provenance.
- **University faculty, staff, and students**: check with your department,
  principal investigator, or technology transfer office. Some institutions
  permit Apache-2.0 contributions broadly; others require prior approval.
- **Corporate employees**: check with your employer's open-source program
  office or legal team. Many employers have a list of pre-approved open-source
  licenses; Apache 2.0 is commonly on it.

If you're unsure, open a Discussion or contact the maintainers before
contributing significant work, and we'll help you find the right path.

---

## Branching Workflow

TerraViz uses a single-branch model centered on `main`.

- **`main`** → The stable, integration, and release branch.
  - All releases are tagged from `main`.
  - CI/CD (web deploy, desktop builds, tests) runs against `main` and PRs targeting `main`.
  - Do **not** commit directly to `main`; all changes land via pull request.

### Rules

1. **Feature Development**
   - Branch off `main`:

     ```
     git checkout main
     git pull origin main
     git checkout -b feature/my-feature
     ```

   - Open a Pull Request (PR) back into `main`.

2. **Testing & Integration**
   - CI/CD runs against the PR.
   - At least one maintainer review is required before merge.
   - Squash or merge commits according to PR conventions; ensure the final merge preserves DCO sign-off (see below).

3. **Hotfixes**
   - Branch off `main` (e.g., `fix/short-description`), open a PR, and merge once green.

---

## Project Structure & Build Targets

TerraViz has three related build targets that share the `src/` tree:

- **Web app** — Vite + TypeScript SPA (`npm run dev`, `npm run build`)
- **Desktop app** — Tauri v2 wrapper around the web app (`npm run dev:desktop`, `npm run build:desktop`, requires Rust)
- **Catalog backend** — Cloudflare Pages Functions + D1 (`npm run dev:functions`)

If your change touches shared code (anything in `src/services/`, `src/ui/`,
`src/types/`, or `src/utils/`), please verify it works in **both** the web
app and the desktop app before requesting review. Changes touching the
catalog backend should be verified against `npm run dev:functions` per the
walkthrough in [docs/CATALOG_BACKEND_DEVELOPMENT.md](docs/CATALOG_BACKEND_DEVELOPMENT.md).

For analytics-related changes (anything that emits, schemas, or aggregates
analytics events), follow the additional review checklist in
[docs/ANALYTICS_CONTRIBUTING.md](docs/ANALYTICS_CONTRIBUTING.md) — privacy
invariants must be preserved.

---

## Filing Issues

When filing a bug, please include:

1. Browser and OS (and for desktop: app version + platform)
2. Console errors (if any)
3. Network tab observations (if data-related)
4. Steps to reproduce
5. Expected vs. actual behavior

For feature requests, please describe the use case, the proposed change, and
any alternatives you've considered.

Open issues at <https://github.com/zyra-project/terraviz/issues>.

---

## Code Style

- **TypeScript** is the primary language. Follow existing conventions in the
  `src/` tree — strict typing, no `any` unless justified, prefer `unknown`
  + narrowing.
- **UI conventions** are documented in [STYLE_GUIDE.md](STYLE_GUIDE.md) (colors, surfaces, frosted-glass design language). Match the existing component patterns.
- **Module organization**: services in `src/services/`, UI controllers in
  `src/ui/`, types in `src/types/`, utilities in `src/utils/`. New code
  should fit this layout. When you add a module under `src/` or
  `src-tauri/src/`, add a one-line row to the matching module-map table in
  [CLAUDE.md](CLAUDE.md) in the same PR — `npm run check:doc-coverage`
  (part of `type-check`) fails CI otherwise. For a module that genuinely
  needs no row, add a `// doc-exempt: <reason>` comment to its source.
- **Rust** (desktop app): follow the existing patterns in `src-tauri/src/`.
  Run `cargo fmt` and `cargo clippy` before submitting changes.
- Check `package.json` for the available `scripts` (lint, format, type-check,
  build, test) and run the relevant ones locally before opening a PR.

For AI-assisted development, see [CLAUDE.md](CLAUDE.md) and [AGENTS.md](AGENTS.md)
for codebase conventions and constraints.

---

## Testing

1. Install dependencies:

   ```
   npm install
   ```

2. Run the test suite:

   ```
   npm test
   ```

3. For desktop-specific changes, build and smoke-test the Tauri app:

   ```
   npm run dev:desktop
   ```

4. For catalog backend changes, run the Pages Functions runtime and exercise
   the relevant endpoints per [docs/CATALOG_BACKEND_DEVELOPMENT.md](docs/CATALOG_BACKEND_DEVELOPMENT.md).

New features should include tests where practical. Bug fixes should include
a regression test where the bug is testable.

---

## Pull Requests

- Make sure your branch is up to date with `main`.
- Include descriptive commit messages that explain *why*, not just *what*.
- Request a review from at least one maintainer.
- Link the related issue in the PR description (e.g., `Closes #123`).
- Ensure all commits in the PR are DCO-signed (see below).
- Confirm CI is green before requesting merge.

---

## Releases

- Releases are tagged from `main`.
- Desktop builds (Windows `.msi`, macOS `.dmg`, Linux `.AppImage`) are
  produced by CI on tagged releases and attached to the GitHub Release.
- The web app is deployed continuously from `main` to <https://terraviz.zyra-project.org>.

---

## Developer Certificate of Origin (DCO)

This project uses the DCO to ensure that contributors have the right to submit
their work. The full text is in the `DCO` file at the repository root.

All commits must include a Signed-off-by line matching your Git author
information. Use the `-s` flag when committing to add this automatically:

```
git commit -s -m "Add feature X"
```

If you forgot to sign off, amend the most recent commit:

```
git commit --amend -s --no-edit
```

For multiple commits, you can interactively rebase and sign each commit:

```
git rebase -i <base-branch>
# then for each commit: edit -> git commit --amend -s --no-edit -> git rebase --continue
```

Notes

- The Signed-off-by line must include your real name and a reachable email, for example:
  `Signed-off-by: Jane Doe <jane.doe@example.com>`
- Ensure your `git config user.name` and `user.email` are correct.
- Co-authored commits require a Signed-off-by for each author.
- The DCO check will run on pull requests; failures include instructions on how to fix your commits.

Enable global sign-off (recommended)

To automatically include a DCO sign-off on every commit from your machine,
enable global sign-off:

```
git config --global format.signoff true
```

This works with most Git clients and IDEs (including VS Code) and reduces the
chance of missing a sign-off.

---

Thanks again for contributing!
