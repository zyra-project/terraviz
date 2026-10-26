// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { serializeDataset } from '../../functions/api/v1/_lib/dataset-serializer'
import { CARD_BUDGET, CARD_SKELETON } from '../../functions/api/v1/_lib/exhibit-reads'
import type { DatasetRow } from '../../functions/api/v1/_lib/catalog-store'

// LSL compiles only in-world, so nothing here runs the scripts. What the
// globe script writes into the page's address is held to the page by
// ../second-life-probe/globe.test.ts, which checks both globe scripts.
// These tests hold the exhibit's three scripts to each other and to the
// node: a link message, a state key or a command one script renamed would
// leave the others quietly doing nothing, with no error anywhere.

const read = (file: string): string =>
  readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const globe = read('./terraviz-exhibit.lsl')
const visitors = read('./terraviz-exhibit-visitors.lsl')
const info = read('./terraviz-exhibit-info.lsl')
const SCRIPTS = { globe, visitors, info }
const readme = read('./README.md')
const plan = read('../../docs/SECOND_LIFE_COMPAT.md')

/** A global's initial value, as written. */
function constant(script: string, type: string, name: string): string {
  const value = script.match(new RegExp(`^${type}\\s+${name}\\s*=\\s*([^;]+);`, 'm'))?.[1]
  expect(value, `${type} ${name}`).toBeDefined()
  return (value as string).trim()
}

/** One LSL function's body: from its signature to the brace closing it at column 0. */
function body(script: string, signature: string): string {
  const start = script.indexOf(`\n${signature}\n{`)
  expect(start, signature).toBeGreaterThan(-1)
  return script.slice(start, script.indexOf('\n}\n', start))
}

/** The string literals in some LSL source. */
const literals = (source: string): string[] => [...source.matchAll(/"([^"]*)"/g)].map((m) => m[1])

/** Every capture of `pattern`'s first group in `source`. */
const all = (source: string, pattern: RegExp): string[] => [...source.matchAll(pattern)].map((m) => m[1])

const bytes = (s: string): number => new TextEncoder().encode(s).length

/** The MSG_* numbers a script declares. */
const messages = (script: string): Record<string, string> =>
  Object.fromEntries([...script.matchAll(/^integer\s+(MSG_\w+)\s*=\s*(\d+);/gm)].map((m) => [m[1], m[2]]))

describe('second-life exhibit scripts', () => {
  it('agree on the link-message numbers, and give each message its own', () => {
    const declared = Object.values(SCRIPTS).map(messages)
    const merged: Record<string, string> = {}
    for (const names of declared) {
      for (const [name, value] of Object.entries(names)) {
        expect(merged[name] ?? value, name).toBe(value)
        merged[name] = value
      }
    }
    expect(new Set(Object.values(merged)).size).toBe(Object.keys(merged).length)
    // Every message a script uses, it declares itself: a script reading
    // another's number from memory is the drift this guards against.
    for (const [name, script] of Object.entries(SCRIPTS)) {
      const used = new Set(all(script, /\b(MSG_\w+)\b/g))
      expect(new Set(Object.keys(messages(script))), name).toEqual(used)
    }
  })

  it('send every message to a script that handles it', () => {
    for (const [name, script] of Object.entries(SCRIPTS)) {
      for (const sent of new Set(all(script, /llMessageLinked\(LINK_THIS, (MSG_\w+)/g))) {
        const handlers = Object.entries(SCRIPTS).filter(
          ([other, s]) => other !== name && new RegExp(`\\bn [!=]= ${sent}\\b`).test(s),
        )
        expect(handlers.length, `${name} sends ${sent}`).toBeGreaterThan(0)
      }
    }
  })

  it('read only the state the globe broadcasts', () => {
    const list = body(globe, 'broadcast()').match(/llList2Json\(JSON_OBJECT, \[([\s\S]*?)\]\)/)?.[1] ?? ''
    // The keys are the literals; their values are the globe's variables.
    const broadcast = new Set(literals(list))
    expect(broadcast.size).toBeGreaterThan(0)
    for (const [name, script] of Object.entries({ visitors, info })) {
      const read = all(script, /llJsonGetValue\(str, \["(\w+)"\]\)/g)
      expect(read.length, name).toBeGreaterThan(0)
      for (const key of read) expect(broadcast, `${name} reads ${key}`).toContain(key)
    }
  })

  it('ask the globe only for what it lets a visitor do', () => {
    const act = body(globe, 'act(key who, integer owner, string msg)')
    const gate = act.indexOf("// Everything below is the owner's.")
    expect(gate).toBeGreaterThan(-1)
    const allowed = new Set(all(act.slice(0, gate), /cmd == "(\w+)"/g))
    const asked = new Set([
      ...all(visitors, /\bask\(who, "(\w+)/g),
      ...all(visitors, /MSG_CONTROL, "(\w+)/g),
    ])
    expect(asked).toEqual(new Set(['show', 'earth', 'rest', 'pause', 'play', 'jump', 'nudge', 'restart', 'turn', 'tilt', 'level']))
    for (const cmd of asked) expect(allowed, cmd).toContain(cmd)
    // The rate stays the owner's, even though the globe's check that the
    // live Earth has no clock to change names it before the gate. So does
    // the rotation a visitor's turn is undone back to.
    expect(asked).not.toContain('rate')
    expect(asked).not.toContain('rotation')
    expect(Number(constant(visitors, 'float', 'NUDGE'))).toBeLessThanOrEqual(Number(constant(globe, 'float', 'NUDGE_MAX')))
  })

  it('turn the globe east the way the Earth turns, and undo it when visitors leave', () => {
    // East moves the places facing a visitor to their right, so the
    // picture's centre shows a longitude further west: the address's
    // rotation goes down.
    const act = body(globe, 'act(key who, integer owner, string msg)')
    expect(act).toContain('gRotation = degrees(gRotation - (float)arg);')
    const turn = Number(constant(visitors, 'integer', 'TURN'))
    expect(turn).toBeGreaterThan(0)
    expect(turn).toBeLessThanOrEqual(360)
    expect(visitors).toContain('if (msg == BTN_EAST) ask(who, "turn " + (string)TURN);')
    expect(visitors).toContain('else if (msg == BTN_WEST) ask(who, "turn -" + (string)TURN);')
    // The owner's rotation is home, and the scripts' own return goes back
    // to it, even on a live Earth a visitor only turned.
    // Home is set before commit(), which tells the other scripts whether
    // the globe is turned from it.
    const rotation = act.slice(act.indexOf('if (cmd == "rotation")'))
    expect(rotation.indexOf('gHome = gRotation;')).toBeGreaterThan(-1)
    expect(rotation.indexOf('gHome = gRotation;')).toBeLessThan(rotation.indexOf('commit(saved)'))
    expect(act).toMatch(/if \(cmd == "rest"\)\n\s+\{\n\s+gRotation = gHome;\n\s+if \(gTilted\) level\(\);/)
    expect(body(visitors, 'check()')).toContain('(gDataset != "" || gTurned)')
  })

  it('tip a pole toward whoever asked, and stand the globe back up', () => {
    // A tilt turns the sphere itself, which the region sends every
    // viewer, toward the asker's own position, stepping no further than
    // facing them.
    const tilt = body(globe, 'integer tilt(key who, integer south)')
    expect(tilt).toContain('llGetObjectDetails(who, [OBJECT_POS])')
    expect(tilt).toContain('if (step > angle) step = angle;')
    expect(tilt).toContain('setRot(r * llAxisAngle2Rot(llVecNorm(axis), step));')
    expect(tilt).toContain('if (angle < 0.01) return 2;')
    expect(Number(constant(globe, 'float', 'TILT'))).toBe(30)
    // Set so it lands right on a child prim of a build too.
    expect(body(globe, 'setRot(rotation global)')).toContain('if (llGetLinkNumber() > 1) llSetLocalRot(global / llGetRootRotation());')
    expect(body(globe, 'upright()')).toContain('setRot(llEuler2Rot(')
    // The north pole is whichever of the sphere's own axes is up at rest,
    // and the rest is written into the object, so a mesh globe reset while
    // tilted stands back at its rest rather than keeping the tilt.
    const home = body(globe, 'home()')
    expect(home).toContain('gNorth = <0.0, 0.0, 1.0> / llGetRot();')
    expect(home).toContain('llLinksetDataWrite(HOME_KEY, (string)gHomeRot);')
    expect(body(globe, 'level()')).toContain('llSetLocalRot(gHomeRot);')
    expect(globe).toMatch(/if \(UPRIGHT_ON_START\) \{ upright\(\); home\(\); \}/)
    expect(globe).toContain('string stored = llLinksetDataRead(HOME_KEY);')
    // The owner's spin, ended by a visitor's tilt, comes back with the rest.
    expect(body(globe, 'act(key who, integer owner, string msg)')).toMatch(/if \(gOwnerSpin != 0\.0 && gSpin == 0\.0 && !gTilted\)/)
    // A tilted sphere counts as turned, so the idle return comes for it,
    // and so does an owner's spin a tilt ended, which Upright again doesn't
    // restart (found in review); a spin, about the region's vertical, waits
    // until it is level.
    expect(body(globe, 'broadcast()')).toContain('"turned", gRotation != gHome || gTilted || gSpin != gOwnerSpin,')
    expect(body(globe, 'act(key who, integer owner, string msg)')).toContain('if (gTilted) { tell(who, "Not while the globe is tilted')
    const turn = body(visitors, 'turnMenu(key who)')
    expect(turn).toContain('[BTN_NORTH, BTN_SOUTH, BTN_LEVEL, BTN_WEST, BTN_EAST, BTN_MENU], gDlgTurn);')
    expect(visitors).toContain('else if (msg == BTN_SOUTH) ask(who, "tilt south");')
    expect(visitors).toContain('else if (msg == BTN_NORTH) ask(who, "tilt north");')
    expect(visitors).toContain('else if (msg == BTN_LEVEL) ask(who, "level");')
  })

  it('hold no web reply in the globe script, and leave checking a choice to the info script', () => {
    // Second Life hands every web reply to every script in the prim with
    // an http_response, and the globe script rests close to its 64 KB
    // (62 KB, measured in-world in October 2026). It ran out of memory
    // there after showing a dataset, with replies in hand: its own check's,
    // and the info script's records, up to 9,000 bytes then, which every
    // show set off. So it makes no request and has no handler, and shows a
    // choice at once.
    expect(globe).not.toContain('http_response')
    expect(globe).not.toContain('llHTTPRequest')
    const act = body(globe, 'act(key who, integer owner, string msg)')
    const show = act.slice(act.indexOf('if (cmd == "show")'), act.indexOf('if (cmd == "earth"'))
    expect(show).toMatch(/\n\s+show\(who, dataset, described\);/)
    // The info script, which reads the card anyway, puts the globe back
    // on the live Earth when the node has no such dataset or it is a tour,
    // as a script's own request, and tells the owner and whoever chose it.
    const unshowable = body(info, 'unshowable(string why)')
    expect(unshowable).toContain('llMessageLinked(LINK_THIS, MSG_CONTROL, "earth " + gDataset, NULL_KEY);')
    expect(unshowable).toContain('llOwnerSay(')
    expect(unshowable).toMatch(/if \(gChose\)\n\s+if \(gChose != llGetOwner\(\)\)\n\s+llRegionSayTo\(gChose, 0, /)
    // Only for the card it asked for, and a 404 only when the node's own
    // envelope says so: a proxy's 404 says nothing about the dataset.
    const reply = info.slice(info.indexOf('    http_response(key req'), info.indexOf('    timer()'))
    expect(reply).toMatch(/if \(req != gReq\) return;\n\s+gReq = NULL_KEY;/)
    expect(reply).toMatch(/if \(status == 404\)\n\s+if \(llJsonGetValue\(body, \["error"\]\) == "not_found"\) \{ unshowable\(/)
    // Shown only when the node says the page can show it, and only a kind
    // this script knows: the kinds are an open set, so one a later node
    // adds is refused rather than shown.
    const card = body(info, 'card(string b, integer cut)')
    const gate = 'if (llJsonGetValue(b, ["showable"]) != JSON_TRUE || (kind != "video" && kind != "image"))'
    expect(card).toContain('if (kind == "tour") { unshowable(')
    expect(card).toMatch(/if \(llJsonGetValue\(b, \["showable"\]\) != JSON_TRUE \|\| \(kind != "video" && kind != "image"\)\)\n\s+\{\n\s+unshowable\(/)
    // The chooser is kept only until the node has answered about their
    // choice, and the README's account of what the scripts keep says so.
    expect(card.indexOf('gChose = NULL_KEY;')).toBeGreaterThan(card.indexOf(gate))
    expect(unshowable).toContain('gChose = NULL_KEY;')
    expect(readme).toContain('the key of whoever chose the dataset showing, until the node has said')
    // The globe names the chooser of a new dataset in the broadcast that
    // shows it, and the info script keeps it with the dataset. A request
    // naming a dataset the globe has since gone on from is set aside, so
    // a slow record can't undo someone else's choice.
    expect(body(globe, 'show(key who, string id, string title)')).toMatch(
      /if \(llList2String\(saved, 0\) != id\) gBy = who;\n\s+if \(!commit\(saved\)\)/,
    )
    expect(info).toMatch(/forget\(\);\n\s+gChose = id;\n\s+fetch\(\);\n\s+\}\n\s+else if \(id\) moved\(id\);/)
    const stale = 'if (cmd == "earth" && who == NULL_KEY && arg != "" && arg != gDataset) return;'
    expect(act).toContain(stale)
    expect(act.indexOf(stale)).toBeLessThan(act.indexOf('if (cmd == "earth" || (cmd == "rest"'))
    // "earth" is a control any script may send: it sits before the owner's
    // gate in the globe script.
    expect(act.indexOf('if (cmd == "earth"')).toBeLessThan(act.indexOf("// Everything below is the owner's."))
    // The info script reads a card, which the node keeps within its budget,
    // and keeps a little of the abstract.
    expect(Number(constant(info, 'integer', 'CARD_MAX'))).toBe(CARD_BUDGET)
    expect(CARD_BUDGET).toBe(2048)
    expect(Number(constant(info, 'integer', 'ABSTRACT_MAX'))).toBeLessThanOrEqual(500)
    // And the globe says how full showing a dataset left it.
    const shown = body(globe, 'show(key who, string id, string title)')
    const statements = shown.slice(shown.indexOf('{') + 1).split('\n').filter((line) => line.trim() !== '' && !/^\s*\/\//.test(line))
    expect(statements[0].trim()).toBe('llScriptProfiler(PROFILE_SCRIPT_MEMORY);')
    expect(shown).toMatch(/llScriptProfiler\(PROFILE_NONE\);\n\s+if \(llGetSPMaxMemory\(\) > gPeak\) gPeak = llGetSPMaxMemory\(\);$/)
    expect(shown).not.toContain('return;')
    expect(act).toContain('KB while showing a dataset')
  })

  it('read a card once, and copy what it tells a visitor as few times as it can be', () => {
    // A copy counts against a script's 64 KB until Second Life collects
    // it, and the info script ran out in-world (October 2026). So the card
    // is handed straight to the one function that reads it, and HTML,
    // entities and cuts are the node's work, not the script's.
    const reply = info.slice(info.indexOf('    http_response(key req'), info.indexOf('    timer()'))
    expect(reply).toMatch(/llScriptProfiler\(PROFILE_SCRIPT_MEMORY\);\n\s+card\(body, llListFindList\(meta, \[HTTP_BODY_TRUNCATED\]\) != -1\);\n\s+peak\(\);/)
    for (const gone of ['string field(', 'string plain(', 'tidy()', 'gBody']) expect(info, gone).not.toContain(gone)
    // A reply that isn't a card, as an older node's page is, or one cut at
    // the budget, which no card is, is not read, nor asked for again.
    const card = body(info, 'card(string b, integer cut)')
    expect(card).toMatch(/if \(cut \|\| kind == JSON_INVALID\)\n\s+\{\n\s+if \(gTries < TRIES\) \{ later\(60\); return; \}/)
    // "About" is joined once and measured a character at a time, not
    // copied for each line added and each piece counted.
    const about = body(info, 'about(key av)')
    expect(about).not.toMatch(/text \+=/)
    expect(about).toContain('say(av, llDumpList2String(lines, "\\n"));')
    expect(about).toContain('link = gNode + gPage;')
    const say = body(info, 'say(key av, string text)')
    expect(say).toContain('llOrd(text, n)')
    expect(say).not.toContain('bytes(')
    expect(info).not.toContain('llToLower(body)')
    // And "/9 memory" says the most either took.
    expect(info).toMatch(/MSG_ABOUT\)\n\s+\{\n\s+llScriptProfiler\(PROFILE_SCRIPT_MEMORY\);\n\s+about\(id\);\n\s+peak\(\);/)
    expect(info).toContain('KB while reading a card or answering About')
  })

  it("name a dataset shown by its id alone by the card's title, and keep any name it was given", () => {
    // `/9 show <id>` gives the globe no name, so it sends the id, which
    // means nothing to a visitor (found in-world, 26 October). A menu's,
    // a notecard's or a preset's name is the owner's choice and stays.
    expect(body(globe, 'show(key who, string id, string title)')).toContain('if (gTitle == "") gTitle = id;')
    const name = body(info, 'string called()')
    expect(name).toContain('if ((gTitle == "" || gTitle == gDataset) && gFor == gDataset && gCardTitle != "") return gCardTitle;')
    expect(body(info, 'hover()')).toContain('string title = called();')
    const about = body(info, 'about(key av)')
    expect(about).toContain('string title = called();')
    expect(about).not.toContain('gTitle')
    expect(body(info, 'forget()')).toContain('gCardTitle = "";')
  })

  it('ask for a card a bounded number of times, and again when an answer was lost', () => {
    // Every request counts against TRIES, one at a time, so a failing node
    // is asked at most four times a dataset, never every 30 s for good.
    const fetch = body(info, 'fetch()')
    expect(fetch).toMatch(/if \(gDataset == "" \|\| gNode == "" \|\| gTries >= TRIES\) return;\n\s+if \(gReq\) return;\n\s+\+\+gTries;/)
    expect(fetch).toContain('if (gReq == NULL_KEY) later(30);')
    expect(Number(constant(info, 'integer', 'TRIES'))).toBe(4)
    // A failure is asked again; the timer is what asks.
    const reply = info.slice(info.indexOf('    http_response(key req'), info.indexOf('    timer()'))
    expect(reply).toMatch(/if \(status != 200\)\n\s+\{\n\s+if \(gTries < TRIES\) later\(30\);\n\s+else if \(!gToldNode && !gHaveRec\)\n\s+\{\n\s+llOwnerSay\([^;]+;\n\s+gToldNode = TRUE;/)
    // A card read before the failure (a retry's) still stands, so neither
    // message is sent over it: both say the hover text shows titles alone.
    // The latch is set only with the message, or a silent pass would keep
    // the owner from hearing of the next dataset that gets no card.
    expect(body(info, 'card(string b, integer cut)')).toMatch(
      /\n\s+if \(!gToldNode && !gHaveRec\)\n\s+\{\n\s+llOwnerSay\([^;]+;\n\s+gToldNode = TRUE;\n\s+\}\n\s+return;/,
    )
    // The owner is told once a node, not once a script's life.
    const state = info.slice(info.indexOf('        if (n != MSG_STATE) return;'), info.indexOf('    http_response(key req'))
    expect(state).toMatch(/string node = llJsonGetValue\(str, \["node"\]\);\n\s+if \(node != gNode\) gToldNode = FALSE;\n\s+gNode = node;/)
    // Second Life's 415, for a reply that isn't the JSON asked for (an
    // older node's page, found in-world), is no card: asked again, then
    // the owner is told the node sent none.
    expect(reply).toMatch(/if \(status == 415\) \{ card\("", TRUE\); hover\(\); pace\(\); return; \}/)
    expect(reply.indexOf('if (status == 415)')).toBeLessThan(reply.indexOf('if (status != 200)'))
    expect(info).toContain('HTTP_ACCEPT, "application/json"')
    // Once the tries are spent the owner is told, with the status, rather
    // than the globe going quiet.
    expect(reply).toContain('" tries (HTTP " + (string)status + "). The hover text shows the title alone."')
    const timer = info.slice(info.indexOf('    timer()'), info.indexOf('    listen('))
    expect(timer).toMatch(/if \(gRetryAt && llGetUnixTime\(\) >= gRetryAt\)\n\s+\{\n\s+gRetryAt = 0;\n\s+fetch\(\);/)
    // The timer runs while a retry waits, a retry is the earliest asked
    // for, and every dataset starts with its tries unspent.
    expect(body(info, 'pace()')).toContain('if (moving || gRetryAt) llSetTimerEvent(TICK);')
    expect(body(info, 'later(integer s)')).toMatch(/integer at = llGetUnixTime\(\) \+ s;\n\s+if \(gRetryAt == 0 \|\| at < gRetryAt\) gRetryAt = at;/)
    expect(body(info, 'forget()')).toMatch(/gTries = 0;\n\s+gRetryAt = 0;\n\s+gReq = NULL_KEY;/)
    // A region restart drops a request in flight, which is asked again,
    // and sets the timer again whatever was waiting on it.
    expect(info).toMatch(/if \(c & CHANGED_REGION_START\)\n\s+\{\n\s+if \(gReq\) \{ gReq = NULL_KEY; later\(10\); \}\n\s+pace\(\);\n\s+\}/)
    // A card of exactly the budget can't read as cut.
    expect(fetch).toContain('HTTP_BODY_MAXLENGTH, CARD_MAX + 1]')
  })

  it("read only what a card carries, as the type it has", () => {
    // The card's names are a contract with copies already rezzed
    // (functions/api/v1/_lib/exhibit-reads.ts), so a field this script
    // reads that the card lacks would read "" on every node, quietly.
    const shape = JSON.parse(CARD_SKELETON) as Record<string, unknown>
    const card = body(info, 'card(string b, integer cut)')
    const read = [...all(card, /value\(b, "(\w+)"\)/g), ...all(card, /llJsonGetValue\(b, \["(\w+)"\]\)/g)]
    expect(new Set(read)).toEqual(new Set([
      'kind', 'showable', 'title', 'page', 'credit', 'license', 'licenseText', 'truncated', 'abstract',
      'startTime', 'endTime', 'period', 'exactDuration', 'retry',
    ]))
    for (const name of read) expect(Object.keys(shape), name).toContain(name)
    // Numbers are cast, and the one boolean is compared with JSON_TRUE,
    // since (integer) of a JSON true reads 0.
    expect(typeof shape.exactDuration).toBe('number')
    expect(typeof shape.retry).toBe('number')
    expect(card).toContain('gDuration = (float)value(b, "exactDuration");')
    expect(card).toContain('integer retry = (integer)value(b, "retry");')
    expect(typeof shape.truncated).toBe('boolean')
    expect(card).toContain('gCut = llJsonGetValue(b, ["truncated"]) == JSON_TRUE;')
    expect(typeof shape.showable).toBe('boolean')
    // The card's page is a path on the node, as its dataset link.
    expect(card).toContain('if (llGetSubString(gPage, 0, 0) != "/") gPage = "/dataset/" + gDataset;')
    // A length the node didn't settle is asked for again when it says.
    expect(card).toContain('if (gVideo && gDuration == 0.0 && retry > 0) later(retry);')
    expect(info).toContain('gNode + "/api/exhibit/v1/datasets/" + llEscapeURL(gDataset)')
  })

  it('answer a pause, a play or a move with the date the globe shows, not the clip\'s seconds', () => {
    // A clip's seconds mean nothing to a visitor, and only the info
    // script knows the dataset's dates. So the globe script names who
    // asked in the broadcast that follows, and the info script answers
    // them: the date where there is one, the plain word where there isn't.
    const act = body(globe, 'act(key who, integer owner, string msg)')
    const playback = act.slice(act.indexOf('if (cmd == "pause")\n'), act.indexOf('if (cmd == "tilt")'))
    expect(playback.match(/gBy = who;\n\s+commit\(saved\);/g)).toHaveLength(3)
    // Every key the globe names goes out in the very next broadcast: one
    // left set by a change that returned first would name its asker in
    // someone else's. The key starts as a real NULL_KEY, since a key
    // never given a value is "", which the info script would answer.
    const named = [...globe.matchAll(/gBy = who;\n([^\n]*)/g)].map((m) => m[1].trim())
    expect(named).toHaveLength(4)
    for (const next of named) expect(next).toMatch(/^(if \(!)?commit\(saved\)/)
    expect(globe).toMatch(/^key\s+gBy = NULL_KEY;/m)
    expect(playback).not.toMatch(/" s[.,]/)
    expect(body(globe, 'broadcast()')).toMatch(/"node", NODE\]\), gBy\);\n\s+gBy = NULL_KEY;/)
    // A refused change names nobody, so no one is told it happened.
    expect(body(globe, 'integer commit(list saved)')).toContain('if (!setMedia()) { restore(saved); gBy = NULL_KEY; return FALSE; }')
    expect(info).toContain('else if (id) moved(id);')
    const moved = body(info, 'moved(key who)')
    // The date at the position broadcast, not a second later: the globe
    // takes it before setting the media, which takes a second.
    expect(moved).toMatch(
      /integer paused = gPaused;\n\s+gPaused = TRUE;\n\s+if \(gFor == gDataset && gDuration > 0\.0\) d = date\(\);\n\s+gPaused = paused;/,
    )
    expect(moved).toContain('if (d != "") s = "Paused at " + d + ".";')
    expect(moved).toContain('if (d != "") s = "Playing from " + d + ".";')
  })

  it("keep the dataset's id in every manifest the node builds, for copies already rezzed", () => {
    // Info scripts rezzed before the card read a clip's length from the
    // manifest, and trust it only when the manifest carries the dataset's
    // own id: a Vimeo manifest carries Vimeo's id and its whole-second
    // length, which the page's loop drifts from. Those copies can't be
    // updated, so the node keeps writing the id into every manifest it
    // builds (manifest.test.ts pins the leading keys).
    expect(info).not.toContain('/manifest')
    const manifest = read('../../functions/api/v1/datasets/[id]/manifest.ts')
    expect(manifest.match(/^\s+id: row\.id,$/gm)?.length).toBeGreaterThanOrEqual(2)
    expect(manifest).toMatch(/externalVideoManifest\(row\.id,/)
    // A Vimeo manifest's id is Vimeo's own, which the proxy gives.
    const proxy = read('../../functions/api/v1/_lib/video-proxy.ts')
    expect(proxy).toMatch(/^\s+id: data\.id,$/m)
    expect(manifest).toMatch(/fetchVimeoManifest\(parsed\.value, proxyBase, fetchImpl\)/)
  })

  it('label every button within the 24 bytes a menu allows', () => {
    const labels = [...visitors.matchAll(/^string\s+BTN_\w+ = "([^"]*)";/gm)].map((m) => m[1])
    expect(labels.length).toBeGreaterThan(10)
    for (const label of labels) expect(bytes(label), label).toBeLessThanOrEqual(24)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('never offer more than a menu holds', () => {
    // Every button mainMenu can add, counted as if every condition held:
    // a choice between two labels is one button. Past 12, the menu
    // isn't shown at all.
    const menu = body(visitors, 'mainMenu(key who)')
      .replace(/llList2String\(\[[^\]]*\], \w+\)/g, 'ONE')
    const added = all(menu, /(?:list b = |b \+= )\[([^\]]*)\];/g)
    expect(added.length).toBeGreaterThan(0)
    const count = added.reduce((n, items) => n + items.split(',').length, 0)
    expect(count).toBeLessThanOrEqual(12)
  })

  it("offer the globe's own presets when there is no datasets notecard", () => {
    const presets = literals(globe.match(/^list PRESETS = \[([\s\S]*?)\];/m)?.[1] ?? '')
    const menu = literals(visitors.match(/^list\s+DEFAULT_MENU = \[([\s\S]*?)\];/m)?.[1] ?? '')
    const presetIds = presets.filter((_, i) => i % 3 === 1)
    const menuIds = menu.filter((_, i) => i % 2 === 1)
    const menuNames = menu.filter((_, i) => i % 2 === 0)
    expect(menuIds).toEqual(presetIds)
    // A name past a menu button's 24 bytes would be cut, and two that cut
    // alike would answer as the first.
    for (const name of menuNames) expect(bytes(name), name).toBeLessThanOrEqual(24)
    expect(new Set(menuNames).size).toBe(menuNames.length)
  })

  it('share a channel, and leave each command to the script that answers it', () => {
    const chan = constant(globe, 'integer', 'CHAN')
    expect(constant(visitors, 'integer', 'CHAN')).toBe(chan)
    expect(constant(info, 'integer', 'CHAN')).toBe(chan)
    // The globe answers anything it doesn't know with its help text, so
    // it has to stay quiet on the visitors script's commands.
    expect(body(globe, 'act(key who, integer owner, string msg)')).toMatch(
      /if \(cmd == "talk" \|\| cmd == "presenters"\) return;\n {4}help\(\);/,
    )
    expect(visitors).toMatch(/cmd == "talk"/)
    expect(visitors).toMatch(/cmd == "presenters"/)
    // All three say how much memory they use.
    expect(globe).toMatch(/cmd == "memory"/)
    expect(visitors).toMatch(/cmd == "memory"/)
    expect(info).toMatch(/!= "memory"/)
  })

  it('read the notecards and settings the docs name', () => {
    const cards = literals(visitors.match(/^list\s+gCards = \[([^\]]*)\];/m)?.[1] ?? '')
    expect(cards).toEqual(['settings', 'presenters', 'datasets'])
    for (const card of cards) {
      expect(readme, card).toContain(`\`${card}\``)
      expect(plan, card).toContain(`\`${card}\``)
    }
    const settings = all(body(visitors, 'setting(string line)'), /name == "([^"]+)"/g)
    expect(settings).toEqual(['radius', 'idle minutes', 'hold seconds', 'talk minutes'])
    for (const name of settings) {
      expect(readme, name).toContain(`${name} = `)
      expect(plan, name).toContain(`\`${name}\``)
    }
  })

  it('write before createdAt every record field copies already rezzed read', () => {
    // Info scripts rezzed before the card read a record by position, only
    // as far as 3,072 bytes (9,000 in the first copies), which works
    // because every field they read comes before `createdAt`, which every
    // record has. A serializer that moved one after it would cut that
    // field from long records for copies that can't be updated. The order
    // isn't the protocol's promise (docs/protocol/README.md); it is this
    // node's, and this pins it. Every version of the script read these.
    const fields = [
      'slug', 'format', 'abstractTxt', 'attributionText', 'rightsHolder', 'organization',
      'licenseSpdx', 'licenseUrl', 'licenseStatement', 'startTime', 'endTime', 'period',
    ]
    expect(info).not.toContain('"/api/v1/datasets/"')
    const wire = serializeDataset(
      fullRow(),
      { tags: ['Air'], categories: [], keywords: ['k'], developers: [{ role: 'data', name: 'D', affiliation_url: null }], related: [] },
      { node_id: 'N', display_name: 'N', base_url: 'https://n.example', description: null, contact_email: null, public_key: 'k', created_at: T },
      undefined,
      undefined,
      () => 'https://n.example/frames/{n}.png',
    )
    const sent = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>
    const keys = Object.keys(sent)
    const end = keys.indexOf('createdAt')
    expect(end).toBeGreaterThan(-1)
    for (const name of fields) {
      expect(keys.indexOf(name), name).toBeGreaterThan(-1)
      expect(keys.indexOf(name), `${name} before createdAt`).toBeLessThan(end)
      expect(typeof sent[name], `${name} is a string`).toBe('string')
    }
    // Every object the record can carry comes after it, so no key nested
    // in one can be taken for a field the record lacks. probingInfo is the
    // one a publisher writes freely, and the fixture's holds a "period".
    for (const key of ['probingInfo', 'boundingBox', 'renderEncoding', 'colorScale', 'frames', 'enriched']) {
      expect(keys.indexOf(key), `${key} is in the fixture's record`).toBeGreaterThan(-1)
      expect(keys.indexOf(key), `${key} after createdAt`).toBeGreaterThan(end)
    }
    for (const key of keys.slice(0, end)) {
      const value = sent[key]
      const flat = typeof value !== 'object' || value === null
        || (Array.isArray(value) && value.every((v) => typeof v === 'string'))
      expect(flat, key).toBe(true)
    }
  })

  it("leave the title room in the hover text, whatever else it says", () => {
    // The fixed lines are never cut, so they have to leave the title its
    // floor. The worst case: a preview node, whose address is the longest
    // the README sends anyone to, with telemetry on, a talk under way, and
    // a sub-daily range, which shows while a clip's length is unknown.
    const string = (name: string) => JSON.parse(constant(info, 'string', name)) as string
    const hover = body(info, 'hover()')
    // The telemetry notice sits under the date, says what the globe does
    // and where the policy is, and is never cut: it is counted before the
    // title and credit share what is left, and it is drawn whole.
    expect(hover).toMatch(/if \(stamp != ""\) tail \+= "\\n" \+ stamp;\n\s+if \(gTelemetry\) tail \+= "\\nCounts anonymous use: " \+ gNode \+ "\/privacy";/)
    expect(hover).toContain('integer avail = 254 - bytes(tail) - bytes(end);')
    expect(hover).toContain('string s = title + tail;')
    expect(body(globe, 'describe()')).toContain('desc = "TerraViz globe. Counts anonymous use: " + NODE + "/privacy";')
    // Kept short, at the maintainer's request: no line naming the globe.
    expect(info).not.toMatch(/llSetText\("TerraViz/)
    expect(hover).not.toContain('TerraViz globe')
    expect(hover).toContain('if (keepT < MIN_TITLE) keepT = MIN_TITLE;')
    const preview = `https://${'a'.repeat(28)}.terraviz.pages.dev`
    const production = JSON.parse(constant(globe, 'string', 'NODE')) as string
    const end = `\n${string('TALK_LINE')}\n${string('TOUCH_LINE')}`
    // Two-digit days on both sides, the widest when() writes.
    const range = '\n30 Sep 2012, 12:00 to 30 Oct 2012, 11:35 UTC'
    expect(body(info, 'string range()')).toContain('if (gRes == RES_TIME) a = llGetSubString(a, 0, -5);')
    const minTitle = Number(constant(info, 'integer', 'MIN_TITLE'))
    const minCredit = Number(constant(info, 'integer', 'MIN_CREDIT'))
    for (const node of [preview, production]) {
      const privacy = `\nCounts anonymous use: ${node}/privacy`
      const left = 254 - bytes(range) - bytes(privacy) - bytes(end) - 1
      expect(left, node).toBeGreaterThanOrEqual(minTitle)
      // On the node the exhibit ships for, the credit keeps its floor too.
      if (node === production) expect(left - minTitle, node).toBeGreaterThanOrEqual(minCredit)
      // The live Earth's lines fit whole, with nothing cut.
      const live = string('LIVE_LINE') + privacy + '\n' + string('LIVE_CREDIT') + end
      expect(bytes(live), node).toBeLessThanOrEqual(254)
    }
  })

  it("take the dataset ids the globe takes, from the notecard", () => {
    // A line the globe would refuse is caught when the notecard is read,
    // not when a visitor picks it.
    expect(constant(visitors, 'string', 'ID_CHARS')).toBe(constant(globe, 'string', 'ID_CHARS'))
    expect(constant(visitors, 'integer', 'ID_MAX')).toBe(constant(globe, 'integer', 'ID_MAX'))
    expect(body(visitors, 'integer isId(string s)')).toBe(body(globe, 'integer isId(string s)'))
  })

  it('answer each kind of menu on its own channel', () => {
    // So an answer from an older menu means what that menu meant.
    expect(body(visitors, 'mainMenu(key who)')).toContain('menu(who, text, b, gDlg);')
    expect(body(visitors, 'datasetsMenu(key who, integer page)')).toContain('menu(who, text, b, gDlgSets);')
    expect(visitors).toContain('llTextBox(who, "Jump to where in the clip? Seconds, like 90, or minutes and seconds, like 1:30.", gDlgJump);')
    expect(body(visitors, 'turnMenu(key who)')).toContain('gDlgTurn);')
    expect(visitors).toMatch(/gDlgSets = gDlg \+ 1;\n\s+gDlgJump = gDlg \+ 2;\n\s+gDlgTurn = gDlg \+ 3;/)
    // Every channel the menus use stays negative, where no avatar can chat.
    expect(visitors).toMatch(/gDlg = -4 - /)
  })
})

const T = '2026-05-01T00:00:00.000Z'

/**
 * A dataset row with every field that can put an object on the wire
 * filled in, and the text and time fields the info script reads. Not a
 * tour, so no `tourJsonUrl`.
 */
function fullRow(): DatasetRow {
  return {
    id: '01KQG611HF8YXJNRBEHT0757KT',
    slug: 'hurricane-season-2024',
    origin_node: 'N',
    title: 'Hurricane Season - 2024',
    abstract: 'An abstract.',
    organization: 'NOAA',
    format: 'video/mp4',
    data_ref: 'url:https://example.com/v.mp4',
    thumbnail_ref: 'https://example.com/t.jpg',
    sphere_thumbnail_ref: 'https://example.com/s.jpg',
    sphere_thumbnail_ref_lg: 'https://example.com/l.jpg',
    legend_ref: 'https://example.com/legend.png',
    caption_ref: 'https://example.com/c.vtt',
    website_link: 'https://example.com',
    start_time: '2024-06-01T12:00:00Z',
    end_time: '2024-11-30T12:00:00Z',
    period: 'P1D',
    weight: 1,
    visibility: 'public',
    is_hidden: 0,
    run_tour_on_load: 'https://example.com/tour.json',
    license_spdx: 'CC-BY-4.0',
    license_url: 'https://creativecommons.org/licenses/by/4.0/',
    license_statement: 'A statement.',
    attribution_text: 'NOAA',
    rights_holder: 'NOAA',
    doi: '10.1/x',
    citation_text: 'A citation.',
    schema_version: 1,
    created_at: T,
    updated_at: T,
    published_at: T,
    retracted_at: null,
    publisher_id: null,
    legacy_id: 'INTERNAL_SOS_768',
    color_table_ref: null,
    probing_info: JSON.stringify({ period: 'P1Y', note: 'a publisher writes what it likes here' }),
    bbox_n: 90,
    bbox_s: -90,
    bbox_w: -180,
    bbox_e: 180,
    bbox_provenance: 'unknown',
    bbox_evidence: null,
    temporal_semantics: 'unknown',
    temporal_evidence: null,
    resource_kind: 'unknown',
    celestial_body: null,
    radius_mi: null,
    lon_origin: null,
    is_flipped_in_y: null,
    render_encoding: 'data-luma',
    playback_fps: 30,
    color_scale: JSON.stringify({
      stops: [
        { t: 0, rgba: [0, 0, 0, 0] },
        { t: 1, rgba: [255, 0, 0, 255] },
      ],
      vmin: 0,
      vmax: 50,
      units: 'mg m-2',
    }),
    transcoding: null,
    active_transcode_upload_id: null,
    frame_count: 10,
    frame_extension: 'png',
    frame_source_filenames_ref: 'r2:datasets/x/frames.json',
    content_digest: null,
    source_digest: 'abc',
  }
}
