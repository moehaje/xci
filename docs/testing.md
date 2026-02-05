# Testing

## Local

```bash
npm test
npm run lint
npm run type-check
npm run format:check
npm run smoke:packaged
```

## Notes

- `npm run smoke:packaged` builds a tarball with `npm pack`, installs it into a temp prefix, and exercises `xci --version`, `xci --help`, and `xci run --json` in an empty repo.
- `format:check` is strict. Run `npm run format` if it fails.
