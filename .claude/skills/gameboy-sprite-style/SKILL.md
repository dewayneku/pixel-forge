---
name: gameboy-sprite-style
description: Turn a modern creature sprite (GBA/DS-era or fan art) into the Game Boy Gen 1 or Gen 2 battle-sprite style in Pixel Forge, then hand-finish it. Use when the user asks to convert, "demake", or redraw a sprite in Gen 1 / Gen 2 / Game Boy / Red-Blue-Yellow / Gold-Silver-Crystal style, or to judge how close a sprite is to that style.
---

# Game Boy sprite style (Gen 1 / Gen 2)

You have Pixel Forge's MCP tools. The converter does the mechanical 70%; your job is the
artistic 30% a script can't do. Never stop at the raw conversion.

## The style, as measured

Measured from 151 Gen 1 (Yellow) and 250 Gen 2 (Crystal) sprites against 151 Gen 3 (FireRed)
sprites. These are the targets `style_check` scores against.

| | Gen 1 | Gen 2 |
| --- | --- | --- |
| Colors | 4: white, light, dark, black | same (GBC: white, 2 tints, black) |
| Canvas | 40, 48 or 56 px square, by creature size | same |
| Longest side | ~98% of the canvas (canvas − 1), centered, resting on the bottom | same |
| Edge pixels that are black | ~63% (broken by light outlines and anti-aliasing) | ~88% (almost solid) |
| Shade share (white/light/dark/black) | 13 / 29 / 28 / 26% | 14 / 31 / 20 / 29% |
| Black *inside* the outline | ~17% of the body | ~16% |
| Single-pixel regions | ~15% (textured) | ~11% (cleaner) |
| Dithering (2×2 checker) | ~2% | ~5% |

- Darker creatures get more black and less white (measured, moderate correlation).
- Size class from the source silhouette's longest side vs its own frame: ≤ 69% → 40,
  ≤ 85% → 48, else 56. Designers sometimes broke this; follow the creature's importance and
  bulk (big final evolutions and legendaries → 56).

## Workflow

1. **Look first.** `view_frame` or `analyze_image` the source. Note what defines the creature:
   silhouette, face, signature features (horns, flames, shell). Decide what must survive at
   40–56 px and what can go.
2. **Pick the settings** before converting:
   - `preset`: gen1 (rougher, moodier) or gen2 (clean, solid outline). Default gen2.
   - `tone`: dark-bodied or ghostly creatures → `darker`/`darkest`; pale ones → `lighter`.
   - `size`: only override when the creature's bulk says otherwise.
   - `colors`: `gray` for Gen 1 look, `auto` or `[light, dark]` for Game Boy Color.
3. **Convert**: `gameboy_style` (from a file with `path`, or the open sprite's frame). The
   converter is made for *shrinking* detailed art (GBA 64 px, DS 80 px, or bigger). If the
   source is already smaller than the target canvas, it gets enlarged and looks blocky: pass
   a smaller `size`, or redraw it by hand instead.
4. **Read the report** it returns (same as `style_check`). Each check passes when the value is
   inside `ok_range`, the range ~90% of real sprites fall in; `typical` is the median. Real
   sprites vary: about half pass every check, and 90% miss **two or fewer**. Aim for ≤ 2
   misses and treat them as hints, not orders: a stylistic choice can justify a miss.
5. **Hand-finish** with `get_pixels` → edit rows → `draw_grid` (work on a copy layer or
   new frame so the user can compare). Go through the checklist below, then
   `view_frame` at scale 6+ to look, and `style_check` again.
6. **Show the user** before/after with `view_animation` or by placing both as frames, and say
   which checks still miss and why.

## Hand-finishing checklist

The converter averages pixels; real sprites are drawn. Fix these by hand:

- **Face and eyes first.** Eyes are 1–3 px black (often with a 1 px white glint). Mouths are
  a single black line. Re-draw them if the conversion smeared them; they carry the character.
- **Silhouette.** Spikes, horns, ears and tails should end in clean points, not stumps or
  stair-step mush. Remove stray pixels outside the body; close gaps in the outline.
- **Black outline.** Gen 2: close it fully except deliberate lit spots. Gen 1: allow lighter
  outline pixels where light hits (top/left).
- **Light outlines on dark shapes.** Black can't be outlined in "blacker": where a dark part
  overlaps another dark part (an arm over a dark body), separate them with a *light* line.
- **Interior lines.** Use black to separate limbs, folds, muscles, the mouth. Lines are 1 px,
  continuous, and follow form; delete black specks that aren't part of a line or an eye.
- **Shading.** Light from the top-left. Shadows are flat shapes along the bottom/right of each
  form, not noise. Merge lone pixels into neighbours (`style_check` single_px too high).
- **Anti-aliasing (sparingly).** On stair-stepped curves against white, a light or dark pixel
  at the step softens it. Light has a stronger effect than dark.
- **Dithering (rarely).** A checkerboard of two shades for a soft highlight or gradient on a
  big form. Never as texture everywhere.
- **Gen 1 vs Gen 2 feel.** Gen 1: rougher, more dark, more texture, broken outline. Gen 2:
  cleaner, lighter, bigger flat areas, solid outline.

## Animations

Convert one frame, finish it by hand, then build the other frames from the finished one
(row drops for breathing, rotations around a pivot for limbs). Converting every frame
separately gives inconsistent sizes and shading.

## Rights

Only commit or share sprites the user has the rights to. Converted official sprites are for
the user's own use; keep them out of public repos.
