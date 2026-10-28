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
// model's name ("terraviz-stem-high" and the like), so dress a piece
// before renaming it. A prim whose name starts with none of the names
// below is left alone and listed.
//
// Faces are numbered in the order the generator writes each piece's
// materials (`faces` in pieces.ts); mesh.test.ts holds FACES to it.
//
// The look is STYLE_GUIDE.md's, as docs/SECOND_LIFE_COMPAT.md §9 Phase 5
// ("The furniture's look") sets it out: graphite bodies, the app's dark
// glass for the console's panel, and one accent line per piece in the
// app's blue, full bright and glowing a little. A key's ring rests grey;
// the console script lights it when the key is pressed.

// Colours from tokens/global.json and STYLE_GUIDE.md.
vector GRAPHITE = <0.086, 0.094, 0.122>; // #16181f
vector PANEL    = <0.063, 0.071, 0.094>; // #101218
vector KEY      = <0.114, 0.125, 0.161>; // #1d2029
vector RING     = <0.204, 0.227, 0.278>; // #343a47
vector ACCENT   = <0.302, 0.651, 1.0>;   // #4da6ff, --color-accent
float  ACCENT_GLOW = 0.08;

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
    float glow = 0.0;
    integer bright = FALSE;
    integer shiny = PRIM_SHINY_MEDIUM;
    if (material == "panel") { c = PANEL; shiny = PRIM_SHINY_LOW; }
    else if (material == "cap") { c = KEY; shiny = PRIM_SHINY_LOW; }
    else if (material == "ring") { c = RING; }
    else if (material == "accent") { c = ACCENT; glow = ACCENT_GLOW; bright = TRUE; shiny = PRIM_SHINY_NONE; }
    return [PRIM_TEXTURE, face, TEXTURE_BLANK, <1.0, 1.0, 0.0>, ZERO_VECTOR, 0.0,
        PRIM_COLOR, face, c, 1.0,
        PRIM_GLOW, face, glow,
        PRIM_FULLBRIGHT, face, bright,
        PRIM_BUMP_SHINY, face, shiny, PRIM_BUMP_NONE];
}

// Paints one prim if its name is a piece's; TRUE if it was.
integer dress(integer link, string name)
{
    integer i;
    for (i = 0; i < llGetListLength(FACES); i += 2)
    {
        if (llSubStringIndex(name, llList2String(FACES, i)) == 0)
        {
            list materials = llParseString2List(llList2String(FACES, i + 1), [" "], []);
            list p = [];
            integer f;
            for (f = 0; f < llGetListLength(materials); ++f)
                p += look(f, llList2String(materials, f));
            llSetLinkPrimitiveParamsFast(link, p);
            return TRUE;
        }
    }
    return FALSE;
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
