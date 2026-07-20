# URnetwork Web Elements

This repository contains UI web components for the URnetwork project, built using Lit and React.

## Structure

`components/` - Contains reusable web components built with Lit.
`react/` - Contains React wrappers for the web components.

## Development

Create a new component in the `components/` directory.
To see it, place the new component in the `index.html` file.
Run `npm run dev` to start the development server.

## Usage

These elements use paid fonts, in order to use this package in your project, please ensure you have the appropriate font licenses.

https://abcdinamo.com/typefaces/gravity
https://pangrampangram.com/products/bitmap-neuebit
https://pangrampangram.com/products/neue-montreal

## Deployment

- Make sure everything is committed and pushed to the main branch.
- If you're not already, login to npm with `npm login`.
- `npm run build` to build the package.
- Run `npm pack --dry-run` to see what will be included in the package.
- If everything looks good, run `npm run release:patch` to publish the package. There are also `release:beta`, `release:minor`, and `release:major` scripts available for versioning.
- Tag it on Github after publishing like `git tag vx.y.z` and `git push --tags`.
