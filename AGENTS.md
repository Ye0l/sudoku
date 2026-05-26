## Nightly Isolation Notes

- Keep nightly-only behavior inside `src/nightly.ts` or `src/nightly/*.ts`.
- Avoid top-level side effects in nightly modules. Stable builds import `src/nightly.ts`, so experimental work must run only from explicit `activate()` paths.
- Guard future experimental entry points with `nightlyModule.isActive()` or call them only from `nightlyModule.activate()`.
- URL activation with `?nightly` is session-scoped. Persisted nightly state should only come from the settings toggle.
