// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// TerraViz exhibit globe - the globe script.
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
// It is one of three scripts that make a sphere a TerraViz exhibit: a
// globe that stays up all the time, that anyone who walks up can use, and
// that a presenter can take over for a talk.
//   terraviz-exhibit.lsl           this one: what the globe shows
//   terraviz-exhibit-visitors.lsl  touches, menus, talks, who is nearby
//   terraviz-exhibit-info.lsl      the floating text, and "About"
// All three go in the sphere's Content tab.
//
// The sphere's surface shows TerraViz's output page: a web page that
// draws the whole Earth unwrapped into a flat 2:1 picture, which Second
// Life wraps round the sphere. Every visitor's viewer loads that page for
// itself, so the page is told what to show by its address alone: which
// dataset, where in its animation, and whether it is paused. Every copy
// reads the same address, so everyone at the globe sees the same moment.
// This script is the only one that sets that address. The visitors script
// asks it for changes, as the info script does to put back a dataset the
// page can't show, and it tells the other two what the globe shows after
// each one.
//
// Changes go after the address's #, which a web browser applies without
// reloading the page. Firestorm 7.2.4 was seen to do the same in-world.
// If your viewer reloads on a # change (the probe kit's /7 hash tells
// you), "/9 steer query" puts every change before the # instead, which
// always reloads: the globe shows the plain live Earth for a few seconds,
// then the same moment.
//
// MORE
//   Setting up the exhibit, step by step:
//     https://github.com/zyra-project/terraviz/blob/main/scripts/second-life-exhibit/README.md
//   The Second Life plan, and what was tested in-world:
//     https://github.com/zyra-project/terraviz/blob/main/docs/SECOND_LIFE_COMPAT.md
//   Everything the output page's address can say:
//     https://github.com/zyra-project/terraviz/blob/main/docs/EMBED_URL_GRAMMAR.md#the-output-page--a-globes-texture
//   What "/9 telemetry on" sends:
//     https://terraviz.zyra-project.org/privacy
//
// COMMANDS, said on channel 9 by the owner. Visitors use the touch menu.
//   /9 show <name or id>   a dataset, playing from its start
//   /9 list                the names /9 show knows
//   /9 earth               back to the live Earth
//   /9 pause, /9 play      every visitor stops on, or starts from, the same frame
//   /9 jump <s or m:ss>    go to that point in the clip, paused or playing
//   /9 rate <speed>        0.084 to 12.8; 1 is the clip's own speed
//   /9 rotation <degrees>  the longitude at the centre of the picture, east, and
//                          where the globe goes back to once visitors leave
//   /9 turn <degrees>      turn the globe that far east, as the Earth turns; minus is
//                          west. Visitors' Turn east and Turn west buttons do this.
//   /9 spin <degrees/s>    turn the whole sphere; /9 spin off stops it
//   /9 debug on|off        TerraViz's diagnostic readout, drawn on the globe
//   /9 width 1024|2048     the picture's resolution
//   /9 telemetry on|off    anonymous counts (reloads every visitor's page)
//   /9 steer hash|query    where changes go in the address (see above)
//   /9 status              the current address and state
//   /9 tilt south|north    tip the sphere 30 degrees so that pole comes round toward
//                          you, until it faces you. Visitors' "South Pole to me" and
//                          "North Pole to me" buttons do this.
//   /9 level               stand a tilted sphere back as it was
//   /9 home                make the sphere's rotation now its rest, which a reset keeps
//   /9 upright             stand the poles upright again
//   /9 memory              each of the three scripts says how much of its 64 KB it uses
// The visitors script answers /9 talk and /9 presenters too.
//
// TELEMETRY
// "/9 telemetry on" has each visitor's page report, anonymously and only
// in the first minute after it loads, which dataset it showed and
// anything that failed. Every reload reports again as a new visit, so the
// privacy policy asks the owner of a measured globe to change only what
// comes after the #: this script refuses "/9 steer query" while telemetry
// is on. The floating text and the object's description say the globe is
// measured, as the policy also asks.
//
// Channel 9 rather than the smoke-test globe's 8 or the probe's 7, so one
// command never reaches two kinds of object at once.

// The TerraViz node the globe shows, with no slash at the end. The other
// two scripts take it from this one.
string  NODE = "https://terraviz.zyra-project.org";
integer CHAN = 9;
integer FACE = 0;              // a sphere has only face 0
integer UPRIGHT_ON_START = TRUE; // FALSE for a mesh globe with its own mapping

// The link messages the three scripts share. The numbers are arbitrary;
// all three must agree, and exhibit.test.ts holds them to it.
integer MSG_STATE   = 271001;  // globe to all: what the globe shows, as JSON
integer MSG_CONTROL = 271002;  // visitors or info to globe: a control, for the key who asked
integer MSG_HELLO   = 271003;  // any to globe: say the state again (a script reset)

// Shared media is capped at 2048 pixels a side (indra/llprimitive/
// llmediaentry.h); a script asking for more gets a bounds error.
integer MEDIA_W = 2048;
integer MEDIA_H = 1024;

// Datasets /9 show knows by name: name, the node's id for it, what it is.
// The touch menu takes its own list from the "datasets" notecard. The ids
// are terraviz.zyra-project.org's, and a preview build shares them.
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

// How far the visitors' back and forward buttons move, in seconds.
float   NUDGE_MAX = 600.0;

// The characters and length the page accepts in a dataset id.
string  ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
integer ID_MAX = 128;

// What the globe shows. The address is built from these alone.
string  gDataset;       // the node's dataset id, or "" for the live Earth
string  gTitle;         // its title, as the node gave it
float   gPos;           // seconds into the clip at the anchor
integer gAtS;           // the anchor, when gPos was current: Unix seconds
integer gAtMs;          // and milliseconds
float   gRate = 1.0;
integer gPaused;
float   gRotation;      // degrees east at the picture's centre, [0, 360)
float   gHome;          // the owner's rotation, which a visitor's turn doesn't outlast
rotation gHomeRot;      // the sphere's own rotation at rest, upright, in its build
vector  gNorth;         // its north pole, in its own axes: the one up at rest
integer gTilted;        // a tilt has tipped it from gHomeRot
float   TILT = 30.0;    // degrees a tilt tips it
float   gOwnerSpin;     // the owner's /9 spin, which the idle return brings back
string  HOME_KEY = "terraviz:home";   // where the rest is kept, in the object, across resets
integer gDebug;
integer gTelemetry;
integer gWidth = 2048;
integer gHash = TRUE;   // changes go after the #

float   gSpin;          // degrees a second, 0 for still
integer gPeak;          // the most memory used while showing a dataset
key     gBy = NULL_KEY; // who chose a dataset, or paused, played or moved the clip, for the next broadcast

help()
{
    llOwnerSay("[exhibit] Commands on /" + (string)CHAN + ": show <name or id>, list, earth, pause, play, "
        + "jump <s or m:ss>, rate <speed>, rotation <degrees>, turn <degrees east>, tilt south|north, level, home, spin <degrees/s or off>, debug on|off, "
        + "width 1024|2048, telemetry on|off, steer hash|query, status, upright, memory, talk, presenters");
}

// Tells whoever asked. The owner hears it privately wherever they are; a
// visitor in their own chat, which nobody else at the globe sees; and a
// request the scripts made themselves, such as the return to the live
// Earth, tells nobody.
tell(key who, string msg)
{
    if (who == NULL_KEY) return;
    if (who == llGetOwner()) llOwnerSay("[exhibit] " + msg);
    else llRegionSayTo(who, 0, msg);
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
// whose length only the page and the manifest know.
float position()
{
    if (gPaused) return gPos;
    return gPos + since(now()) * gRate;
}

// An angle in [0, 360), at the three places the address carries.
float degrees(float r)
{
    r = (float)num(r - 360.0 * (float)llFloor(r / 360.0));
    if (r >= 360.0) r = 0.0;
    return r;
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

// Seconds from "90" or "1:30", or -1 for anything else.
float seconds(string arg)
{
    list mmss = llParseString2List(arg, [":"], []);
    if (llGetListLength(mmss) == 2 && isNumber(llList2String(mmss, 0)) && isNumber(llList2String(mmss, 1)))
        return llList2Float(mmss, 0) * 60.0 + llList2Float(mmss, 1);
    if (isNumber(arg)) return (float)arg;
    return -1.0;
}

// The output page's address for the current state.
// Before the #: the setup, fixed for the life of a page, so changing it
// reloads every copy. That is only fit=fill, which never changes, and
// telemetry, which the page must have when it loads, since it counts its
// minute from then. After it: everything a session changes. It always has
// something after the #, because a change from an address with one to an
// address without one is a reload, not a #-only change.
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

// Tells the other two scripts what the globe shows. The info script times
// the date from the clip's anchor, so it gets the anchor itself rather
// than a position that would be stale on arrival. After a pause, a play or
// a move, the key is whoever asked, and the info script answers them with
// the date the globe now shows, which this script doesn't know. "turned"
// is anything the idle return puts back: the owner's rotation, an upright
// sphere, and the owner's spin, which a tilt ends and Upright again
// doesn't restart.
broadcast()
{
    llMessageLinked(LINK_THIS, MSG_STATE, llList2Json(JSON_OBJECT, [
        "dataset", gDataset, "title", gTitle,
        "pos", gPos, "atS", gAtS, "atMs", gAtMs, "rate", gRate, "paused", gPaused,
        "telemetry", gTelemetry, "turned", gRotation != gHome || gTilted || gSpin != gOwnerSpin,
        "node", NODE]), gBy);
    gBy = NULL_KEY;
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
// The touch menu is the only way in.
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
        llOwnerSay("[exhibit] Second Life refused the media (status " + (string)r + "). The globe is unchanged.");
        return FALSE;
    }
    return TRUE;
}

// A title cut to a length every message it goes in can hold: a node's
// titles run to 200 characters, and at three bytes each that pushes the
// rest of a chat line past its limit.
string shorten(string title)
{
    if (llStringLength(title) <= 100) return title;
    return llGetSubString(title, 0, 96) + "...";
}

// The object's description, which a visitor sees on hover in some viewers
// and in the object's profile. It carries the telemetry notice whether or
// not the floating text is up. The floating text is the info script's.
describe()
{
    string what = "the live Earth";
    if (gDataset != "") what = shorten(gTitle);
    string desc = "TerraViz globe: " + what;
    if (gTelemetry) desc = "TerraViz globe. Counts anonymous use: " + NODE + "/privacy";
    llSetObjectDesc(llGetSubString(desc, 0, 126));
}

// Applies a change already made to the state, or puts the state back if
// Second Life refuses it, so a refused change leaves state and globe
// agreeing.
integer commit(list saved)
{
    if (!setMedia()) { restore(saved); gBy = NULL_KEY; return FALSE; }
    describe();
    broadcast();
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

// The sphere's rotation in the region, set so it works whether the sphere
// stands alone or is a child prim of a build: llSetRot on a child prim
// lands wrong unless the root is unrotated. As the root of a build,
// turning the sphere turns the build, so the scripts belong in the sphere
// and the sphere in a build is a child.
setRot(rotation global)
{
    if (llGetLinkNumber() > 1) llSetLocalRot(global / llGetRootRotation());
    else llSetRot(global);
}

// The rotation the sphere rests at, and which of its own axes is its
// north pole: the one pointing up at rest, which for a default sphere
// upright() puts there, and for a mesh globe is its own. The rest is kept
// in its build's frame, so turning the whole build keeps it, and written
// into the object, so a reset while it is tilted doesn't take the tilt
// for the rest.
home()
{
    gHomeRot = llGetLocalRot();
    gNorth = <0.0, 0.0, 1.0> / llGetRot();
    gTilted = FALSE;
    llLinksetDataWrite(HOME_KEY, (string)gHomeRot);
}

level()
{
    llSetLocalRot(gHomeRot);
    gTilted = FALSE;
}

// Tips the sphere a step about a level axis, so that one pole comes round
// toward the avatar who asked, and no further than facing them: three
// steps from upright put it on the equator in front of them. The region
// sends the rotation to every viewer, so all see the same angle, unlike
// a spin, which each draws for itself and which a tilt therefore ends.
// FALSE if it can't tell where they are, 2 if the pole already faces them.
integer tilt(key who, integer south)
{
    list d = llGetObjectDetails(who, [OBJECT_POS]);
    if (d == []) return FALSE;
    vector to = llList2Vector(d, 0) - llGetPos();
    to.z = 0.0;
    if (llVecMag(to) < 0.01) return FALSE;
    to = llVecNorm(to);
    if (gSpin != 0.0) stopSpin();
    rotation r = llGetRot();
    vector pole = gNorth * r;
    if (south) pole = -pole;
    float c = pole * to;
    if (c > 1.0) c = 1.0;
    if (c < -1.0) c = -1.0;
    float angle = llAcos(c);
    if (angle < 0.01) return 2;
    float step = TILT * DEG_TO_RAD;
    if (step > angle) step = angle;
    // About pole x to, which carries the pole toward them; for a pole
    // pointing straight away, over the top instead.
    vector axis = pole % to;
    if (llVecMag(axis) < 0.001) axis = pole % <0.0, 0.0, 1.0>;
    setRot(r * llAxisAngle2Rot(llVecNorm(axis), step));
    gTilted = TRUE;
    return TRUE;
}

// The spin axis is the region's vertical, since llTargetOmega spins a
// root prim about region axes, and upright() stands the poles on it.
upright()
{
    stopSpin();
    // A default sphere has its poles on its local X axis and wraps its
    // texture pole to pole, so a world map lands sideways. Turning -90
    // degrees about Y carries local X to world up; the texture turns 90.
    setRot(llEuler2Rot(<0.0, -PI_BY_TWO, 0.0>));
    llRotateTexture(PI_BY_TWO, FACE);
    llScaleTexture(1.0, 1.0, FACE);
    llOffsetTexture(0.0, 0.0, FACE);
}

show(key who, string id, string title)
{
    // Measured, for /9 memory: this script runs close to its 64 KB, and
    // showing a dataset is when it needs the most.
    llScriptProfiler(PROFILE_SCRIPT_MEMORY);
    list saved = snapshot();
    gDataset = id;
    gTitle = title;
    if (gTitle == "") gTitle = id;
    gPos = 0.0;
    gRate = 1.0;
    gPaused = FALSE;
    anchor();
    // A new choice names its chooser, whom the info script tells if the
    // page can't show it. The same dataset again is only a restart.
    if (llList2String(saved, 0) != id) gBy = who;
    if (!commit(saved)) tell(who, "The globe couldn't change just now. Try again in a moment.");
    else if (who == llGetOwner()) tell(who, "Showing " + gTitle + " from its start, at its own speed. Address: " + address());
    else tell(who, "Showing " + shorten(gTitle) + " for everyone at the globe.");
    llScriptProfiler(PROFILE_NONE);
    if (llGetSPMaxMemory() > gPeak) gPeak = llGetSPMaxMemory();
}

// One command, from the owner's chat or a visitor's menu. A visitor
// reaches only the commands the touch menu offers; everything else is
// the owner's. Who may act at all is the visitors script's to decide.
act(key who, integer owner, string msg)
{
    list w = llParseString2List(llStringTrim(msg, STRING_TRIM), [" "], []);
    string cmd = llToLower(llList2String(w, 0));
    string arg = llList2String(w, 1);   // case kept: dataset ids are case-sensitive
    string larg = llToLower(arg);
    list saved = snapshot();

    if (cmd == "show")
    {
        if (arg == "") { tell(who, "Show what? /" + (string)CHAN + " list names a few."); return; }
        string dataset = arg;
        // The menu sends its own name for the dataset after the id, so a
        // title the node can't give still reads as the menu said.
        // (A list of two would come back whole: llList2List's range runs
        // backwards there, and a backwards range means everything outside it.)
        string described = "";
        if (llGetListLength(w) > 2) described = llDumpList2String(llList2List(w, 2, -1), " ");
        integer at = llListFindList(PRESETS, [larg]);
        // A name sits at a multiple of three; an id or description elsewhere is not one.
        if (at != -1 && at % 3 == 0)
        {
            dataset = llList2String(PRESETS, at + 1);
            described = llList2String(PRESETS, at + 2);
        }
        else if (!isId(arg))
        {
            if (owner) tell(who, "\"" + arg + "\" is neither a name from /" + (string)CHAN
                + " list nor a dataset id. Ids are letters, digits, - and _.");
            else
            {
                tell(who, "That dataset isn't available right now. The globe is unchanged.");
                llOwnerSay("[exhibit] A visitor chose \"" + arg + "\" from the menu, which isn't a dataset id.");
            }
            return;
        }
        // Shown at once. The info script reads the record next and puts
        // the globe back on the live Earth if the node has no such
        // dataset or it is a tour; this script holds no reply of its own.
        show(who, dataset, described);
        return;
    }
    // "rest" is the visitors script's own return, once nobody has been at
    // the globe for a while: the live Earth, turned back to the owner's
    // rotation. Only the scripts send it, with no key. The info script's
    // "earth" names the dataset the page can't show, and is set aside
    // once the globe has gone on to another.
    if (cmd == "earth" && who == NULL_KEY && arg != "" && arg != gDataset) return;
    if (cmd == "earth" || (cmd == "rest" && who == NULL_KEY))
    {
        gDataset = "";
        gTitle = "";
        gPaused = FALSE;
        if (cmd == "rest")
        {
            gRotation = gHome;
            if (gTilted) level();
            // The owner's spin, which a visitor's tilt ended, comes back.
            if (gOwnerSpin != 0.0 && gSpin == 0.0 && !gTilted)
            {
                gSpin = gOwnerSpin;
                llTargetOmega(<0.0, 0.0, 1.0>, gSpin * DEG_TO_RAD, 1.0);
            }
        }
        if (!commit(saved)) { tell(who, "The globe couldn't change just now."); return; }
        tell(who, "Back to the live Earth.");
        return;
    }
    if (cmd == "pause" || cmd == "play" || cmd == "jump" || cmd == "nudge" || cmd == "restart" || cmd == "rate")
    {
        if (gDataset == "")
        {
            tell(who, "The live Earth follows the real clock, so there is nothing to " + cmd + ". Show a dataset first.");
            return;
        }
    }
    if (cmd == "pause")
    {
        if (gPaused) { tell(who, "Already paused."); return; }
        reanchor();
        gPaused = TRUE;
        gBy = who;
        commit(saved);
        return;
    }
    if (cmd == "play")
    {
        if (!gPaused) { tell(who, "Already playing."); return; }
        gPaused = FALSE;
        anchor();
        gBy = who;
        commit(saved);
        return;
    }
    if (cmd == "jump" || cmd == "restart" || cmd == "nudge")
    {
        float to = 0.0;
        if (cmd == "jump")
        {
            to = seconds(arg);
            if (to < 0.0 || to > 100000.0)
            {
                tell(who, "Jump to where? Seconds into the clip, like 90, or minutes and seconds, like 1:30.");
                return;
            }
        }
        else if (cmd == "nudge")
        {
            if (!isNumber(arg) || llFabs((float)arg) > NUDGE_MAX) { tell(who, "Nudge by how many seconds?"); return; }
            // From where the clip is now, never before its start. Past its
            // end the page wraps round it.
            to = position() + (float)arg;
            if (to < 0.0) to = 0.0;
        }
        gPos = to;
        anchor();
        gBy = who;
        commit(saved);
        return;
    }
    if (cmd == "tilt")
    {
        if (larg != "south" && larg != "north") { tell(who, "Tilt which pole toward you, south or north?"); return; }
        string pole = llList2String(["North", "South"], larg == "south");
        integer moved = tilt(who, larg == "south");
        if (!moved) { tell(who, "The globe couldn't tell where you are."); return; }
        if (moved == 2) { tell(who, "The " + pole + " Pole already faces you."); return; }
        broadcast();
        tell(who, "Tilted. The " + pole + " Pole is coming round toward you.");
        return;
    }
    if (cmd == "level")
    {
        if (!gTilted) { tell(who, "The globe is already upright."); return; }
        level();
        broadcast();
        tell(who, "Upright again.");
        return;
    }
    if (cmd == "turn")
    {
        // Degrees east, the way the Earth turns, so the places facing a
        // visitor move to their right. The picture's centre then shows a
        // longitude that far west.
        if (!isNumber(arg) || llFabs((float)arg) > 360.0) { tell(who, "Turn by how many degrees east?"); return; }
        gRotation = degrees(gRotation - (float)arg);
        if (commit(saved))
            tell(who, "Turned " + num(llFabs((float)arg)) + " degrees " + llList2String(["east.", "west."], (float)arg < 0.0));
        return;
    }

    // Everything below is the owner's.
    if (!owner) return;

    if (cmd == "help") { help(); return; }
    if (cmd == "list")
    {
        integer i;
        for (i = 0; i < llGetListLength(PRESETS); i += 3)
            tell(who, "/" + (string)CHAN + " show " + llList2String(PRESETS, i) + " - " + llList2String(PRESETS, i + 2));
        tell(who, "Or /" + (string)CHAN + " show <id>, with any dataset id from the node's catalog. "
            + "The touch menu offers the \"datasets\" notecard's list instead.");
        return;
    }
    if (cmd == "rate")
    {
        // Rounded to what the address will carry, so the scripts time the
        // clip at the rate every copy plays it.
        float r = -1.0;
        if (isNumber(arg)) r = (float)num((float)arg);
        if (r < MIN_RATE || r > MAX_RATE)
        {
            tell(who, "A rate from " + num(MIN_RATE) + " to " + num(MAX_RATE) + ", where 1 is the clip's own speed.");
            return;
        }
        reanchor();
        gRate = r;
        if (commit(saved)) tell(who, "Rate " + num(gRate) + ".");
        return;
    }
    if (cmd == "rotation")
    {
        if (!isNumber(arg) || llFabs((float)arg) > 3600.0)
        {
            tell(who, "Rotation in degrees east, from -3600 to 3600, like 90 or -75.");
            return;
        }
        // Home first, since commit() tells the other scripts whether the
        // globe is turned from it.
        float home = gHome;
        gRotation = degrees((float)arg);
        gHome = gRotation;
        if (!commit(saved)) { gHome = home; return; }
        tell(who, num(gRotation) + " degrees east is at the centre of the picture.");
        return;
    }
    if (cmd == "spin")
    {
        float rate = (float)arg;
        if (larg == "off" || (isNumber(arg) && rate == 0.0))
        {
            stopSpin();
            gOwnerSpin = 0.0;
            tell(who, "Spin off.");
            return;
        }
        if (!isNumber(arg) || llFabs(rate) > 90.0)
        {
            tell(who, "Spin in degrees a second, up to 90, like 6 for a turn a minute, or off.");
            return;
        }
        // The spin turns about the region's vertical, which a tilted
        // sphere's poles no longer are.
        if (gTilted) { tell(who, "Not while the globe is tilted: /" + (string)CHAN + " level first."); return; }
        gSpin = rate;
        gOwnerSpin = rate;
        llTargetOmega(<0.0, 0.0, 1.0>, gSpin * DEG_TO_RAD, 1.0);
        tell(who, "Spinning at " + num(gSpin) + " degrees a second. Each viewer draws the spin for itself, so "
            + "visitors don't all see the same side at once. Leave it off when someone will point at a place.");
        return;
    }
    if (cmd == "debug")
    {
        if (larg != "on" && larg != "off") { tell(who, "debug on, or debug off."); return; }
        gDebug = (larg == "on");
        if (commit(saved)) tell(who, "Debug readout " + larg + ".");
        return;
    }
    if (cmd == "width")
    {
        if (arg != "1024" && arg != "2048") { tell(who, "width 1024, or width 2048."); return; }
        gWidth = (integer)arg;
        if (commit(saved)) tell(who, "Width " + arg + ". The picture changes size at once, and the "
            + "video's resolution follows at the next dataset.");
        return;
    }
    if (cmd == "telemetry")
    {
        if (larg != "on" && larg != "off") { tell(who, "telemetry on, or telemetry off."); return; }
        if (larg == "on" && !gHash)
        {
            tell(who, "Not while changes go before the #: each would reload every visitor's page, and each "
                + "reload reports again as a new visit. Say /" + (string)CHAN + " steer hash first.");
            return;
        }
        gTelemetry = (larg == "on");
        if (!commit(saved)) return;
        if (gTelemetry)
            tell(who, "Telemetry on. In the first minute after each visitor's page loads, it reports "
                + "anonymously which dataset it showed and anything that failed, then nothing more. A viewer "
                + "that sends Global Privacy Control reports nothing. The floating text and the object's "
                + "description now say so, as the policy asks: " + NODE + "/privacy. Every visitor's page "
                + "reloaded to pick this up. Every change from here on goes after the #.");
        else
            tell(who, "Telemetry off. Every visitor's page reloaded to pick this up.");
        return;
    }
    if (cmd == "steer")
    {
        if (larg != "hash" && larg != "query") { tell(who, "steer hash, or steer query."); return; }
        if (larg == "query" && gTelemetry)
        {
            tell(who, "Not while telemetry is on: each change would reload every visitor's page, and each "
                + "reload reports again as a new visit. Say /" + (string)CHAN + " telemetry off first.");
            return;
        }
        gHash = (larg == "hash");
        if (!commit(saved)) return;
        if (gHash) tell(who, "Changes now go after the #, which a browser applies without a reload.");
        else tell(who, "Changes now go before the #, so each one reloads every visitor's page: the globe "
            + "shows the plain live Earth for a few seconds, then the same moment. For viewers that "
            + "reload on a # change anyway.");
        return;
    }
    if (cmd == "status")
    {
        string what = "the live Earth";
        if (gDataset != "")
            what = gTitle + " at " + num(position()) + " s, " + llList2String(["playing", "paused"], gPaused)
                + ", rate " + num(gRate);
        tell(who, "Showing " + what + ". Spin " + num(gSpin) + " degrees a second. Address: " + address());
        return;
    }
    if (cmd == "home")
    {
        if (gSpin != 0.0) stopSpin();
        home();
        broadcast();
        tell(who, "The globe's rotation now is its rest: the idle return, Upright again and a reset stand it like this.");
        return;
    }
    if (cmd == "upright")
    {
        upright();
        home();
        gOwnerSpin = 0.0;
        broadcast();
        tell(who, "Poles upright, texture turned 90 degrees, spin off.");
        return;
    }
    if (cmd == "memory")
    {
        string peaked = "";
        if (gPeak) peaked = ", and at most " + (string)(gPeak / 1024) + " KB while showing a dataset";
        tell(who, "Globe script: " + (string)(llGetUsedMemory() / 1024) + " KB used of 64" + peaked + ".");
        return;
    }
    // The visitors script's commands, which it answers itself.
    if (cmd == "talk" || cmd == "presenters") return;
    help();
}

default
{
    state_entry()
    {
        llListen(CHAN, "", llGetOwner(), "");
        while (llGetSubString(NODE, -1, -1) == "/") NODE = llDeleteSubString(NODE, -1, -1);
        if (llGetObjectName() == "Object") llSetObjectName("TerraViz globe");
        if (UPRIGHT_ON_START) { upright(); home(); }
        else
        {
            // A mesh globe stands back at the rest it was given, so a
            // reset while tilted doesn't keep the tilt.
            stopSpin();
            string stored = llLinksetDataRead(HOME_KEY);
            if (stored == "") home();
            else
            {
                gHomeRot = (rotation)stored;
                llSetLocalRot(gHomeRot);
                gNorth = <0.0, 0.0, 1.0> / llGetRot();
                gTilted = FALSE;
            }
        }
        anchor();
        if (setMedia())
        {
            describe();
            llOwnerSay("[exhibit] Showing the live Earth from " + NODE + ". Address: " + address());
        }
        broadcast();
        help();
    }

    on_rez(integer p) { llResetScript(); }

    changed(integer c)
    {
        if (c & CHANGED_OWNER) llResetScript();
    }

    listen(integer ch, string name, key id, string msg)
    {
        act(id, TRUE, msg);
    }

    link_message(integer sender, integer n, string str, key id)
    {
        if (n == MSG_HELLO) { broadcast(); return; }
        if (n != MSG_CONTROL) return;
        // A visitor's own request, or one the scripts made (NULL_KEY). The
        // owner using the menu is still the owner.
        act(id, id == llGetOwner(), str);
    }
}
