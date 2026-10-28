# TerraViz exhibit meshes

Mesh furniture for the Second Life exhibit, in the TerraViz look:
graphite and the app's dark glass, one accent line per piece in the
app's blue, glow only where something is live. The design is in
[`docs/SECOND_LIFE_COMPAT.md`](../../../docs/SECOND_LIFE_COMPAT.md)
§9 Phase 5 ("The building" and "The furniture's look"). This is its
first batch: the exhibit globe's stand and the console. The console
script that makes the buttons work comes later (Phase 5, steps 3–4),
so for now the console is furniture.

| Piece | What it is | Size, m (X × Y × Z) | Faces | Triangles, high to lowest |
|---|---|---|---|---|
| `terraviz-plinth` | The disc the globe's stand sits on, with an inlaid accent ring | 4.200 × 4.200 × 0.071 | 0 body, 1 accent | 1792 / 704 / 256 / 128 |
| `terraviz-stem` | The stand for a 3 m globe: a lathed stem flaring into a shallow cup, an accent line at its rim | 1.000 × 1.000 × 0.982 | 0 body, 1 accent | 2688 / 1344 / 480 / 160 |
| `terraviz-console` | Base, flared blade, and a top panel tilted 22° toward the visitor on its +X side | 0.584 × 1.240 × 1.135 | 0 body, 1 panel, 2 accent | 2250 / 874 / 314 / 54 |
| `terraviz-key` | One console button: a cap for its icon and a ring that lights when pressed | 0.074 × 0.074 × 0.024 | 0 body, 1 cap, 2 ring | 320 / 192 / 96 / 48 |

The files are in [`dae/`](dae/): for each piece, four levels of detail
(`-high`, `-medium`, `-low`, `-lowest`) and a physics shape
(`-physics`), as COLLADA, the format the uploader reads. They are built
by [`build-meshes.ts`](build-meshes.ts) and committed so you can upload
them without installing anything.

## Uploading a piece

In Firestorm or the Second Life viewer: **Build → Upload → Model**.

1. **Level of detail tab.** For **High**, choose *Load from file* and
   pick `terraviz-<piece>-high.dae`. Do the same for **Medium**, **Low**
   and **Lowest** with their files. Don't let the viewer generate them:
   it thins out a thin shape like the stem's column until it vanishes
   at a distance.
2. **Physics tab.** Choose *From file*, pick `terraviz-<piece>-physics.dae`,
   then **Analyze**. Analysis turns it into a convex hull, the cheapest
   shape for the region to test against.
3. **Upload options tab.** Scale 1. Leave *Include textures* off;
   the dress script paints the pieces.
4. **Calculate weights & fee**, check the land impact it reports, and
   upload. The model's name becomes the object's name; keep it
   starting `terraviz-<piece>` until it is dressed.

## Placing them

Second Life centres an uploaded mesh on its bounding box, so each
piece's position is its middle, not its base. For the exhibit globe:

- **The plinth** on the ground: its centre 0.035 m above the ground.
- **The stem** on the plinth's centre: its centre 0.07 + 0.491 = 0.561 m
  above the ground.
- **The globe**, 3 m across, its centre 0.07 + 1.0 + 1.5 = 2.57 m above
  the ground. It floats about 2 cm above the cup rather than touching it.

For a globe of another size, scale the stem and plinth by the same
factor as the globe, in proportion; the cup and the gap scale with them.

The console stands wherever visitors approach the globe, with its +X
side, where the accent line is, toward them. The buttons' positions on
its panel are `KEY_LAYOUT` in [`pieces.ts`](pieces.ts), in the panel's
own frame; the console script will place them when it is written.

## Dressing them

A freshly uploaded mesh is grey plywood: Second Life keeps a COLLADA
file's shape and faces, not its colours. Drop
[`terraviz-dress.lsl`](terraviz-dress.lsl) into a piece, or into the
root of a linked set of pieces. It paints every prim whose name starts
with a piece's name, says how many it painted, and removes itself.

| Face material | Colour | Finish |
|---|---|---|
| body | graphite `#16181f` | medium shine |
| panel | dark glass `#101218` | low shine |
| cap | `#1d2029` | low shine |
| ring | `#343a47` at rest | medium shine; the console script lights it |
| accent | the app's blue `#4da6ff` | full bright, glow 0.08 |

## Changing a piece

Edit [`pieces.ts`](pieces.ts) (or the builders in
[`geometry.ts`](geometry.ts)), then rebuild:

```
npx tsx scripts/second-life-exhibit/mesh/build-meshes.ts
```

[`mesh.test.ts`](mesh.test.ts) fails if `dae/` no longer matches what
the script builds, if any level of a piece disagrees with the others
on its faces or their order (the uploader refuses that), if a triangle
faces the wrong way, or if the dress script's face table falls out of
step with the pieces. `build-meshes.ts --check` runs the first of those
on its own.

The frame is Second Life's: metres, Z up, +X the front. The files are
COLLADA 1.4.1 with Z up and one `<triangles>` block per face, written
to five decimal places with fixed dates, so a rebuild of unchanged
pieces is byte for byte the same.

## Not yet

- **Textures**: the console's group labels (TIME, VIEW, DATASET) and
  the icon sheet the keys' caps show. Both come with the console
  script, which picks each key's icon.
- **The rest of Phase 5's furniture**: the kiosk screen, the pilot's
  seat, the ring console for inside the big sphere, Orbit's body, and
  the rotunda, field and 25 m sphere.
- **In-world checks**: these have been built and loaded back through
  three.js's COLLADA loader, not yet uploaded. Their land impact is
  §10 question 22.
