# Third-party notices

Pixel Forge is MIT licensed (see [LICENSE](./LICENSE)). It bundles no third-party code; the work
below inspired techniques that Pixel Forge reimplements in its own code.

## agent-sprite-forge

- **Project:** [agent-sprite-forge](https://github.com/0x0funky/agent-sprite-forge)
- **License:** MIT. Copyright (c) 2026 0x0funky.
- **Used for:** the majority-vote downscale and contrast-aware lone-pixel cleanup in
  `web/gbstyle.js` are adapted from the ideas in its hi-bit finish (`forge_hibit.py`): every output
  pixel takes the shade covering most of its area instead of a blend, and a lone pixel is only
  merged into its neighbours when it does not contrast with them.

```
MIT License

Copyright (c) 2026 0x0funky

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
