# Contributing

Thanks for your interest in improving this project.

## No CI policy

This project intentionally does **not** use GitHub Actions, GitHub workflows, or any other form of CI/CD pipeline.

- Never add a `.github/workflows/` directory or any GitHub workflow file to this repository.
- Never add CI configuration for this project (e.g. GitHub Actions, CircleCI, Travis CI, Jenkins, GitLab CI, Azure Pipelines).
- Do not propose changes that reintroduce automated CI checks.

Changes are built and verified locally by maintainers before merging. If you think CI is needed, please open an issue to discuss it first — but note that the project's direction is to remain CI-free.

## Making changes

1. Fork the repository and create a branch from `master`.
2. Make your change to `index.js` (never edit `dist/` by hand).
3. Format the source with `npm run format`.
4. Rebuild the bundled action with `npm run build` and commit the updated `dist/` output.
5. Open a pull request describing your change.

## Pull requests

- Keep changes focused and scoped to a single concern.
- Update the documentation (`README.md`) when behavior or inputs change.
- Be responsive to review feedback.
