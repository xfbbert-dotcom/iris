# Iris Python Test Script Design

## Goal

Make the Python worker test command stable from the repository root. Developers and agents should
not need to remember that `pytest` must run from `workers/ai` for `iris_worker` imports to resolve.

## Architecture

Add a root npm script:

```json
"test:python": "cd workers/ai && python -m pytest"
```

The script keeps the Python package layout unchanged and uses the existing `workers/ai/pyproject.toml`
pytest configuration. Local docs should reference `npm run test:python` as the canonical root-level
command, while GitHub Actions may keep its explicit `working-directory: workers/ai` step.

## Invariants

- `npm run test:python` works from the repository root.
- The script does not change Python package names, dependencies, or runtime behavior.
- Existing `npm test` continues to run only the TypeScript Core tests.
- CI and local docs should avoid ambiguous root-level `python -m pytest` instructions.

## Out Of Scope

- Publishing the Python worker package.
- Adding Python dependency management beyond the existing editable install path.
- Combining all verification commands into one script.
