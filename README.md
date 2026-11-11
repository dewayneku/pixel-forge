# Pixel Forge

**A pixel-art sprite animator that runs in your browser — with an AI co-pilot that can draw alongside you, live.**

[![Support on Ko-fi](https://img.shields.io/badge/Support-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/T5Y42AGW58)

![A green slime bouncing, made with Pixel Forge](docs/demo.gif)

Draw, animate and export sprites in a lightweight editor. Connect an AI agent like
[Claude](https://claude.com/claude-code) through the built-in [MCP](https://modelcontextprotocol.io)
server, and it sees the same canvas you do: ask it to add an idle animation, clean up a sprite
sheet or put a hat on a new layer, and watch the edits land on your screen as it makes them.

## Features

- **Editor**: pencil, eraser, fill, eyedropper, line, rectangle and ellipse; layers with opacity;
  palette; undo/redo; zoom and pan.
- **Animation**: timeline with per-frame timing, onion skin, live playback.
- **Import anything**: PNG, GIF, JPEG, WebP, BMP. Cut sprite sheets by grid *or* automatically
  find every sprite on a messy sheet, remove solid backgrounds, and clean JPEG noise back to a
  small palette.
- **Export**: PNG frames, sprite sheets (with a JSON of frame positions and timings) and looping
  animated GIFs.
- **AI collaboration**: 21 MCP tools let an agent see your sprite as an image, read exact pixels,
  draw, animate, import and export. Undo is shared, and the agent can point at things on your
  canvas.
- **No build step, no account, runs locally.** Your work autosaves.

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/dewayneku/pixel-forge.git
cd pixel-forge
npm install
npm start
```

Then open **http://localhost:7777**.

Your work autosaves to `data/autosave.forge.json` and comes back when the server restarts. Use
**Save** to keep a project as a `.forge.json` file.

## Importing images

Click **Import** or drop an image on the window (PNG, GIF, JPEG, WebP or BMP; a dropped
`.forge.json` opens as a project). The dialog previews exactly what you'll get:

- **Remove background**: makes a solid background transparent. The color is detected from the
  image border; raise **Tolerance** for noisy JPEGs. "Keep matching colors inside sprites" only
  removes background that touches the edge, so white eyes and highlights survive.
- **Cut into → Even grid**: fixed frame size, spacing and margin. Strips of square frames are
  detected automatically.
- **Cut into → Separate sprites**: finds every sprite on a messy sheet. Click sprites to pick
  them in the order you want as frames (or import them all). Frames are sized to the largest
  pick and sprites are lined up by their feet so animations don't jitter. Raise **Join gap** if
  detached parts (a sword, an effect) come out as separate sprites.
- **Clean up colors**: JPEGs and resized art smear pixel art into hundreds of near-identical
  shades. This pulls the imported frames back to a small palette (24 colors by default; it's on
  automatically for JPEGs), makes edges fully opaque or fully transparent, and removes stray
  single pixels. The resulting colors become your palette. Or snap to your current palette.
- **Import as** a new sprite, new frames after the current one, or a new layer.

To clean up a sprite that's already in the editor, use **Reduce…** above the palette: type a
number of colors, or "palette" to snap to the current one. Undo brings the original back.

Claude can do the same: `analyze_image` shows a sheet with every sprite numbered, and
`import_image` takes `remove_background`, `detect`, `pick: [numbers]` and `reduce_colors`.
For sprites already in the editor there's `reduce_colors`. Claude's tools read
PNG and JPEG files.

Your work autosaves to `data/autosave.forge.json` and comes back when the server restarts.

## Work with an AI agent

**Claude Code**: this repo includes a `.mcp.json`, so starting Claude Code in the `pixel-forge`
folder offers the `pixel-forge` server — approve it. Or add it from anywhere:

```bash
claude mcp add pixel-forge -- node /path/to/pixel-forge/mcp/index.js
```

**Claude Desktop and other MCP clients**: add this to the client's MCP config, with the full
path to your copy:

```json
{
  "mcpServers": {
    "pixel-forge": { "command": "node", "args": ["/path/to/pixel-forge/mcp/index.js"] }
  }
}
```

Then ask for things like:

- "Look at what I'm drawing and suggest shading."
- "Add a 4-frame idle bob animation to this sprite."
- "Put a hat on a new layer."

If the editor isn't running, the MCP server starts it automatically. Claude's edits show up
instantly with a toast, an activity entry, and an orange box when it points at something.
Undo is shared, so Ctrl+Z also undoes Claude's last change.

### Tools Claude gets

| Tool | What it does |
| --- | --- |
| `get_document` | Size, frames, layers, palette, and what you have selected |
| `view_frame`, `view_animation` | See a frame, or all frames as a sheet, as an image |
| `get_pixels` / `draw_grid` | Read or write pixels as a character grid with a color legend |
| `set_pixels`, `draw_shape`, `fill` | Pixels, lines, rectangles, ellipses, paint bucket |
| `edit_cel` | Clear, shift, flip, copy from another frame, replace a color |
| `manage_frames`, `manage_layers` | Add, duplicate, delete, reorder, timing, visibility |
| `reduce_colors` | Clean up colors: reduce to N colors or snap to the palette, remove stray pixels |
| `set_palette`, `canvas`, `history` | Palette, new/resize canvas, undo/redo |
| `annotate` | Highlight a region on your screen with a message |
| `get_activity` | What you (and Claude) changed recently |
| `analyze_image` | See an image file with every sprite boxed and numbered |
| `import_image` | Import a PNG/JPEG as a new sprite, frames or a layer; remove backgrounds; cut by grid or by detected sprites |
| `file`, `open_editor` | Save/open projects, export a PNG frame, sprite sheet or looping animated GIF, open the editor |

When Claude leaves out a frame or layer, it uses the one you have selected.

## Exporting

**Frame PNG**, **Sprite sheet** (PNG plus a JSON of frame positions and durations) and **GIF**
(an animated GIF that loops forever, with each frame's own timing) are in the top bar; pick the
scale first. GIFs keep transparency (fully on or off) and up to 255 colors; GIF timing is in
10 ms steps, so frames shorter than 20 ms play slower in most viewers.

## Editor shortcuts

| Key | Action |
| --- | --- |
| B / E / G / I | Pencil / eraser / fill / eyedropper |
| L / U / O | Line / rectangle / ellipse |
| H or hold Space | Pan (middle mouse also pans) |
| Right-click | Erase · Alt+click picks a color · Shift+fill replaces a color everywhere |
| [ and ] | Brush size |
| , and . (or ← →) | Previous / next frame |
| Enter | Play / pause |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+S | Save project file |
| 0 | Fit to screen |
| Mouse wheel | Zoom |

## How it fits together

```
browser editor (web/)  ──WebSocket──┐
                                    ├── app server (server/app.js): owns the document, undo, autosave
MCP server (mcp/) ─────WebSocket────┘
     ▲ stdio
   Claude
```

- `server/doc.js`: document model (layers, frames, cels as RGBA)
- `server/methods.js`: every edit operation, shared by the editor and the MCP server
- `server/png.js`, `server/gif.js`: PNG and animated GIF encoding for views and exports
- `web/`: the editor (plain JS, no build step)
- `mcp/index.js`: MCP tools that forward to the app server
- `web/imagetools.js`: background removal, sprite detection and color cleanup (shared by editor and server)
- `scripts/smoke-test.js`, `scripts/import-test.js`, `scripts/sheet-test.js`, `scripts/cleanup-test.js`: exercise the tools end to end

Set `PIXEL_FORGE_PORT` to use a port other than 7777.

## Contributing

Issues and pull requests are welcome. The code is plain JavaScript with no build step. The
end-to-end scripts in `scripts/` drive the MCP server like an agent would; they **replace the
open sprite**, so run them against a separate port (each port keeps its own autosave):

```bash
PIXEL_FORGE_PORT=7790 npm start    # terminal 1
PIXEL_FORGE_PORT=7790 npm test     # terminal 2
```

On Windows PowerShell, set the port first with `$env:PIXEL_FORGE_PORT=7790`.

Please don't commit sprites or sheets you don't have the rights to share — `projects/` and
`data/` are git-ignored for your own work.

## Support

Pixel Forge is free and open source. If it helps you and you'd like to chip in, you can
[buy me a coffee on Ko-fi](https://ko-fi.com/T5Y42AGW58) ☕ — every bit helps keep it going.
Starring the repo, sharing what you make with it, and reporting bugs help a lot too.

## License

[MIT](LICENSE) © dewayneku
