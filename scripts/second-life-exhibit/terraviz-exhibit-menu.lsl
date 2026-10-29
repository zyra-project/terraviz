// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// TerraViz exhibit globe - the menu script.
//
// ABOUT TERRAVIZ
// TerraViz is a free, open-source globe for environmental data, most of
// it from NOAA's Science On a Sphere collection.
//   The app:     https://terraviz.zyra-project.org
//   The source:  https://github.com/zyra-project/terraviz
//
// WHAT THIS SCRIPT DOES
// It is one of the exhibit's four scripts: the dataset menu read from the
// node's catalog, which terraviz-exhibit-visitors.lsl opens for whoever
// chooses Datasets when the globe has no "datasets" notecard. It is a
// script of its own because the visitors script had no room left for it
// (a Stack-Heap Collision in-world, 27 October 2026), and in a prim of its
// own, linked to the globe, because a web reply reaches every script in
// the prim it arrives in, and the info script there has little room to
// spare while it reads a card.
// - The menu opens on the node's categories, with how many datasets each
//   has, and "All datasets", since some are in none. A category opens its
//   datasets nine to a page, in the order the app's browse lists them.
// - On a page the buttons are numbers and the titles are in the menu's
//   text, since most titles are longer than a button holds and some cut
//   alike. The numbers count from the category's first dataset, 10 to 18
//   on its second page, so a button pressed on an older page answers
//   nothing rather than the wrong dataset.
// - A choice goes back to the visitors script, which holds it to the hold
//   and any talk, as it does a choice from the notecard's menu.
// - When the node can't give the menu, the visitor gets the visitors
//   script's built-in datasets, and the owner is told why, once until the
//   node answers again.
//
// It reads the node itself (/api/exhibit/v1/tags and
// /api/exhibit/v1/datasets), asking only for a category and where a page
// starts, nothing about who asked. The visitors script says which node,
// and the "categories" line of the globe's "settings" notecard, each time
// it opens the menu: "categories = Water, Air" narrows the menu to those of
// the node's categories, by name in any case and in that order, with "All
// datasets" among them if named.
//
// A copy of this script in the globe's own prim answers nothing, so the
// visitors script gives the built-in datasets and tells the owner it goes
// in a prim of its own. It gives this prim the globe's name, which heads
// its menus. One exhibit to an object: two globes linked into one build
// would each open the other's menu.
//
// The owner can ask "/9 memory": this script says how much of its 64 KB it
// uses, and the most it has used reading the node for a menu.

integer CHAN = 9;

// The link messages this script and the visitors script share, sent to the
// whole object (LINK_SET) since they are in different prims.
// exhibit.test.ts holds the numbers to the visitors script's.
// The menu's own numbers are new ones, never the earlier relay's
// (271006, 271007), so a prim holding scripts of both builds can't take
// one message for the other.
integer MSG_MENU_OPEN = 271008;  // visitors to menu: the node, the categories and when, in lines; open the menu for the key
integer MSG_MENU_DONE = 271009;  // menu to visitors: "open", then "show <id> <title>", "main" or "datasets", for the key

// A page's budget and the categories', in bytes, as the node states them.
// A request reads one byte more, so a reply of exactly the budget can't
// read as cut, whichever way Second Life counts the limit.
integer PAGE_BYTES = 1024;
integer TAGS_BYTES = 2048;
integer PAGE = 9;            // datasets a page shows, beside its three moves
integer TAGS_TTL = 600;      // seconds the node's categories are kept before asking again
integer LIVE_PAGES = 4;      // pages kept for visitors with one open, each at most 1 KB as the node sent it
integer CTX_TTL = 300;       // seconds a menu stays answerable after it opened
integer CTX_MAX = 8;         // menus open at once
// An open this many whole seconds old by the region's clock goes
// unanswered: the visitors script gives the built-in datasets at its
// MENU_WAIT (6), and an answer that late could reach it after them, a
// second menu on the first. So this script answers for two to three
// seconds, and an answer has over three seconds to cross the object before
// the built-in datasets go; exhibit.test.ts holds the margin. A region
// slower than that can still show both.
integer OPEN_LATE = 3;

// The ids the globe script takes. exhibit.test.ts holds them to its.
string  ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
integer ID_MAX = 128;

string  BTN_PREV = "< Previous";
string  BTN_NEXT = "Next >";
string  BTN_MENU = "Main menu";
string  BTN_ALL = "All datasets";
string  BTN_KINDS = "Categories";

string  gNode;               // the node the globe shows, from the visitors script
string  gCats;               // the settings notecard's "categories", as written
list    gCategories;         // those, or [] for all the node's
list    gTags;               // the node's categories: tag, count, tag, count...
integer gTagsAt;             // when the node gave them, 0 for never
integer gKindsAt;            // when the categories offered last changed
list    gPages;              // pages open: who, tag, list, the page as the node sent it
list    gRefetched;          // who has been sent past an end to the last page, and not yet shown one
list    gReqs;               // reads in flight: request, who
list    gCtx;                // who, their categories page, when: one entry per visitor with a menu open
integer gTold;               // the owner has been told the node isn't giving the menu
integer gPeak;               // the most memory used reading the node for a menu

// Each kind of menu answers on its own channel, so an answer from an
// older menu still means what that menu meant.
integer gDlgKinds;           // the categories
integer gDlgLive;            // a page of datasets

integer unix() { return llGetUnixTime(); }

integer isId(string s)
{
    integer n = llStringLength(s);
    if (n < 1 || n > ID_MAX) return FALSE;
    integer i;
    for (i = 0; i < n; ++i)
        if (llSubStringIndex(ID_CHARS, llGetSubString(s, i, i)) == -1) return FALSE;
    return TRUE;
}

// The bytes a string takes in UTF-8, which is what a menu's limits count:
// 24 for a button, 512 for the message.
integer bytes(string s)
{
    string b = llStringToBase64(s);
    integer n = llStringLength(b);
    integer pad = 0;
    if (llGetSubString(b, -2, -1) == "==") pad = 2;
    else if (llGetSubString(b, -1, -1) == "=") pad = 1;
    return n / 4 * 3 - pad;
}

// A string cut to fit, since a menu past either limit isn't shown at all.
// A character takes at least a byte, so the first cut is by characters.
string fit(string s, integer max)
{
    // Nothing fits in no room, and below one byte the loop below never ends.
    if (max < 1) return "";
    if (bytes(s) <= max) return s;
    s = llGetSubString(s, 0, max - 1);
    while (bytes(s) > max) s = llDeleteSubString(s, -1, -1);
    return s;
}

// Trimmed after the cut, so a name cut at a space matches what a viewer
// that trims its buttons sends back.
string label(string name) { return llStringTrim(fit(name, 24), STRING_TRIM); }

// A menu draws its buttons from the bottom row up. These are in reading
// order, so the rows go in reversed, with the odd ones out on top.
list layout(list b)
{
    integer n = llGetListLength(b);
    integer top = n % 3;
    if (top == 0) top = 3;
    list out = llList2List(b, 0, top - 1);
    integer i;
    for (i = top; i < n; i += 3) out = llList2List(b, i, i + 2) + out;
    return out;
}

menu(key who, string text, list b, integer channel)
{
    llDialog(who, fit(text, 500), layout(b), channel);
}

remember(key who, integer page)
{
    integer at = llListFindList(gCtx, [who]);
    if (at != -1) gCtx = llDeleteSubList(gCtx, at, at + 2);
    gCtx += [who, page, unix()];
    while (llGetListLength(gCtx) > CTX_MAX * 3) gCtx = llDeleteSubList(gCtx, 0, 2);
}

// The categories page this visitor's open menu is on, or 0 with none open.
integer pageOf(key who)
{
    integer at = llListFindList(gCtx, [who]);
    if (at == -1) return 0;
    return llList2Integer(gCtx, at + 1);
}

// To the visitors script, for this visitor.
done(key who, string what)
{
    llMessageLinked(LINK_SET, MSG_MENU_DONE, what, who);
}

// A reply's string, or "" for a value it lacks.
string value(string body, list path)
{
    string v = llJsonGetValue(body, path);
    if (v == JSON_INVALID) return "";
    return v;
}

// Forgets this visitor's read in flight, so its reply, when it comes,
// opens nothing over the menu they have by then.
drop(key who)
{
    integer at = llListFindList(gReqs, [who]);
    if (at != -1 && at % 2 == 1) gReqs = llDeleteSubList(gReqs, at - 1, at);
}

// Asks the node for this visitor: one read in flight each, so a slow reply
// to a read they have since replaced opens nothing. Their menu stays
// answerable from now, since the reply opens the next one.
read(key who, string path, integer budget)
{
    remember(who, pageOf(who));
    drop(who);
    if (gNode == "") { liveFailed(who, failure(0)); return; }
    key req = llHTTPRequest(gNode + path, [HTTP_METHOD, "GET", HTTP_ACCEPT, "application/json",
        HTTP_BODY_MAXLENGTH, budget + 1], "");
    // Throttled: no key, and never an answer.
    if (req == NULL_KEY) { liveFailed(who, failure(-1)); return; }
    gReqs += [req, who];
    while (llGetListLength(gReqs) > CTX_MAX * 2) gReqs = llDeleteSubList(gReqs, 0, 1);
}

askPage(key who, string tag, integer offset)
{
    read(who, "/api/exhibit/v1/datasets?limit=9&offset=" + (string)offset + "&tag=" + llEscapeURL(tag), PAGE_BYTES);
}

// The menu, for a visitor the visitors script let open it: the categories,
// kept TAGS_TTL.
open(key who)
{
    if (gTagsAt == 0 || unix() - gTagsAt > TAGS_TTL) read(who, "/api/exhibit/v1/tags", TAGS_BYTES);
    else kindsMenu(who, 0);
}

// The categories the menu offers. With the settings notecard's, those the
// node has, in the owner's order and whatever their case, "All datasets"
// among them if named. Otherwise "" for all the datasets, since some are in
// none, and then every category, most datasets first, as the node lists
// them.
list kinds()
{
    list tags = llList2ListStrided(gTags, 0, -1, 2);
    if (gCategories == []) return [""] + tags;
    list out = [];
    integer i;
    integer j;
    for (i = 0; i < llGetListLength(gCategories); ++i)
    {
        string c = llToLower(llList2String(gCategories, i));
        if (c == llToLower(BTN_ALL) && llListFindList(out, [""]) == -1) out += [""];
        for (j = 0; j < llGetListLength(tags); ++j)
        {
            string t = llList2String(tags, j);
            if (llToLower(t) == c && llListFindList(out, [t]) == -1) out += [t];
        }
    }
    return out;
}

string kindName(string tag)
{
    if (tag == "") return BTN_ALL;
    return tag;
}

// Whether a page of categories can name its buttons: each name fits a
// button whole, and none is another's or a move's. Otherwise its buttons
// are numbers, as a page of datasets' are.
integer named(list tags)
{
    list seen = [BTN_PREV, BTN_NEXT, BTN_MENU];
    integer i;
    for (i = 0; i < llGetListLength(tags); ++i)
    {
        string l = kindName(llList2String(tags, i));
        if (label(l) != l || llListFindList(seen, [l]) != -1) return FALSE;
        seen += [l];
    }
    return TRUE;
}

// The categories, nine to a page. Numbered buttons count from the first
// category, as a page of datasets' do from its first dataset.
kindsMenu(key who, integer page)
{
    // Shown without asking the node, so a page still on its way for this
    // visitor would land over it: forgotten (found in review).
    drop(who);
    // Back at the categories, the next page isn't paging on from the last.
    integer at = llListFindList(gPages, [who]);
    if (at != -1 && at % 4 == 0) gPages = llDeleteSubList(gPages, at, at + 3);
    list k = kinds();
    integer count = llGetListLength(k);
    if (count == 0) { liveFailed(who, "it has none of the settings notecard's categories"); return; }
    // One to choose from: its datasets at once.
    if (count == 1) { askPage(who, llList2String(k, 0), 0); return; }
    integer pages = (count + PAGE - 1) / PAGE;
    if (page < 0) page = pages - 1;
    if (page >= pages) page = 0;
    list tags = llList2List(k, page * PAGE, page * PAGE + PAGE - 1);
    integer n = llGetListLength(tags);
    integer byName = named(tags);
    string text = "Choose a category of datasets for the globe.";
    if (pages > 1) text += " Page " + (string)(page + 1) + " of " + (string)pages + ".";
    // The names share the text's room, as a page's titles do.
    integer room = (500 - bytes(text)) / n - 1;
    list b = [];
    integer i;
    for (i = 0; i < n; ++i)
    {
        string c = llList2String(tags, i);
        string l = kindName(c);
        if (c != "") l += " (" + (string)llList2Integer(gTags, llListFindList(gTags, [c]) + 1) + ")";
        if (byName) b += [kindName(c)];
        else
        {
            string number = (string)(page * PAGE + i + 1);
            l = number + ". " + l;
            b += [number];
        }
        text += "\n" + fit(l, room);
    }
    if (pages > 1) b += [BTN_PREV, BTN_MENU, BTN_NEXT];
    else b += [BTN_MENU];
    remember(who, page);
    menu(who, text, b, gDlgKinds);
}

// Why the node gave no menu, from a read's status: 0 with no node yet and
// -1 for a request Second Life throttled.
string failure(integer status)
{
    if (status == -1) return "Second Life is limiting this object's web requests";
    if (status == 0) return "the globe has no node yet";
    if (status == 415) return "its reply wasn't JSON. A node from before October 2026 has no menu, "
        + "and one whose Functions are down sends its page instead";
    if (status == 200) return "its reply wasn't a menu this script can read";
    return "it answered HTTP " + (string)status;
}

// The node gave no menu: this visitor gets the built-in datasets, and the
// owner hears why, once until the node gives one again.
liveFailed(key who, string why)
{
    integer asked = llListFindList(gRefetched, [who]);
    if (asked != -1) gRefetched = llDeleteSubList(gRefetched, asked, asked);
    if (!gTold)
        llOwnerSay("[exhibit] The node didn't give the dataset menu: " + why + ". Visitors get the built-in datasets until it does.");
    gTold = TRUE;
    done(who, "datasets");
}

// The node's categories, then the menu of them.
tagsRead(key who, string body)
{
    string before = llDumpList2String(kinds(), "\n");
    gTags = [];
    integer i;
    while (i < 30 && llJsonValueType(body, ["tags", i]) != JSON_INVALID)
    {
        // A tag past the node's own cap is left out, as the node leaves one out.
        string t = value(body, ["tags", i, "tag"]);
        if (t != "" && llStringLength(t) <= 40) gTags += [t, (integer)llJsonGetValue(body, ["tags", i, "count"])];
        ++i;
    }
    gTagsAt = unix();
    // A categories menu still open answers by what it showed, so it is
    // shown again rather than answered once they have changed.
    if (llDumpList2String(kinds(), "\n") != before) gKindsAt = gTagsAt;
    // Told once of categories the node lacks, not at every refresh.
    if (kinds() != []) gTold = FALSE;
    kindsMenu(who, 0);
}

// A page of the node's datasets: { total, offset, limit, tag, list,
// datasets: [{ id, title }] }. The buttons are numbers, counted from the
// category's first dataset, and the titles are in the text, sharing its
// room, so a long one is cut. The page is kept as the node sent it while
// the visitor's menu answers.
livePage(key who, string body)
{
    integer total = (integer)llJsonGetValue(body, ["total"]);
    integer offset = (integer)llJsonGetValue(body, ["offset"]);
    string tag = value(body, ["tag"]);
    // Ids the globe takes, no more than a page holds, each id and title
    // within the node's own caps (26 and 48 bytes, so as many characters at
    // most), or it isn't a page: a choice goes on to the globe script,
    // which has the least room.
    integer n = 0;
    integer ok = TRUE;
    while (ok && n <= PAGE && llJsonValueType(body, ["datasets", n]) != JSON_INVALID)
    {
        string id = value(body, ["datasets", n, "id"]);
        ok = isId(id) && llStringLength(id) <= 26 && llStringLength(value(body, ["datasets", n, "title"])) <= 48;
        ++n;
    }
    if (!ok || n > PAGE) { liveFailed(who, failure(200)); return; }
    if (n == 0)
    {
        // Past the end, as a page can be once the catalog has shrunk: its
        // last page, asked for once, since a node echoing an offset other
        // than the one asked for would otherwise be asked for ever.
        integer asked = llListFindList(gRefetched, [who]);
        if (total > 0 && asked == -1)
        {
            gRefetched += [who];
            if (llGetListLength(gRefetched) > CTX_MAX) gRefetched = llDeleteSubList(gRefetched, 0, 0);
            askPage(who, tag, (total - 1) / PAGE * PAGE);
            return;
        }
        if (asked != -1) gRefetched = llDeleteSubList(gRefetched, asked, asked);
        if (total > 0) { liveFailed(who, failure(200)); return; }
        // A category emptied since it was listed: the categories again,
        // unless it was the only one, which would open it again.
        if (tag != "" && llGetListLength(kinds()) > 1)
        {
            llRegionSayTo(who, 0, tag + " has no datasets the globe can show just now.");
            kindsMenu(who, 0);
            return;
        }
        liveFailed(who, "it has no datasets the globe can show");
        return;
    }
    integer sent = llListFindList(gRefetched, [who]);
    if (sent != -1) gRefetched = llDeleteSubList(gRefetched, sent, sent);
    gTold = FALSE;
    string text = kindName(tag) + ": " + (string)(offset + 1) + " to " + (string)(offset + n) + " of "
        + (string)total + ". Choose one for the globe.";
    // A page of the category this visitor is paging through, from another
    // list: a dataset may have moved between the two. A notice, never a
    // start over, since pages can come from lists a minute apart (the
    // node's listHash); and none when either page lacks a list.
    string from = value(body, ["list"]);
    integer at = llListFindList(gPages, [who]);
    if (at != -1 && at % 4 == 0)
    {
        string was = llList2String(gPages, at + 2);
        if (llList2String(gPages, at + 1) == tag && from != "" && was != "" && was != from)
            text += " A dataset may have moved between pages since the last one.";
        gPages = llDeleteSubList(gPages, at, at + 3);
    }
    integer room = (500 - bytes(text)) / n - 1;
    list b = [];
    integer i;
    for (i = 0; i < n; ++i)
    {
        string number = (string)(offset + i + 1);
        text += "\n" + fit(number + ". " + value(body, ["datasets", i, "title"]), room);
        b += [number];
    }
    // Back to the categories, or to the main menu when there were none to choose.
    string back = BTN_KINDS;
    if (llGetListLength(kinds()) < 2) back = BTN_MENU;
    if (total > PAGE) b += [BTN_PREV, back, BTN_NEXT];
    else b += [back];
    gPages += [who, tag, from, body];
    while (llGetListLength(gPages) > LIVE_PAGES * 4) gPages = llDeleteSubList(gPages, 0, 3);
    remember(who, pageOf(who));
    menu(who, text, b, gDlgLive);
}

default
{
    state_entry()
    {
        gDlgKinds = -4 - (integer)llFrand(1000000000.0);
        gDlgLive = gDlgKinds - 1;
        llListen(gDlgKinds, "", NULL_KEY, "");
        llListen(gDlgLive, "", NULL_KEY, "");
        llListen(CHAN, "", llGetOwner(), "");
        llSetTimerEvent(60.0);
    }

    on_rez(integer p) { llResetScript(); }

    changed(integer c)
    {
        if (c & CHANGED_OWNER) llResetScript();
        // A region restart drops a read in flight, which then never
        // answers: the visitor touches the globe again.
        if (c & CHANGED_REGION_START) gReqs = [];
    }

    timer()
    {
        // Menus nobody answered, and the pages that went with them.
        integer t = unix();
        while (gCtx != [] && t - llList2Integer(gCtx, 2) > CTX_TTL) gCtx = llDeleteSubList(gCtx, 0, 2);
        integer i = 0;
        while (i < llGetListLength(gPages))
        {
            if (llListFindList(gCtx, [llList2Key(gPages, i)]) == -1) gPages = llDeleteSubList(gPages, i, i + 3);
            else i += 4;
        }
        i = 0;
        while (i < llGetListLength(gRefetched))
        {
            if (llListFindList(gCtx, [llList2Key(gRefetched, i)]) == -1) gRefetched = llDeleteSubList(gRefetched, i, i);
            else ++i;
        }
    }

    link_message(integer sender, integer n, string str, key id)
    {
        // Only from another prim: a copy of this script in the globe's
        // prim stays silent, since its replies would reach the info script
        // there, which has little room to spare.
        if (n != MSG_MENU_OPEN || sender == llGetLinkNumber()) return;
        list w = llParseStringKeepNulls(str, ["\n"], []);
        // Asked too long ago: the visitors script gives its own datasets. An
        // open with no time, from a visitors script before 28 October 2026,
        // is answered, as it was then.
        if (llGetListLength(w) > 2)
            if (unix() - (integer)llList2String(w, 2) >= OPEN_LATE) return;
        // Said at once, so the visitors script knows this script is running
        // and doesn't give the visitor its built-in datasets.
        done(id, "open");
        // A menu is headed with its prim's name, so this prim takes the globe's.
        string name = llGetLinkName(sender);
        if (llGetObjectName() != name) llSetObjectName(name);
        string node = llList2String(w, 0);
        // Another node: nothing the last one said stands, a read still on
        // its way from it included, and the owner hears of this one's
        // trouble.
        if (node != gNode)
        {
            gTagsAt = 0;
            gTags = [];
            gPages = [];
            gReqs = [];
            gRefetched = [];
            gTold = FALSE;
        }
        gNode = node;
        // The owner's categories, when they change: names, not ids, between
        // commas, in the order the menu shows them.
        string cats = llList2String(w, 1);
        if (cats != gCats)
        {
            gCats = cats;
            gCategories = [];
            list parts = llParseString2List(cats, [","], []);
            integer i;
            for (i = 0; i < llGetListLength(parts); ++i)
            {
                string c = llStringTrim(llList2String(parts, i), STRING_TRIM);
                if (c != "") gCategories += [c];
            }
            // The categories offered changed, and the owner hears of the
            // new settings' trouble with the node.
            gKindsAt = unix();
            gTold = FALSE;
        }
        open(id);
    }

    http_response(key req, integer status, list meta, string body)
    {
        integer at = llListFindList(gReqs, [req]);
        if (at == -1 || at % 2 != 0) return;
        key who = llList2Key(gReqs, at + 1);
        gReqs = llDeleteSubList(gReqs, at, at + 1);
        // A visitor whose menu timed out meanwhile gets nothing.
        at = llListFindList(gCtx, [who]);
        if (at == -1 || at % 3 != 0) return;
        // Measured, for /9 memory: a page held while the next is shown is
        // when this script needs the most.
        llScriptProfiler(PROFILE_SCRIPT_MEMORY);
        if (status != 200 || llListFindList(meta, [HTTP_BODY_TRUNCATED]) != -1) liveFailed(who, failure(status));
        else if (llJsonValueType(body, ["datasets"]) == JSON_ARRAY) livePage(who, body);
        else if (llJsonValueType(body, ["tags"]) == JSON_ARRAY) tagsRead(who, body);
        else liveFailed(who, failure(200));
        llScriptProfiler(PROFILE_NONE);
        if (llGetSPMaxMemory() > gPeak) gPeak = llGetSPMaxMemory();
    }

    listen(integer ch, string name, key who, string msg)
    {
        if (ch == CHAN)
        {
            if (llToLower(llStringTrim(msg, STRING_TRIM)) != "memory") return;
            string most = "";
            if (gPeak) most = ", and at most " + (string)(gPeak / 1024) + " KB while reading the node for a menu";
            llOwnerSay("[exhibit] Menu script: " + (string)(llGetUsedMemory() / 1024) + " KB used of 64" + most + ".");
            return;
        }
        integer at = llListFindList(gCtx, [who]);
        // No menu of theirs is open, or it was shown longer ago than a
        // menu answers (the timer that forgets it runs once a minute).
        if (at == -1 || at % 3 != 0 || unix() - llList2Integer(gCtx, at + 2) > CTX_TTL) return;
        integer page = llList2Integer(gCtx, at + 1);
        if (msg == BTN_MENU) { drop(who); done(who, "main"); return; }

        if (ch == gDlgKinds)
        {
            // Answered after the categories offered changed: what it showed
            // may have moved, so it is shown again rather than answered.
            if (gKindsAt > llList2Integer(gCtx, at + 2)) { kindsMenu(who, page); return; }
            if (msg == BTN_PREV) { kindsMenu(who, page - 1); return; }
            if (msg == BTN_NEXT) { kindsMenu(who, page + 1); return; }
            list k = kinds();
            list tags = llList2List(k, page * PAGE, page * PAGE + PAGE - 1);
            // A name on that page, or a number counted from the first category.
            integer i = (integer)msg - 1;
            if (named(tags))
            {
                i = 0;
                while (i < llGetListLength(tags) && kindName(llList2String(tags, i)) != msg) ++i;
                if (i == llGetListLength(tags)) return;
                i += page * PAGE;
            }
            else if ((string)(i + 1) != msg) return;
            if (i >= 0 && i < llGetListLength(k)) askPage(who, llList2String(k, i), 0);
            return;
        }
        if (ch != gDlgLive) return;
        if (msg == BTN_KINDS) { kindsMenu(who, page); return; }
        integer p = llListFindList(gPages, [who]);
        // Its page gave way to newer ones: the categories again.
        if (p == -1 || p % 4 != 0) { open(who); return; }
        string body = llList2String(gPages, p + 3);
        string tag = value(body, ["tag"]);
        integer offset = (integer)llJsonGetValue(body, ["offset"]);
        integer total = (integer)llJsonGetValue(body, ["total"]);
        if (msg == BTN_NEXT)
        {
            offset += PAGE;
            if (offset >= total) offset = 0;
            askPage(who, tag, offset);
            return;
        }
        if (msg == BTN_PREV)
        {
            offset -= PAGE;
            if (offset < 0) offset = (total - 1) / PAGE * PAGE;
            askPage(who, tag, offset);
            return;
        }
        // The number pressed counts from the category's first dataset, so
        // one from an older page of theirs isn't taken for this one's.
        integer row = (integer)msg - 1 - offset;
        if ((string)(row + 1 + offset) != msg || row < 0 || llJsonValueType(body, ["datasets", row]) == JSON_INVALID) return;
        // The visitors script holds it to the hold and any talk.
        done(who, "show " + value(body, ["datasets", row, "id"]) + " " + value(body, ["datasets", row, "title"]));
    }
}
