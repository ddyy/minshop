# create-minshop

Scaffold a fresh [Minshop](https://github.com/ddyy/minshop) storefront:

```sh
npm create minshop@latest my-store
cd my-store
npm run provision:local -- --seed
npm run dev
```

The initializer clones the current public template, removes its Git history and
package-release files, initializes a new repository, and installs the storefront
and MCP dependencies.

Requires Node 22.12 or newer and Git.

## Options

```text
--no-install   Scaffold without installing dependencies
--ref <ref>    Clone a specific Git branch or tag (default: main)
-h, --help     Show help
-v, --version  Show the installed version
```

To provision a new Cloudflare instance after scaffolding:

```sh
npx wrangler login
npm run provision:cf my-store
```

## Publishing

The first release must be published interactively so the package exists on npm:

```sh
cd create-minshop
npm login
npm run check
npm publish
```

After that, configure npm trusted publishing for the `ddyy/minshop` GitHub
repository and the `publish-create-minshop.yml` workflow, with `npm publish`
allowed. Future releases are published by bumping this package version and
publishing a matching GitHub release such as `v0.1.1`.
