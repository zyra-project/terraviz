// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// TerraViz globe - a live Earth-data globe for Second Life.
//
// ABOUT TERRAVIZ
// TerraViz is a free, open-source globe for environmental data: hurricane
// seasons, sea surface temperature, wildfire smoke forecasts, the Earth's
// night lights and nearly two hundred more, most of them from NOAA's
// Science On a Sphere collection. It runs in a web browser and as a
// desktop app, and any museum, lab or school can run its own copy of the
// service, called a node.
//   The app:     https://terraviz.zyra-project.org
//   The source:  https://github.com/zyra-project/terraviz
//
// WHAT THIS SCRIPT DOES
// It turns a sphere into a TerraViz globe. The sphere's surface shows
// TerraViz's output page: a web page that draws the whole Earth unwrapped
// into a flat 2:1 picture, which Second Life wraps round the sphere. Every
// visitor's viewer loads that page for itself, so the page is told what
// to show by its address alone: which dataset, where in its animation,
// and whether it is paused. Every copy reads the same address, so
// everyone at the globe sees the same moment.
//
// The commands below rewrite that address. Changes go after its #, which
// a web browser applies without reloading the page. Whether every Second
// Life viewer passes a #-only change on without reloading is still being
// tested: the probe kit's /7 hash answers it for your viewer. If yours
// reloads, "/8 steer query" puts every change before the # instead, which
// always reloads. A reload doesn't lose the moment, since the address
// says what it is, but each globe shows the plain live Earth for a few
// seconds while its dataset loads again.
//
// A SMOKE-TEST SCRIPT, NOT YET THE EXHIBIT
// Only the owner can change the globe, by chat. The exhibit version -
// a presenter list, controls visitors can touch, and an automatic return
// to the live Earth after the last visitor leaves - is Phase 2 of the
// plan, and not built. A left-click on the globe only focuses its media;
// a visitor who right-clicks it and chooses Touch is told in chat what it
// shows, with a link to it in the full app.
//
// MORE
//   The Second Life plan, and what was tested in-world:
//     https://github.com/zyra-project/terraviz/blob/main/docs/SECOND_LIFE_COMPAT.md
//   Everything the output page's address can say:
//     https://github.com/zyra-project/terraviz/blob/main/docs/EMBED_URL_GRAMMAR.md#the-output-page--a-globes-texture
//   Setting this up, step by step, and the probe kit it sits beside:
//     https://github.com/zyra-project/terraviz/blob/main/scripts/second-life-probe/README.md
//   What "/8 telemetry on" sends:
//     https://terraviz.zyra-project.org/privacy
//
// SETTING UP
// 1. Rez a sphere. A default prim sphere is fine.
// 2. In its Content tab, make a New Script, replace its text with all of
//    this one, and save. The globe shows the live Earth within a few
//    seconds: today's clouds and the real day/night line.
// 3. Say /8 help in local chat.
// If the sphere stays blank, media auto-play is off in your viewer: open
// the Nearby Media list (top right of the screen) and press play beside
// the globe.
//
// COMMANDS, said on channel 8 by the owner:
//   /8 show <name or id>   a dataset, playing from its start
//   /8 list                the names /8 show knows
//   /8 earth               back to the live Earth
//   /8 pause, /8 play      every visitor stops on, or starts from, the same frame
//   /8 jump <s or m:ss>    go to that point in the clip, paused or playing
//   /8 rate <speed>        0.084 to 12.8; 1 is the clip's own speed
//   /8 rotation <degrees>  the longitude at the centre of the picture, east
//   /8 spin <degrees/s>    turn the whole sphere; /8 spin off stops it
//   /8 debug on|off        TerraViz's diagnostic readout, drawn on the globe
//   /8 width 1024|2048     the picture's resolution
//   /8 telemetry on|off    anonymous counts (reloads every visitor's page)
//   /8 steer hash|query    where changes go in the address (see above)
//   /8 status              the current address and state
//   /8 upright             stand the poles upright again
//
// TELEMETRY
// "/8 telemetry on" has each visitor's page report, anonymously and only
// in the first minute after it loads, which dataset it showed and
// anything that failed. Every reload reports again as a new visit, so
// the privacy policy asks the owner of a measured globe to change only
// what comes after the #: this script refuses "/8 steer query" while
// telemetry is on. The hover text and the object's description say the
// globe is measured, as the policy also asks. If the probe's /7 hash
// found your viewer reloads on a # change anyway, leave telemetry off.
//
// Channel 8 rather than the probe's 7, so one command never reaches both
// kinds of object at once.

// The TerraViz node the globe shows, with no slash at the end. Change it
// to test another node, or a preview build: the README says which address
// a preview has.
string  NODE = "https://terraviz.zyra-project.org";
integer CHAN = 8;
integer FACE = 0;              // a sphere has only face 0
integer UPRIGHT_ON_START = TRUE; // FALSE for a mesh globe with its own mapping
integer HOVER_TEXT = TRUE;     // say over the globe what it is showing

// Shared media is capped at 2048 pixels a side (indra/llprimitive/
// llmediaentry.h); a script asking for more gets a bounds error.
integer MEDIA_W = 2048;
integer MEDIA_H = 1024;

// Datasets /8 show knows by name: name, the node's id for it, what it is.
// The ids are terraviz.zyra-project.org's, and a preview build shares
// them. On another node, use that node's ids.
list PRESETS = [
    "hurricanes", "01KQG611HF8YXJNRBEHT0757KT", "Hurricane Season 2024 (video)",
    "sst",        "01KQG65ZW1JC7M27EQ1CYD8YZ7", "Sea Surface Temperature, real-time (video)",
    "smoke",      "01KYJDXB4909JWG8DP257D3D0Z", "Wildfire Smoke Forecast, United States (data video, one region)",
    "quakes",     "01KQG62M0Z3EC0T9EXFH1MVXDV", "Earthquakes 2001-2015 (video)",
    "lights",     "01KQG629957NPZN7NTW4VK6FW0", "Nighttime Lights (still image)"
];

// The page plays rates from 1/12 (0.0833...) to 12.8 and reads anything
// outside as 1 (docs/EMBED_URL_GRAMMAR.md). Held a little inside 1/12,
// because an address carries three decimal places and 0.083 would read
// as 1.
float   MIN_RATE = 0.084;
float   MAX_RATE = 12.8;

// The characters and length the page accepts in a dataset id.
string  ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
integer ID_MAX = 128;

// The most of the node's record read when checking a dataset: its first
// four fields (id, slug, title, format) are under 1 KB even for the
// longest slug and title the node accepts, and every byte read is held
// twice over while the reply is dealt with. The exhibit's globe script,
// which once had this check, ran out of memory in-world with replies in
// hand: its own, and the info script's records, since Second Life hands
// a web reply to every script in the prim with a handler for one.
integer CHECK_MAX = 1024;

// What the globe shows. The address is built from these alone.
string  gDataset;       // the node's dataset id, or "" for the live Earth
string  gTitle;         // its title, as the node gave it
float   gPos;           // seconds into the clip at the anchor
integer gAtS;           // the anchor, when gPos was current: Unix seconds
integer gAtMs;          // and milliseconds
float   gRate = 1.0;
integer gPaused;
float   gRotation;      // degrees east at the picture's centre, [0, 360)
integer gDebug;
integer gTelemetry;
integer gWidth = 2048;
integer gHash = TRUE;   // changes go after the #

float   gSpin;          // degrees a second, 0 for still
key     gReq;           // the dataset check in flight, if any
string  gReqId;         // the id it checks
string  gReqTitle;      // a preset's own description, if it was one

help()
{
    llOwnerSay("[globe] Commands on /" + (string)CHAN + ": show <name or id>, list, earth, pause, play, "
        + "jump <s or m:ss>, rate <speed>, rotation <degrees>, spin <degrees/s or off>, debug on|off, "
        + "width 1024|2048, telemetry on|off, steer hash|query, status, upright");
}

// Unix time from the region's clock, as [seconds, milliseconds].
// llGetUnixTime has no fraction, and an LSL float holds a Unix time only
// to the nearest couple of minutes, so the two parts stay integers, read
// from one llGetTimestamp so they cannot straddle a second. Correct until
// 2038, when Unix seconds outgrow an LSL integer.
list now()
{
    string ts = llGetTimestamp();   // 2026-10-24T18:06:29.482361Z
    integer y  = (integer)llGetSubString(ts, 0, 3);
    integer mo = (integer)llGetSubString(ts, 5, 6);
    integer d  = (integer)llGetSubString(ts, 8, 9);
    integer s  = (integer)llGetSubString(ts, 11, 12) * 3600
               + (integer)llGetSubString(ts, 14, 15) * 60
               + (integer)llGetSubString(ts, 17, 18);
    // Days since 1970-01-01 (Howard Hinnant's days_from_civil). A year
    // starts in March here, so a leap day falls at its end.
    integer mp = mo - 3;
    if (mo <= 2) { y -= 1; mp = mo + 9; }
    integer era = y / 400;
    integer yoe = y - era * 400;
    integer doy = (153 * mp + 2) / 5 + d - 1;
    integer days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    string frac = llList2String(llParseString2List(ts, [".", "Z"], []), 1) + "000";
    return [days * 86400 + s, (integer)llGetSubString(frac, 0, 2)];
}

// Seconds from the anchor to `t`, a now() reading.
float since(list t)
{
    return (float)(llList2Integer(t, 0) - gAtS) + (float)(llList2Integer(t, 1) - gAtMs) / 1000.0;
}

// Makes gPos the position as of now. Every visitor's page counts on from
// this moment by its own computer's clock. If the region's clock is off,
// every copy is off alike while playing, and the error shows only at a
// pause or a resume, as a jump of that error times the rate.
anchor()
{
    list t = now();
    gAtS = llList2Integer(t, 0);
    gAtMs = llList2Integer(t, 1);
}

// Moves the anchor to now, keeping the clip where it is: a playing clip
// has moved on since the last anchor.
reanchor()
{
    list t = now();
    if (!gPaused) gPos += since(t) * gRate;
    gAtS = llList2Integer(t, 0);
    gAtMs = llList2Integer(t, 1);
}

// Where the clip is now, unwrapped: the page wraps it round the clip,
// whose length only the page knows.
float position()
{
    if (gPaused) return gPos;
    return gPos + since(now()) * gRate;
}

// A plain decimal with at most three places, as the page reads numbers:
// no exponent, no padding. LSL's own (string) gives six places. A
// float's fraction coarsens as it grows, to about 8 ms once a clip has
// played for a day at full speed, which the page does not notice.
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

// Digits, at most one point, an optional leading minus.
integer isNumber(string s)
{
    if (llGetSubString(s, 0, 0) == "-") s = llDeleteSubString(s, 0, 0);
    integer n = llStringLength(s);
    if (n == 0 || n > 12) return FALSE;
    integer dots = 0;
    integer digits = 0;
    integer i;
    for (i = 0; i < n; ++i)
    {
        string c = llGetSubString(s, i, i);
        if (c == ".") ++dots;
        else if (llSubStringIndex("0123456789", c) == -1) return FALSE;
        else ++digits;
    }
    return (dots <= 1) && (digits > 0);
}

// The shape the page accepts for a dataset id.
integer isId(string s)
{
    integer n = llStringLength(s);
    if (n < 1 || n > ID_MAX) return FALSE;
    integer i;
    for (i = 0; i < n; ++i)
        if (llSubStringIndex(ID_CHARS, llGetSubString(s, i, i)) == -1) return FALSE;
    return TRUE;
}

// The output page's address for the current state.
// Before the #: the setup, fixed for the life of a page, so changing it
// reloads every copy. That is only fit=fill, which never changes, and
// telemetry, which the page must have when it loads, since it counts its
// minute from then. After it: everything a session changes. It always has something after the #,
// because a change from an address with one to an address without one is
// a reload, not a #-only change.
string address()
{
    string setup = "fit=fill";
    if (gTelemetry) setup += "&telemetry=1";
    list live = [];
    if (gDataset != "")
    {
        live += ["dataset=" + gDataset, "t=" + num(gPos)];
        if (gPaused) live += ["paused=1"];
        else
        {
            live += ["at=" + (string)gAtS + "." + llGetSubString((string)(1000 + gAtMs), 1, 3)];
            if (gRate != 1.0) live += ["rate=" + num(gRate)];
        }
    }
    live += ["width=" + (string)gWidth, "rotation=" + num(gRotation)];
    if (gDebug) live += ["debug=1"];
    string sep = "#";
    if (!gHash) sep = "&";
    return NODE + "/output/output?" + setup + sep + llDumpList2String(live, "&");
}

list snapshot()
{
    return [gDataset, gTitle, gPos, gAtS, gAtMs, gRate, gPaused, gRotation, gDebug, gTelemetry, gWidth, gHash];
}

restore(list s)
{
    gDataset = llList2String(s, 0);
    gTitle = llList2String(s, 1);
    gPos = llList2Float(s, 2);
    gAtS = llList2Integer(s, 3);
    gAtMs = llList2Integer(s, 4);
    gRate = llList2Float(s, 5);
    gPaused = llList2Integer(s, 6);
    gRotation = llList2Float(s, 7);
    gDebug = llList2Integer(s, 8);
    gTelemetry = llList2Integer(s, 9);
    gWidth = llList2Integer(s, 10);
    gHash = llList2Integer(s, 11);
}

// Puts the current state on the face, every setting every time: a face
// given only an address takes media's defaults for the rest, which let
// anyone click it, and the owner may have changed the face's media by
// hand. Sending the rest costs nothing, since the call sleeps the script
// for a second whatever it carries and a viewer navigates only when the
// address changed (llviewermedia.cpp).
// The media is not interactive for anyone, so no visitor's click can
// move it to another address: a viewer broadcasts such a navigation to
// everyone near the globe (docs/SECOND_LIFE_COMPAT.md section 7, item 4).
integer setMedia()
{
    string url = address();
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
        llOwnerSay("[globe] Second Life refused the media (status " + (string)r + "). The globe is unchanged.");
        return FALSE;
    }
    return TRUE;
}

// A title cut to a length every message it goes in can hold: a node's
// titles run to 200 characters, and at three bytes each that pushes the
// rest of a hover text or a chat line past its limit.
string shorten(string title)
{
    if (llStringLength(title) <= 100) return title;
    return llGetSubString(title, 0, 96) + "...";
}

// What a visitor sees over the globe and in its description. The
// description carries the telemetry notice whether or not the hover text
// is on.
describe()
{
    string what = "The live Earth: today's clouds and the real day and night";
    if (gDataset != "") what = shorten(gTitle);
    string desc = "TerraViz globe: " + what;
    if (gTelemetry) desc = "TerraViz globe. Counts anonymous use: " + NODE + "/privacy";
    llSetObjectDesc(llGetSubString(desc, 0, 126));
    if (!HOVER_TEXT) { llSetText("", ZERO_VECTOR, 0.0); return; }
    // The notice comes before the title: hover text stops at 254 bytes.
    string s = "TerraViz globe\n";
    if (gTelemetry) s += "This globe counts anonymous use: " + NODE + "/privacy\n";
    llSetText(s + what, <1.0, 1.0, 1.0>, 1.0);
}

// Applies a change already made to the state, or puts the state back if
// Second Life refuses it, so a refused change leaves state and globe
// agreeing.
integer commit(list saved)
{
    if (!setMedia()) { restore(saved); return FALSE; }
    describe();
    llOwnerSay("[globe] Address: " + address());
    return TRUE;
}

// Stops a spin and lines every viewer up again. The spin is drawn by each
// viewer, and outlives a reset since it belongs to the prim. A viewer
// drops the turn it has drawn only when an update brings a rotation
// different from the last one the region sent, and the region's rotation
// never moved, so setting it again alone changes nothing on screen. A
// small turn first, then the real rotation, are two different updates.
// From the viewer's source (llviewerobject.cpp); not yet seen in-world.
// Local rotation, so a globe linked to a stand is set back where it was
// rather than turned by the stand's rotation, and a pause between the two
// so a busy region does not fold them into one update.
stopSpin()
{
    rotation rest = llGetLocalRot();
    llTargetOmega(ZERO_VECTOR, 0.0, 0.0);
    llSetLocalRot(rest * llAxisAngle2Rot(<0.0, 0.0, 1.0>, 0.01));
    llSleep(0.5);
    llSetLocalRot(rest);
    gSpin = 0.0;
}

// The spin axis is the region's vertical, since llTargetOmega spins a
// root prim about region axes, and upright() stands the poles on it.
upright()
{
    stopSpin();
    // A default sphere has its poles on its local X axis and wraps its
    // texture pole to pole, so a world map lands sideways. Turning -90
    // degrees about Y carries local X to world up; the texture turns 90.
    llSetRot(llEuler2Rot(<0.0, -PI_BY_TWO, 0.0>));
    llRotateTexture(PI_BY_TWO, FACE);
    llScaleTexture(1.0, 1.0, FACE);
    llOffsetTexture(0.0, 0.0, FACE);
}

// Asks the node for the dataset before showing it: a mistyped id is
// caught here rather than turning every visitor's globe to the live Earth.
// FALSE if Second Life wouldn't send the request.
integer check(string id, string described)
{
    // Only the start of the reply is read, since a whole record can run
    // past 12 KB, which would cost this script twice that in memory. This
    // node's serializer puts id, slug, title and format first, and
    // dataset-serializer.test.ts holds it to that for this script's sake;
    // the order is not part of the published contract.
    key req = llHTTPRequest(NODE + "/api/v1/datasets/" + id, [HTTP_BODY_MAXLENGTH, CHECK_MAX], "");
    if (req == NULL_KEY)
    {
        // Any earlier /8 show still waiting is dropped too, or it would
        // land after the owner was told to try again.
        gReq = NULL_KEY;
        llOwnerSay("[globe] Second Life is limiting this object's web requests. Try again in a minute.");
        return FALSE;
    }
    gReq = req;
    gReqId = id;
    gReqTitle = described;
    return TRUE;
}

show(string id, string title)
{
    list saved = snapshot();
    gDataset = id;
    gTitle = title;
    if (gTitle == "") gTitle = id;
    gPos = 0.0;
    gRate = 1.0;
    gPaused = FALSE;
    anchor();
    if (commit(saved)) llOwnerSay("[globe] Showing " + gTitle + " from its start, at its own speed.");
}

default
{
    state_entry()
    {
        llListen(CHAN, "", llGetOwner(), "");
        while (llGetSubString(NODE, -1, -1) == "/") NODE = llDeleteSubString(NODE, -1, -1);
        if (llGetObjectName() == "Object") llSetObjectName("TerraViz globe");
        if (UPRIGHT_ON_START) upright();
        else stopSpin();
        anchor();
        if (setMedia())
        {
            describe();
            llOwnerSay("[globe] Showing the live Earth from " + NODE + ". Address: " + address());
        }
        help();
    }

    on_rez(integer p) { llResetScript(); }

    changed(integer c)
    {
        if (c & CHANGED_OWNER) llResetScript();
    }

    touch_start(integer n)
    {
        // A left-click never gets here: a viewer hands a click on a face
        // with media to the media (lltoolpie.cpp). Right-click and Touch
        // does. The link goes in the chat text, where viewers make it
        // clickable, since llLoadURL would sleep the script ten seconds a
        // touch and hold up the owner's commands.
        string what = "the live Earth, with today's clouds and the real day and night";
        string url = NODE + "/";
        if (gDataset != "")
        {
            what = shorten(gTitle);
            url = NODE + "/?dataset=" + gDataset;
        }
        // Each link ends its line, so no punctuation joins the link, and
        // the notice comes before the title, so a chat line cut at its
        // limit loses the title's end rather than the notice.
        string say = "This globe is TerraViz, a free, open-source globe for Earth data, most of it from "
            + "NOAA's Science On a Sphere collection.";
        if (gTelemetry) say += "\nThis globe counts anonymous use: " + NODE + "/privacy";
        say += "\nIt is showing " + what + ".\nExplore it in your web browser: " + url;
        integer i;
        for (i = 0; i < n; ++i) llRegionSayTo(llDetectedKey(i), 0, say);
    }

    listen(integer ch, string name, key id, string msg)
    {
        list w = llParseString2List(llStringTrim(msg, STRING_TRIM), [" "], []);
        string cmd = llToLower(llList2String(w, 0));
        string arg = llList2String(w, 1);   // case kept: dataset ids are case-sensitive
        string larg = llToLower(arg);
        list saved = snapshot();

        if (cmd == "help") { help(); return; }
        if (cmd == "list")
        {
            integer i;
            for (i = 0; i < llGetListLength(PRESETS); i += 3)
                llOwnerSay("[globe] /" + (string)CHAN + " show " + llList2String(PRESETS, i) + " - "
                    + llList2String(PRESETS, i + 2));
            llOwnerSay("[globe] Or /" + (string)CHAN + " show <id>, with any dataset id from the node's catalog.");
            return;
        }
        if (cmd == "show")
        {
            if (arg == "") { llOwnerSay("[globe] Show what? /" + (string)CHAN + " list names a few."); return; }
            string dataset = arg;
            string described = "";
            integer at = llListFindList(PRESETS, [larg]);
            // A name sits at a multiple of three; an id or description elsewhere is not one.
            if (at != -1 && at % 3 == 0)
            {
                dataset = llList2String(PRESETS, at + 1);
                described = llList2String(PRESETS, at + 2);
            }
            else if (!isId(arg))
            {
                llOwnerSay("[globe] \"" + arg + "\" is neither a name from /" + (string)CHAN
                    + " list nor a dataset id. Ids are letters, digits, - and _.");
                return;
            }
            if (check(dataset, described)) llOwnerSay("[globe] Asking the node about " + dataset + "...");
            return;
        }
        if (cmd == "earth")
        {
            gDataset = "";
            gTitle = "";
            gPaused = FALSE;
            if (!commit(saved)) return;
            gReq = NULL_KEY;   // a /8 show still waiting on the node is overtaken
            llOwnerSay("[globe] Back to the live Earth.");
            return;
        }
        if (cmd == "pause" || cmd == "play" || cmd == "jump" || cmd == "rate")
        {
            if (gDataset == "")
            {
                llOwnerSay("[globe] The live Earth follows the real clock, so there is nothing to " + cmd
                    + ". Show a dataset first.");
                return;
            }
        }
        if (cmd == "pause")
        {
            if (gPaused) { llOwnerSay("[globe] Already paused."); return; }
            reanchor();
            gPaused = TRUE;
            if (commit(saved)) llOwnerSay("[globe] Paused at " + num(gPos) + " s. Every visitor holds this frame.");
            return;
        }
        if (cmd == "play")
        {
            if (!gPaused) { llOwnerSay("[globe] Already playing."); return; }
            gPaused = FALSE;
            anchor();
            if (commit(saved)) llOwnerSay("[globe] Playing from " + num(gPos) + " s.");
            return;
        }
        if (cmd == "jump")
        {
            float to = -1.0;
            list mmss = llParseString2List(arg, [":"], []);
            if (llGetListLength(mmss) == 2 && isNumber(llList2String(mmss, 0)) && isNumber(llList2String(mmss, 1)))
                to = llList2Float(mmss, 0) * 60.0 + llList2Float(mmss, 1);
            else if (isNumber(arg)) to = (float)arg;
            if (to < 0.0 || to > 100000.0)
            {
                llOwnerSay("[globe] Jump to where? Seconds into the clip, like 90, or minutes and seconds, like 1:30.");
                return;
            }
            gPos = to;
            anchor();
            if (commit(saved)) llOwnerSay("[globe] At " + num(gPos) + " s, " + llList2String(["playing.", "paused."], gPaused)
                + " Past the clip's end, the page wraps round it.");
            return;
        }
        if (cmd == "rate")
        {
            // Rounded to what the address will carry, so the script times
            // the clip at the rate every copy plays it.
            float r = -1.0;
            if (isNumber(arg)) r = (float)num((float)arg);
            if (r < MIN_RATE || r > MAX_RATE)
            {
                llOwnerSay("[globe] A rate from " + num(MIN_RATE) + " to " + num(MAX_RATE) + ", where 1 is the clip's own speed.");
                return;
            }
            reanchor();
            gRate = r;
            if (commit(saved)) llOwnerSay("[globe] Rate " + num(gRate) + ".");
            return;
        }
        if (cmd == "rotation")
        {
            if (!isNumber(arg) || llFabs((float)arg) > 3600.0)
            {
                llOwnerSay("[globe] Rotation in degrees east, from -3600 to 3600, like 90 or -75.");
                return;
            }
            float r = (float)arg;
            r = (float)num(r - 360.0 * (float)llFloor(r / 360.0));
            if (r >= 360.0) r = 0.0;
            gRotation = r;
            if (commit(saved)) llOwnerSay("[globe] " + num(gRotation) + " degrees east is at the centre of the picture.");
            return;
        }
        if (cmd == "spin")
        {
            float rate = (float)arg;
            if (larg == "off" || (isNumber(arg) && rate == 0.0))
            {
                stopSpin();
                llOwnerSay("[globe] Spin off.");
                return;
            }
            if (!isNumber(arg) || llFabs(rate) > 90.0)
            {
                llOwnerSay("[globe] Spin in degrees a second, up to 90, like 6 for a turn a minute, or off.");
                return;
            }
            gSpin = rate;
            llTargetOmega(<0.0, 0.0, 1.0>, gSpin * DEG_TO_RAD, 1.0);
            llOwnerSay("[globe] Spinning at " + num(gSpin) + " degrees a second. Each viewer draws the spin "
                + "for itself, so visitors don't all see the same side at once. Leave it off when someone "
                + "will point at a place.");
            return;
        }
        if (cmd == "debug")
        {
            if (larg != "on" && larg != "off") { llOwnerSay("[globe] debug on, or debug off."); return; }
            gDebug = (larg == "on");
            if (commit(saved)) llOwnerSay("[globe] Debug readout " + larg + ".");
            return;
        }
        if (cmd == "width")
        {
            if (arg != "1024" && arg != "2048") { llOwnerSay("[globe] width 1024, or width 2048."); return; }
            gWidth = (integer)arg;
            if (commit(saved)) llOwnerSay("[globe] Width " + arg + ". The picture changes size at once, and the "
                + "video's resolution follows at the next dataset.");
            return;
        }
        if (cmd == "telemetry")
        {
            if (larg != "on" && larg != "off") { llOwnerSay("[globe] telemetry on, or telemetry off."); return; }
            if (larg == "on" && !gHash)
            {
                llOwnerSay("[globe] Not while changes go before the #: each would reload every visitor's page, "
                    + "and each reload reports again as a new visit. Say /" + (string)CHAN + " steer hash first.");
                return;
            }
            gTelemetry = (larg == "on");
            if (!commit(saved)) return;
            if (gTelemetry)
            {
                string where = "The object's description now says so";
                if (HOVER_TEXT) where = "The hover text and the object's description now say so";
                llOwnerSay("[globe] Telemetry on. In the first minute after each visitor's page loads, it reports "
                    + "anonymously which dataset it showed and anything that failed, then nothing more. A viewer "
                    + "that sends Global Privacy Control reports nothing. " + where + ", as the policy asks: "
                    + NODE + "/privacy. Every visitor's page reloaded to pick this up. Change only what comes "
                    + "after the # from here on, which every other command does.");
            }
            else
                llOwnerSay("[globe] Telemetry off. Every visitor's page reloaded to pick this up.");
            return;
        }
        if (cmd == "steer")
        {
            if (larg != "hash" && larg != "query") { llOwnerSay("[globe] steer hash, or steer query."); return; }
            if (larg == "query" && gTelemetry)
            {
                llOwnerSay("[globe] Not while telemetry is on: each change would reload every visitor's page, and "
                    + "each reload reports again as a new visit. Say /" + (string)CHAN + " telemetry off first.");
                return;
            }
            gHash = (larg == "hash");
            if (!commit(saved)) return;
            if (gHash)
                llOwnerSay("[globe] Changes now go after the #, which a browser applies without a reload.");
            else
                llOwnerSay("[globe] Changes now go before the #, so each one reloads every visitor's page: the "
                    + "globe shows the plain live Earth for a few seconds, then the same moment. For viewers that "
                    + "reload on a # change anyway.");
            return;
        }
        if (cmd == "status")
        {
            string what = "the live Earth";
            if (gDataset != "")
                what = gTitle + " at " + num(position()) + " s, " + llList2String(["playing", "paused"], gPaused)
                    + ", rate " + num(gRate);
            llOwnerSay("[globe] Showing " + what + ". Spin " + num(gSpin) + " degrees a second. Address: " + address());
            return;
        }
        if (cmd == "upright")
        {
            upright();
            llOwnerSay("[globe] Poles upright, texture turned 90 degrees, spin off.");
            return;
        }
        help();
    }

    http_response(key id, integer status, list meta, string body)
    {
        if (id != gReq) return;   // overtaken by a later /8 show, or by /8 earth
        gReq = NULL_KEY;
        if (status == 404)
        {
            llOwnerSay("[globe] The node has no dataset " + gReqId + ". The globe is unchanged.");
            return;
        }
        string title = "";
        if (status == 200 && llGetSubString(body, 0, 0) != "{")
            // Bot protection or a node whose app answers every path.
            llOwnerSay("[globe] The node answered with a web page rather than the dataset's record, so "
                + gReqId + " couldn't be checked. Showing it anyway. If it won't load, every visitor's "
                + "globe shows the live Earth.");
        else if (status == 200)
        {
            // The record is cut short, so it is not JSON as a whole. Its
            // first three fields are, closed off before "format".
            integer f = llSubStringIndex(body, ",\"format\":\"");
            if (f > 0)
            {
                title = llJsonGetValue(llGetSubString(body, 0, f - 1) + "}", ["title"]);
                if (title == JSON_INVALID || title == JSON_NULL) title = "";
                string rest = llGetSubString(body, f + 11, f + 60);
                integer q = llSubStringIndex(rest + "\"", "\"");
                string format = "";
                if (q > 0) format = llGetSubString(rest, 0, q - 1);
                // The page shows only images and videos, and refuses the
                // rest without retrying, which would leave every visitor's
                // globe on the live Earth.
                if (llSubStringIndex(format, "image/") != 0 && llSubStringIndex(format, "video/") != 0)
                {
                    string kind = "is in the format \"" + format + "\"";
                    if (format == "") kind = "has no format";
                    if (llSubStringIndex(format, "tour/") == 0) kind = "is a tour, which drives the full app";
                    llOwnerSay("[globe] " + gReqId + " " + kind + ". A globe shows only images and videos. "
                        + "The globe is unchanged.");
                    return;
                }
            }
            else
                llOwnerSay("[globe] Couldn't read " + gReqId + "'s format from the node's reply, so it couldn't be "
                    + "checked. Showing it anyway. If it won't load, every visitor's globe shows the live Earth.");
        }
        else
            llOwnerSay("[globe] Couldn't check " + gReqId + " with the node (HTTP " + (string)status + "). "
                + "Showing it anyway. If it won't load, every visitor's globe shows the live Earth.");
        if (title == "") title = gReqTitle;
        show(gReqId, title);
    }
}
