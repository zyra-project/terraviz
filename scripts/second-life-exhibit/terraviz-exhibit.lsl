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
// It is one of five scripts that make a sphere a TerraViz exhibit: a
// globe that stays up all the time, that anyone who walks up can use, and
// that a presenter can take over for a talk.
//   terraviz-exhibit.lsl           this one: what the globe shows
//   terraviz-exhibit-visitors.lsl  touches, menus, talks, who is nearby
//   terraviz-exhibit-info.lsl      the floating text, and "About"
//   terraviz-exhibit-owner.lsl     the owner's commands on channel 9
//   terraviz-exhibit-menu.lsl      the dataset menu from the node, in a
//                                  small prim of its own linked to the sphere
// The first four go in the sphere's Content tab, the menu script in that
// small prim's. An optional sixth, terraviz-exhibit-kiosk.lsl, goes in a
// flat screen linked to the sphere, and shows what the globe shows there
// for visitors to read.
//
// The sphere's surface shows TerraViz's output page: a web page that
// draws the whole Earth unwrapped into a flat 2:1 picture, which Second
// Life wraps round the sphere. Every visitor's viewer loads that page for
// itself, so the page is told what to show by its address alone: which
// dataset, where in its animation, and whether it is paused. Every copy
// reads the same address, so everyone at the globe sees the same moment.
// This script is the only one that sets that address. The visitors script
// asks it for changes, as the owner script does for the owner and the
// info script does to put back a dataset the page can't show, and it
// tells the visitors and info scripts what the globe shows after each
// one. The info script also tells it how long the clip is, so that a
// pause, a nudge or a change of rate lands on the frame the copies show
// however long the globe has played (position()): every copy that loops
// on the stream's playlist total, and one looping on a length of its own
// is brought back into step.
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
// COMMANDS
// The owner's commands on channel 9 are the owner script's
// (terraviz-exhibit-owner.lsl), which lists them. It checks each one and
// hands it here, and this script makes the change. What a visitor can
// ask for too, this script answers whoever asked; the rest, it tells the
// owner script how it went (MSG_RESULT), which says so. They moved out of
// this script to give it room: it read 57 KB of its 64 at rest and up to
// 60 showing a dataset, the least room of any of the scripts, with the
// console's motion still to come (docs/SECOND_LIFE_COMPAT.md §9 Phase 5,
// step 1).
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
// SOUND
// A dataset with a sound track plays it in each visitor's own viewer, at
// their media volume and fainter with distance from the globe, so each
// hears their own copy, as in step as the pictures are. A seek to catch
// up is a skip in the sound, catching up without one plays it up to a
// quarter faster or slower for a while, and a short loop repeats its
// sound every pass. "/9 sound off" silences the globe until a reset, with
// no reload while changes go after the #; SOUND below sets how it starts.

// The TerraViz node the globe shows, with no slash at the end. The
// visitors and info scripts take it from this one.
string  NODE = "https://terraviz.zyra-project.org";
integer FACE = 0;              // a sphere has only face 0
integer UPRIGHT_ON_START = TRUE; // FALSE for a mesh globe with its own mapping
integer SOUND = TRUE;          // FALSE for a globe that starts silent

// The link messages the scripts in the sphere share. The numbers are
// arbitrary; every script must agree, and exhibit.test.ts holds them to it.
integer MSG_STATE   = 271001;  // globe to all: what the globe shows, as JSON
integer MSG_CONTROL = 271002;  // visitors or info to globe: a control, for the key who asked
integer MSG_HELLO   = 271003;  // any to globe: say the state again (a script reset)
integer MSG_OWNER   = 271010;  // owner to globe: one of the owner's commands, checked
integer MSG_RESULT  = 271011;  // globe to owner: how an owner-only command went, as a JSON array

// Shared media is capped at 2048 pixels a side (indra/llprimitive/
// llmediaentry.h); a script asking for more gets a bounds error.
integer MEDIA_W = 2048;
integer MEDIA_H = 1024;

// The page plays rates from 1/12 (0.0833...) to 12.8 and reads anything
// outside as 1 (docs/EMBED_URL_GRAMMAR.md). Held a little inside 1/12,
// because an address carries three decimal places and 0.083 would read
// as 1. The owner script checks a rate against its copy of these first.
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
integer gLen;           // the clip's length in microseconds, from the info script, 0 while unknown
string  gLenFor;        // the dataset gLen is for
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
integer gSound;
integer gWidth = 2048;
integer gHash = TRUE;   // changes go after the #

float   gSpin;          // degrees a second, 0 for still
integer gPeak;          // the most memory used while showing a dataset
key     gBy = NULL_KEY; // who chose a dataset, or paused, played or moved the clip, for the next broadcast

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
    gPos = position(t);
    gAtS = llList2Integer(t, 0);
    gAtMs = llList2Integer(t, 1);
}

// Where the clip is at `t`, a now() reading. Round the loop once the info
// script has said how long the clip is, in whole microseconds (loopUs).
// Until then, and for a clip it can't say, unwrapped, as the page wraps it
// round the clip itself, and in a float, which holds a day's play to about
// 10 ms and a month's only to a third of a second.
float position(list t)
{
    if (gLen > 0 && gLenFor == gDataset) return (float)loopUs(t, gLen) / 1000000.0;
    if (gPaused) return gPos;
    return gPos + since(t) * gRate;
}

// Where the clip is at `t`, a now() reading, in microseconds round a loop
// of `d`: the anchor's position plus the time since it at the rate, in
// whole numbers. Worked in floats the sum lost about 10 ms a day of play,
// a third of a second a month and more at a higher rate, so the date in
// the floating text drifted from the picture on a globe left playing, and
// a pause landed off the frame every copy was showing. The rate has the
// address's three places, so a millisecond of it is a whole number of
// microseconds of clip. The info script keeps the same copy, which
// exhibit.test.ts holds the two to, and runs.
integer loopUs(list t, integer d)
{
    integer s = llList2Integer(t, 0) - gAtS;
    integer ms = llList2Integer(t, 1) - gAtMs;
    if (ms < 0) { s -= 1; ms += 1000; }
    if (gPaused) { s = 0; ms = 0; }
    integer r = llRound(gRate * 1000.0);
    // The anchor's position, wrapped first in a float for one set past the
    // loop, by a jump (up to 100000 s) or before the length was known:
    // within a few milliseconds there, and tens of microseconds otherwise.
    float f = (float)d / 1000000.0;
    integer p = llRound((gPos - f * llFloor(gPos / f)) * 1000000.0) % d;
    if (p < 0) p += d;
    integer a = s % d;
    if (a < 0) a += d;
    integer b = (1000 * r) % d;
    // p plus a times b, round d, a bit of b at a time, so that nothing
    // leaves an integer's range.
    while (b)
    {
        if (b & 1) { p += a - d; if (p < 0) p += d; }
        a += a - d;
        if (a < 0) a += d;
        b = b >> 1;
    }
    p += (ms * r) % d - d;
    if (p < 0) p += d;
    return p;
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
// float's fraction coarsens as it grows: the position, kept round the loop
// once the clip's length is known, holds to tens of microseconds, and
// unwrapped, without one, to about 8 ms after a day's play at full speed.
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
    if (gSound) live += ["sound=1"];
    string sep = "#";
    if (!gHash) sep = "&";
    return NODE + "/output/output?" + setup + sep + llDumpList2String(live, "&");
}

list snapshot()
{
    return [gDataset, gTitle, gPos, gAtS, gAtMs, gRate, gPaused, gRotation, gDebug, gTelemetry, gWidth, gHash, gSound];
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
    gSound = llList2Integer(s, 12);
}

// Tells the visitors and info scripts what the globe shows, and a kiosk
// screen's script, which is in a prim of its own, so this goes to the
// whole object. The info script and the kiosk time the date from the
// clip's anchor, so they get the anchor itself rather than a position
// that would be stale on arrival. After a pause, a play or a move, the
// key is whoever asked, and the info script answers them with the date
// the globe now shows, which this script doesn't know. "turned" is
// anything the idle return puts back: the owner's rotation, an upright
// sphere, and the owner's spin, which a tilt ends and Upright again
// doesn't restart.
broadcast()
{
    llMessageLinked(LINK_SET, MSG_STATE, llList2Json(JSON_OBJECT, [
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

// Tells the owner script how an owner-only command went: the command,
// then "ok" and what it now is, or why it was refused.
report(string cmd, list how)
{
    llMessageLinked(LINK_THIS, MSG_RESULT, llList2Json(JSON_ARRAY, [cmd] + how), llGetOwner());
}

// One command, from a visitor's menu, the owner script or the scripts'
// own requests. A visitor reaches only the commands the touch menu
// offers; everything else is the owner's. Who may act at all is the
// visitors script's to decide.
act(key who, integer owner, string msg)
{
    list w = llParseString2List(llStringTrim(msg, STRING_TRIM), [" "], []);
    string cmd = llToLower(llList2String(w, 0));
    string arg = llList2String(w, 1);   // case kept: dataset ids are case-sensitive
    string larg = llToLower(arg);
    list saved = snapshot();

    if (cmd == "show")
    {
        // The owner script has turned a name from /9 list into its id.
        if (!isId(arg))
        {
            tell(who, "That dataset isn't available right now. The globe is unchanged.");
            if (!owner) llOwnerSay("[exhibit] A visitor chose \"" + arg + "\" from the menu, which isn't a dataset id.");
            return;
        }
        // The menu sends its own name for the dataset after the id, so a
        // title the node can't give still reads as the menu said.
        // (A list of two would come back whole: llList2List's range runs
        // backwards there, and a backwards range means everything outside it.)
        string described = "";
        if (llGetListLength(w) > 2) described = llDumpList2String(llList2List(w, 2, -1), " ");
        // Shown at once. The info script reads the record next and puts
        // the globe back on the live Earth if the node has no such
        // dataset or it is a tour; this script holds no reply of its own.
        show(who, arg, described);
        return;
    }
    // The clip's length in microseconds and the dataset it is for, from the
    // info script, which reads it from the node's card, so that the clock
    // can be kept round the loop (position()). Only the scripts send it,
    // and 0, for none, each time the info script starts on a dataset.
    if (cmd == "length" && who == NULL_KEY)
    {
        gLen = (integer)arg;
        gLenFor = llList2String(w, 2);
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
        // One reading of the clock for where the clip is and the new anchor,
        // as in reanchor(), so the clip skips nothing between them.
        list t = now();
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
            to = position(t) + (float)arg;
        }
        // Round the loop once its length is known, as the page plays it,
        // so a copy on a period of its own lands in step with the rest too:
        // back past the start goes round to the loop's end. A float holds a
        // jump to 100000 s wrapped to a few milliseconds. Before the length
        // is known, never before the start, and past the end the page wraps.
        float len = (float)gLen / 1000000.0;
        if (gLen > 0 && gLenFor == gDataset) to -= len * (float)llFloor(to / len);
        else if (to < 0.0) to = 0.0;
        gPos = to;
        gAtS = llList2Integer(t, 0);
        gAtMs = llList2Integer(t, 1);
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

    // Everything below is the owner's. It comes from the owner script,
    // which has checked it and words the answer: this script makes the
    // change and reports it (report()). The checks here only keep a value
    // the owner script should never send out of the address and the
    // clock. Nothing is reported when Second Life refuses the media, which
    // setMedia() has told the owner already.
    if (!owner) return;

    if (cmd == "rate")
    {
        // Rounded to what the address will carry, so the scripts time the
        // clip at the rate every copy plays it.
        float r = (float)num((float)arg);
        if (!isNumber(arg) || r < MIN_RATE || r > MAX_RATE) return;
        reanchor();
        gRate = r;
        if (commit(saved)) report(cmd, ["ok", num(gRate)]);
        return;
    }
    if (cmd == "rotation")
    {
        if (!isNumber(arg) || llFabs((float)arg) > 3600.0) return;
        // Home first, since commit() tells the other scripts whether the
        // globe is turned from it.
        float home = gHome;
        gRotation = degrees((float)arg);
        gHome = gRotation;
        if (!commit(saved)) { gHome = home; return; }
        report(cmd, ["ok", num(gRotation)]);
        return;
    }
    if (cmd == "spin")
    {
        float rate = (float)arg;
        if (!isNumber(arg) || llFabs(rate) > 90.0) return;
        if (rate == 0.0)
        {
            stopSpin();
            gOwnerSpin = 0.0;
            report(cmd, ["off"]);
            return;
        }
        // The spin turns about the region's vertical, which a tilted
        // sphere's poles no longer are.
        if (gTilted) { report(cmd, ["tilted"]); return; }
        gSpin = rate;
        gOwnerSpin = rate;
        llTargetOmega(<0.0, 0.0, 1.0>, gSpin * DEG_TO_RAD, 1.0);
        report(cmd, ["ok", num(gSpin)]);
        return;
    }
    if (cmd == "debug")
    {
        gDebug = (larg == "on");
        if (commit(saved)) report(cmd, ["ok", larg]);
        return;
    }
    if (cmd == "sound")
    {
        gSound = (larg == "on");
        if (commit(saved)) report(cmd, ["ok", larg]);
        return;
    }
    if (cmd == "width")
    {
        if (arg != "1024" && arg != "2048") return;
        gWidth = (integer)arg;
        if (commit(saved)) report(cmd, ["ok", arg]);
        return;
    }
    if (cmd == "telemetry")
    {
        // Each reload reports again as a new visit, so a measured globe
        // keeps its changes after the #.
        if (larg == "on" && !gHash) { report(cmd, ["steer"]); return; }
        gTelemetry = (larg == "on");
        if (commit(saved)) report(cmd, ["ok", larg, NODE]);
        return;
    }
    if (cmd == "steer")
    {
        // Anything but the two words is refused before the telemetry
        // check, or a third would turn the # off unchecked.
        if (larg != "hash" && larg != "query") return;
        if (larg == "query" && gTelemetry) { report(cmd, ["telemetry"]); return; }
        gHash = (larg == "hash");
        if (commit(saved)) report(cmd, ["ok", larg]);
        return;
    }
    if (cmd == "status")
    {
        // The clip's length, once the info script has said it, which is
        // also how the owner tells the clock is kept round the loop.
        string len = "";
        if (gLen > 0 && gLenFor == gDataset) len = num((float)gLen / 1000000.0);
        report(cmd, ["ok", gDataset, gTitle, num(position(now())), len, gPaused, num(gRate), num(gSpin), address()]);
        return;
    }
    if (cmd == "home")
    {
        if (gSpin != 0.0) stopSpin();
        home();
        broadcast();
        report(cmd, ["ok"]);
        return;
    }
    if (cmd == "upright")
    {
        upright();
        home();
        gOwnerSpin = 0.0;
        broadcast();
        report(cmd, ["ok"]);
        return;
    }
    if (cmd == "memory")
    {
        report(cmd, ["ok", llGetUsedMemory() / 1024, gPeak / 1024]);
        return;
    }
}

default
{
    state_entry()
    {
        gSound = SOUND;
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
            // Said here too, since without the owner script in the sphere
            // nothing else would point to it.
            llOwnerSay("[exhibit] Showing the live Earth from " + NODE + ". The owner script, "
                + "terraviz-exhibit-owner, answers /9 help. Address: " + address());
        }
        broadcast();
    }

    on_rez(integer p) { llResetScript(); }

    changed(integer c)
    {
        if (c & CHANGED_OWNER) llResetScript();
    }

    link_message(integer sender, integer n, string str, key id)
    {
        if (n == MSG_HELLO) { broadcast(); return; }
        // The owner's chat, which the owner script has checked.
        if (n == MSG_OWNER) { act(llGetOwner(), TRUE, str); return; }
        if (n != MSG_CONTROL) return;
        // A visitor's own request, or one the scripts made (NULL_KEY). The
        // owner using the menu is still the owner.
        act(id, id == llGetOwner(), str);
    }
}
