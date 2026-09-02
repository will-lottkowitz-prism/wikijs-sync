# Publishing

## Build the .vsix

```sh
npm ci
npm run lint && npm run check-types && npm test && npm run build
npx vsce package --no-dependencies      # -> wikijs-sync-<version>.vsix
```

## VS Code Marketplace

One-time setup:

1. Create the **`xQx`** publisher at <https://marketplace.visualstudio.com/manage>
   (sign in with the Microsoft account you want to own it).
2. Create an **Azure DevOps Personal Access Token**: <https://dev.azure.com> →
   User settings → Personal access tokens → New. Organization: **All accessible
   organizations**. Scopes: **Marketplace → Manage**. Copy the token.
3. `npx vsce login xQx` and paste the token (stored in your keychain).

Each release:

```sh
# bump "version" in package.json + add a CHANGELOG entry, commit, tag vX.Y.Z
npx vsce publish            # packages + uploads; or: npx vsce publish <patch|minor|major>
```

`vsce publish --packagePath wikijs-sync-<version>.vsix` uploads an already-built
`.vsix` instead of rebuilding.

## GitHub release

```sh
gh release create vX.Y.Z wikijs-sync-X.Y.Z.vsix --title "vX.Y.Z" --notes "…"
```
