// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// TerraViz exhibit: dress a mesh piece.
//
// Paints the exhibit's mesh furniture in the TerraViz look, then removes
// itself. A mesh arrives from the uploader as grey plywood: Second Life
// keeps a COLLADA file's shape and its faces, not its colours. Drop this
// script into an uploaded piece, or into the root of a linked set of
// them, and every prim it recognises is painted.
//
// It recognises a prim by its name, which the uploader takes from the
// model's name ("terraviz-stem" and the like), so dress a piece before
// renaming it. A prim is painted as the longest piece name its own name
// starts with, so a later "terraviz-console-ring" is not taken for the
// console. A prim whose name starts with none of them is left alone and
// listed.
//
// Faces are numbered as pieces.ts lists each piece's materials
// (`faces`): the generator names them f0-body, f1-accent and so on,
// because Second Life numbers a mesh's faces by sorting those names.
// mesh.test.ts holds FACES to pieces.ts.
//
// The look is docs/SECOND_LIFE_COMPAT.md §9 Phase 5's ("The furniture's
// look"): graphite bodies, the app's dark glass for the console's panel,
// and one accent line per piece in the app's blue, full bright so it
// reads as a line of colour in any light. Nothing glows at rest: glow is
// for what is live or pressed, and the console script lights a key's
// ring when the key is pressed.

// The dark glass and the blue are the app's tokens (tokens/global.json).
// Graphite and the keys' greys are this script's own, lifted a little
// from the glass so a solid piece reads as an object under the region's
// light.
vector GRAPHITE = <0.086, 0.094, 0.122>; // #16181f
vector PANEL    = <0.051, 0.051, 0.071>; // #0d0d12, --color-bg
vector KEY      = <0.114, 0.125, 0.161>; // #1d2029
vector RING     = <0.204, 0.227, 0.278>; // #343a47
vector ACCENT   = <0.302, 0.651, 1.0>;   // #4da6ff, --color-accent

// Each piece's name, then its faces' materials in face order.
list FACES = [
    "terraviz-stem",    "body accent",
    "terraviz-plinth",  "body accent",
    "terraviz-console", "body panel accent",
    "terraviz-key",     "body cap ring"
];

// One face, by the material it carries.
list look(integer face, string material)
{
    vector c = GRAPHITE;
    integer bright = FALSE;
    integer shiny = PRIM_SHINY_MEDIUM;
    if (material == "panel") { c = PANEL; shiny = PRIM_SHINY_LOW; }
    else if (material == "cap") { c = KEY; shiny = PRIM_SHINY_LOW; }
    else if (material == "ring") { c = RING; }
    else if (material == "accent") { c = ACCENT; bright = TRUE; shiny = PRIM_SHINY_NONE; }
    return [PRIM_TEXTURE, face, TEXTURE_BLANK, <1.0, 1.0, 0.0>, ZERO_VECTOR, 0.0,
        PRIM_COLOR, face, c, 1.0,
        PRIM_GLOW, face, 0.0,
        PRIM_FULLBRIGHT, face, bright,
        PRIM_BUMP_SHINY, face, shiny, PRIM_BUMP_NONE];
}

// Paints one prim if its name is a piece's; TRUE if it was.
integer dress(integer link, string name)
{
    integer best = -1;
    integer bestLength = 0;
    integer i;
    for (i = 0; i < llGetListLength(FACES); i += 2)
    {
        string piece = llList2String(FACES, i);
        if (llStringLength(piece) > bestLength && llSubStringIndex(name, piece) == 0)
        {
            best = i;
            bestLength = llStringLength(piece);
        }
    }
    if (best < 0) return FALSE;
    list materials = llParseString2List(llList2String(FACES, best + 1), [" "], []);
    list p = [];
    integer f;
    for (f = 0; f < llGetListLength(materials); ++f)
        p += look(f, llList2String(materials, f));
    llSetLinkPrimitiveParamsFast(link, p);
    return TRUE;
}

default
{
    state_entry()
    {
        integer n = llGetNumberOfPrims();
        integer done = 0;
        list unknown = [];
        if (n == 1)
        {
            if (dress(LINK_THIS, llGetObjectName())) ++done;
            else unknown += [llGetObjectName()];
        }
        else
        {
            integer i;
            for (i = 1; i <= n; ++i)
            {
                if (dress(i, llGetLinkName(i))) ++done;
                else unknown += [llGetLinkName(i)];
            }
        }
        string msg = "[dress] Painted " + (string)done + " piece(s).";
        if (unknown != []) msg += " Not a TerraViz piece, left alone: " + llDumpList2String(unknown, ", ") + ".";
        llOwnerSay(msg);
        llRemoveInventory(llGetScriptName());
    }
}
