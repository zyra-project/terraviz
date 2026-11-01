// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// TerraViz exhibit globe - the owner script.
//
// ABOUT TERRAVIZ
// TerraViz is a free, open-source globe for environmental data, most of
// it from NOAA's Science On a Sphere collection.
//   The app:     https://terraviz.zyra-project.org
//   The source:  https://github.com/zyra-project/terraviz
//
// WHAT THIS SCRIPT DOES
// It is one of the exhibit's five scripts, and the one that hears the
// owner's commands on channel 9. It checks each one, hands it to the
// globe script (terraviz-exhibit.lsl), which makes the change, and says
// how it went. It holds the help, the list of datasets /9 show knows by
// name, and everything the owner is told about a command only the owner
// can give. What a visitor can ask for too (show, pause, a turn and the
// rest), the globe script words itself, for whoever asked.
//
// It exists to give the globe script room: a script has 64 KB in all,
// and the globe script read 57 KB at rest and up to 60 showing a
// dataset, the least room of any of the scripts, with the console's
// motion still to come (docs/SECOND_LIFE_COMPAT.md §9 Phase 5, step 1).
// It goes in the sphere with the globe, visitors and info scripts.
// Without it the globe still runs and visitors still use it, but of
// these commands only /9 talk, /9 presenters and /9 memory answer.
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
//   /9 sound on|off        a dataset's sound track; on at the start unless the globe
//                          script's SOUND says not
//   /9 width 1024|2048     the picture's resolution
//   /9 telemetry on|off    anonymous counts (reloads every visitor's page)
//   /9 steer hash|query    where changes go in the address (the globe script says why)
//   /9 status              the current address and state
//   /9 tilt south|north    tip the sphere 30 degrees so that pole comes round toward
//                          you, until it faces you. Visitors' "South Pole to me" and
//                          "North Pole to me" buttons do this.
//   /9 level               stand a tilted sphere back as it was
//   /9 home                make the sphere's rotation now its rest, which a reset keeps
//   /9 upright             stand the poles upright again
//   /9 memory              each of the five scripts says how much of its 64 KB it uses
// The visitors script answers /9 talk and /9 presenters itself.
//
// Channel 9 rather than the smoke-test globe's 8 or the probe's 7, so one
// command never reaches two kinds of object at once.

integer CHAN = 9;

// The link messages this script and the globe script share. New numbers,
// never the one visitors' requests use: a globe script from before this
// one answers the owner's chat itself and ignores these, so a sphere
// holding this script beside it does each command once, not twice.
// exhibit.test.ts holds the numbers to the globe script's.
integer MSG_OWNER  = 271010;  // owner to globe: one of the owner's commands, checked
integer MSG_RESULT = 271011;  // globe to owner: how an owner-only command went, as a JSON array

// Datasets /9 show knows by name: name, the node's id for it, what it is.
// The touch menu takes its own list from the node, or from the "datasets"
// notecard. The ids are terraviz.zyra-project.org's, and a preview build
// shares them.
list PRESETS = [
    "hurricanes", "01KQG611HF8YXJNRBEHT0757KT", "Hurricane Season 2024 (video)",
    "sst",        "01KQG65ZW1JC7M27EQ1CYD8YZ7", "Sea Surface Temperature, real-time (video)",
    "smoke",      "01KYJDXB4909JWG8DP257D3D0Z", "Wildfire Smoke Forecast, United States (data video, one region)",
    "quakes",     "01KQG62M0Z3EC0T9EXFH1MVXDV", "Earthquakes 2001-2015 (video)",
    "lights",     "01KQG629957NPZN7NTW4VK6FW0", "Nighttime Lights (still image)"
];

// The globe script's limits, which it holds to as well; exhibit.test.ts
// holds the two copies equal.
float   MIN_RATE = 0.084;
float   MAX_RATE = 12.8;
string  ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
integer ID_MAX = 128;

say(string msg)
{
    llOwnerSay("[exhibit] " + msg);
}

help()
{
    say("Commands on /" + (string)CHAN + ": show <name or id>, list, earth, pause, play, "
        + "jump <s or m:ss>, rate <speed>, rotation <degrees>, turn <degrees east>, tilt south|north, level, home, spin <degrees/s or off>, debug on|off, "
        + "width 1024|2048, sound on|off, telemetry on|off, steer hash|query, status, upright, memory, talk, presenters");
}

// To the globe script, as the owner.
ask(string cmd)
{
    llMessageLinked(LINK_THIS, MSG_OWNER, cmd, llGetOwner());
}

// A plain decimal with at most three places, as the page reads numbers:
// the globe script's own, so a rate is checked as the address will carry it.
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

// One of the owner's commands, from chat.
command(string msg)
{
    list w = llParseString2List(msg, [" "], []);
    string cmd = llToLower(llList2String(w, 0));
    string arg = llList2String(w, 1);   // case kept: dataset ids are case-sensitive
    string larg = llToLower(arg);

    if (cmd == "show")
    {
        if (arg == "") { say("Show what? /" + (string)CHAN + " list names a few."); return; }
        integer at = llListFindList(PRESETS, [larg]);
        // A name sits at a multiple of three; an id or description elsewhere is not one.
        if (at != -1 && at % 3 == 0)
        {
            ask("show " + llList2String(PRESETS, at + 1) + " " + llList2String(PRESETS, at + 2));
            return;
        }
        if (!isId(arg))
        {
            say("\"" + arg + "\" is neither a name from /" + (string)CHAN + " list nor a dataset id. Ids are letters, digits, - and _.");
            return;
        }
        // The id, and any name for it after, as the menu sends them.
        ask(msg);
        return;
    }
    // What a visitor may ask for too: the globe script checks these and
    // answers whoever asked itself.
    if (llListFindList(["earth", "pause", "play", "jump", "nudge", "restart", "turn", "tilt", "level"], [cmd]) != -1)
    {
        ask(msg);
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
            say("A rate from " + num(MIN_RATE) + " to " + num(MAX_RATE) + ", where 1 is the clip's own speed.");
            return;
        }
        ask("rate " + num(r));
        return;
    }
    if (cmd == "rotation")
    {
        if (!isNumber(arg) || llFabs((float)arg) > 3600.0)
        {
            say("Rotation in degrees east, from -3600 to 3600, like 90 or -75.");
            return;
        }
        ask("rotation " + arg);
        return;
    }
    if (cmd == "spin")
    {
        if (larg == "off" || (isNumber(arg) && (float)arg == 0.0)) { ask("spin 0"); return; }
        if (!isNumber(arg) || llFabs((float)arg) > 90.0)
        {
            say("Spin in degrees a second, up to 90, like 6 for a turn a minute, or off.");
            return;
        }
        ask("spin " + arg);
        return;
    }
    if (cmd == "debug" || cmd == "sound" || cmd == "telemetry")
    {
        if (larg != "on" && larg != "off") { say(cmd + " on, or " + cmd + " off."); return; }
        ask(cmd + " " + larg);
        return;
    }
    if (cmd == "width")
    {
        if (arg != "1024" && arg != "2048") { say("width 1024, or width 2048."); return; }
        ask("width " + arg);
        return;
    }
    if (cmd == "steer")
    {
        if (larg != "hash" && larg != "query") { say("steer hash, or steer query."); return; }
        ask("steer " + larg);
        return;
    }
    if (cmd == "status" || cmd == "home" || cmd == "upright")
    {
        ask(cmd);
        return;
    }
    if (cmd == "memory")
    {
        say("Owner script: " + (string)(llGetUsedMemory() / 1024) + " KB used of 64.");
        ask(cmd);
        return;
    }
    if (cmd == "list")
    {
        integer i;
        for (i = 0; i < llGetListLength(PRESETS); i += 3)
            say("/" + (string)CHAN + " show " + llList2String(PRESETS, i) + " - " + llList2String(PRESETS, i + 2));
        say("Or /" + (string)CHAN + " show <id>, with any dataset id from the node's catalog. "
            + "The touch menu offers the node's catalog, or the \"datasets\" notecard's list, instead.");
        return;
    }
    // The visitors script's commands, which it answers itself.
    if (cmd == "talk" || cmd == "presenters") return;
    help();
}

// What the globe script did with an owner-only command: the command, then
// "ok" and what it now is, or the reason it refused. A change Second Life
// refused brings nothing, since the globe script has said so already.
result(string r)
{
    string cmd = llJsonGetValue(r, [0]);
    string done = llJsonGetValue(r, [1]);
    string v = llJsonGetValue(r, [2]);
    if (cmd == "rate") say("Rate " + v + ".");
    else if (cmd == "rotation") say(v + " degrees east is at the centre of the picture.");
    else if (cmd == "spin")
    {
        // The spin turns about the region's vertical, which a tilted
        // sphere's poles no longer are.
        if (done == "tilted") say("Not while the globe is tilted: /" + (string)CHAN + " level first.");
        else if (done == "off") say("Spin off.");
        else say("Spinning at " + v + " degrees a second. Each viewer draws the spin for itself, so "
            + "visitors don't all see the same side at once. Leave it off when someone will point at a place.");
    }
    else if (cmd == "debug") say("Debug readout " + v + ".");
    else if (cmd == "sound") say("Sound " + v + ".");
    else if (cmd == "width") say("Width " + v + ". The picture changes size at once, and the "
        + "video's resolution follows at the next dataset.");
    else if (cmd == "telemetry")
    {
        if (done == "steer")
            say("Not while changes go before the #: each would reload every visitor's page, and each "
                + "reload reports again as a new visit. Say /" + (string)CHAN + " steer hash first.");
        else if (v == "on")
            say("Telemetry on. In the first minute after each visitor's page loads, it reports "
                + "anonymously which dataset it showed and anything that failed, then nothing more. A viewer "
                + "that sends Global Privacy Control reports nothing. The floating text and the object's "
                + "description now say so, as the policy asks: " + llJsonGetValue(r, [3]) + "/privacy. Every visitor's page "
                + "reloaded to pick this up. Every change from here on goes after the #.");
        else say("Telemetry off. Every visitor's page reloaded to pick this up.");
    }
    else if (cmd == "steer")
    {
        if (done == "telemetry")
            say("Not while telemetry is on: each change would reload every visitor's page, and each "
                + "reload reports again as a new visit. Say /" + (string)CHAN + " telemetry off first.");
        else if (v == "hash") say("Changes now go after the #, which a browser applies without a reload.");
        else say("Changes now go before the #, so each one reloads every visitor's page: the globe "
            + "shows the plain live Earth for a few seconds, then the same moment. For viewers that "
            + "reload on a # change anyway.");
    }
    else if (cmd == "status")
    {
        // The dataset, its title, where the clip is, its length once the
        // info script has said it (which is also how the owner tells the
        // clock is kept round the loop), paused, the rate, the spin and
        // the address.
        string what = "the live Earth";
        if (v != "")
        {
            string of = "";
            if (llJsonGetValue(r, [5]) != "") of = " of " + llJsonGetValue(r, [5]);
            what = llJsonGetValue(r, [3]) + " at " + llJsonGetValue(r, [4]) + of + " s, "
                + llList2String(["playing", "paused"], (integer)llJsonGetValue(r, [6]))
                + ", rate " + llJsonGetValue(r, [7]);
        }
        say("Showing " + what + ". Spin " + llJsonGetValue(r, [8]) + " degrees a second. Address: " + llJsonGetValue(r, [9]));
    }
    else if (cmd == "home")
        say("The globe's rotation now is its rest: the idle return, Upright again and a reset stand it like this.");
    else if (cmd == "upright") say("Poles upright, texture turned 90 degrees, spin off.");
    else if (cmd == "memory")
    {
        string peaked = "";
        if ((integer)llJsonGetValue(r, [3])) peaked = ", and at most " + llJsonGetValue(r, [3]) + " KB while showing a dataset";
        say("Globe script: " + v + " KB used of 64" + peaked + ".");
    }
}

default
{
    state_entry()
    {
        llListen(CHAN, "", llGetOwner(), "");
        help();
    }

    on_rez(integer p) { llResetScript(); }

    changed(integer c)
    {
        if (c & CHANGED_OWNER) llResetScript();
    }

    listen(integer ch, string name, key id, string msg)
    {
        // The listen hears only the owner already; this holds if it is
        // ever widened.
        if (id != llGetOwner()) return;
        command(llStringTrim(msg, STRING_TRIM));
    }

    link_message(integer sender, integer n, string str, key id)
    {
        if (n != MSG_RESULT) return;
        result(str);
    }
}
