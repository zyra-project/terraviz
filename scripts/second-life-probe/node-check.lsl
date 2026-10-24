// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// TerraViz in-world probe - the network half of the kit.
//
// ABOUT TERRAVIZ
// TerraViz is a free, open-source globe for environmental data, most of
// it from NOAA's Science On a Sphere collection. It runs in a web browser
// and as a desktop app, and any museum, lab or school can run its own
// copy of the service, called a node.
//   The app:     https://terraviz.zyra-project.org
//   The source:  https://github.com/zyra-project/terraviz
//   What this script found (section 4.1), and the plan it led to:
//     https://github.com/zyra-project/terraviz/blob/main/docs/SECOND_LIFE_COMPAT.md
//   How to run it:
//     https://github.com/zyra-project/terraviz/blob/main/scripts/second-life-probe/README.md
//
// WHAT THIS IS FOR
// Asks a TerraViz node for two replies from inside Second Life and says
// what came back: whether the region's servers can reach the node at
// all (it sits behind Cloudflare), whether LSL reads its JSON natively,
// where the 16 KB reply cap cuts in, and what holding a reply costs a
// script out of its 64 KB.
//
// A script of its own on purpose. The memory reading is the point, and
// a lean script is what an exhibit would run: measured inside the probe,
// which carries its whole test page as string constants, one full reply
// took it past its limit. Here the baseline is small, so the reading is
// the reply's cost, not the probe's.
//
// Runs once on start. `/7 api` (owner only) runs it again.

integer CHAN = 7;
string  NODE = "https://terraviz.zyra-project.org";

key gEventsReq;
key gCatalogReq;

askNode()
{
    llOwnerSay("[node] Asking " + NODE + ". Script memory in use before: "
        + (string)llGetUsedMemory() + " of " + (string)llGetMemoryLimit() + " bytes");
    // Events is small; the catalog is far over the cap, which is the point.
    gEventsReq  = llHTTPRequest(NODE + "/api/v1/events",  [HTTP_BODY_MAXLENGTH, 16384], "");
    gCatalogReq = llHTTPRequest(NODE + "/api/v1/catalog", [HTTP_BODY_MAXLENGTH, 16384], "");
}

default
{
    state_entry()
    {
        llListen(CHAN, "", llGetOwner(), "");
        askNode();
    }

    on_rez(integer p) { llResetScript(); }

    changed(integer c)
    {
        if (c & CHANGED_OWNER) llResetScript();
    }

    listen(integer ch, string name, key id, string msg)
    {
        if (llToLower(llStringTrim(msg, STRING_TRIM)) == "api") askNode();
    }

    http_response(key id, integer status, list meta, string body)
    {
        string which;
        if (id == gEventsReq) which = "events";
        else if (id == gCatalogReq) which = "catalog";
        else return;
        string line = "[node] " + which + ": HTTP " + (string)status + ", " + (string)llStringLength(body) + " characters received";
        integer t = llListFindList(meta, [HTTP_BODY_TRUNCATED]);
        if (t != -1)
            // Half a JSON document parses as nothing useful, so say so
            // rather than report a count read from a failed parse.
            line += ", cut off at " + (string)llList2Integer(meta, t + 1) + " bytes, so not parsed";
        else if (status == 200 && llJsonValueType(body, []) != JSON_OBJECT)
            // A 200 that is not JSON - a challenge page, or a node whose
            // app answers every path - is the case worth seeing.
            line += ". Not JSON. Reply starts: " + llGetSubString(body, 0, 100);
        else if (status == 200 && which == "events")
        {
            integer count = llGetListLength(llJson2List(llJsonGetValue(body, ["events"])));
            line += ". llJsonGetValue read " + (string)count + " event(s)";
            if (count > 0) line += ", first: " + llJsonGetValue(body, ["events", 0, "title"]);
        }
        if (status != 200) line += ". Reply starts: " + llGetSubString(body, 0, 100);
        line += ". Script memory in use: " + (string)llGetUsedMemory() + " of " + (string)llGetMemoryLimit() + " bytes";
        llOwnerSay(line);
    }
}
