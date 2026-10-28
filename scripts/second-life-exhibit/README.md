# TerraViz in Second Life: the exhibit globe

[TerraViz](https://terraviz.zyra-project.org) is a free, open-source
globe for environmental data, most of it from NOAA's
[Science On a Sphere](https://sos.noaa.gov/) collection. In Second Life
a sphere can show a web page on its surface, and TerraViz's output page
draws the whole Earth unwrapped for exactly that. The page reads what to
show from its own address, so a script that writes the address controls
the globe for everyone at once.

The [probe kit's globe](../second-life-probe/README.md#the-globe) is the
smoke test: its owner drives it in chat. This folder is the exhibit, a
globe that stays up all the time:

- **Anyone who walks up can use it.** A touch opens a menu of datasets,
  read from the node's catalog by category, and controls, and everyone
  at the globe sees what they choose.
- **Two visitors don't fight over it.** Whoever acts holds the globe for
  a minute after their last choice, and anyone else is told who has it.
- **A presenter can take it over for a talk.** The presenters are named
  in a notecard. During a talk only they can change the globe.
- **It goes back to the live Earth** five minutes after the last visitor
  leaves, never during a talk.
- **It says what it shows.** The floating text gives the title, the date
  in the animation, and a short credit. "About" in the menu gives the
  abstract, the full credit and the licence. A kiosk screen beside the
  globe, if you add one, shows all of that in full, with the dataset's
  legend, and the floating text then leaves the date and the credit to
  the screen.
- **It plays a dataset's sound.** The movies have sound tracks, which
  each visitor hears at their own viewer's media volume, fainter with
  distance from the globe. The owner can turn it off.

Why it works this way, and what was decided when, is in
[`docs/SECOND_LIFE_COMPAT.md`](../../docs/SECOND_LIFE_COMPAT.md), §7
item 4 and §9 Phase 2.

| File | What it is |
|---|---|
| `terraviz-exhibit.lsl` | **The globe script.** Owns the address, the clock and the media: the smoke test's globe, taking requests from the others. The one with settings to edit (the names `/9 show` knows are the owner script's). |
| `terraviz-exhibit-visitors.lsl` | **The visitors script.** Touches and menus, the hold, talks, and who is at the globe. |
| `terraviz-exhibit-info.lsl` | **The info script.** The floating text, and "About". |
| `terraviz-exhibit-owner.lsl` | **The owner script.** Your commands on channel 9: it checks each one, has the globe script make the change, and tells you how it went. |
| `terraviz-exhibit-menu.lsl` | **The menu script.** The dataset menu from the node's catalog, which the visitors script opens. It goes in a small prim of its own, linked to the globe. |
| `terraviz-exhibit-kiosk.lsl` | **The kiosk script**, optional. Shows TerraViz's kiosk page on a flat screen linked to the globe: what the globe shows, its date, abstract, legend and credit, for visitors to read. |
| `exhibit.test.ts` | Holds the six scripts to each other and to the node: their link messages, the state they share, the commands a visitor may send, the card fields read, and what the node keeps for copies already rezzed. `../second-life-probe/globe.test.ts` holds the globe script's address to the output page. |

A script in Second Life has 64 KB in all, which is why there are five:
one script reading what the node says about a dataset while also holding menus,
notecards and the visitor list would run out. The menu script is the
fourth because the dataset menu, written into the visitors script first,
stopped it at once with a Stack-Heap Collision in-world. It is in a prim
of its own because a web reply reaches every script in the prim that
asked: in the sphere, the menu's pages stopped the info script the same
way. The owner script is the fifth because the globe script had the
least room of any, 57 KB at rest and up to 60 showing a dataset, with
the console's controls still to come
([`docs/SECOND_LIFE_COMPAT.md`](../../docs/SECOND_LIFE_COMPAT.md) §9
Phase 5): your commands, their help and their wording moved out of it.
The kiosk script is a sixth, and optional: it goes in the screen it
shows the page on.

## Before you start

- A region where you can rez objects and run scripts, and where
  visitors can reach the globe.
- Shared media on in your viewer, with auto-play allowed. In Firestorm:
  Preferences → Sound & Media. Visitors need the same.
- No L$. Nothing here uploads anything.
- **Which node the globe shows.** `NODE`, at the top of
  `terraviz-exhibit.lsl`, is `https://terraviz.zyra-project.org`. The
  probe kit's README says how to point it at a preview deploy instead.
  The other scripts take the node from the globe script: the visitors
  and info scripts as it changes, and the menu script from the visitors
  script each time a visitor opens the menu.
- **A node with the exhibit's reads.** The info script reads a dataset's
  card, a reply of at most 2 KB that the node writes for this exhibit
  (`/api/exhibit/v1/datasets/<id>`). A node that predates the cards
  answers with the app's page instead, as does any node while its
  Functions are down; Second Life refuses a page where JSON was asked
  for, with its own HTTP 415. The floating text then shows the title alone and
  "About" gives the dataset's page. The info script asks again a minute
  later, and after four tries tells you once. The dataset menu comes
  from the same node (`/api/exhibit/v1/tags` and
  `/api/exhibit/v1/datasets`); a node without it gives visitors the five
  built-in datasets, and you are told once.

## Setting it up

1. Rez a sphere. A default prim sphere is fine.
2. In its Content tab, make four **New Script**s and replace their
   text with the globe, visitors, info and owner scripts
   (`terraviz-exhibit.lsl`, `terraviz-exhibit-visitors.lsl`,
   `terraviz-exhibit-info.lsl`, `terraviz-exhibit-owner.lsl`), one
   each, saving each. Set `NODE` in
   the globe script first if you need to. The order doesn't matter:
   each asks the others for what it missed.
3. Within a few seconds the sphere stands its poles upright and shows
   the live Earth, and the floating text gives the live Earth's line
   and its credit. Chat shows the visitors script's
   summary of what the notecards gave: with none, no presenters and the
   dataset menu from the node's catalog.
4. Make the menu script's prim, a small cube hidden inside the sphere:
   1. Rez a cube (Build, then the cube in the Create tab, then click
      the ground).
   2. In the build floater's Object tab, set its size to 0.1 in all
      three, and its position to the sphere's (copy the three numbers
      from the sphere's Object tab).
   3. In the Texture tab, set Transparency to 100, so nothing shows if
      the sphere is ever smaller than the cube or see-through.
   4. In its Content tab, make a **New Script** and replace its text
      with `terraviz-exhibit-menu.lsl`, saving it. Its name doesn't
      matter: the script gives the cube the sphere's name the first
      time a visitor opens the menu, since a menu is headed with the
      name of the prim it comes from.
   5. Link the cube to the sphere: with the cube selected, Shift-click
      the sphere, so it is selected last, and choose Build → Link
      (Ctrl+L). The prim selected last becomes the root, so the sphere
      stays the root and moving it moves the cube with it. The sphere
      is outlined in yellow and the cube in blue.
   6. To reach the cube's Content tab later, edit the sphere, tick
      **Edit linked** in the build floater, and choose Build → Select
      Linked Parts → Select Next Part (Ctrl+.) until the cube is
      selected: inside the sphere it can't be clicked.
5. `/9 memory` should answer from all five scripts, the menu script
   among them. A visitor's Datasets now opens the node's categories.
6. Add any of the notecards below, and say `/9 presenters` to check what
   was read.
7. Optionally, make a kiosk screen beside the globe:
   1. Rez a cube, and in the Object tab set its size to 2 (X), 0.05 (Y)
      and 1 (Z): twice as wide as it is high, since the page is drawn
      2048 by 1024. Place it beside the globe, where visitors can read
      it. The page goes on face 1, the side facing −Y, so turn the
      screen until that side faces the visitors.
   2. Link it to the globe **with the screen as the root**: select the
      sphere, then Shift-click the screen so it is selected last, and
      choose Build → Link (Ctrl+L). The screen is outlined in yellow.
      The globe script turns the prim it is in, so a sphere left as the
      root would swing the screen round the globe with every tilt and
      spin (the warning under "Things that will trip you up"). If the
      globe is already part of a build with a stand or a floor as its
      root, link the screen into that instead, with the root selected
      last.
   3. Say `/9 upright` (`/9 home` for a mesh globe), so the sphere's
      rest is taken again in its new build.
   4. Edit the screen (now the root, so its Content tab is the one the
      build floater shows), make a **New Script** and replace its text
      with `terraviz-exhibit-kiosk.lsl`, saving it. For the screen's
      other side, set `FACE = 3` at the top of the script first.
   5. Within a few seconds the screen shows what the globe shows, and
      the floating text drops the date and the credit, which the screen
      shows in full. It keeps the title, for anyone whose viewer shows
      no media, the telemetry notice while telemetry is on, a talk, and
      "Right-click, Touch for more".
   6. If you see nothing, check that shared media is on in your viewer,
      and read what the script said in chat: it tells you, after ten
      seconds, if no globe answered, or at once if Second Life refused
      the face.

The media is deliberately not clickable, for anyone. A visitor who could
click it could move it to another page, and their viewer would move it
for everyone near the globe.

## What visitors do

A visitor **right-clicks the globe and chooses Touch**. A left-click on
a face showing a web page goes to the page rather than to a script,
which is why the floating text says "Right-click, Touch for more". The
menu that opens is theirs alone:

| Button | Who gets it | What it does |
|---|---|---|
| About | everyone | The abstract, credit and licence, in their own chat, or a notecard the owner wrote. |
| Datasets | whoever may act | The node's categories, then a category's datasets, nine to a page, numbered, with the titles in the menu's text. With a `datasets` notecard, its own list instead. |
| Pause / Play | whoever may act, a dataset showing | Every visitor stops on, or starts from, the same frame. The reply gives the date the globe shows, where the info script knows it: not for a dataset with no dates, nor for a video whose exact length the node can't read. |
| Back 10 s, Forward 10 s, Start over | the same | Move through the animation. |
| Live Earth | the same | Back to today's clouds and the real day and night. |
| Turn... | whoever may act | A menu for turning the globe, for everyone at it, which comes back after each press: |
| ↳ Turn west, Turn east | | Turn it 30° about its poles. East is the way the Earth turns: the places facing you move to your right. |
| ↳ South Pole to me, North Pole to me | | Tip the globe 30° so that pole comes round toward you, until it faces you: three presses from upright put it on the equator, as for the ozone hole over Antarctica. |
| ↳ Upright again | | Stand a tipped globe back up. |
| Jump to... | presenters | Type a time in the clip, such as `90` or `1:30`. |
| Start talk, End talk | presenters, whoever holds the globe | See below. |

**Who may act.** Outside a talk, anyone, one at a time. Whoever chooses
something holds the globe until `hold seconds` after their last choice,
or until they walk away from it. Anyone else who touches it is told who
has it and when it frees up, and gets only "About". A menu answers for
five minutes after it opens, and each answer is checked again against
the hold and any talk.

**Talks.** A presenter chooses Start talk, and everyone near the globe
is told a talk is starting. Until it ends, only presenters can change
the globe, and the floating text says a talk is on. It ends when a
presenter chooses End talk, or once no presenter has been at the globe
for `talk minutes`, so a presenter who logs off doesn't lock it. The
owner counts as a presenter, and can end a talk from chat.

**The live Earth comes back** once nobody has been within `radius` of
the globe for `idle minutes`, turned back to the owner's
`/9 rotation` and stood upright, so a visitor's turn or tilt doesn't
outlast their visit. Never
during a talk. Every change to the globe starts the clock again, as
does the end of a talk, so a choice made from beyond the radius isn't
undone at once.

**Turning and tilting are different motions.** A turn spins the picture
about the globe's poles, in the page's address; each visitor's page
sets it moving and lets it coast to a stop, so a turn is most of the
way there in about two seconds, and a second press while it still moves
pushes it on.
A tilt tips the sphere
itself, which the region shows every viewer at the same angle, so the
poles stop being straight up. A tilt ends any spin, and the owner's
`/9 spin` waits until the globe is upright; the idle return brings the
owner's spin back, also when a visitor has already stood the globe
upright again.

The tilt is a stopgap. The plan is to turn the picture instead, so the
sphere stays upright and a pole comes to the front with zoom alongside
(Phase 4). The page can already do that (`lat` and `zoom` in the
address); the tilt comes out when this controller's menu drives them.

**Turning with the mouse doesn't work yet.** A drag on the globe never
reaches a script, for the same reason a left-click doesn't, so the menu
turns it instead. A drag handle beside the globe is planned
(`docs/SECOND_LIFE_COMPAT.md` §9, Phase 2, "Left out for now").

**The floating text** holds 254 bytes, in this order, here for a
dataset a `datasets` notecard names "Wildfire Smoke Overhead
(2026-08-12)" (the title is the name the globe was given, from the menu,
a notecard, a preset or `/9 show <id> <name>`; for one `/9 show` names by
its id alone, the dataset's own title once its card arrives, and the id
until then or on a node without cards):

```
Wildfire Smoke Overhead (2026-08-12)
12 Aug 2026, 06:00 UTC
Counts anonymous use: https://terraviz.zyra-project.org/privacy    (only with telemetry on)
Credit: NOAA/NWS/NCEP Rapid Refresh Forecast System (RRFS), distributed via NOAA O...
Talk in progress                                                   (only during one)
Right-click, Touch for more
```

The title and the credit share what the other lines leave. The title
keeps at least 32 bytes and the credit 48 where both fit, and the
title's come first where they don't, as on a preview node, whose longer
address makes the telemetry notice longer. Either is cut with `...` when
it must be: above, with both optional lines showing, the credit loses
its end. Nothing else is ever cut, so the telemetry notice can't be
lost.

The date is worked out from the dataset's start and end times and the
point the animation has reached. It is exact when paused and updated
every couple of seconds while playing. It shows to the dataset's
period: the year for a yearly dataset, the month for a monthly one, the
time in UTC for one updated more often than daily, and the day
otherwise. A dataset with a frame a day, a month or a year (a period of
`P1D`, `P1M` or `P1Y`) is counted in frames: one per period from the
start to the end, evenly through the clip, the first at the start and
the last at the end, so the label changes with the frame. Any other
is the start plus the share of its span played, the arithmetic of the
app's own label. Until the node has said how long the clip is, and for
an image, it shows the dataset's range instead. The length is the one
the node reads from the stream's own playlists, its own HLS bundle's or
a Vimeo stream's, such as Sea temperature's: Vimeo's API gives whole
seconds, which isn't quite the stream's, and a date worked out from it
would drift from the picture with every loop. A visitor's copy of the
page that reads the stream's playlist, through hls.js, loops on that
same length; one playing the stream itself, or a single file, loops on
the video's own, which can differ by a few hundredths of a second. The
info script tells the globe script the length too, and both count the
clip in whole microseconds round the loop, so the date keeps to the
picture however long the globe is left playing, and a pause, a move or
a change of rate puts a copy on a length of its own back in step. A
video with no playlist to read, a single file, shows its range, and so
does a clip of 2147 s or more, too long for the scripts to count in
microseconds (the node's longest was 717 s in October 2026). When
the node couldn't read
the length in time, the card says when to ask again, and the info
script does. A card the node fails to send, an error or a
timeout, is asked for again too, up to four tries in all. If none of
them brings a card, the owner is told once for that node (with the
HTTP status, when there was one), and the hover text shows the title
alone.

The credit is the dataset's attribution, or else its rights holder, or
else its organization, with the licence after it. A dataset that names
none of them, as some imported ones don't, has no credit line; "About"
still gives its licence statement.

## Notecards

All optional. Put them in the globe's Content tab beside the scripts. A
change is read at once. In each, a line starting with `#` is a comment
and blank lines are skipped.

### `presenters`

One **username** a line, as in a profile's URL or under the name in a
profile. A legacy name works too and is read as its username. A display
name never works, since anyone can take any display name.

```
# Presenters at the Zyra globe
eric.hackathorn
Brent Resident
```

`Brent Resident` is read as `brent`, which is what Second Life calls
that avatar now.

### The menu without one: the node's catalog

Without a `datasets` notecard, Datasets reads the menu from the node, so
a dataset published there reaches the globe with nothing typed. It opens
the node's categories, with how many datasets each has, and "All
datasets", since some are in none. A category opens its datasets nine
to a page, in the order the app's browse lists them. On a page the
buttons are numbers and the titles are in the menu's text: most titles
are longer than a button's 24 bytes. The numbers count from the
category's first dataset, 10 to 18 on its second page, so a button
pressed on an older menu answers nothing rather than the wrong dataset.
A category's button is its name when every name on that page fits one.
Only datasets the globe can show are offered: images and videos, never
tours. The floating text and About name a chosen dataset by its full
title, though the menu cut it to fit.

The menu script shows it and reads it from the node, asking only for a
category and where a page starts. The categories are kept ten minutes,
and a categories menu answered after they changed is shown again. If
the node's catalog changes while a visitor pages through, the menu says
a dataset may have moved between pages. When the node can't give
the menu (Second Life is limiting the object's web requests, the node
answers with an error, or it is a node from before October 2026 with no
menu to give), the visitor gets the five built-in datasets below, and
you are told once why, until the node answers again. They get them too
if the menu script doesn't answer the visitors script within a few
seconds, because it isn't in the object or has stopped, and you are told
that once.

### `datasets`

A menu of your own in place of the node's catalog, for an exhibit with a
theme, one `Name = dataset id` a line, in the order it shows them. A
dataset's id is 26 capital letters and digits, its `id` in the node's
catalog (`https://terraviz.zyra-project.org/api/v1/catalog`, searched
for the title). A TerraViz link's `/dataset/` part is usually the
dataset's slug, such as `hurricane-season-2024`, which the node's API
doesn't take. A name is cut to a menu button's 24 bytes, so keep names
short and different in their first twenty characters or so.

```
# The Zyra globe's datasets
Hurricanes 2024 = 01KQG611HF8YXJNRBEHT0757KT
Sea temperature = 01KQG65ZW1JC7M27EQ1CYD8YZ7
Wildfire smoke, US = 01KYJDXB4909JWG8DP257D3D0Z
Earthquakes 2001-15 = 01KQG62M0Z3EC0T9EXFH1MVXDV
Nighttime lights = 01KQG629957NPZN7NTW4VK6FW0
```

Those five are also the built-in datasets, offered when the node can't
give its menu. A line that isn't
`Name = id`, with an id of letters, digits, `-` and `_`, is left out,
and so is a name that cuts to a menu button's own (`< Previous`,
`Next >`, `Main menu`). The owner is told which.

### `settings`

`name = value` lines, any of:

```
radius = 15
idle minutes = 5
hold seconds = 60
talk minutes = 2
categories = Water, Air
```

| Setting | What it is | Allowed |
|---|---|---|
| `radius` | metres from the globe's surface that count as at it | 2 to 96 |
| `idle minutes` | how long after the last visitor leaves before the live Earth comes back | 1 to 1440 |
| `hold seconds` | how long a visitor holds the globe after their last choice | 10 to 3600 |
| `talk minutes` | how long with no presenter at the globe before a talk ends | 1 to 120 |
| `categories` | which of the node's categories the menu offers, in that order, by name in any case, between commas, with `All datasets` among them if you want it (all of them, with "All datasets"). The visitors script reads it and hands it to the menu script, which can't read the sphere's notecards from its own prim | names the node has |

A value outside its range is ignored, with a word to the owner. A
category the node doesn't have is left out of the menu; with none of
them left, visitors get the built-in datasets and you are told.
`categories` has no effect with a `datasets` notecard.

### A notecard named by a dataset's id

If the globe holds a notecard named exactly by a dataset's id, such as
`01KQG611HF8YXJNRBEHT0757KT`, a visitor choosing "About" for that
dataset is given the notecard instead of chat. It is for the datasets an
exhibit features, where a curator wants to say more than the abstract
does. A script can't write a notecard, so every other dataset gets chat.
The notecard needs copy and transfer permission for its owner: without
copy the first visitor would take it, and without transfer it can't be
given at all. Such a notecard is skipped, the visitor gets chat, and
the owner is told why.

## The owner's commands

Said in local chat on channel 9, by the object's owner only. The owner
script hears them, checks each one, has the globe script make the
change and tells you how it went. They are the smoke test's commands,
on 9 rather than 8, so one command never reaches both kinds of globe:

`/9 show <name or id>`, `/9 list`, `/9 earth`, `/9 pause`, `/9 play`,
`/9 jump <s or m:ss>`, `/9 rate <speed>`, `/9 rotation <degrees>`,
`/9 spin <degrees a second>` or `/9 spin off`, `/9 debug on|off`,
`/9 width 1024|2048`, `/9 telemetry on|off`, `/9 steer hash|query`,
`/9 status`, `/9 upright`.

The probe kit's README describes each, under
[Commands](../second-life-probe/README.md#commands). Here `/9 rotation`
also sets where the globe goes back to once visitors leave, and
`/9 show` shows the dataset at once rather than asking the node first:
the info script reads its card next, and if the node has no such
dataset, or it is a tour or one the page can't show, it tells you, tells whoever chose it from the
menu that it can't be shown, and puts the globe back on the live Earth,
unless someone has chosen another since. (The globe script runs too close to its 64 KB to hold the
node's reply; see Things that will trip you up.) `/9 rate` takes up to
12.8, but on a short clip a high rate keeps visitors' copies apart:
each pass round the clip restarts the video, and a clip of a few
seconds at 12.8 restarts several times a second, so copies never
settle ([the grammar's clock](../../docs/EMBED_URL_GRAMMAR.md) says
why). The owner can always act, and doesn't take the hold. Besides
those:

| Command | What it does |
|---|---|
| `/9 turn <degrees>` | Turns the globe that far east, the way the Earth turns, or west for a negative number, as the menu's turn buttons do. Unlike `/9 rotation`, it doesn't move where the globe goes back to. |
| `/9 tilt south`, `/9 tilt north` | Tips that pole 30° toward you, as the menu's pole buttons do for a visitor. |
| `/9 level` | Stands a tipped globe back up, as it was at rest. |
| `/9 sound on\|off` | Whether a dataset's sound track plays, for every visitor, without reloading anyone's page while changes go after the # (the default; under `/9 steer query` it reloads them as every change does). On when the globe starts, unless `SOUND`, at the top of the globe script, is `FALSE`, which makes a silent exhibit last through resets. Each visitor hears their own copy, at their viewer's media volume, so it is as in step as the pictures are: a seek to catch up is a skip in the sound, catching up without one plays it up to a quarter faster or slower for a while, and a short loop repeats its sound every pass. A browser that won't play aloud without a click plays the picture muted; Second Life's viewers don't ask (Firestorm 7.2.4 played a movie aloud with nothing clicked, 27 October). |
| `/9 home` | Makes the sphere's rotation now its rest, for a globe you have turned by hand or a mesh globe with its own mapping. The rest is kept in the object, so a reset doesn't lose it. On a default sphere `/9 upright` does this too, and a reset stands it upright as always. |
| `/9 presenters` | What the notecards gave: how many presenters, where the menu comes from, and the settings. |
| `/9 talk` | Whether a talk is on, and when none is, how many avatars are at the globe. `/9 talk start` and `/9 talk end` start and end one. |
| `/9 memory` | How much of its 64 KB each script uses. The globe script also says the most it has used showing a dataset, the info script the most reading a card or answering About, and the menu script the most reading the node for a menu. |
| `/9 help` | The owner script's list. Anything it doesn't know gets the list too. |

## What leaves the object

Nothing about a visitor reaches the node. The visitors script reads the
region's avatar list every five seconds and keeps only how many are
near and when someone last was. It knows the holder by key, and by
display name to tell others who has the globe, only while the hold
lasts, and anyone with a menu open by key, for the five minutes the
menu answers. The info script keeps the key of the last
visitor who asked for "About", so a double press is answered once, and
the key of whoever chose the dataset showing, until the node has said
whether the globe can show it. The menu script reads the dataset menu
from the node asking only for a category and where a page starts, never
who asked, and keeps the page a visitor has open, for four visitors at
most, while their menu answers. It tells a visitor about a dataset in
their own chat, which no one else sees. A tilt reads the position of whoever asked, once, to aim at them.
Nothing is kept across a reset.

What each visitor's viewer loads is the output page, from the node, like
any web page. With `/9 telemetry on` that page reports, anonymously and
only in the first minute after it loads, which dataset it showed and
anything that failed. The probe kit's README has the details; the
floating text and the object's description say so while it is on.

## Smoke-testing the exhibit

You need a second avatar, or a friend, for most of this. Have them
stand at the globe.

1. **Setup.** `/9 presenters` lists what was read. `/9 memory` should
   answer from all five scripts; a kiosk script says nothing to it.
   `/9 debug on` should show the readout on the globe.
2. **Does a left-click reach the script?** The second avatar left-clicks
   the globe. If a menu opens, a left-click works in their viewer and
   the floating text's "Right-click" is more than they need. If not,
   that is what the plan expected, and a touchable stand beside the
   globe is the remedy, which isn't built. Say which viewer it was.
3. **A visitor's menu.** They right-click and Touch: About, Datasets and
   the controls. They choose Datasets: the node's categories should
   open, with a count beside each, and All datasets. They choose a
   category, page with Next > and < Previous, and go back with
   Categories. Then All datasets, and Earthquakes 2001-15 by its
   number. Everyone
   at the globe should see it start, and the floating text should show
   its title, a date moving from 1 Jan 2001 to 2 Dec 2015 across the
   three-minute clip, updated every couple of seconds, and a credit
   starting `Credit: NOAA Pacific Tsunami Warning Center`. Hurricanes
   2024 shows a date and no credit, since its record names none.
4. **The hold.** A third avatar touches the globe within a minute of the
   second one's choice. (The owner can't test this: the owner may always
   act.) They should get only About, and be told who has the globe and
   for how long. Once the second avatar walks out of range, the globe
   should free up within five seconds.
5. **Pause.** They pause. The reply should give the date the globe now
   shows, the floating text's date should stop and match the frame, and
   both views should show the same frame. On a dataset with no dates,
   such as Air Traffic, the reply just says it paused. A video on
   Vimeo, such as `/9 show sst`, has a moving date like any other.
6. **About.** They choose About. They should get the abstract, the
   credit, the licence and a link, in their own chat, in a few pieces.
   Nobody else should see it. Then add a notecard named
   `01KQG611HF8YXJNRBEHT0757KT` and choose About again: they should be
   offered the notecard.
7. **A talk.** Add yourself to `presenters` and choose Start talk. The
   other avatar's menu should lose its controls, and the floating text
   should say a talk is on. Leave the globe for longer than
   `talk minutes`, or use a short one in `settings`: the talk should end
   with a word in chat.
8. **Turning, tilting, and the idle return.** `/9 rotation 0`. The other
   avatar chooses Turn..., then Turn east: whichever side each of you
   faces, the places on it should move to your right. Then South Pole to
   me three times: Antarctica should come round to face them, on the
   globe's equator, and look the same from your side. Upright again
   should stand it back up. Set `idle minutes = 1`, show a dataset, turn
   and tilt it, and have everyone leave the globe. About a minute later
   it should go back to the live Earth, upright and facing as it did
   before. It shouldn't during a talk.
9. **Memory, and a date with a time.** `/9 show 01KQG64Y0999GTWAQQ1MZ99HAE`,
   Hurricane Maria 2017, which has a long abstract and a frame every 15
   minutes. The floating text and About should lead with "Hurricane
   Maria - 2017", the card's title, not the id. The floating text
   should show a date and a UTC time, from 17 Sep 2017, 00:00 UTC to
   25 Sep 2017, 23:45 UTC across the clip. Choose About, then open
   Datasets and page through a category or two, then `/9 memory`. Every
   script should report well under 64 KB. The peaks are the numbers that
   matter, the globe script's while showing a dataset, the info
   script's while reading a card or answering About, and the menu
   script's while reading the node for a menu: say what they were.

10. **Without the menu script.** Open the cube's menu script and untick
    Running. A visitor's Datasets should give the five built-in
    datasets within about eleven seconds, and you should be told once
    that the menu script didn't answer. Tick Running again, and
    Datasets should open the node's categories, with no second menu.
11. **Sound.** Show a movie, `/9 show 01KQG621GKSF0R9Q74AAE5QFV0`
    (HOLOSCENES / Little Boxes). Both avatars should hear it with
    nothing clicked, louder near the globe and quieter walking away, and
    the second avatar's own media volume should change only what they
    hear. Then `/9 sound off`: it should go quiet with the picture
    playing on, and `/9 sound on` bring it back. Say which viewer, if
    one plays it silent. Then `/9 memory`: the globe script's most while
    showing a dataset is the number to report, since sound added to it.
12. **The kiosk**, if you made one. Show Earthquakes 2001-15: within a
    couple of seconds the screen should show its title, abstract,
    legend and credit, and a date moving with the globe's, the same date
    for both avatars. Pause, and the screen's date should stop on the
    globe's frame; play at another rate (`/9 rate 2`), and it should
    say so. Show the smoke forecast, `/9 show smoke`, and the legend
    should be a colour bar with its units, where Earthquakes had an
    image. Choose Live Earth, and the screen should say what
    the live Earth is. The floating text should keep only the lines
    step 7 of the setup names throughout. Turn the globe, tip a pole
    toward you and stand it Upright again, `/9 spin 10` and
    `/9 spin 0`: the screen should stay where it is throughout. Take
    the object into your inventory and rez it again: the screen should
    face the way it did. Then `/9 memory`: the info script's most is
    the number to report, since the kiosk added to it. Unlink the
    screen: the full floating text should come back at once, and after
    ten seconds the kiosk script should tell you that no globe answered.
    Say which viewer showed the screen, and whether text on it is
    readable from where a visitor stands.

When you report results, say which viewer and version (Help → About)
each avatar used, and what steps 2, 9, 11 and 12 showed.

## Things that will trip you up

- **Updating a globe set up with four scripts: add the owner script
  first, then replace the globe script.** Before 28 October 2026 the
  globe script heard your commands itself; the new one doesn't. In
  between, the owner script beside the old globe script does each
  command once, since the old one ignores what the owner script hands
  it, though the help, `/9 list` and a command either refuses answer
  twice. The other order leaves a while when only `/9 talk`,
  `/9 presenters` and `/9 memory` answer, though visitors notice
  nothing either way.
- **Put the globe's four scripts in the sphere, and in a build make
  the sphere a child prim.** A tilt turns the prim the scripts are in, so as the root
  of a build, with a stand or a kiosk screen linked to it, the whole
  build would tip, and a spin would swing the screen round the globe. The
  menu script's cube can be linked anywhere in the build, the root
  included; the scripts find each other across the whole object. One
  exhibit to an object, though: two globes linked into one build would
  each open the other's menu.
- **A kiosk needs the globe script from 28 October 2026 on.** Before it,
  the globe told only the scripts in the sphere what it shows, so a
  kiosk beside an older globe script hears nothing, and says so in chat
  after ten seconds. Update the globe script, and reset the kiosk script.
- **Unlink a kiosk to retire it, rather than deleting its script.** The
  info script asks whether a kiosk is there when it starts and when a
  prim is linked or unlinked, so a kiosk script deleted, stopped or
  stuck in a screen still linked leaves the floating text short of its
  date and credit until the info script is reset or a prim is next
  linked or unlinked.
- **Keep the menu script out of the sphere.** In the sphere with the
  other four, its pages of the node's catalog would reach the info
  script too, which has little room to spare while it reads a card. So
  a copy there answers nothing, as one left from the build that had it
  there would be: Datasets gives the five built-in datasets after a few
  seconds' wait, and you are told once that the menu script didn't
  answer. Two "Menu script" lines from `/9 memory` mean a copy is still
  in the sphere: delete it there and keep the cube's. The same happens
  while the cube's copy is missing or stopped, and the menu script and
  the visitors script are best updated together.

- **A script stops for good at 64 KB.** It reports a Stack-Heap
  Collision and does nothing more until it is reset, and a script with
  no room left can stop the moment it starts. In-world in October 2026
  the globe script rested at 62 KB and the other two at about 50, and
  every web reply goes to every script in the sphere with a handler for
  one. A copy a script makes counts too, until Second Life collects it.
  So in the sphere only the info script asks the node anything, the globe script
  shows a choice without checking it first, and the info script reads
  the node's card for a dataset, at most 2 KB with its text already
  plain, rather than the dataset's record. Before the card, `/9 memory`
  read in-world: the globe script 54 KB, and at most 57 while showing a
  dataset; the info script 55, and at most 58 while reading the first
  3 KB of a record or answering About; the visitors script 49. With the
  card and the clip clock both scripts gained on 27 October, it read
  that day: the globe script 57 KB, and at most 59 while showing a
  dataset; the info script 48, and at most 52 while reading a card or
  answering About; the visitors script 49. The globe script, with 5 KB
  left at its busiest, has the least room, so code that could go in
  another script should, and code added to any of them needs measuring
  again (step 9 of the smoke test). The dataset menu, added the same
  day, went into the visitors script first and stopped it at once with
  a Stack-Heap Collision, so it became a fourth script, the menu
  script, which reads the node itself, from a prim of its own so that
  no reply of its reaches a script in the sphere. What crosses between
  the prims is a link message of a line or two: the node and the
  categories one way, a choice the other. The info script then stopped
  three times reading the card of a dataset chosen from the menu. Most
  likely the cause was an older copy of it still in the globe, from the
  first menu build, about 90 lines longer: it rested at 56 KB, and
  replaced, at 49, and it hasn't stopped since. Likely rather than
  proven: that afternoon the current copy climbed about 12 KB above its
  rest on a 2 KB card, which from 56 would have reached 68, but that
  morning it climbed 4 KB on Hurricane Maria's 1.9 KB card, which would
  have reached only 60, a difference the cards' sizes don't explain
  (garbage Second Life hasn't yet collected counts in a peak). That day
  `/9 memory` read, with the menu in its own prim: the globe script 57
  KB, and at most 60 while showing a dataset; the info script 51, and
  **at most 63** while reading the card of Clouds (colorized) -
  Real-time, filled to 2 KB, or answering About (one peak covers both);
  the visitors script 49; the menu script 44, and at most 48 while
  reading the node for a menu. A card is held whole while it is read,
  and that card's abstract was 1,496 characters, of which the info
  script keeps 500, so the node now sends no more than those 500
  characters, and that card is about 1 KB. Most cards are now about
  that size, since most abstracts are longer than 500 characters. With
  them `/9 memory` read, after a reset, cards read and About answered:
  the globe script 57 KB, and at most 60 while showing a dataset; the
  info script 51, and **at most 57** while reading a card or answering
  About, 7 KB to spare where it had 1; the visitors script 52; the menu
  script 44, and at most 51 while reading the node for a menu. With
  sound added, in Firestorm, it read: the globe script 57 KB, and at
  most 60 while showing a movie, unchanged; the info script 51, and at
  most 59; the menu script 44, and at most 53; the visitors script 52.
  The globe script, with 4 KB to spare at its busiest, has the least
  room of those that report a peak, the info script next with 5; the
  visitors script reports none. So a script copied from an older build is the
  first thing to rule out after a collision: open it and check the
  first lines say what this README's file does.
- **The info script checks a choice after it is shown.** For a second or
  two, a dataset the node doesn't have, or one the page can't show, is in every visitor's
  page address, and the page shows the live Earth while it fails. With
  telemetry on, each page still in its first minute reports that
  failure, and with `/9 steer query` each reloads twice. The info script
  is also what answers a pause, a play or a move with the date. If it
  stops, the globe still shows and plays what visitors choose, but those
  replies don't come, and a dataset the page can't show stays chosen.
- **A visitor's change takes a second.** Second Life pauses the globe
  script for a second whenever it sets media.
- **A long dataset name in `datasets` is cut** to a button's 24 bytes.
  Two names that cut alike answer as the first.
- **The date is UTC**, and follows the clip as the region's clock says:
  a second or so from the picture while playing, exact when paused. It
  doesn't drift further on a clip left looping, since the scripts count
  it in whole numbers round the one length the node reads, which is the
  length a viewer's page loops on when it plays the stream through
  hls.js. That rests on the node's length matching the page's to the
  microsecond, which holds for a playlist that writes its segments'
  lengths to six places, as TerraViz's own bundles and Vimeo's streams
  do. A video with no length to read, or one of 2147 s or more, shows
  its range, and its clock, kept in a float, is about 10 ms out after a
  day of play and a third of a second after a month, which a pause, a
  move or a change of rate shows.
- **Long text is cut.** The node cuts what doesn't fit a card at a
  word, ending `...`: a credit past 200 bytes, a licence statement past
  400 with its address, and the abstract past the 500 characters the
  info script keeps, or what the rest of the card leaves if that is
  less, which cuts most of them (135 of the 143 on the node in October
  2026). A node from before 27 October sends the abstract to what the
  rest of the card leaves, and the info script cuts it to 500 itself.
  "About" then says the rest is at the dataset's page.
  A date or a period is never cut: one the node couldn't read whole is
  left out, and the floating text shows no date, or a yearly dataset's
  date to the day.
- **Display names don't make presenters.** If someone in `presenters`
  isn't recognised, check their username in their profile.

## Changing the scripts

The scripts are written by hand: edit them directly. `npx vitest run
scripts/second-life-exhibit scripts/second-life-probe` runs the tests
that keep them in step with each other, with the output page and with
the node, and [lslint](https://github.com/Makopo/lslint) checks each
script's syntax, since LSL compiles only in-world.
