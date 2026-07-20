# URnetwork Web Elements

UI web components for the URnetwork project, built using Lit and React.

This package lives in the extension repository (`elements/`) and is consumed directly from source — the extension's Vite and TypeScript configs alias `@urnetwork/elements/*` to `elements/src/*`. It is no longer published to npm. The former standalone repository was https://github.com/urnetwork/elements (archived).

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

Nothing to deploy — the extension builds these components in from `elements/src` and they ship with each extension release.
