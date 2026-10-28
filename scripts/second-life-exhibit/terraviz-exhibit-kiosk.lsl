// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// TerraViz exhibit globe - the kiosk script.
//
// ABOUT TERRAVIZ
// TerraViz is a free, open-source globe for environmental data, most of
// it from NOAA's Science On a Sphere collection.
//   The app:     https://terraviz.zyra-project.org
//   The source:  https://github.com/zyra-project/terraviz
//
// WHAT THIS SCRIPT DOES
// It shows TerraViz's kiosk page on a flat screen linked to an exhibit
// globe: the dataset the globe shows, the date in it ticking in step with
// the globe, what the dataset is about, its legend, and who made it, or
// what the live Earth is when no dataset is chosen. The screen is
// optional, a sixth script beside the exhibit's five, and has one
// setting, FACE.
//
// The globe script tells every prim of the object what the globe shows,
// after each change. This script turns that into the kiosk page's
// address: the dataset, and the globe's clock in the keys the globe's own
// address carries, written the same way, so the page works out the date
// the globe shows. Every visitor's viewer loads the page for itself and
// reads the same address, so everyone at the screen sees the same thing,
// and nothing about a visitor goes in it. The page plays no video and
// draws no globe, so it costs a visitor little. Its `t` can differ from
// the globe's own by a millisecond, a rounding of the state's six-decimal
// position, which moves the date only when a frame begins inside it.
//
// While a kiosk shows the page, the info script leaves the date and the
// credit out of the floating text over the globe, since the screen shows
// them in full, and keeps the title for a visitor whose viewer shows no
// media. It asks whether a kiosk is linked when it starts and when a prim
// is linked or unlinked, and this script answers once its face has taken
// the page, and says so then itself.
//
// Link the screen as the root of the build, with the sphere a child: the
// globe script turns the prim it is in, and as the root it would swing
// the screen round with every tilt and spin. Like the globe's, the
// screen's page takes no clicks from anyone: a visitor who could click it
// could move it to another page, and their viewer would move it for
// everyone near it. This script takes no touches either, so a touch on
// the screen does nothing yet; touches come in a later step.
//
// MORE
//   Setting up the exhibit, the kiosk included:
//     https://github.com/zyra-project/terraviz/blob/main/scripts/second-life-exhibit/README.md
//   The kiosk page's address:
//     https://github.com/zyra-project/terraviz/blob/main/docs/EMBED_URL_GRAMMAR.md
//   The Second Life plan, which has the kiosk in section 7, item 9:
//     https://github.com/zyra-project/terraviz/blob/main/docs/SECOND_LIFE_COMPAT.md

// The face the page goes on. A box's sides are 1 (toward -Y), 2 (+X),
// 3 (+Y) and 4 (-X), its top 0 and its bottom 5, so a box twice as wide
// (X) as it is high (Z), and thin in Y, shows the page on 1, or on 3 for
// its other side.
integer FACE = 1;

// The link messages this script shares with the exhibit's scripts. The
// numbers are arbitrary; every script must agree, and exhibit.test.ts
// holds them to it.
integer MSG_STATE = 271001;  // globe to all: what the globe shows, as JSON
integer MSG_HELLO = 271003;  // any to globe: say the state again (a script reset)
integer MSG_KIOSK = 271012;  // info and kiosk: "?" asks whether a kiosk is linked, "here" says one is

// The page draws one fixed layout this size, the largest Second Life
// gives a face (indra/llprimitive/llmediaentry.h).
integer MEDIA_W = 2048;
integer MEDIA_H = 1024;

// Seconds to wait for the globe before telling the owner it said nothing.
float   WAIT = 10.0;

string  gWant;          // the address the globe's latest state calls for
string  gShown;         // the address on the face
integer gLive;          // the face has taken the page, so the floating text can leave it the title's company
integer gPrims;         // the object's prims, not counting anyone sitting on it

// The globe script's num(), which exhibit.test.ts holds equal to it: a
// number with at most three decimal places and no trailing zeros.
string num(float f)
{
    string sign = "";
    if (f < 0.0) { sign = "-"; f = -f; }
    integer whole = (integer)f;
    integer ms = llRound((f - (float)whole) * 1000.0);
    if (ms >= 1000) { whole += 1; ms -= 1000; }
    string s = (string)whole;
    if (ms > 0)
    {
        string frac = llGetSubString((string)(1000 + ms), 1, 3);
        while (llGetSubString(frac, -1, -1) == "0") frac = llDeleteSubString(frac, -1, -1);
        s += "." + frac;
    }
    if (s == "0") return s;
    return sign + s;
}

// The kiosk page's address for one of the globe's states, or "" for a
// message that isn't one. All of it goes after the #, which a web browser
// applies without reloading the page, and there is always something
// there: an empty dataset= is the live Earth. The clock is the globe's
// own anchor, so the page reckons the date from the moment the globe
// does, and the address changes only when the globe's does.
string address(string str)
{
    string node = llJsonGetValue(str, ["node"]);
    string dataset = llJsonGetValue(str, ["dataset"]);
    if (node == JSON_INVALID || dataset == JSON_INVALID) return "";
    list live = ["dataset=" + dataset];
    if (dataset != "")
    {
        live += ["t=" + num((float)llJsonGetValue(str, ["pos"]))];
        if ((integer)llJsonGetValue(str, ["paused"])) live += ["paused=1"];
        else
        {
            live += ["at=" + llJsonGetValue(str, ["atS"]) + "." + llGetSubString((string)(1000 + (integer)llJsonGetValue(str, ["atMs"])), 1, 3)];
            float rate = (float)llJsonGetValue(str, ["rate"]);
            if (rate != 1.0) live += ["rate=" + num(rate)];
        }
    }
    return node + "/output/kiosk#" + llDumpList2String(live, "&");
}

// Puts the address the globe's latest state calls for on the face, with
// every setting every time, as the globe script does: a face given only
// an address takes media's defaults for the rest, which let anyone click
// it. The call sleeps this script for a second. Only an address the face
// took counts as shown, so one refused is tried again with the next
// state; and the info script is told a kiosk is here only once a face
// has taken one, since until then nothing shows what it would leave out.
show()
{
    llSetTimerEvent(0.0);
    if (gWant == gShown) return;
    string url = gWant;
    list p = [PRIM_MEDIA_CURRENT_URL, url, PRIM_MEDIA_HOME_URL, url,
        PRIM_MEDIA_AUTO_PLAY, TRUE,
        PRIM_MEDIA_AUTO_SCALE, FALSE,
        PRIM_MEDIA_AUTO_ZOOM, FALSE,
        PRIM_MEDIA_FIRST_CLICK_INTERACT, FALSE,
        PRIM_MEDIA_WIDTH_PIXELS, MEDIA_W,
        PRIM_MEDIA_HEIGHT_PIXELS, MEDIA_H,
        PRIM_MEDIA_PERMS_INTERACT, PRIM_MEDIA_PERM_NONE,
        PRIM_MEDIA_PERMS_CONTROL, PRIM_MEDIA_PERM_NONE];
    integer r = llSetPrimMediaParams(FACE, p);
    if (r != STATUS_OK)
    {
        llOwnerSay("[exhibit] Kiosk: Second Life refused the media on face " + (string)FACE + " (status "
            + (string)r + "). Set FACE, at the top of the kiosk script, to the screen's face.");
        return;
    }
    gShown = url;
    if (!gLive)
    {
        gLive = TRUE;
        llMessageLinked(LINK_SET, MSG_KIOSK, "here", NULL_KEY);
    }
}

default
{
    state_entry()
    {
        gPrims = llGetObjectPrimCount(llGetKey());
        llMessageLinked(LINK_SET, MSG_HELLO, "", NULL_KEY);
        llSetTimerEvent(WAIT);
    }

    on_rez(integer p) { llResetScript(); }

    changed(integer c)
    {
        if (c & CHANGED_OWNER) llResetScript();
        // A prim linked or unlinked, which may have joined this screen to
        // a globe or taken it away. Someone sitting down or standing up
        // changes the links too, and the prims not at all.
        if (c & CHANGED_LINK)
            if (llGetObjectPrimCount(llGetKey()) != gPrims) llResetScript();
    }

    link_message(integer sender, integer n, string str, key id)
    {
        if (n == MSG_KIOSK)
        {
            if (str == "?" && gLive) llMessageLinked(LINK_SET, MSG_KIOSK, "here", NULL_KEY);
            return;
        }
        if (n != MSG_STATE) return;
        string a = address(str);
        if (a == "") return;
        gWant = a;
        // A moment's wait gathers changes that come together into one, since
        // each change of the face's media sleeps this script for a second.
        if (gWant != gShown) llSetTimerEvent(0.2);
    }

    timer()
    {
        if (gWant != "") { show(); return; }
        llSetTimerEvent(0.0);
        llOwnerSay("[exhibit] Kiosk: no globe has said what it shows. Link this screen to the exhibit's sphere, "
            + "whose globe script must be from 28 October 2026 or later: see the README.");
    }
}
