// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { serializeDataset } from '../../functions/api/v1/_lib/dataset-serializer'
import {
  CARD_ABSTRACT_CHARS,
  CARD_BUDGET,
  CARD_SKELETON,
  PAGE_BUDGET,
  PAGE_CAPS,
  PAGE_MAX_LIMIT,
  parsePageQuery,
  resetExhibitListForTests,
  TAG_CAP,
  TAGS_BUDGET,
  TAGS_MAX,
  type ExhibitPage,
  type ExhibitTags,
} from '../../functions/api/v1/_lib/exhibit-reads'
import type { DatasetRow } from '../../functions/api/v1/_lib/catalog-store'
import { asD1, makeCtx } from '../../functions/api/v1/_lib/test-helpers'
import { onRequestGet as getPage } from '../../functions/api/exhibit/v1/datasets'
import { onRequestGet as getTags } from '../../functions/api/exhibit/v1/tags'
import { freshMigratedDb } from '../lib/catalog-migrations'

// LSL compiles only in-world, so nothing here runs the scripts. What the
// globe script writes into the page's address is held to the page by
// ../second-life-probe/globe.test.ts, which checks both globe scripts.
// These tests hold the exhibit's five scripts to each other and to the
// node: a link message, a state key or a command one script renamed would
// leave the others quietly doing nothing, with no error anywhere.

const read = (file: string): string =>
  readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const globe = read('./terraviz-exhibit.lsl')
const visitors = read('./terraviz-exhibit-visitors.lsl')
const info = read('./terraviz-exhibit-info.lsl')
const menu = read('./terraviz-exhibit-menu.lsl')
const owner = read('./terraviz-exhibit-owner.lsl')
const SCRIPTS = { globe, visitors, info, menu, owner }
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
      const sends = [...script.matchAll(/llMessageLinked\((LINK_\w+), (MSG_\w+)/g)]
      expect(sends.length, name).toBeGreaterThan(0)
      for (const [, target, sent] of sends) {
        const handlers = Object.entries(SCRIPTS).filter(
          ([other, s]) => other !== name && new RegExp(`\\bn [!=]= ${sent}\\b`).test(s),
        )
        expect(handlers.length, `${name} sends ${sent}`).toBeGreaterThan(0)
        // The menu script is in a prim of its own, so what passes between
        // it and the visitors script goes to the whole object; everything
        // else stays in the globe's prim.
        const across = handlers.some(([other]) => other === 'menu') || name === 'menu'
        expect(target, `${name} sends ${sent}`).toBe(across ? 'LINK_SET' : 'LINK_THIS')
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
    // The menu script, in a prim of its own, hears the state only through
    // the visitors script, which reads the node from it.
    expect(menu).not.toMatch(/MSG_STATE|MSG_HELLO|llJsonGetValue\(str/)
    expect(all(visitors, /llJsonGetValue\(str, \["(\w+)"\]\)/g)).toContain('node')
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
    expect(body(globe, 'act(key who, integer owner, string msg)')).toContain('if (gTilted) { report(cmd, ["tilted"]); return; }')
    expect(body(owner, 'result(string r)')).toContain('if (done == "tilted") say("Not while the globe is tilted')
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
    expect(show).toMatch(/\n\s+show\(who, arg, described\);/)
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
    // and keeps a little of the abstract. The node sends no more of it than
    // that: the card is held whole while it is read, and the info script
    // reached 63 KB of 64 in-world when an abstract filled the card.
    expect(Number(constant(info, 'integer', 'CARD_MAX'))).toBe(CARD_BUDGET)
    expect(CARD_BUDGET).toBe(2048)
    expect(Number(constant(info, 'integer', 'ABSTRACT_MAX'))).toBe(CARD_ABSTRACT_CHARS)
    // And the globe says how full showing a dataset left it.
    const shown = body(globe, 'show(key who, string id, string title)')
    const statements = shown.slice(shown.indexOf('{') + 1).split('\n').filter((line) => line.trim() !== '' && !/^\s*\/\//.test(line))
    expect(statements[0].trim()).toBe('llScriptProfiler(PROFILE_SCRIPT_MEMORY);')
    expect(shown).toMatch(/llScriptProfiler\(PROFILE_NONE\);\n\s+if \(llGetSPMaxMemory\(\) > gPeak\) gPeak = llGetSPMaxMemory\(\);$/)
    expect(shown).not.toContain('return;')
    expect(act).toContain('report(cmd, ["ok", llGetUsedMemory() / 1024, gPeak / 1024]);')
    expect(body(owner, 'result(string r)')).toContain('KB while showing a dataset')
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
    expect(name).toMatch(/if \(gFor == gDataset && gCardTitle != ""\)\n\s+\{\n\s+if \(gTitle == "" \|\| gTitle == gDataset\) return gCardTitle;/)
    // The live menu's title, which the node cut to 48 bytes with "...",
    // gives way to the card's, which is the same title whole or cut far
    // later; a name the owner gave doesn't.
    expect(name).toContain('if (n > 3 && llGetSubString(gTitle, -3, -1) == "..."')
    expect(name).toContain('&& llSubStringIndex(gCardTitle, llGetSubString(gTitle, 0, n - 4)) == 0) return gCardTitle;')
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
    expect(card).toContain('list x = llParseString2List(value(b, "exactDuration"), ["."], []);')
    expect(card).toContain('integer retry = (integer)value(b, "retry");')
    expect(typeof shape.truncated).toBe('boolean')
    expect(card).toContain('gCut = llJsonGetValue(b, ["truncated"]) == JSON_TRUE;')
    expect(typeof shape.showable).toBe('boolean')
    // The card's page is a path on the node, as its dataset link.
    expect(card).toContain('if (llGetSubString(gPage, 0, 0) != "/") gPage = "/dataset/" + gDataset;')
    // A length the node didn't settle is asked for again when it says.
    expect(card).toContain('if (gVideo && gLen == 0 && retry > 0) later(retry);')
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
      /integer paused = gPaused;\n\s+gPaused = TRUE;\n\s+if \(gFor == gDataset && gLen > 0\) d = date\(\);\n\s+gPaused = paused;/,
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
    // The menu script's too, and its moves are the visitors script's.
    const own = Object.fromEntries([...menu.matchAll(/^string\s+(BTN_\w+) = "([^"]*)";/gm)].map((m) => [m[1], m[2]]))
    for (const label of Object.values(own)) expect(bytes(label), label).toBeLessThanOrEqual(24)
    expect(new Set(Object.values(own)).size).toBe(Object.keys(own).length)
    for (const name of ['BTN_PREV', 'BTN_NEXT', 'BTN_MENU']) expect(own[name], name).toBe(constant(visitors, 'string', name).replace(/"/g, ''))
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

  it("offer the owner's presets when there is no datasets notecard", () => {
    const presets = literals(owner.match(/^list PRESETS = \[([\s\S]*?)\];/m)?.[1] ?? '')
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
    const chan = constant(owner, 'integer', 'CHAN')
    expect(constant(visitors, 'integer', 'CHAN')).toBe(chan)
    expect(constant(info, 'integer', 'CHAN')).toBe(chan)
    expect(constant(menu, 'integer', 'CHAN')).toBe(chan)
    // The globe script hears no chat at all: the owner script hears the
    // owner and hands it over.
    expect(globe).not.toMatch(/\bCHAN\b|llListen|\n    listen\(/)
    // Every script that hears the channel hears only the owner: anyone
    // else on it could otherwise turn telemetry on or steer the address.
    // The owner script, which acts on all of it, checks the key again.
    for (const [name, script] of Object.entries({ owner, visitors, info, menu })) {
      expect(script, name).toContain('llListen(CHAN, "", llGetOwner(), "");')
      expect(script.match(/llListen\(CHAN,/g), name).toHaveLength(1)
    }
    expect(owner).toMatch(/listen\(integer ch, string name, key id, string msg\)\n\s+\{\n(\s+\/\/[^\n]*\n)*\s+if \(id != llGetOwner\(\)\) return;/)
    // The owner script answers anything it doesn't know with its help
    // text, so it has to stay quiet on the visitors script's commands.
    expect(body(owner, 'command(string msg)')).toMatch(
      /if \(cmd == "talk" \|\| cmd == "presenters"\) return;\n {4}help\(\);/,
    )
    expect(visitors).toMatch(/cmd == "talk"/)
    expect(visitors).toMatch(/cmd == "presenters"/)
    // All five say how much memory they use, the globe through the owner
    // script, and the menu script nothing else: it answers no command, so
    // it never asks the globe for one.
    expect(globe).toMatch(/cmd == "memory"/)
    expect(owner).toMatch(/cmd == "memory"/)
    expect(visitors).toMatch(/cmd == "memory"/)
    expect(info).toMatch(/!= "memory"/)
    expect(menu).toMatch(/!= "memory"\) return;/)
    expect(menu).not.toContain('MSG_CONTROL')
  })

  it('read the notecards and settings the docs name', () => {
    const cards = literals(visitors.match(/^list\s+gCards = \[([^\]]*)\];/m)?.[1] ?? '')
    expect(cards).toEqual(['settings', 'presenters', 'datasets'])
    for (const card of cards) {
      expect(readme, card).toContain(`\`${card}\``)
      expect(plan, card).toContain(`\`${card}\``)
    }
    const settings = all(body(visitors, 'setting(string line)'), /name == "([^"]+)"/g)
    expect(settings).toEqual(['categories', 'radius', 'idle minutes', 'hold seconds', 'talk minutes'])
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
    // And the menu script, from the node's pages.
    expect(constant(menu, 'string', 'ID_CHARS')).toBe(constant(globe, 'string', 'ID_CHARS'))
    expect(constant(menu, 'integer', 'ID_MAX')).toBe(constant(globe, 'integer', 'ID_MAX'))
    expect(body(menu, 'integer isId(string s)')).toBe(body(globe, 'integer isId(string s)'))
  })

  it('start with sound as SOUND says, and let the owner turn it on and off without a reload', () => {
    // On by default for the exhibit (the maintainer's call, 27 October
    // 2026); the page stays silent unless its address asks.
    expect(constant(globe, 'integer', 'SOUND')).toBe('TRUE')
    expect(body(globe, 'act(key who, integer owner, string msg)')).toMatch(
      /if \(cmd == "sound"\)\n\s+\{\n\s+gSound = \(larg == "on"\);\n\s+if \(commit\(saved\)\) report\(cmd, \["ok", larg\]\);/,
    )
    // The owner script lets only on and off through.
    expect(body(owner, 'command(string msg)')).toMatch(
      /if \(cmd == "debug" \|\| cmd == "sound" \|\| cmd == "telemetry"\)\n\s+\{\n\s+if \(larg != "on" && larg != "off"\)/,
    )
    expect(globe).toMatch(/state_entry\(\)\n\s+\{\n\s+gSound = SOUND;/)
    // After the #, so it reloads nobody's page.
    expect(body(globe, 'string address()')).toContain('if (gSound) live += ["sound=1"];')
    // A face that refuses the new address puts the old sound back with
    // everything else: the snapshot and its restore agree, field by field.
    const fields = (globe.match(/return \[(gDataset[^\]]*)\];/)?.[1] ?? '').split(',').map((f) => f.trim())
    expect(fields).toContain('gSound')
    const restore = body(globe, 'restore(list s)')
    fields.forEach((field, i) => expect(restore, field).toMatch(new RegExp(`${field} = llList2\\w+\\(s, ${i}\\);`)))
    // And the docs name the command.
    expect(owner).toMatch(/sound on\|off, telemetry on\|off/)
    // In a table, where the README escapes the bar.
    expect(readme).toMatch(/\/9 sound on\\?\|off/)
  })

  it('hear the owner in the owner script, which has the globe make each change and says how it went', () => {
    // The owner's commands moved out of the globe script to give it room
    // (docs/SECOND_LIFE_COMPAT.md §9 Phase 5, step 1). They travel on
    // numbers of their own, never the visitors' control: a globe script
    // from before the split answers the owner's chat itself and ignores
    // them, so a sphere holding both does each command once, not twice.
    expect(owner).not.toContain('MSG_CONTROL')
    expect(body(owner, 'ask(string cmd)')).toContain('llMessageLinked(LINK_THIS, MSG_OWNER, cmd, llGetOwner());')
    for (const name of ['MSG_OWNER', 'MSG_RESULT']) {
      expect(messages(owner)[name], name).toBeDefined()
      // Nor the retired relay's, for the same reason.
      expect(['271006', '271007'], name).not.toContain(messages(owner)[name])
    }
    expect(globe).toContain('if (n == MSG_OWNER) { act(llGetOwner(), TRUE, str); return; }')
    // The two agree on every command, both ways. What a visitor may ask
    // for too, the owner script hands over as said and the globe words
    // for whoever asked: those sit before the globe's gate, beside `show`,
    // the scripts' own `rest` and `length`, and `rate`, which is the
    // owner's but is turned away there on the live Earth. Everything only
    // the owner may ask for comes after the gate, and the owner script
    // takes exactly those.
    const command = body(owner, 'command(string msg)')
    const shared = literals(command.match(/llListFindList\(\[([^\]]*)\], \[cmd\]\)/)?.[1] ?? '')
    const act = body(globe, 'act(key who, integer owner, string msg)')
    const gate = act.indexOf("// Everything below is the owner's.")
    expect(gate).toBeGreaterThan(-1)
    expect(new Set(all(act.slice(0, gate), /cmd == "(\w+)"/g))).toEqual(new Set([...shared, 'show', 'rest', 'length', 'rate']))
    const ownerOnly = new Set(all(act.slice(gate), /cmd == "(\w+)"/g))
    const answered = ['show', 'list', 'talk', 'presenters']
    expect(new Set(all(command, /cmd == "(\w+)"/g).filter((cmd) => !answered.includes(cmd)))).toEqual(ownerOnly)
    expect(command).toContain('ask("spin 0");')
    // A name from /9 list goes over as its id and its description, which
    // the globe titles the dataset with until the node's card says.
    expect(command).toContain('ask("show " + llList2String(PRESETS, at + 1) + " " + llList2String(PRESETS, at + 2));')
    // The globe reports each owner-only command, never wording it, and the
    // owner script words each report, refusal and stopped spin.
    const result = body(owner, 'result(string r)')
    for (const cmd of ownerOnly) expect(result, cmd).toContain(`cmd == "${cmd}"`)
    // The globe's peak is said only once it has shown a dataset.
    expect(result).toContain('if ((integer)llJsonGetValue(r, [3])) peaked = ')
    expect(act.slice(gate)).not.toContain('tell(')
    const outcomes = all(act, /report\(cmd, \["(\w+)"\]\)/g).filter((how) => how !== 'ok')
    expect(outcomes.sort()).toEqual(['off', 'steer', 'telemetry', 'tilted'])
    for (const how of outcomes) expect(result, how).toContain(`done == "${how}"`)
    // Its own checks keep a measured globe's changes after the # whatever
    // an owner script of another version sends, and round a rate as the
    // address carries it.
    expect(act).toMatch(/if \(larg != "hash" && larg != "query"\) return;\n\s+if \(larg == "query" && gTelemetry\) \{ report\(cmd, \["telemetry"\]\); return; \}/)
    expect(act).toContain('if (larg == "on" && !gHash) { report(cmd, ["steer"]); return; }')
    expect(act.slice(gate)).toContain('float r = (float)num((float)arg);')
    // The status the owner script reads is the one the globe sends, field
    // by field: each field the globe sends, and where the owner script
    // reads it.
    const fields: Array<[string, string]> = [
      ['gDataset', 'if (v != "")'],
      ['gTitle', 'what = llJsonGetValue(r, [3]) + " at "'],
      ['num(position(now()))', '" at " + llJsonGetValue(r, [4]) + of'],
      ['len', 'of = " of " + llJsonGetValue(r, [5])'],
      ['gPaused', '["playing", "paused"], (integer)llJsonGetValue(r, [6])'],
      ['num(gRate)', '", rate " + llJsonGetValue(r, [7])'],
      ['num(gSpin)', '". Spin " + llJsonGetValue(r, [8])'],
      ['address()', 'Address: " + llJsonGetValue(r, [9])'],
    ]
    const status = act.match(/report\(cmd, \["ok", (gDataset, [^\]]*)\]\);/)?.[1] ?? ''
    expect(status.split(', ')).toEqual(fields.map(([sent]) => sent))
    expect(result).toContain('string v = llJsonGetValue(r, [2]);')
    for (const [sent, read] of fields) expect(result, sent).toContain(read)
    // The owner script checks a command as the globe script would.
    for (const fn of ['string num(float f)', 'integer isNumber(string s)', 'integer isId(string s)']) {
      expect(body(owner, fn), fn).toBe(body(globe, fn))
    }
    for (const [type, name] of [['float', 'MIN_RATE'], ['float', 'MAX_RATE'], ['string', 'ID_CHARS'], ['integer', 'ID_MAX']]) {
      expect(constant(owner, type, name), name).toBe(constant(globe, type, name))
    }
    // And the globe script holds none of the owner's help, names or wording.
    expect(globe).not.toMatch(/\bhelp\(\)|PRESETS|Commands on \//)
  })

  it("word the owner's answers as the smoke-test globe does, for the commands the two share", () => {
    // The exhibit's owner script and the probe kit's globe answer the
    // same commands, and an owner who knows one reads the other. These
    // sentences are each one's, word for word; the exhibit's own (sound,
    // home, a spin a tilt refuses, the privacy notice) are its alone.
    const smoke = new Set(literals(read('../second-life-probe/terraviz-globe.lsl')).map((s) => s.replace(/^\[globe\] /, '')))
    const said = new Set(literals(owner))
    for (const sentence of [
      'Show what? /', ' list names a few.', ' list nor a dataset id. Ids are letters, digits, - and _.',
      'A rate from ', ", where 1 is the clip's own speed.", 'Rate ',
      'Rotation in degrees east, from -3600 to 3600, like 90 or -75.', ' degrees east is at the centre of the picture.',
      'Spin in degrees a second, up to 90, like 6 for a turn a minute, or off.', 'Spin off.', 'Spinning at ',
      'Debug readout ', 'width 1024, or width 2048.', 'Width ', '. The picture changes size at once, and the ',
      "video's resolution follows at the next dataset.",
      "Telemetry on. In the first minute after each visitor's page loads, it reports ",
      'anonymously which dataset it showed and anything that failed, then nothing more. A viewer ',
      "Telemetry off. Every visitor's page reloaded to pick this up.", ' steer hash first.', ' telemetry off first.',
      'steer hash, or steer query.', 'Changes now go after the #, which a browser applies without a reload.',
      'reload on a # change anyway.', 'Showing ', ', rate ', '. Spin ', ' degrees a second. Address: ',
      'Poles upright, texture turned 90 degrees, spin off.',
    ]) {
      expect(said, sentence).toContain(sentence)
      expect(smoke, sentence).toContain(sentence)
    }
  })

  it('answer each kind of menu on its own channel', () => {
    // So an answer from an older menu means what that menu meant.
    expect(body(visitors, 'mainMenu(key who)')).toContain('menu(who, text, b, gDlg);')
    expect(body(visitors, 'datasetsMenu(key who, integer page)')).toContain('menu(who, text, b, gDlgSets);')
    expect(visitors).toContain('llTextBox(who, "Jump to where in the clip? Seconds, like 90, or minutes and seconds, like 1:30.", gDlgJump);')
    expect(body(visitors, 'turnMenu(key who)')).toContain('gDlgTurn);')
    expect(visitors).toMatch(/gDlgSets = gDlg \+ 1;\n\s+gDlgJump = gDlg \+ 2;\n\s+gDlgTurn = gDlg \+ 3;/)
    // The node's menu is the menu script's, on channels of its own.
    expect(body(menu, 'kindsMenu(key who, integer page)')).toContain('menu(who, text, b, gDlgKinds);')
    expect(body(menu, 'livePage(key who, string body)')).toContain('menu(who, text, b, gDlgLive);')
    for (const channel of ['gDlgKinds', 'gDlgLive']) expect(menu).toContain(`llListen(${channel}, "", NULL_KEY, "");`)
    expect(menu).toMatch(/gDlgKinds = -4 - \(integer\)llFrand\(1000000000\.0\);\n\s+gDlgLive = gDlgKinds - 1;/)
    // Every channel the menus use stays negative, where no avatar can chat.
    expect(visitors).toMatch(/gDlg = -4 - /)
  })
})

describe("the exhibit's dataset menu", () => {
  const ID = (n: number) => `01KQG611HF8YXJNRBEHT0757${String(n).padStart(2, '0')}`

  /** The node's real replies, from a catalog of datasets with the longest
   *  titles and tags a page or the categories carry. */
  async function served(): Promise<{ page: ExhibitPage; tags: ExhibitTags }> {
    resetExhibitListForTests()
    const sqlite = freshMigratedDb()
    sqlite.prepare(`INSERT INTO node_identity (node_id, display_name, base_url, public_key, created_at)
                    VALUES ('NODE000', 'T', 'https://t', 'k', ?)`).run(T)
    sqlite.prepare(`INSERT INTO publishers (id, email, display_name, role, status, created_at)
                    VALUES ('PUB001', 'p@t', 'P', 'admin', 'active', ?)`).run(T)
    for (let i = 0; i < 12; i++) {
      sqlite.prepare(`INSERT INTO datasets (id, slug, origin_node, title, abstract, format, data_ref, weight, visibility,
                        is_hidden, schema_version, created_at, updated_at, published_at, publisher_id)
                      VALUES (?, ?, 'NODE000', ?, 'A.', 'video/mp4', 'vimeo:1', 0, 'public', 0, 1, ?, ?, ?, 'PUB001')`)
        .run(ID(i), `d-${i}`, `${'A long title '.repeat(15)}${i}`, T, T, T)
      for (let j = 0; j < 3; j++) {
        sqlite.prepare('INSERT INTO dataset_tags (dataset_id, tag) VALUES (?, ?)')
          .run(ID(i), `${String(i * 3 + j).padStart(2, '0')}${' Category'.repeat(5)}`.slice(0, TAG_CAP))
      }
    }
    const env = { CATALOG_DB: asD1(sqlite) }
    const pageText = await (await getPage(makeCtx({ url: 'https://t/api/exhibit/v1/datasets?limit=9&offset=0&tag=', env }) as never)).text()
    const tagsText = await (await getTags(makeCtx({ url: 'https://t/api/exhibit/v1/tags', env }) as never)).text()
    return { page: JSON.parse(pageText) as ExhibitPage, tags: JSON.parse(tagsText) as ExhibitTags }
  }

  const listen = (): string => menu.slice(menu.indexOf('    listen(integer ch, string name, key who, string msg)'))
  const kindsAnswer = (): string => listen().slice(listen().indexOf('if (ch == gDlgKinds)'), listen().indexOf('if (ch != gDlgLive) return;'))
  const pageAnswer = (): string => listen().slice(listen().indexOf('if (ch != gDlgLive) return;'))

  const opened = (): string => menu.slice(menu.indexOf('    link_message('), menu.indexOf('    http_response('))

  it('is a script in a prim of its own, which the visitors script opens and hands back to', () => {
    // The visitors script had no room for it, and in the globe's prim its
    // web replies reached the info script too: two Stack-Heap Collisions
    // in-world, 27 October. The visitors script keeps the switch and the
    // hand-back; the info script never sees a page.
    expect(visitors).not.toContain('kindsMenu')
    expect(all(info, /"(\/api\/[^"]*)"/g)).toEqual(['/api/exhibit/v1/datasets/'])
    expect(info).not.toContain('/api/exhibit/v1/tags')
    expect(visitors).toContain('gLive = gMenu == [];')
    expect(visitors).toContain('if (gLive) gMenu = DEFAULT_MENU;')
    expect(visitors).toMatch(/if \(msg == BTN_DATASETS\)\n\s+\{\n(?:\s+\/\/.*\n)*\s+if \(!gLive\) \{ datasetsMenu\(who, 0\); return; \}\n(?:\s+\/\/.*\n)*\s+llMessageLinked\(LINK_SET, MSG_MENU_OPEN, gNode \+ "\\n" \+ gCategories \+ "\\n" \+ \(string\)unix\(\), who\);/)
    // Datasets is offered only to a visitor who may act, so the menu
    // script is opened only for one.
    expect(visitors.indexOf("if (!mayAct(who)) { llRegionSayTo(who, 0, whyNot()); return; }\n\n        if (msg == BTN_DATASETS)")).toBeGreaterThan(-1)
    // It says at once that it is there, before anything it can fail at,
    // unless it is in the visitors script's own prim, where its replies
    // would reach the info script, or asked too long ago.
    expect(opened()).toMatch(/if \(n != MSG_MENU_OPEN \|\| sender == llGetLinkNumber\(\)\) return;\n\s+list w = llParseStringKeepNulls\(str, \["\\n"\], \[\]\);\n(?:\s+\/\/.*\n)*\s+if \(llGetListLength\(w\) > 2\)\n\s+if \(unix\(\) - \(integer\)llList2String\(w, 2\) >= OPEN_LATE\) return;\n(?:\s+\/\/.*\n)*\s+done\(id, "open"\);/)
    expect(opened()).toMatch(/open\(id\);\n\s+\}\s*$/)
    // What comes back: the main menu, the built-in datasets, or a choice,
    // which the visitors script holds to the hold and any talk, and which
    // is only ever a show.
    const back = visitors.slice(visitors.indexOf('if (n == MSG_MENU_DONE)'), visitors.indexOf('if (n != MSG_STATE) return;'))
    expect(back).toMatch(/gOpening = llDeleteSubList\(gOpening, o, o \+ 1\);\n\s+gNoMenu = FALSE;\n\s+if \(str == "open"\) return;/)
    expect(back).toContain('if (str == "main") { mainMenu(id); return; }')
    expect(back).toContain('if (str == "datasets") { datasetsMenu(id, 0); return; }')
    expect(back).toMatch(/if \(llGetSubString\(str, 0, 4\) != "show "\) return;\n\s+if \(!mayAct\(id\)\) \{ llRegionSayTo\(id, 0, whyNot\(\)\); return; \}\n\s+ask\(id, str\);/)
    expect(all(menu, /done\((?:who|id), "(\w+)/g).sort()).toEqual(['datasets', 'main', 'open', 'show'])
    // The numbers are new, so a prim still holding the earlier build's
    // menu relay can't take one message for the other.
    expect(Object.values(messages(menu)).sort()).toEqual(['271008', '271009'])
  })

  it('gives the visitor the built-in datasets when the menu script never answers, and tells the owner once', () => {
    const fallback = body(visitors, 'check()')
    expect(fallback).toMatch(/while \(gOpening != \[\] && t - llList2Integer\(gOpening, 1\) >= MENU_WAIT\)\n\s+\{\n\s+key v = llList2Key\(gOpening, 0\);\n\s+gOpening = llDeleteSubList\(gOpening, 0, 1\);\n\s+if \(!gNoMenu\)\n\s+llOwnerSay\([^;]+;\n\s+gNoMenu = TRUE;\n\s+datasetsMenu\(v, 0\);/)
    expect(fallback).toContain('see the README')
    // One wait a visitor, and a bounded number in all.
    const open = visitors.slice(visitors.indexOf('if (msg == BTN_DATASETS)'), visitors.indexOf('if (msg == BTN_PAUSE)'))
    expect(open).toMatch(/if \(o != -1\) gOpening = llDeleteSubList\(gOpening, o, o \+ 1\);\n\s+gOpening \+= \[who, unix\(\)\];\n\s+if \(llGetListLength\(gOpening\) > CTX_MAX \* 2\) gOpening = llDeleteSubList\(gOpening, 0, 1\);/)
    // It is checked every TICK, so a visitor whose menu script is missing
    // waits at most MENU_WAIT + TICK seconds.
    const wait = Number(constant(visitors, 'integer', 'MENU_WAIT'))
    expect(wait + Number(constant(visitors, 'float', 'TICK'))).toBeLessThanOrEqual(11)
    // Both menus only in a region slower than the margin: the menu script
    // answers only while the request is under OPEN_LATE whole seconds old,
    // so before OPEN_LATE seconds have passed (and for at least OPEN_LATE
    // - 1, room for a busy region), and the visitors script gives its own
    // at MENU_WAIT whole seconds, at or after floor(asked) + MENU_WAIT.
    // Both read the region's clock, so an answer has over MENU_WAIT -
    // OPEN_LATE seconds to arrive first.
    const late = Number(constant(menu, 'integer', 'OPEN_LATE'))
    expect(late).toBeGreaterThanOrEqual(3)
    expect(wait - late).toBeGreaterThanOrEqual(3)
    for (let asked = 0; asked < 1; asked += 0.05) {
      for (let answered = asked; answered < asked + 4; answered += 0.05) {
        if (Math.floor(answered) - Math.floor(asked) >= late) continue // not answered
        for (let check = asked; check < asked + 6; check += 0.05) {
          if (Math.floor(check) - Math.floor(asked) >= wait) {
            expect(check - answered, `${asked} ${answered} ${check}`).toBeGreaterThan(wait - late - 1e-9)
            break
          }
        }
      }
    }
  })

  it("answers a menu for as long as the docs say, and as nobody else's", () => {
    // Five minutes from the last menu shown, though the timer that forgets
    // it runs once a minute.
    expect(Number(constant(menu, 'integer', 'CTX_TTL'))).toBe(300)
    expect(listen()).toContain('if (at == -1 || at % 3 != 0 || unix() - llList2Integer(gCtx, at + 2) > CTX_TTL) return;')
    expect(readme.replace(/\s+/g, ' ')).toContain('for the five minutes the menu answers')
    // Headed with the globe's name, as the visitors script's menus are.
    expect(opened()).toMatch(/string name = llGetLinkName\(sender\);\n\s+if \(llGetObjectName\(\) != name\) llSetObjectName\(name\);/)
  })

  it('tells the owner once why the node gave no menu, and gives the visitor the built-in five', () => {
    const failed = body(menu, 'liveFailed(key who, string why)')
    expect(failed).toMatch(
      /if \(!gTold\)\n\s+llOwnerSay\([^;]+;\n\s+gTold = TRUE;\n\s+done\(who, "datasets"\);/,
    )
    // A visitor sent to the last page and then failed isn't held as sent,
    // so their next page past the end is asked for again.
    expect(failed).toMatch(/integer asked = llListFindList\(gRefetched, \[who\]\);\n\s+if \(asked != -1\) gRefetched = llDeleteSubList\(gRefetched, asked, asked\);/)
    // Until the node gives a menu again, and of categories it lacks once a
    // settings notecard, not at every refresh of them; and of a new node's
    // or new categories' trouble.
    expect(body(menu, 'livePage(key who, string body)')).toContain('gTold = FALSE;')
    expect(body(menu, 'tagsRead(key who, string body)')).toContain('if (kinds() != []) gTold = FALSE;')
    expect(opened()).toMatch(/gKindsAt = unix\(\);\n\s+gTold = FALSE;/)
    expect(opened()).toMatch(/if \(node != gNode\)\n\s+\{[^}]*gTold = FALSE;/)
    // Every failure has its reason: no node yet, a request throttled, a
    // reply that isn't JSON, and one that isn't a menu this script reads.
    const failure = body(menu, 'string failure(integer status)')
    for (const status of ['-1', '0', '200', '415']) expect(failure).toContain(`status == ${status}`)
    const read = body(menu, 'read(key who, string path, integer budget)')
    expect(read).toContain('if (gNode == "") { liveFailed(who, failure(0)); return; }')
    expect(read).toContain('if (req == NULL_KEY) { liveFailed(who, failure(-1)); return; }')
    // The owner's categories narrow it, by name and in any case, "All
    // datasets" among them if named.
    const kinds = body(menu, 'list kinds()')
    expect(kinds).toContain('if (llToLower(t) == c && llListFindList(out, [t]) == -1) out += [t];')
    expect(kinds).toContain('if (c == llToLower(BTN_ALL) && llListFindList(out, [""]) == -1) out += [""];')
  })

  it('reads the node at addresses it takes, one read at a time a visitor, within each budget', () => {
    const read = body(menu, 'read(key who, string path, integer budget)')
    expect(read).toContain('key req = llHTTPRequest(gNode + path, [HTTP_METHOD, "GET", HTTP_ACCEPT, "application/json",')
    expect(read).toContain('HTTP_BODY_MAXLENGTH, budget + 1]')
    expect(body(menu, 'open(key who)')).toContain('read(who, "/api/exhibit/v1/tags", TAGS_BYTES);')
    expect(body(menu, 'askPage(key who, string tag, integer offset)')).toContain(
      'read(who, "/api/exhibit/v1/datasets?limit=9&offset=" + (string)offset + "&tag=" + llEscapeURL(tag), PAGE_BYTES);',
    )
    // A reply of exactly the budget can't read as cut.
    expect(Number(constant(menu, 'integer', 'PAGE_BYTES'))).toBe(PAGE_BUDGET)
    expect(Number(constant(menu, 'integer', 'TAGS_BYTES'))).toBe(TAGS_BUDGET)
    // Nine a page, which the node pages that far, and nine numbers with
    // three moves are a whole menu.
    const page = Number(constant(menu, 'integer', 'PAGE'))
    expect(page).toBe(9)
    expect(page).toBeLessThanOrEqual(PAGE_MAX_LIMIT)
    expect(page + 3).toBeLessThanOrEqual(12)
    // llEscapeURL writes a space as %20 and anything past ASCII as its
    // UTF-8 bytes, which the node reads back as the tag it listed.
    for (const query of ['limit=9&offset=0&tag=', 'limit=9&offset=27&tag=Snow%20and%20Ice', `limit=9&offset=9&tag=${encodeURIComponent('海'.repeat(13))}`]) {
      expect('message' in parsePageQuery(new URLSearchParams(query)), query).toBe(false)
    }
    // One read in flight a visitor, and a bounded number in all. A menu
    // shown without a read forgets the one in flight too, or its reply
    // would land over the menu the visitor has by then.
    expect(body(menu, 'drop(key who)')).toMatch(/integer at = llListFindList\(gReqs, \[who\]\);\n\s+if \(at != -1 && at % 2 == 1\) gReqs = llDeleteSubList\(gReqs, at - 1, at\);/)
    expect(read).toMatch(/remember\(who, pageOf\(who\)\);\n\s+drop\(who\);/)
    expect(body(menu, 'kindsMenu(key who, integer page)')).toMatch(/\{\n(?:\s+\/\/.*\n)*\s+drop\(who\);/)
    expect(listen()).toContain('if (msg == BTN_MENU) { drop(who); done(who, "main"); return; }')
    expect(read).toContain('while (llGetListLength(gReqs) > CTX_MAX * 2) gReqs = llDeleteSubList(gReqs, 0, 1);')
    // A reply this script didn't ask for is set aside at once; so is one
    // for a menu that has closed.
    const reply = menu.slice(menu.indexOf('    http_response('), menu.indexOf('    listen('))
    expect(reply).toMatch(/integer at = llListFindList\(gReqs, \[req\]\);\n\s+if \(at == -1 \|\| at % 2 != 0\) return;/)
    expect(reply).toMatch(/at = llListFindList\(gCtx, \[who\]\);\n\s+if \(at == -1 \|\| at % 3 != 0\) return;/)
    expect(info).toMatch(/http_response\(key req, integer status, list meta, string body\)\n\s+\{\n\s+if \(req != gReq\) return;/)
    // In the globe's prim only the info script has a handler: every reply
    // reaches every script there that has one.
    expect(globe).not.toContain('http_response')
    expect(visitors).not.toContain('http_response')
  })

  it("reads only what the node's replies carry", async () => {
    const { page, tags } = await served()
    // Every value read is a value in a real reply, an index the script
    // counts with read at 0.
    const paths = all(menu, /(?:value\(body, |llJsonGetValue\(body, )\[([^\]]*)\]/g)
    expect(paths.length).toBeGreaterThan(8)
    for (const path of paths) {
      const steps = path.split(',').map((s) => s.trim()).map((s) => (s.startsWith('"') ? JSON.parse(s) : 0))
      const from = steps[0] === 'tags' ? tags : page
      let value: unknown = from
      for (const step of steps) value = (value as Record<string | number, unknown>)[step]
      expect(value, path).toBeDefined()
      expect(typeof value === 'object' && value !== null, `${path} is a value`).toBe(false)
    }
    // No more than a reply can hold, which the node never exceeds.
    expect(body(menu, 'tagsRead(key who, string body)')).toContain(`while (i < ${TAGS_MAX} && `)
    expect(body(menu, 'tagsRead(key who, string body)')).toContain(`if (t != "" && llStringLength(t) <= ${TAG_CAP})`)
    expect(page.datasets.length).toBe(9)
    expect(tags.tags.length).toBeGreaterThan(9)
  })

  it('keeps a few pages as the node sent them, for menus still open, and measures what they cost', () => {
    expect(Number(constant(menu, 'integer', 'LIVE_PAGES'))).toBe(4)
    // A page within its 1 KB budget, at two bytes a character: 8 KB at most.
    expect(Number(constant(menu, 'integer', 'LIVE_PAGES')) * PAGE_BUDGET * 2).toBeLessThanOrEqual(8192)
    const live = body(menu, 'livePage(key who, string body)')
    expect(live).toContain('gPages += [who, tag, from, body];')
    expect(live).toContain('while (llGetListLength(gPages) > LIVE_PAGES * 4) gPages = llDeleteSubList(gPages, 0, 3);')
    // Ids the globe takes, no more than a page holds, each id and title
    // within the node's caps, or it isn't a page.
    expect(live).toMatch(/while \(ok && n <= PAGE && llJsonValueType\(body, \["datasets", n\]\) != JSON_INVALID\)\n\s+\{\n\s+string id = value\(body, \["datasets", n, "id"\]\);\n\s+ok = isId\(id\) && llStringLength\(id\) <= (\d+) && llStringLength\(value\(body, \["datasets", n, "title"\]\)\) <= (\d+);/)
    const [, idCap, titleCap] = live.match(/llStringLength\(id\) <= (\d+) && llStringLength\(value\(body, \["datasets", n, "title"\]\)\) <= (\d+)/) ?? []
    // The node's caps are bytes, and a character takes at least one.
    expect(Number(idCap)).toBe(PAGE_CAPS.id)
    expect(Number(titleCap)).toBe(PAGE_CAPS.title)
    expect(live).toContain('if (!ok || n > PAGE) { liveFailed(who, failure(200)); return; }')
    // A page goes with the menu that showed it, and so does being sent to
    // the last page.
    expect(menu).toContain('if (llListFindList(gCtx, [llList2Key(gPages, i)]) == -1) gPages = llDeleteSubList(gPages, i, i + 3);')
    expect(menu).toContain('if (llListFindList(gCtx, [llList2Key(gRefetched, i)]) == -1) gRefetched = llDeleteSubList(gRefetched, i, i);')
    // A read keeps the visitor's menu answerable until its reply.
    expect(body(menu, 'read(key who, string path, integer budget)')).toContain('remember(who, pageOf(who));')
    // /9 memory says the most it took, as the other scripts do.
    expect(menu).toMatch(/llScriptProfiler\(PROFILE_SCRIPT_MEMORY\);\n[\s\S]*?llScriptProfiler\(PROFILE_NONE\);\n\s+if \(llGetSPMaxMemory\(\) > gPeak\) gPeak = llGetSPMaxMemory\(\);/)
    expect(menu).toContain('KB while reading the node for a menu')
    // Text never asks fit for less than nothing, which would never end.
    expect(body(menu, 'string fit(string s, integer max)')).toMatch(/\{\n(?:\s+\/\/.*\n)*\s+if \(max < 1\) return "";/)
  })

  it('answers every button with the row or category printed beside it, on every page, paging round at both ends', () => {
    // The expressions the script numbers, answers and pages with, pinned
    // here and then run: nothing else in this file executes them.
    const live = body(menu, 'livePage(key who, string body)')
    const kinds = body(menu, 'kindsMenu(key who, integer page)')
    const pageAns = pageAnswer()
    const kindsAns = kindsAnswer()
    expect(live).toContain('string number = (string)(offset + i + 1);')
    expect(pageAns).toContain('integer row = (integer)msg - 1 - offset;')
    expect(pageAns).toContain('if ((string)(row + 1 + offset) != msg || row < 0 || llJsonValueType(body, ["datasets", row]) == JSON_INVALID) return;')
    expect(pageAns).toContain('done(who, "show " + value(body, ["datasets", row, "id"]) + " " + value(body, ["datasets", row, "title"]));')
    expect(pageAns).toMatch(/offset \+= PAGE;\n\s+if \(offset >= total\) offset = 0;/)
    expect(pageAns).toMatch(/offset -= PAGE;\n\s+if \(offset < 0\) offset = \(total - 1\) \/ PAGE \* PAGE;/)
    expect(kinds).toContain('string number = (string)(page * PAGE + i + 1);')
    expect(kindsAns).toContain('integer i = (integer)msg - 1;')
    expect(kindsAns).toContain('i += page * PAGE;')
    expect(kindsAns).toContain('if (i >= 0 && i < llGetListLength(k)) askPage(who, llList2String(k, i), 0);')

    const PAGE = 9
    /** The page answer, as the pinned lines run it: the row shown, or null. */
    const choose = (rows: string[], offset: number, msg: string): string | null => {
      const row = (Number.parseInt(msg, 10) || 0) - 1 - offset
      if (String(row + 1 + offset) !== msg || row < 0 || row >= rows.length) return null
      return rows[row]
    }
    for (const total of [1, 8, 9, 10, 17, 18, 19, 27, 175]) {
      const rowsAll = Array.from({ length: total }, (_, k) => `row ${k}`)
      const seen: string[] = []
      let offset = 0
      for (let step = 0; step < Math.ceil(total / PAGE); step++) {
        const rows = rowsAll.slice(offset, offset + PAGE)
        for (let i = 0; i < rows.length; i++) {
          // Printed beside the button, and what the button answers.
          expect(choose(rows, offset, String(offset + i + 1)), `${total}: ${offset + i + 1}`).toBe(rows[i])
          seen.push(rows[i])
        }
        // A number from another page of the same category answers nothing.
        expect(choose(rows, offset, String(offset + rows.length + 1))).toBeNull()
        if (offset > 0) expect(choose(rows, offset, String(offset))).toBeNull()
        expect(choose(rows, offset, '01')).toBeNull()
        offset += PAGE
        if (offset >= total) offset = 0
      }
      // Next visits every row once and comes back to the first page.
      expect(seen).toEqual(rowsAll)
      expect(offset).toBe(0)
      // Previous from the first page goes to the last, which holds 1 to 9.
      const last = Math.trunc((total - 1) / PAGE) * PAGE
      expect(total - last).toBeGreaterThan(0)
      expect(total - last).toBeLessThanOrEqual(PAGE)
    }
    // Categories: a number counts from the first category on every page.
    const k = Array.from({ length: 23 }, (_, n) => `cat ${n}`)
    for (let page = 0; page * PAGE < k.length; page++) {
      for (let i = 0; i < PAGE && page * PAGE + i < k.length; i++) {
        expect(k[Number.parseInt(String(page * PAGE + i + 1), 10) - 1]).toBe(k[page * PAGE + i])
      }
    }
  })

  it('shows categories again, rather than answering, once they have changed since they were shown', () => {
    const ans = kindsAnswer()
    expect(ans).toContain('if (gKindsAt > llList2Integer(gCtx, at + 2)) { kindsMenu(who, page); return; }')
    expect(ans.indexOf('gKindsAt >')).toBeLessThan(ans.indexOf('askPage('))
    // They change when the node's or the owner's do, and only then.
    expect(body(menu, 'tagsRead(key who, string body)')).toContain('if (llDumpList2String(kinds(), "\\n") != before) gKindsAt = gTagsAt;')
    expect(opened()).toMatch(/if \(cats != gCats\)\n\s+\{\n\s+gCats = cats;[\s\S]*?gKindsAt = unix\(\);/)
  })

  it("says when the list changed between two pages of a category, and doesn't start over", () => {
    const live = body(menu, 'livePage(key who, string body)')
    expect(live).toMatch(
      /if \(llList2String\(gPages, at \+ 1\) == tag && from != "" && was != "" && was != from\)\n\s+text \+= " A dataset may have moved between pages since the last one.";/,
    )
    // Only while paging: the categories forget the page a visitor had.
    expect(body(menu, 'kindsMenu(key who, integer page)')).toContain('if (at != -1 && at % 4 == 0) gPages = llDeleteSubList(gPages, at, at + 3);')
    // Two isolates can hold lists a minute apart: a menu that started over
    // at every change might never page forward. Only a page past the end,
    // as one can be once the catalog has shrunk, asks for another: the
    // last, once a visitor, so a node echoing other offsets isn't asked
    // for ever.
    expect(all(live, /askPage\(who, (.*)\);/g)).toEqual(['tag, (total - 1) / PAGE * PAGE'])
    expect(live).toContain('integer asked = llListFindList(gRefetched, [who]);')
    expect(live).toMatch(/if \(total > 0 && asked == -1\)\n\s+\{\n\s+gRefetched \+= \[who\];/)
    // A category emptied since it was listed goes back to the categories,
    // unless it was the only one, which would open it again.
    expect(live).toContain('if (tag != "" && llGetListLength(kinds()) > 1)')
  })

  it('names a category button only when every name on its page fits one whole and none repeats', () => {
    const named = body(menu, 'integer named(list tags)')
    expect(named).toContain('list seen = [BTN_PREV, BTN_NEXT, BTN_MENU];')
    expect(named).toContain('if (label(l) != l || llListFindList(seen, [l]) != -1) return FALSE;')
    // The menu and its answer decide it from the same page of the same list.
    expect(body(menu, 'kindsMenu(key who, integer page)')).toContain('list tags = llList2List(k, page * PAGE, page * PAGE + PAGE - 1);')
    expect(body(menu, 'kindsMenu(key who, integer page)')).toContain('integer byName = named(tags);')
    const ans = kindsAnswer()
    expect(ans).toContain('list tags = llList2List(k, page * PAGE, page * PAGE + PAGE - 1);')
    expect(ans).toContain('if (named(tags))')
    // "All datasets" is the empty tag, so a category of that name is
    // another button, and one alone opens at once.
    expect(body(menu, 'list kinds()')).toContain('if (gCategories == []) return [""] + tags;')
    expect(body(menu, 'kindsMenu(key who, integer page)')).toContain('if (count == 1) { askPage(who, llList2String(k, 0), 0); return; }')
  })

  it('takes the node and the categories from the visitors script each time it opens, and forgets a node it no longer shows', () => {
    // A script reads notecards from its own prim alone, so the settings
    // notecard's categories come with the node, as the visitors script
    // read them.
    expect(menu).not.toMatch(/llGetNotecardLine|llGetInventory|dataserver/)
    expect(body(visitors, 'setting(string line)')).toMatch(
      /if \(name == "categories"\)\n\s+\{\n\s+gNewCategories = "";\n\s+if \(eq < llStringLength\(line\) - 1\) gNewCategories = llStringTrim\(llGetSubString\(line, eq \+ 1, -1\), STRING_TRIM\);\n\s+return;/,
    )
    expect(body(visitors, 'nextCard()')).toContain('gCategories = gNewCategories;')
    expect(body(visitors, 'readCards()')).toContain('gNewCategories = "";')
    const state = opened()
    expect(state).toContain('list w = llParseStringKeepNulls(str, ["\\n"], []);')
    expect(state).toContain('string node = llList2String(w, 0);')
    expect(state).toContain('string cats = llList2String(w, 1);')
    // The node's categories, pages and reads are of the node they came from.
    expect(state).toMatch(/if \(node != gNode\)\n\s+\{\n\s+gTagsAt = 0;\n\s+gTags = \[\];\n\s+gPages = \[\];\n\s+gReqs = \[\];\n\s+gRefetched = \[\];/)
    // A state without a node hands over none, which the menu reports.
    expect(visitors).toMatch(/gNode = llJsonGetValue\(str, \["node"\]\);\n\s+if \(gNode == JSON_INVALID\) gNode = "";/)
    // Names between commas, trimmed, none empty.
    expect(state).toContain('list parts = llParseString2List(cats, [","], []);')
    expect(state).toContain('if (c != "") gCategories += [c];')
  })
})

/** An LSL integer: 32 bits, signed. */
function int32(value: number): number {
  if (!Number.isInteger(value) || value < -(2 ** 31) || value > 2 ** 31 - 1) {
    throw new RangeError(`${value} is not an LSL integer`)
  }
  return value
}

/**
 * What the translated statements call: LSL's, with every integer checked.
 * llRound and llFloor take a float, so their argument is rounded to 32
 * bits as LSL rounds it.
 */
const LSL = {
  int32,
  // A product of two integers, which LSL would wrap past 32 bits.
  mul: (a: number, b: number): number => int32(a * b),
  round: (x: number): number => int32(Math.round(Math.fround(x))),
  floor: (x: number): number => int32(Math.floor(Math.fround(x))),
}

/** The left and right of the products allowed to stay unchecked: floats'. */
const FLOAT_TIMES_LEFT = /(?:\bgRate|\bf|\)) $/
const FLOAT_TIMES_RIGHT = /^ (?:1000\.0|1000000\.0|lsl\.floor\()/

/**
 * Translates the statements of a whole-number LSL function into JS. Every
 * value given to an integer, and every product of two integers, is
 * checked against 32 bits rather than wrapped. Floats are rounded to 32
 * bits where LSL's types force it (declarations, casts, and llRound's and
 * llFloor's arguments); a step in between runs wider, as Mono may run it.
 * It knows only what the scripts' clock arithmetic uses, and fails closed:
 * a product it can't tell is a float's throws rather than going unchecked.
 */
function translate(statements: string): string {
  const js = statements
    .replace(/\/\/.*$/gm, '')
    .replace(/\b(?:(integer|float) )?([A-Za-z_]\w*) (\+=|-=|=) ([^;]+);/g, (_m, type: string | undefined, name: string, op: string, value: string) => {
      if (type === 'integer') return `let ${name} = lsl.int32(${value});`
      if (type === 'float') return `let ${name} = Math.fround(${value});`
      if (op === '=') return `${name} = lsl.int32(${value});`
      return `${name} = lsl.int32(${name} ${op[0]} (${value}));`
    })
    // Integer times integer: names and whole literals, not a float's
    // literal (1000.0) nor a call's name.
    .replace(/\b([a-z]\w*|\d+) \* ([a-z]\w*|\d+)\b(?![.(])/g, 'lsl.mul($1, $2)')
    .replace(/llList2Integer\(t, (\d)\)/g, 't[$1]')
    .replace(/\(float\)(\w+)/g, 'Math.fround($1)')
    .replace(/\bllRound\(/g, 'lsl.round(')
    .replace(/\bllFloor\(/g, 'lsl.floor(')
  for (let i = js.indexOf('*'); i !== -1; i = js.indexOf('*', i + 1)) {
    if (!FLOAT_TIMES_LEFT.test(js.slice(0, i)) || !FLOAT_TIMES_RIGHT.test(js.slice(i + 1))) {
      throw new Error(`a product the translation can't check: ${js.slice(Math.max(0, i - 20), i + 20)}`)
    }
  }
  return js
}

type LoopUs = (now: [number, number], d: number, clock: {
  gPos: number, gAtS: number, gAtMs: number, gRate: number, gPaused: number
}) => number

/** One script's loopUs, runnable. */
function loopUsOf(script: string): LoopUs {
  const source = body(script, 'integer loopUs(list t, integer d)')
  const run = new Function('t', 'd', 'gPos', 'gAtS', 'gAtMs', 'gRate', 'gPaused', 'lsl',
    translate(source.slice(source.indexOf('{') + 1)))
  return (now, d, c) => run(now, d, Math.fround(c.gPos), c.gAtS, c.gAtMs, Math.fround(c.gRate), c.gPaused, LSL)
}

/** Where the clip is, in microseconds round the loop, worked exactly. */
function exactUs(now: [number, number], d: number, c: Parameters<LoopUs>[2]): number {
  const D = BigInt(d)
  let us = BigInt(Math.round(c.gPos * 1e6))
  if (!c.gPaused) {
    const ms = BigInt(now[0] - c.gAtS) * 1000n + BigInt(now[1] - c.gAtMs)
    us += ms * BigInt(Math.round(c.gRate * 1000))
  }
  return Number(((us % D) + D) % D)
}

describe("the exhibit's clip clock", () => {
  const SIGNATURE = 'integer loopUs(list t, integer d)'
  const loopUs = loopUsOf(globe)
  // An anchor in October 2026, and the node's clips: 1.7 s (Drought), 4.3 s
  // (Ocean Circulation), a Vimeo stream's 12.1 and 143.766672, the node's
  // longest at 717, and the longest the info script keeps.
  const AT: [number, number] = [1_792_500_000, 640]
  const LENGTHS = [1_700_000, 4_333_333, 12_100_000, 143_766_672, 717_033_333, 2_146_999_999]
  const RATES = [0.084, 0.25, 1, 2.5, 4, 12.8]
  const DAY = 86_400

  it('is one copy in the globe and info scripts', () => {
    expect(body(info, SIGNATURE)).toBe(body(globe, SIGNATURE))
  })

  it('is exact to the microsecond however long the globe has played, at any rate, in 32-bit integers', () => {
    // A float lost about 10 ms a day of play at 1x, a third of a second a
    // month, and seconds at a higher rate. Ten years keeps short of 2038,
    // when Unix seconds outgrow an LSL integer.
    for (const d of LENGTHS) {
      for (const gRate of RATES) {
        // Some land on a millisecond below the anchor's, which borrows a second.
        for (const [s, ms] of [[0, 0], [0, 1], [1, 360], [DAY, 359], [30 * DAY, 0], [365 * DAY + 7, 999], [3653 * DAY, 123]]) {
          const now: [number, number] = [AT[0] + s + Math.floor((AT[1] + ms) / 1000), (AT[1] + ms) % 1000]
          const clock = { gPos: 0, gAtS: AT[0], gAtMs: AT[1], gRate, gPaused: 0 }
          expect(loopUs(now, d, clock), `${d} us at ${gRate}x after ${s} s ${ms} ms`).toBe(exactUs(now, d, clock))
        }
      }
    }
  })

  it("adds the time since the anchor to the anchor's own position", () => {
    // Positions a float holds exactly, so the reference is exact too.
    for (const gPos of [0.5, 3.25, 11.875]) {
      const clock = { gPos, gAtS: AT[0], gAtMs: AT[1], gRate: 2.5, gPaused: 0 }
      const now: [number, number] = [AT[0] + 9 * DAY, 17]
      expect(loopUs(now, 12_100_000, clock)).toBe(exactUs(now, 12_100_000, clock))
    }
  })

  it('wraps an anchor set past the loop before it counts in microseconds', () => {
    // As by a jump before the clip's length was known: 99999.5 s is past
    // what an integer holds in microseconds, and about as far as the globe
    // jumps. Wrapped in a float, it lands within the float's error in the
    // clip's length times the loops. Under 5 ms with the products as wide
    // as this translation runs them, under 8 ms with each rounded to 32
    // bits (reckoned in review across the node's lengths): Mono doesn't
    // say which, and either is under a frame.
    expect(body(globe, 'act(key who, integer owner, string msg)')).toContain('if (to < 0.0 || to > 100000.0)')
    for (const d of [1_700_000, 12_100_000, 717_033_333]) {
      const clock = { gPos: 99_999.5, gAtS: AT[0], gAtMs: AT[1], gRate: 1, gPaused: 0 }
      const now: [number, number] = [AT[0] + 3, AT[1]]
      const got = loopUs(now, d, clock)
      expect(got).toBeGreaterThanOrEqual(0)
      expect(got).toBeLessThan(d)
      const off = Math.abs(got - exactUs(now, d, clock))
      expect(Math.min(off, d - off)).toBeLessThan(8_000)
    }
  })

  it('takes nothing the translation can\'t check', () => {
    // A product that leaves 32 bits in LSL but not in a JS double would
    // otherwise pass: these each throw at translation.
    for (const product of ['p = (p + (a * (1000 * r)) % d) % d;', 'p = (p + (a*1000*r) % d) % d;', 'p = (p + a * K * r) % d;']) {
      expect(() => translate(product), product).toThrow(/can't check/)
    }
  })

  it('counts a region clock behind the anchor backwards, round the loop', () => {
    const clock = { gPos: 2, gAtS: AT[0], gAtMs: AT[1], gRate: 1, gPaused: 0 }
    const now: [number, number] = [AT[0] - 5, 100]
    expect(loopUs(now, 4_333_333, clock)).toBe(exactUs(now, 4_333_333, clock))
  })

  it('holds a paused clip where it was paused, however long ago', () => {
    const clock = { gPos: 3.25, gAtS: AT[0], gAtMs: AT[1], gRate: 4, gPaused: 1 }
    expect(loopUs([AT[0] + 400 * DAY, 5], 12_100_000, clock)).toBe(3_250_000)
  })

  it('reads the length from the card in microseconds, and tells the globe, which keeps it for that dataset alone', () => {
    const card = body(info, 'card(string b, integer cut)')
    const list = 'list x = llParseString2List(value(b, "exactDuration"), ["."], []);'
    const from = card.indexOf(list) + list.length
    const parse = card.slice(from, card.indexOf(';', card.indexOf('if (w >= 0', from)) + 1)
    // LSL's (integer) of a string reads its leading digits, and 0 for none.
    const js = translate(parse
      .replace(/\(integer\)llList2String\(x, 0\)/, '(Number.parseInt(x[0] ?? "", 10) || 0)')
      .replace('llList2String(x, 0) == (string)w', '(x[0] ?? "") === String(w)')
      .replace('(integer)llGetSubString(llList2String(x, 1) + "000000", 0, 5)',
        '(Number.parseInt(((x[1] ?? "") + "000000").slice(0, 6), 10) || 0)')
      .replace(/\bgLen\b/g, 'len'))
    expect(js).not.toMatch(/\bll[A-Z]|\(integer\)/)
    // llParseString2List drops the empty pieces.
    const run = new Function('value', 'lsl',
      `const x = value.split(".").filter((p) => p !== "");\nlet len;\n${js}\nreturn len;`)
    const micros = (value: string): number => run(value, LSL)
    expect(micros('0')).toBe(0)
    expect(micros('12')).toBe(12_000_000)
    expect(micros('12.1')).toBe(12_100_000)
    expect(micros('0.5')).toBe(500_000)
    expect(micros('143.766672')).toBe(143_766_672)
    expect(micros('717.033333')).toBe(717_033_333)
    expect(micros('2146.999999')).toBe(2_146_999_999)
    // Past what an integer holds, and anything that isn't a plain length:
    // (integer)"-0" is 0, which alone would let "-0.5" read as half a second.
    expect(micros('2147')).toBe(0)
    expect(micros('-1')).toBe(0)
    expect(micros('-0.5')).toBe(0)
    expect(micros('1e3')).toBe(0)
    expect(micros('')).toBe(0)
    expect(card).toContain('if (gLen > 0) llMessageLinked(LINK_THIS, MSG_CONTROL, "length " + (string)gLen + " " + gDataset, NULL_KEY);')

    // The globe takes it only from the scripts, and only for the dataset
    // it names, so a length for one dataset never times another.
    const act = body(globe, 'act(key who, integer owner, string msg)')
    expect(act).toMatch(/if \(cmd == "length" && who == NULL_KEY\)\n\s+\{\n\s+gLen = \(integer\)arg;\n\s+gLenFor = llList2String\(w, 2\);\n\s+return;/)
    expect(body(globe, 'float position(list t)')).toContain('if (gLen > 0 && gLenFor == gDataset) return (float)loopUs(t, gLen) / 1000000.0;')
    expect(body(info, 'string date()')).toContain('float f = (float)loopUs(now(), gLen) / (float)gLen;')
  })

  it('tells the globe there is no length each time it starts on a dataset, so one shown again never keeps an old one', () => {
    // Found in review (#504): A's card gives a length, the globe shows
    // Earth, then A again, and A's card now gives none, its media
    // replaced by a single file, or the read failing. The globe keeps a
    // length by the dataset it names, so unless told otherwise it would
    // wrap A's moves on the old one while the page loops on another.
    const none = 'llMessageLinked(LINK_THIS, MSG_CONTROL, "length 0 " + gDataset, NULL_KEY);'
    const forget = body(info, 'forget()')
    const tellsNone = forget.includes(none)
    expect(tellsNone).toBe(true)
    // forget() runs whenever the dataset isn't the one last read (pinned
    // above), which Earth between two showings of A makes true twice.

    // The exchange as the scripts make it: forget() and card() send what
    // is pinned here and above, and the globe keeps it as its handler does.
    const state = { dataset: '', len: 0, lenFor: '' }
    const take = (msg: string) => {
      const w = msg.split(' ').filter(p => p !== '')
      state.len = Number.parseInt(w[1] ?? '', 10) || 0
      state.lenFor = w[2] ?? ''
    }
    const show = (id: string, cardLen: number) => {
      state.dataset = id
      if (tellsNone) take(`length 0 ${id}`)
      if (cardLen > 0) take(`length ${cardLen} ${id}`)
    }
    const exact = () => state.len > 0 && state.lenFor === state.dataset
    show('A', 12_100_000)
    expect(exact()).toBe(true)
    show('', 0)
    expect(exact()).toBe(false)
    show('A', 0)
    expect(exact()).toBe(false)
    show('A', 143_766_672)
    expect(state).toEqual({ dataset: 'A', len: 143_766_672, lenFor: 'A' })
  })

  it('moves the anchor without losing the time it takes to', () => {
    // One reading of the clock, so the clip doesn't skip the moment
    // between reading where it is and moving the anchor there.
    const reanchor = body(globe, 'reanchor()')
    expect(reanchor.match(/now\(\)/g)).toHaveLength(1)
    expect(reanchor).toContain('gPos = position(t);')
    const act = body(globe, 'act(key who, integer owner, string msg)')
    const move = act.slice(act.indexOf('if (cmd == "jump" || cmd == "restart" || cmd == "nudge")'), act.indexOf('if (cmd == "tilt")'))
    expect(move.match(/now\(\)/g)).toHaveLength(1)
    expect(move).not.toContain('anchor();')
    expect(move).toContain('to = position(t) + (float)arg;')
    expect(move).toMatch(/gAtS = llList2Integer\(t, 0\);\n\s+gAtMs = llList2Integer\(t, 1\);/)
  })

  it('wraps a jump or a nudge round the loop once the length is known, and never before the start without one', () => {
    // So a copy looping on a length of its own is brought back into step
    // by a move as by a pause, and back past the start goes to the end.
    const act = body(globe, 'act(key who, integer owner, string msg)')
    expect(act).toMatch(
      /if \(gLen > 0 && gLenFor == gDataset\) to -= len \* \(float\)llFloor\(to \/ len\);\n\s+else if \(to < 0\.0\) to = 0\.0;\n\s+gPos = to;/,
    )
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
