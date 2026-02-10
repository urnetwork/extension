# URnetwork Browser Extension

## Development

- `npm install` packages
- `npm run dev` starts the server
- In Chrome, click "Manage Extensions". Enable "Developer Mode". Click "Load unpacked", and select the generated `dist` directory.

## Deployment
- Bump the package.json version with `npm run version:patch`, `npm run version:minor`, or `npm run version:major`.
- `npm run build`. This creates a zip in the `releases/` folder that matches your new version. Upload this to Chrome Developer Dashboard.

## Todos
- [ ] Snackbar we can prompt for error messages
- [ ] Locations loading error handling
- [ ] Display in UI when we're actually connected to URnetwork
- [ ] Tests
