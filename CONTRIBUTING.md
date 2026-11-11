# Contributing to Pixel Forge

Thanks for helping! Pixel Forge is plain JavaScript with no build step, so getting started is quick.

## Setup

```bash
git clone https://github.com/dewayneku/pixel-forge.git
cd pixel-forge
npm install
npm start            # editor at http://localhost:7777
```

## Tests

```bash
npm test             # fast unit tests, no server needed
```

The end-to-end tests drive the MCP server like an AI agent would. They **replace the open
sprite**, so run them against a separate port (each port keeps its own autosave):

```bash
PIXEL_FORGE_PORT=7790 npm start      # terminal 1
PIXEL_FORGE_PORT=7790 npm run test:e2e   # terminal 2
```

On Windows PowerShell, set the port with `$env:PIXEL_FORGE_PORT=7790` first. GitHub runs both
on every push and pull request (Node 18, 20 and 22).

## Where things live

- `server/methods.js`: every edit operation. The editor and the MCP tools both call these, so a
  new feature usually starts here.
- `mcp/index.js`: the MCP tools (thin wrappers that describe each method to the agent).
- `web/`: the editor. `web/imagetools.js` and `web/gbstyle.js` run in both browser and server.

## Pull requests

- Keep changes focused, and say what you tested.
- Add a check to `scripts/unit-test.js` when you add logic that can be tested without a server.
- Only commit art you have the rights to share. Put your own sprites in `projects/` (git-ignored).
