# `.ci/` — release automation

Generated from the private source monorepo. **Do not edit these files here** —
change them in the monorepo's `scripts/public/` and re-run `npm run sync-public`.

- `make-latest-json.mjs` — run by `.github/workflows/release.yml` on a `v*` tag.
  Hashes the built `wikijs-sync-<version>.vsix`, pulls the matching `CHANGELOG.md`
  section, and writes `latest.json` + `RELEASE_NOTES.md`.
- `latest.json` (published as a release asset) is what the **Wiki.js Sync**
  extension's in-editor self-updater polls:
  `https://github.com/will-lottkowitz-prism/wikijs-sync/releases/latest/download/latest.json`

## Cutting a release

Push a tag that matches `package.json`'s version:

```
git tag v<x.y.z>
git push origin v<x.y.z>
```

CI builds the `.vsix`, writes `latest.json`, and publishes the GitHub Release.
Installed copies pick it up within `wikijsSync.updateCheckIntervalHours`.
