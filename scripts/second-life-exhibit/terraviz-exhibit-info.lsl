// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// TerraViz exhibit globe - the info script.
//
// ABOUT TERRAVIZ
// TerraViz is a free, open-source globe for environmental data, most of
// it from NOAA's Science On a Sphere collection.
//   The app:     https://terraviz.zyra-project.org
//   The source:  https://github.com/zyra-project/terraviz
//
// WHAT THIS SCRIPT DOES
// It is one of the exhibit's three scripts, and the one that says what the
// globe shows. terraviz-exhibit.lsl tells it what that is after every
// change. From the node it reads the dataset's card, a reply of at most
// 2 KB that the node writes for the exhibit, its text already plain and
// cut to fit (/api/exhibit/v1/datasets/<id>), and from it keeps two things:
// - The hover text over the globe, kept short, in this order:
//     the title
//     the date: exact when paused, every couple of seconds while playing,
//       and the dataset's range when the clip's length isn't known
//     the telemetry notice, "Counts anonymous use:" and the privacy
//       policy's address, while the owner has telemetry on
//     a short credit, such as "Credit: NOAA · CC-BY-4.0"
//     "Talk in progress", during one
//     how to touch the globe
//   Hover text holds 254 bytes. The title and the credit share what the
//   other lines leave, the title keeping at least 32 bytes and the credit
//   48 where both fit, the title's first where they don't, and either is
//   cut with "..." when it has to be. Nothing else is cut, so the notice
//   is never lost.
// - "About", from the touch menu. If the globe holds a notecard named by
//   the dataset's id, the visitor is given it. Otherwise they get the
//   abstract, the full credit, the licence and a link to the dataset's
//   page, in their own chat, in pieces of about 1 KB. Only the first 500
//   characters of the abstract are given, which cuts most of them, and
//   the link has the rest.
//
// A DATE is the dataset's start time plus the share of its span that the
// clip has played, the arithmetic of the app's videoTimeToDate. How it is
// shown is this script's own: to the period's precision, the year for a
// yearly dataset ("P1Y"), the month for a monthly one, the time for one
// with a period under a day, and the day for the rest, all in UTC. The
// app shows the day, or for a period under a day the time, in the
// viewer's time zone. A day,
// month or year a frame (P1D, P1M, P1Y) is counted in frames: the clip
// holds one per period, the first at the start and the last at the end,
// so the label is the frame's own.
// A clip's length is the card's, which the node reads from the stream's
// own playlists, its own bundle's or a Vimeo stream's: Vimeo's API gives
// whole seconds, the page loops on the stream's own, and a date worked
// out from the first would drift from the picture with every loop. When
// the node has no exact length, as for a single file, the range shows.
//
// A node older than the card answers with the app's page instead. The
// hover text then shows the title alone, "About" gives the dataset's
// page, and the owner is told once.
//
// The owner can ask "/9 memory": each of the three scripts says how much
// of its 64 KB it uses, and this one also says the most it has used while
// reading a card or answering "About", which are when it needs the most.

integer CHAN = 9;

integer MSG_STATE   = 271001;  // globe to all: what the globe shows, as JSON
integer MSG_CONTROL = 271002;  // visitors or info to globe: a control, for the key who asked
integer MSG_HELLO   = 271003;  // any to globe: say the state again (a script reset)
integer MSG_TALK    = 271004;  // visitors to info: "1" during a talk, "0" otherwise
integer MSG_ABOUT   = 271005;  // visitors to info: tell the key about what the globe shows

// A card's budget, in bytes. The node keeps every card within it, so a
// card arrives whole, and a reply cut short isn't one. A request reads one
// byte more, so a card of exactly the budget can't read as cut, whichever
// way Second Life counts the limit. Held at two bytes a character, a card
// is the largest thing this script holds.
integer CARD_MAX = 2048;
integer TRIES = 4;             // asks for one dataset's card, a failed one or one the node said to repeat
integer ABSTRACT_MAX = 500;    // characters of an abstract kept for "About"; the link has the rest
integer PIECE = 1000;          // bytes of a chat piece; a chat line holds 1024
float   TICK = 2.0;            // how often a playing clip's date is worked out again
integer MIN_CREDIT = 48;       // bytes the credit keeps when the hover text is full
integer MIN_TITLE = 32;        // bytes the title keeps, first, when there isn't room for both

string  LIVE_LINE = "Live Earth: today's clouds";
string  LIVE_CREDIT = "Credit: NASA Blue Marble, Black Marble";
string  LIVE_ABOUT = "The live Earth: NASA's Blue Marble by day and its Black Marble city lights at night, under today's clouds, lit by the Sun as it stands right now. The globe rests on it when nobody has chosen a dataset.";
string  TOUCH_LINE = "Right-click, Touch for more";
string  TALK_LINE = "Talk in progress";

list    MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
integer RES_DAY = 0;
integer RES_MONTH = 1;
integer RES_YEAR = 2;
integer RES_TIME = 3;

// What the globe shows, from the globe script.
string  gDataset;
string  gTitle;
float   gPos;
integer gAtS;
integer gAtMs;
float   gRate = 1.0;
integer gPaused;
integer gTelemetry;
string  gNode;
integer gTalk;

// What the node's card says about it.
string  gFor;          // the dataset the fields below describe
integer gHaveRec;      // its card has been read
string  gPage;         // the dataset's page, a path on the node, as "/dataset/<slug>"
string  gCardTitle;    // the card's title, kept for every card, used when the globe's title is the bare id
integer gVideo;
integer gDated;
integer gStartDay;     // days since 1970, and seconds into that day
integer gStartSec;
integer gEndDay;
integer gEndSec;
integer gRes;
integer gSnapS;        // a sub-daily period in seconds, or 0
integer gFrames;       // the period is a single day, month or year (P1D, P1M, P1Y)
float   gDuration;     // the clip's length in seconds, 0 while unknown
string  gWho;          // the credit
string  gSpdx;         // the licence's SPDX id
string  gLicText;      // the licence's statement and address
string  gAbstract;
integer gCut;          // the node cut a value short, or this script cut the abstract

key     gReq;
integer gTries;
integer gRetryAt;

string  gShown;        // the hover text as last set
integer gPeak;         // the most memory used reading a card or answering About
string  gWarned;       // the dataset whose notecard the owner was last warned about
integer gToldNode;     // the owner has been told this node sent no card, or didn't answer
key     gChose;        // who chose the dataset shown, until the node has said whether it can be
key     gLastAbout;
integer gLastAboutAt;

// Days since 1970-01-01 (Howard Hinnant's days_from_civil), as the globe
// script counts them.
integer days(integer y, integer mo, integer d)
{
    integer mp = mo - 3;
    if (mo <= 2) { y -= 1; mp = mo + 9; }
    integer era = y / 400;
    integer yoe = y - era * 400;
    integer doy = (153 * mp + 2) / 5 + d - 1;
    return era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
}

// [year, month, day] for a day since 1970 (civil_from_days), from year 1 on.
list civil(integer z)
{
    z += 719468;
    integer era = z / 146097;
    integer doe = z - era * 146097;
    integer yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    integer doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    integer mp = (5 * doy + 2) / 153;
    integer d = doy - (153 * mp + 2) / 5 + 1;
    integer m = mp + 3;
    if (mp >= 10) m = mp - 9;
    integer y = yoe + era * 400;
    if (m <= 2) ++y;
    return [y, m, d];
}

// Unix time from the region's clock, as [seconds, milliseconds], as the
// globe script reads it.
list now()
{
    string ts = llGetTimestamp();
    integer s = (integer)llGetSubString(ts, 11, 12) * 3600 + (integer)llGetSubString(ts, 14, 15) * 60
        + (integer)llGetSubString(ts, 17, 18);
    integer d = days((integer)llGetSubString(ts, 0, 3), (integer)llGetSubString(ts, 5, 6), (integer)llGetSubString(ts, 8, 9));
    string frac = llList2String(llParseString2List(ts, [".", "Z"], []), 1) + "000";
    return [d * 86400 + s, (integer)llGetSubString(frac, 0, 2)];
}

// [day, second] for an ISO time such as 2024-06-01T12:00:00Z, or [] if it
// isn't one.
list instant(string t)
{
    if (llStringLength(t) < 19 || llGetSubString(t, 4, 4) != "-" || llGetSubString(t, 10, 10) != "T") return [];
    integer y = (integer)llGetSubString(t, 0, 3);
    integer mo = (integer)llGetSubString(t, 5, 6);
    integer d = (integer)llGetSubString(t, 8, 9);
    if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > 31) return [];
    return [days(y, mo, d), (integer)llGetSubString(t, 11, 12) * 3600 + (integer)llGetSubString(t, 14, 15) * 60
        + (integer)llGetSubString(t, 17, 18)];
}

// What a period says about the date's precision, read as the ISO 8601
// durations the app's parseISO8601Duration takes: P, then any of nY nM nW
// nD, then T and any of nH nM nS. The node doesn't check a period when
// it's written, so one that doesn't parse shows the day.
period(string p)
{
    gRes = RES_DAY;
    gSnapS = 0;
    if (llGetSubString(p, 0, 1) == "PT") gRes = RES_TIME;
    if (llGetSubString(p, 0, 0) != "P") return;
    string units = "YMWD";
    string num = "";
    integer inT = FALSE;
    integer last = -1;
    string seen = "";
    integer secs = 0;
    integer i;
    integer n = llStringLength(p);
    for (i = 1; i < n; ++i)
    {
        string c = llGetSubString(p, i, i);
        if (llSubStringIndex("0123456789.", c) != -1) num += c;
        else if (c == "T" && !inT && num == "") { inT = TRUE; units = "HMS"; last = -1; }
        else
        {
            integer at = llSubStringIndex(units, c);
            if (num == "" || at <= last) { gSnapS = 0; if (gRes != RES_TIME) gRes = RES_DAY; return; }
            last = at;
            if (inT) secs += (integer)((float)num * llList2Float([3600.0, 60.0, 1.0], at));
            else seen += c;
            num = "";
        }
    }
    if (num != "") return;
    if (gRes == RES_TIME) { gSnapS = secs; return; }
    if (inT) return;
    if (seen == "Y") gRes = RES_YEAR;
    else if (seen == "M") gRes = RES_MONTH;
}

string pad(integer n)
{
    if (n < 10) return "0" + (string)n;
    return (string)n;
}

string when(integer day, integer sec)
{
    list c = civil(day);
    string y = (string)llList2Integer(c, 0);
    string mon = llList2String(MONTHS, llList2Integer(c, 1) - 1);
    if (gRes == RES_YEAR) return y;
    if (gRes == RES_MONTH) return mon + " " + y;
    string s = (string)llList2Integer(c, 2) + " " + mon + " " + y;
    if (gRes == RES_TIME) s += ", " + pad(sec / 3600) + ":" + pad(sec % 3600 / 60) + " UTC";
    return s;
}

string range()
{
    if (!gDated) return "";
    string a = when(gStartDay, gStartSec);
    string b = when(gEndDay, gEndSec);
    if (a == b) return a;
    if (gRes == RES_TIME) a = llGetSubString(a, 0, -5);   // one " UTC" says it for both
    return a + " to " + b;
}

// Where the clip is now, round the loop, as each visitor's page puts it.
float position()
{
    float p = gPos;
    if (!gPaused)
    {
        list t = now();
        p += ((float)(llList2Integer(t, 0) - gAtS) + (float)(llList2Integer(t, 1) - gAtMs) / 1000.0) * gRate;
    }
    return p - gDuration * llFloor(p / gDuration);
}

// The date on the globe now, or the dataset's range when the clip's
// length isn't known, as for an image.
// The days in a month, for a month's anniversary that it lacks: the 31st
// of a monthly series falls on the 28th, 29th or 30th where there is no
// 31st.
integer monthDays(integer y, integer m)
{
    if (m == 12) return days(y + 1, 1, 1) - days(y, 12, 1);
    return days(y, m + 1, 1) - days(y, m, 1);
}

string date()
{
    if (!gDated) return "";
    if (gDuration <= 0.0) return range();
    float f = position() / gDuration;
    if (f < 0.0) f = 0.0;
    if (f > 1.0) f = 1.0;
    float into = f * ((float)(gEndDay - gStartDay) * 86400.0 + (float)(gEndSec - gStartSec));
    if (gRes != RES_TIME)
    {
        list a = civil(gStartDay);
        list e = civil(gEndDay);
        integer sy = llList2Integer(a, 0);
        integer sm = llList2Integer(a, 1);
        integer ey = llList2Integer(e, 0);
        integer em = llList2Integer(e, 1);
        if (gFrames)
        {
            // A day, month or year a frame: the clip holds one per whole
            // period, evenly, the first at the start and the last at the
            // end, so the label is the frame's own and changes with it.
            integer sd = llList2Integer(a, 2);
            integer ed = llList2Integer(e, 2);
            integer ad = sd;
            integer n;
            if (gRes == RES_DAY) n = gEndDay - gStartDay - (gEndSec < gStartSec);
            else
            {
                if (ad > monthDays(ey, em)) ad = monthDays(ey, em);
                integer short = ed < ad || (ed == ad && gEndSec < gStartSec);
                if (gRes == RES_MONTH) n = ey * 12 + em - sy * 12 - sm - short;
                else n = ey - sy - (em < sm || (em == sm && short));
            }
            if (n < 0) n = 0;
            integer k = llFloor(f * (float)(n + 1));
            if (k > n) k = n;
            if (gRes == RES_DAY) return when(gStartDay + k, gStartSec);
            if (gRes == RES_YEAR) return (string)(sy + k);
            integer m = sy * 12 + sm - 1 + k;
            return llList2String(MONTHS, m % 12) + " " + (string)(m / 12);
        }
        // Otherwise the app's arithmetic: the moment that share of the span
        // in, shown to the day, month or year it falls in.
        float at = (float)gStartSec + into;
        integer d = gStartDay + llFloor(at / 86400.0);
        if (d > gEndDay) d = gEndDay;
        return when(d, 0);
    }
    float off = (float)gStartSec + into;
    integer dd = llFloor(off / 86400.0);
    integer day = gStartDay + dd;
    integer sec = (integer)(off - (float)dd * 86400.0);
    if (sec < 0) sec = 0;
    if (sec > 86399) sec = 86399;
    // A time: to the period when a day holds a whole number of them, as the
    // app snaps it, else to the minute.
    integer step = 60;
    if (gSnapS > 0 && 86400 % gSnapS == 0) step = gSnapS;
    sec = (sec + step / 2) / step * step;
    if (sec >= 86400) { sec -= 86400; ++day; }
    if (day > gEndDay || (day == gEndDay && sec > gEndSec)) { day = gEndDay; sec = gEndSec; }
    if (day < gStartDay || (day == gStartDay && sec < gStartSec)) { day = gStartDay; sec = gStartSec; }
    return when(day, sec);
}

// The bytes a string takes in UTF-8, which is what the hover text's and
// a chat line's limits count.
integer bytes(string s)
{
    string b = llStringToBase64(s);
    integer pads = 0;
    if (llGetSubString(b, -2, -1) == "==") pads = 2;
    else if (llGetSubString(b, -1, -1) == "=") pads = 1;
    return llStringLength(b) / 4 * 3 - pads;
}

// A string cut to fit, with "..." to say so. A character takes at least a
// byte, so the first cut is by characters and the rest is only for text
// that isn't ASCII.
string fit(string s, integer max)
{
    if (bytes(s) <= max) return s;
    if (max < 4) return "";
    s = llGetSubString(s, 0, max - 4);
    while (bytes(s) > max - 3) s = llDeleteSubString(s, -1, -1);
    return llStringTrim(s, STRING_TRIM_TAIL) + "...";
}

// What the dataset is called: the name the globe was given (the menu's,
// a notecard's, a preset's, or one typed after /9 show <id>), or the
// card's title for one shown by its id alone, which the globe then names
// by the id, and which means nothing to a visitor.
string called()
{
    if ((gTitle == "" || gTitle == gDataset) && gFor == gDataset && gCardTitle != "") return gCardTitle;
    return gTitle;
}

hover()
{
    string title = called();
    string credit = LIVE_CREDIT;
    string stamp = "";
    if (gDataset == "") title = LIVE_LINE;
    else
    {
        credit = "";
        if (gFor == gDataset && gHaveRec)
        {
            string lic = gSpdx;
            if (gWho != "" && lic != "") credit = "Credit: " + gWho + " · " + lic;
            else if (gWho != "" || lic != "") credit = "Credit: " + gWho + lic;
            stamp = date();
        }
    }
    string tail = "";
    if (stamp != "") tail += "\n" + stamp;
    if (gTelemetry) tail += "\nCounts anonymous use: " + gNode + "/privacy";
    string end = "";
    if (gTalk) end += "\n" + TALK_LINE;
    end += "\n" + TOUCH_LINE;

    integer avail = 254 - bytes(tail) - bytes(end);
    if (credit != "") avail -= 1;
    integer t = bytes(title);
    integer c = bytes(credit);
    if (t + c > avail)
    {
        integer keepC = c;
        if (keepC > MIN_CREDIT) keepC = MIN_CREDIT;
        integer keepT = avail - keepC;
        if (keepT < MIN_TITLE) keepT = MIN_TITLE;
        if (keepT > avail) keepT = avail;
        if (keepT > t) keepT = t;
        title = fit(title, keepT);
        credit = fit(credit, avail - bytes(title));
    }
    string s = title + tail;
    if (credit != "") s += "\n" + credit;
    s += end;
    if (bytes(s) > 254) s = fit(s, 254);
    if (s == gShown) return;
    gShown = s;
    llSetText(s, <1.0, 1.0, 1.0>, 1.0);
}

// The timer runs while a clip's date moves, and while a request waits to
// be made again.
pace()
{
    integer moving = gDataset != "" && !gPaused && gDated && gDuration > 0.0 && gFor == gDataset;
    if (moving || gRetryAt) llSetTimerEvent(TICK);
    else llSetTimerEvent(0.0);
}

later(integer s)
{
    integer at = llGetUnixTime() + s;
    if (gRetryAt == 0 || at < gRetryAt) gRetryAt = at;
}

// Asks for the dataset's card. It is asked for when the dataset changes,
// and again only when a request failed or the node said to.
fetch()
{
    if (gDataset == "" || gNode == "" || gTries >= TRIES) return;
    if (gReq) return;
    ++gTries;
    gReq = llHTTPRequest(gNode + "/api/exhibit/v1/datasets/" + llEscapeURL(gDataset), [HTTP_METHOD, "GET",
        HTTP_ACCEPT, "application/json", HTTP_BODY_MAXLENGTH, CARD_MAX + 1], "");
    // A request Second Life throttled gets no key and never an answer.
    if (gReq == NULL_KEY) later(30);
}

// A card's string, or "" for a field it lacks. The node takes out what a
// script can't hold, so no value can be read as a JSON_ constant.
string value(string card, string name)
{
    string v = llJsonGetValue(card, [name]);
    if (v == JSON_INVALID) return "";
    return v;
}

// Answers whoever paused, played or moved the clip, with the date the
// globe now shows: the clip's seconds mean nothing to a visitor. A dataset
// with no dates gets the plain word, as does one whose clip length isn't
// known: not yet, or never, for a video with no playlist to read.
moved(key who)
{
    string d = "";
    // The date at the position the globe broadcast, which it took before
    // setting the media, and that takes a second: a playing clip has moved
    // on since by a second times its rate.
    integer paused = gPaused;
    gPaused = TRUE;
    if (gFor == gDataset && gDuration > 0.0) d = date();
    gPaused = paused;
    string s = "Playing.";
    if (d != "") s = "Playing from " + d + ".";
    if (gPaused)
    {
        s = "Paused.";
        if (d != "") s = "Paused at " + d + ".";
        s += " Everyone at the globe holds this frame.";
    }
    if (who == llGetOwner()) llOwnerSay("[exhibit] " + s);
    else llRegionSayTo(who, 0, s);
}

// The globe shows a choice without asking the node first, since holding
// the node's reply ran it out of memory (in-world, October 2026). So this
// script, which reads the card anyway, puts it back on the live Earth
// when the page can't show it, and tells the owner why and whoever chose
// it that it can't be shown. The request names the dataset, so a globe
// that has gone on to another since leaves that one up, which is why
// neither is told where the globe is now.
unshowable(string why)
{
    llOwnerSay("[exhibit] " + gDataset + " " + why + ", so the globe won't show it.");
    if (gChose)
        if (gChose != llGetOwner())
            llRegionSayTo(gChose, 0, "That dataset can't be shown on this globe after all.");
    gChose = NULL_KEY;
    gHaveRec = TRUE;   // nothing more to ask the node about it
    llMessageLinked(LINK_THIS, MSG_CONTROL, "earth " + gDataset, NULL_KEY);
}

// What a card says, kept. A reply that isn't a card, or one longer than
// a card can be, changes nothing. An older node answers with the app's
// page, but so does any node while its Functions are down (a spent daily
// quota, say), so it is asked again a minute later, and only once the
// tries are spent is the owner told, once.
card(string b, integer cut)
{
    string kind = llJsonGetValue(b, ["kind"]);
    if (cut || kind == JSON_INVALID)
    {
        if (gTries < TRIES) { later(60); return; }
        // A card already read stands (a retry's), so there is nothing to
        // tell, and the owner is still to be told of the next that fails.
        if (!gToldNode && !gHaveRec)
        {
            llOwnerSay("[exhibit] " + gNode + " sent no dataset card. A node older than the exhibit's reads has "
                + "none, and one whose Functions are down sends its page instead. The hover text shows titles "
                + "alone, and About gives the dataset's page.");
            gToldNode = TRUE;
        }
        return;
    }
    // The node says whether the page can show it, which the kind alone
    // doesn't: a video it can't reach is a video. The kinds are an open
    // set, and this script shows only the two it knows.
    if (kind == "tour") { unshowable("is a tour, which drives the full app rather than a globe"); return; }
    if (llJsonGetValue(b, ["showable"]) != JSON_TRUE || (kind != "video" && kind != "image"))
    {
        unshowable("is a dataset (" + kind + ") the page can't show");
        return;
    }
    gChose = NULL_KEY;   // it can be shown, so nobody needs telling
    gVideo = kind == "video";
    gCardTitle = value(b, "title");
    gPage = value(b, "page");
    if (llGetSubString(gPage, 0, 0) != "/") gPage = "/dataset/" + gDataset;
    gWho = value(b, "credit");
    gSpdx = value(b, "license");
    gLicText = value(b, "licenseText");
    // A JSON true reads as JSON_TRUE: (integer) of it is 0.
    gCut = llJsonGetValue(b, ["truncated"]) == JSON_TRUE;
    gAbstract = value(b, "abstract");
    if (llStringLength(gAbstract) > ABSTRACT_MAX)
    {
        // At a space in the last half, where there is one, as the node cuts.
        integer sp = ABSTRACT_MAX;
        while (sp > ABSTRACT_MAX / 2 && llOrd(gAbstract, sp) != 32) --sp;
        if (sp <= ABSTRACT_MAX / 2) sp = ABSTRACT_MAX;
        gAbstract = llStringTrim(llGetSubString(gAbstract, 0, sp - 1), STRING_TRIM_TAIL) + "...";
        gCut = TRUE;
    }
    list a = instant(value(b, "startTime"));
    list e = instant(value(b, "endTime"));
    gDated = a != [] && e != [];
    if (gDated)
    {
        gStartDay = llList2Integer(a, 0); gStartSec = llList2Integer(a, 1);
        gEndDay = llList2Integer(e, 0); gEndSec = llList2Integer(e, 1);
        if (gEndDay < gStartDay || (gEndDay == gStartDay && gEndSec < gStartSec)) gDated = FALSE;
    }
    string p = value(b, "period");
    period(p);
    gFrames = p == "P1D" || p == "P1M" || p == "P1Y";
    // The clip's exact length, or 0 when the node has none, as for a
    // single file.
    gDuration = (float)value(b, "exactDuration");
    if (gDuration < 0.0) gDuration = 0.0;
    // The node's read of the length didn't settle, and it says when to ask
    // again. The rest of the card stands meanwhile, showing the range.
    integer retry = (integer)value(b, "retry");
    if (gVideo && gDuration == 0.0 && retry > 0) later(retry);
    gHaveRec = TRUE;
}

// Chat to one visitor, in pieces that fit a chat line, cut between words.
// A piece is measured a character at a time, which copies nothing, since
// the text is the most this script holds while answering.
say(key av, string text)
{
    while (text != "")
    {
        integer len = llStringLength(text);
        integer n = 0;
        integer b = 0;
        while (n < len && b <= PIECE)
        {
            integer c = llOrd(text, n);
            b += 1 + (c >= 128) + (c >= 2048) + (c >= 65536);
            ++n;
        }
        if (b <= PIECE) { llRegionSayTo(av, 0, llStringTrim(text, STRING_TRIM)); return; }
        --n;
        integer sp = n - 1;
        while (sp > n / 2 && llOrd(text, sp) != 32 && llOrd(text, sp) != 10) --sp;
        if (sp > n / 2) n = sp + 1;
        llRegionSayTo(av, 0, llStringTrim(llGetSubString(text, 0, n - 1), STRING_TRIM));
        text = llStringTrim(llDeleteSubString(text, 0, n - 1), STRING_TRIM_HEAD);
    }
}

about(key av)
{
    // A visitor pressing About twice is answered once.
    integer t = llGetUnixTime();
    if (av == gLastAbout && t - gLastAboutAt < 10) return;
    gLastAbout = av;
    gLastAboutAt = t;

    if (gDataset == "") { say(av, LIVE_ABOUT + " TerraViz: " + gNode); return; }
    string title = called();
    if (llGetInventoryType(gDataset) == INVENTORY_NOTECARD)
    {
        // Without copy it would move to the first visitor, and without
        // transfer it can't be given at all.
        // The owner needs no transfer permission to be given their own.
        integer perms = llGetInventoryPermMask(gDataset, MASK_OWNER);
        if ((perms & PERM_COPY) && ((perms & PERM_TRANSFER) || av == llGetOwner()))
        {
            llRegionSayTo(av, 0, "Here is a notecard about " + title + ".");
            llGiveInventory(av, gDataset);
            return;
        }
        // Once a dataset, or a busy exhibit would fill the owner's chat.
        if (gWarned != gDataset)
            llOwnerSay("[exhibit] The notecard " + gDataset + " needs copy and transfer permission to be given. "
                + "Visitors get the chat version instead.");
        gWarned = gDataset;
    }
    string link = gNode + "/dataset/" + gDataset;
    if (gFor != gDataset || !gHaveRec)
    {
        say(av, title + ". More about it: " + link);
        return;
    }
    link = gNode + gPage;
    // Lines in a list, joined once, rather than a string copied whole for
    // each line added.
    list lines = [title];
    string r = range();
    if (r != "") lines = [title + " (" + r + ")"];
    if (gAbstract != "") lines += [gAbstract];
    if (gWho != "") lines += ["Credit: " + gWho];
    string lic = llStringTrim(gSpdx + " " + gLicText, STRING_TRIM);
    if (lic != "") lines += ["Licence: " + lic];
    lic = "";
    if (gCut) lines += ["Some of this was too long to give here. All of it is at " + link];
    else lines += ["More about it: " + link];
    say(av, llDumpList2String(lines, "\n"));
}

// The most memory used since the profiler was started, kept for "/9
// memory": reading a card and answering "About" are when this script
// needs the most.
peak()
{
    llScriptProfiler(PROFILE_NONE);
    if (llGetSPMaxMemory() > gPeak) gPeak = llGetSPMaxMemory();
}

forget()
{
    gFor = gDataset;
    gHaveRec = FALSE;
    gVideo = FALSE;
    gDated = FALSE;
    gDuration = 0.0;
    gFrames = FALSE;
    gPage = "/dataset/" + gDataset;
    gCardTitle = "";
    gWho = ""; gSpdx = ""; gLicText = ""; gAbstract = "";
    gCut = FALSE;
    gTries = 0;
    gRetryAt = 0;
    gReq = NULL_KEY;
}

default
{
    state_entry()
    {
        llListen(CHAN, "", llGetOwner(), "");
        llSetText("", <1.0, 1.0, 1.0>, 1.0);
        gShown = "";
        llMessageLinked(LINK_THIS, MSG_HELLO, "", NULL_KEY);
    }

    on_rez(integer p) { llResetScript(); }

    changed(integer c)
    {
        if (c & CHANGED_OWNER) llResetScript();
        // A region restart drops a request in flight, which then never
        // answers, so it is asked again; and the timer is set again, for a
        // retry only scheduled or a clip's moving date.
        if (c & CHANGED_REGION_START)
        {
            if (gReq) { gReq = NULL_KEY; later(10); }
            pace();
        }
    }

    link_message(integer sender, integer n, string str, key id)
    {
        if (n == MSG_TALK) { gTalk = str == "1"; hover(); return; }
        if (n == MSG_ABOUT)
        {
            llScriptProfiler(PROFILE_SCRIPT_MEMORY);
            about(id);
            peak();
            return;
        }
        if (n != MSG_STATE) return;
        string dataset = llJsonGetValue(str, ["dataset"]);
        if (dataset == JSON_INVALID) return;
        gDataset = dataset;
        gTitle = llJsonGetValue(str, ["title"]);
        gPos = (float)llJsonGetValue(str, ["pos"]);
        gAtS = (integer)llJsonGetValue(str, ["atS"]);
        gAtMs = (integer)llJsonGetValue(str, ["atMs"]);
        gRate = (float)llJsonGetValue(str, ["rate"]);
        gPaused = (integer)llJsonGetValue(str, ["paused"]);
        gTelemetry = (integer)llJsonGetValue(str, ["telemetry"]);
        // A node the owner hasn't been told about gets its own word.
        string node = llJsonGetValue(str, ["node"]);
        if (node != gNode) gToldNode = FALSE;
        gNode = node;
        // The globe names who changed what it shows: who chose a dataset,
        // told if it can't be shown, or who paused, played or moved the
        // clip, told the date it now shows. A key is true only when it is
        // a real one.
        if (gDataset != gFor)
        {
            forget();
            gChose = id;
            fetch();
        }
        else if (id) moved(id);
        hover();
        pace();
    }

    http_response(key req, integer status, list meta, string body)
    {
        if (req != gReq) return;
        gReq = NULL_KEY;
        // Only the node's own 404, which says so in its JSON, means there is
        // no such dataset: anything between here and the node can answer 404.
        if (status == 404)
            if (llJsonGetValue(body, ["error"]) == "not_found") { unshowable("isn't a dataset on the node"); pace(); return; }
        // Second Life answers a reply that isn't the JSON asked for with
        // its own 415 rather than handing it over (found in-world): the
        // app's page from a node with no cards, or from one whose
        // Functions are down. That is no card, as card() treats it.
        if (status == 415) { card("", TRUE); hover(); pace(); return; }
        // A failure (a 503, or Second Life's 499 for a timeout) is asked
        // again, as many times as TRIES allows, and the owner is told,
        // once a node, with the status, when the last fails too, unless a
        // card was read before it (a retry's), which still stands.
        if (status != 200)
        {
            if (gTries < TRIES) later(30);
            else if (!gToldNode && !gHaveRec)
            {
                llOwnerSay("[exhibit] " + gNode + " didn't answer for " + gDataset + " after " + (string)TRIES
                    + " tries (HTTP " + (string)status + "). The hover text shows the title alone.");
                gToldNode = TRUE;
            }
        }
        else
        {
            llScriptProfiler(PROFILE_SCRIPT_MEMORY);
            card(body, llListFindList(meta, [HTTP_BODY_TRUNCATED]) != -1);
            peak();
        }
        hover();
        pace();
    }

    timer()
    {
        if (gRetryAt && llGetUnixTime() >= gRetryAt)
        {
            gRetryAt = 0;
            fetch();
        }
        hover();
        pace();
    }

    listen(integer ch, string name, key who, string msg)
    {
        if (llToLower(llStringTrim(msg, STRING_TRIM)) != "memory") return;
        string most = "";
        if (gPeak) most = ", and at most " + (string)(gPeak / 1024) + " KB while reading a card or answering About";
        llOwnerSay("[exhibit] Info script: " + (string)(llGetUsedMemory() / 1024) + " KB used of 64" + most + ".");
    }
}
