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
| `terraviz-plinth` | The disc the globe's stand sits on, with an inlaid accent ring | 4.200 × 4.200 × 0.070 | 0 body, 1 accent | 1920 / 768 / 288 / 144 |
| `terraviz-stem` | The stand for a 3 m globe: a lathed stem flaring into a shallow cup, an accent line at its rim | 1.000 × 1.000 × 0.983 | 0 body, 1 accent | 2880 / 1344 / 512 / 176 |
| `terraviz-console` | Base, flared blade, and a top panel tilted 22° toward the visitor on its +X side | 0.584 × 1.240 × 1.132 | 0 body, 1 panel, 2 accent | 2216 / 856 / 304 / 200 |
| `terraviz-key` | One console button: a cap for its icon and a ring that lights when pressed | 0.074 × 0.074 × 0.024 | 0 body, 1 cap, 2 ring | 320 / 192 / 96 / 64 |

The face numbers are the ones you see in-world (in the build tool,
*Select Face*). Second Life numbers a mesh's faces by sorting their
material names alphabetically, not in the order a file lists them, so
the files name each face for its number as well as its material:
`f0-body`, `f1-accent`.

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
   The uploader stretches every level to fill the high level's
   bounding box, so each file here has that same box; one that came
   out a few millimetres smaller would be drawn a few millimetres
   wider than built.
2. **Physics tab.** Choose *From file*, pick `terraviz-<piece>-physics.dae`,
   then **Analyze**. Analysis turns it into a convex hull, the cheapest
   shape for the region to test against. The physics shape is the
   piece's bounding box (a prism for the round pieces), since the
   uploader stretches it to that box anyway.
3. **Upload options tab.** Scale 1. Leave *Include textures* off;
   the dress script paints the pieces.
4. **Calculate weights & fee**, check the land impact it reports, and
   upload. The model's name becomes the object's name; keep it
   starting `terraviz-<piece>` until it is dressed.

## Placing them

Second Life centres an uploaded mesh on its bounding box, so each
piece's position is its middle, not its base. For the exhibit globe:

- **The plinth** on the ground: its centre 0.035 m above the ground.
- **The stem** on the plinth's centre: its centre 0.07 + 0.492 = 0.562 m
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
| panel | the app's dark glass `#0d0d12` | low shine |
| cap | `#1d2029` | low shine |
| ring | `#343a47` at rest | medium shine; the console script lights it |
| accent | the app's blue `#4da6ff` | full bright, no glow |

Nothing glows at rest. Full bright keeps the accent the same blue in
any light, the way the app's one-pixel border is; glow is kept for
what is live or pressed.

## Changing a piece

Edit [`pieces.ts`](pieces.ts) (or the builders in
[`geometry.ts`](geometry.ts)), then rebuild:

```
npx tsx scripts/second-life-exhibit/mesh/build-meshes.ts
```

[`mesh.test.ts`](mesh.test.ts) fails if:

- `dae/` no longer matches what the script builds;
- a level of a piece disagrees with the others on its faces, or its
  bounding box differs from the high level's by more than 0.3%;
- the face names would sort into a different order in Second Life;
- a level is not closed, a face disagrees with its neighbours about
  which side is out, or a closed shell faces inward;
- the console's blade no longer reaches up into its panel;
- the dress script's face table falls out of step with the pieces, or
  it lights anything at rest.

`build-meshes.ts --check` runs the first of those on its own.

The frame is Second Life's: metres, Z up, +X the front. The files are
COLLADA 1.4.1 with Z up and one `<triangles>` block per face, written
to five decimal places with fixed dates, so a rebuild of unchanged
pieces is byte for byte the same. Where two faces meet on a flat top
(the plinth's inlay, the key's cap and ring, the console's label
panel) they share one surface and its seams rather than one lying a
hair above the other, which flickers from far off.

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
