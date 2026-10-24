// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// TerraViz in-world probe - the shared-media half of the kit.
//
// ABOUT TERRAVIZ
// TerraViz is a free, open-source globe for environmental data, most of
// it from NOAA's Science On a Sphere collection. It runs in a web browser
// and as a desktop app, and any museum, lab or school can run its own
// copy of the service, called a node.
//   The app:     https://terraviz.zyra-project.org
//   The source:  https://github.com/zyra-project/terraviz
//
// WHAT THIS IS FOR
// Testing, from inside Second Life, what TerraViz can do here: whether a
// viewer's built-in browser runs WebGL and plays TerraViz's video, how a
// sphere wraps a picture, and whether a change to the part of an address
// after # reaches the page without a reload. It is a test kit, not an
// exhibit: its test page renders only for the object's owner. For a
// globe that visitors see, use terraviz-globe.lsl, in a sphere of its own.
//   What the tests found, and the plan they led to (sections 3-5, 7):
//     https://github.com/zyra-project/terraviz/blob/main/docs/SECOND_LIFE_COMPAT.md
//   How to run it, and how to read what it says:
//     https://github.com/zyra-project/terraviz/blob/main/scripts/second-life-probe/README.md
//
// terraviz-probe.lsl is generated from probe.template.lsl and probe.html
// by `npx tsx scripts/second-life-probe`. Edit those two, never the
// generated file: a test fails when it drifts from them.
//
// Drop this into a sphere you own, in a region where scripts run. It
// serves its own test page onto the sphere through shared media. The
// page checks WebGL, video codecs and HLS playback, and reports back to
// you in local chat. Its companion, node-check.lsl, asks the TerraViz
// node for data and reports what that costs a script; put both in the
// same prim, or either one alone.
//
// Commands, said on channel 7 (owner only):
//   /7 probe    the test page and a labelled grid (the default)
//   /7 image    a real TerraViz dataset frame (Nighttime Lights)
//   /7 video    a real TerraViz video (Hurricane Season 2024), if it can play
//   /7 app      the actual TerraViz web app
//   /7 sos      TerraViz's LED-sphere output page: a live, correctly wrapped Earth
//               (terraviz-globe.lsl puts datasets on the same page)
//   /7 soak     keep WebGL drawing and report every 10 s until it stops
//   /7 soak2d   the same animation without WebGL - the comparison for soak
//   /7 globe    stand the sphere's poles upright and rotate its texture 90
//               degrees. A default prim sphere has its poles on its local
//               X axis and its texture wrapped pole-to-pole, so a world map
//               lands sideways (indra/llmath/llvolume.cpp: the half-circle
//               profile ends on X, the path revolves about X, and texture
//               U follows the profile). Confirmed in-world, October 2026.
//   /7 turn     rotate the texture another 90 degrees
//   /7 mirror   flip the texture left-to-right
//   /7 reset    back to the default rotation and texture mapping
//   /7 face N   move the media to face N (a sphere only has face 0)
//   /7 hash     change only the part of the address after # - does every
//               viewer take it without reloading? (the doc's section 7,
//               items 4 and 7)
//
// The page renders as a web page only for the object's owner, in their
// own viewer, in the same region (llSetContentType) - a test kit, not an
// exhibit. The app and the output page come from TerraViz's own site and
// have no such limit.
//
// How it knows a page went quiet. Every viewer near the prim fetches
// the page, not only the owner's, and only the owner's copy runs, so a
// fetch says nothing about whether a test is running. The watch is
// therefore armed by a command, which only the owner can give, and
// confirmed or cleared by the page's own reports, which only a page
// that ran can send. Each command's address carries a run number, the
// page reports to that same address, and a report from an earlier
// run is ignored, so a page still reporting after a switch cannot pass
// for the current one.

integer CHAN = 7;
string  NODE = "https://terraviz.zyra-project.org";

// Shared media is capped at 2048 pixels a side (indra/llprimitive/
// llmediaentry.h); a script asking for more gets a bounds error, not a
// smaller size. 2:1, because everything shown here is a world map.
integer MEDIA_W = 2048;
integer MEDIA_H = 1024;

// What the current command is waiting to hear from its page.
integer WATCH_NONE      = 0;
integer WATCH_FRAMES    = 1;   // the probe's 10-second WebGL report
integer WATCH_HEARTBEAT = 2;   // a soak's 10-second heartbeats
float   FRAMES_WAIT     = 45.0;
float   HEARTBEAT_WAIT  = 25.0; // two missed heartbeats and change

integer gFace = 0;
string  gBase;          // this script's own web address
key     gUrlReq;
integer gRun;           // the current command's run number, sent as n=
string  gMode;          // the current command's page: probe, soak, ...
integer gServedRun;     // the last run whose page fetch was announced
integer gStarts;        // how many times the current run's page has started
integer gWatch;         // WATCH_*
float   gDeadline;      // the llGetTime() at which the current watch runs out
string  gSoakLast;      // the most recent heartbeat
integer gTexRot;        // texture rotation in degrees: 0, 90, 180 or 270
integer gMirror;        // texture flipped left-to-right

float   HASH_WAIT = 30.0;   // how long an answer to /7 hash is waited for
string  gUrl;           // the address show() gave the face, without any # part
integer gHashes;        // how many # changes this script has made
float   gHashAt;        // the llGetTime() of the latest, or 0 if none is waited on
float   gHashSaidAt;    // when the page reported taking it, or 0

string HELP = "Commands on /7: probe, image, video, app, sos, soak, soak2d, globe, turn, mirror, reset, face N, hash";

string page()
{
    string s = "";
    s += "<!doctype html>\n";
    s += "<!-- SPDX-License-Identifier: Apache-2.0 -->\n";
    s += "<!-- Copyright 2026 The Zyra Project -->\n";
    s += "<!-- Embedded in terraviz-probe.lsl verbatim: no double quotes or backslashes (see build.ts). -->\n";
    s += "<html><head><meta charset=utf-8><title>TerraViz probe</title>\n";
    s += "<style>\n";
    s += "html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000;color:#fff;font:1.6vw monospace}\n";
    s += ".full{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill}\n";
    s += "#t{position:absolute;left:30%;top:22%;width:40%;background:rgba(0,0,0,.75);padding:.5em;white-space:pre-wrap}\n";
    s += "#w{position:absolute;left:47%;bottom:4%;width:6%;height:12%}\n";
    s += "#m{position:absolute;left:4%;bottom:4%;width:20%}\n";
    s += "</style></head><body>\n";
    s += "<canvas id=g class=full width=2048 height=1024></canvas>\n";
    s += "<div id=t>TerraViz probe: starting</div>\n";
    s += "<script>\n";
    s += "var NL=String.fromCharCode(10),Q=String.fromCharCode(34),R=[],sent=0;\n";
    s += "var T=document.getElementById('t'),MODE=location.search.slice(1).split('&')[0],HERE=location.href;\n";
    s += "var TV_IMG='https://d3sik7mbbzunjo.cloudfront.net/land/earth_night/2012/nightlights_2048.jpg';\n";
    s += "var TV_HLS='https://video.zyra-project.org/videos/01KQG611HF8YXJNRBEHT0757KT/master.m3u8';\n";
    s += "var OPEN_HLS='https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';\n";
    s += "var HLSJS='https://cdn.jsdelivr.net/npm/hls.js@1.6.15/dist/hls.min.js';\n";
    s += "function a(k,v){R.push(k+': '+v);T.textContent=R.slice(-14).join(NL)}\n";
    s += "function md(m){a('mode',m+(location.hash?' '+location.hash:''))}\n";
    s += "function send(){var s=R.slice(sent);sent=R.length;if(s.length)fetch(HERE,{method:'POST',body:s.join('~')}).catch(function(){})}\n";
    s += "window.onerror=function(m){a('page error',m);send()};\n";
    s += "function el(tag,id,cls){var e=document.createElement(tag);if(id)e.id=id;if(cls)e.className=cls;document.body.appendChild(e);return e}\n";
    s += "function grat(c){\n";
    s += "var W=c.canvas.width,H=c.canvas.height,k=W/1024,i,C=['#be3232','#325abe','#32a03c','#d29614'];\n";
    s += "function font(px){c.font='bold '+Math.round(px*k)+'px sans-serif'}\n";
    s += "c.fillStyle=C[0];c.fillRect(0,0,W/2,H/2);c.fillStyle=C[1];c.fillRect(W/2,0,W/2,H/2);\n";
    s += "c.fillStyle=C[2];c.fillRect(0,H/2,W/2,H/2);c.fillStyle=C[3];c.fillRect(W/2,H/2,W/2,H/2);\n";
    s += "c.strokeStyle='#fff';c.lineWidth=2*k;\n";
    s += "for(i=0;i<=12;i++){c.beginPath();c.moveTo(i*W/12,0);c.lineTo(i*W/12,H);c.stroke()}\n";
    s += "for(i=0;i<=6;i++){c.beginPath();c.moveTo(0,i*H/6);c.lineTo(W,i*H/6);c.stroke()}\n";
    s += "c.lineWidth=6*k;c.strokeStyle='#ff0';c.beginPath();c.moveTo(0,H/2);c.lineTo(W,H/2);c.stroke();\n";
    s += "c.strokeStyle='#0ff';c.beginPath();c.moveTo(W/2,0);c.lineTo(W/2,H);c.stroke();\n";
    s += "c.fillStyle='#fff';font(26);\n";
    s += "[['180W',0],['90W',W/4],['0',W/2],['90E',3*W/4]].forEach(function(p){c.fillText(p[0],p[1]+6*k,H/2-10*k)});\n";
    s += "font(20);\n";
    s += "[['60N',H/6],['30N',H/3],['30S',2*H/3],['60S',5*H/6]].forEach(function(p){c.fillText(p[0],W/2+6*k,p[1]-6*k)});\n";
    s += "c.fillText('NORTH POLE',W/2+6*k,24*k);c.fillText('SOUTH POLE',W/2+6*k,H-8*k);\n";
    s += "font(26);\n";
    s += "[['NW',W/8,H/8],['NE',5*W/8,H/8],['SW',W/8,5*H/8],['SE',5*W/8,5*H/8]].forEach(function(p){c.fillText(p[0],p[1],p[2]+20*k)});\n";
    s += "}\n";
    s += "function gl(t){try{return document.createElement('canvas').getContext(t)}catch(e){return null}}\n";
    s += "function ty(v,s){return (window.MediaSource&&MediaSource.isTypeSupported(s)?'MSE yes':'MSE no')+', video tag '+(v.canPlayType(s)||'no')}\n";
    s += "function mp4(s){return 'video/mp4; codecs='+Q+s+Q}\n";
    s += "function mkVideo(id,cls){var v=el('video',id,cls);v.muted=true;v.loop=true;v.autoplay=true;v.playsInline=true;return v}\n";
    s += "function loadHls(cb){if(window.Hls)return cb();var s=document.createElement('script');s.src=HLSJS;s.onload=cb;s.onerror=function(){a('hls.js','could not load from jsdelivr');send()};document.head.appendChild(s)}\n";
    s += "function play(v,url,label,next){\n";
    s += "var done=false,h=null;\n";
    s += "function fin(msg){if(done)return;done=true;var ok=msg.indexOf('PLAYING')==0;if(h&&!ok){h.destroy();h=null}a(label,msg);send();if(next&&!ok)next()}\n";
    s += "v.onerror=function(){fin('failed, media error '+(v.error?v.error.code:'?'))};\n";
    s += "if(url.indexOf('NATIVE:')==0){v.src=url.slice(7)}\n";
    s += "else{v.removeAttribute('src');if(!window.Hls||!Hls.isSupported())return fin('hls.js not supported');\n";
    s += "h=new Hls();h.on(Hls.Events.ERROR,function(e,d){if(d.fatal)fin('failed, '+d.type+' / '+d.details)});\n";
    s += "h.loadSource(url);h.attachMedia(v)}\n";
    s += "var p=v.play();if(p)p.catch(function(){});\n";
    s += "setTimeout(function(){fin(v.currentTime>0.5?'PLAYING '+v.videoWidth+'x'+v.videoHeight+' at t='+v.currentTime.toFixed(1)+'s':'stalled at t='+v.currentTime.toFixed(1)+'s')},15000);\n";
    s += "}\n";
    s += "function probe(){\n";
    s += "grat(document.getElementById('g').getContext('2d'));\n";
    s += "md('probe');\n";
    s += "a('chrome',(navigator.userAgent.split('Chrome/')[1]||'?').split(' ')[0]);\n";
    s += "a('viewport',innerWidth+'x'+innerHeight+' at '+devicePixelRatio+'x');\n";
    s += "var v=document.createElement('video');\n";
    s += "a('MediaSource',!!window.MediaSource);\n";
    s += "a('H.264 720p (TerraViz)',ty(v,mp4('avc1.4d4020')));\n";
    s += "a('H.264 4K (TerraViz)',ty(v,mp4('avc1.4d4033')));\n";
    s += "a('AAC',ty(v,'audio/mp4; codecs='+Q+'mp4a.40.2'+Q));\n";
    s += "a('VP9',ty(v,'video/webm; codecs='+Q+'vp9'+Q));\n";
    s += "a('AV1',ty(v,mp4('av01.0.05M.08')));\n";
    s += "a('native HLS',v.canPlayType('application/vnd.apple.mpegurl')||'no');\n";
    s += "send();\n";
    s += "var g1=gl('webgl'),g2=gl('webgl2'),x=g2||g1;\n";
    s += "a('WebGL 1',!!g1);a('WebGL 2',!!g2);\n";
    s += "if(x){var d=x.getExtension('WEBGL_debug_renderer_info');a('GPU',d?x.getParameter(d.UNMASKED_RENDERER_WEBGL):x.getParameter(x.RENDERER))}\n";
    s += "send();\n";
    s += "frames();\n";
    s += "}\n";
    s += "function frames(){\n";
    s += "var w=el('canvas','w'),c=null,n=0,lost=0,ok='not reached',stop=false;\n";
    s += "w.width=64;w.height=64;\n";
    s += "try{c=w.getContext('webgl2')||w.getContext('webgl')}catch(e){}\n";
    s += "if(!c){a('webgl frames','no context');send();return hlsTest()}\n";
    s += "w.addEventListener('webglcontextlost',function(){lost++});\n";
    s += "(function f(){if(!c.isContextLost()){var k=(n%60)/60;c.clearColor(k,1-k,0.5,1);c.clear(c.COLOR_BUFFER_BIT);\n";
    s += "if(n==30){var p=new Uint8Array(4);c.readPixels(0,0,1,1,c.RGBA,c.UNSIGNED_BYTE,p);ok=p[3]==255?'ok':'failed'}\n";
    s += "n++}if(!stop)requestAnimationFrame(f)})();\n";
    s += "setTimeout(function(){stop=true;a('webgl frames',n+' in 10s, context lost '+lost+'x, readback '+ok);send();hlsTest()},10000);\n";
    s += "}\n";
    s += "function soak(kind){\n";
    s += "grat(document.getElementById('g').getContext('2d'));\n";
    s += "md('soak '+kind);send();\n";
    s += "var w=el('canvas','w'),c=null,n=0,lost=0,t0=performance.now();\n";
    s += "w.width=64;w.height=64;\n";
    s += "if(kind=='webgl'){try{c=w.getContext('webgl2')}catch(e){}\n";
    s += "if(!c){a('soak webgl','no WebGL 2 context');send();return}\n";
    s += "w.addEventListener('webglcontextlost',function(){lost++})}\n";
    s += "else c=w.getContext('2d');\n";
    s += "(function f(){var k=(n%60)/60;\n";
    s += "if(kind=='webgl'){if(!c.isContextLost()){c.clearColor(k,1-k,0.5,1);c.clear(c.COLOR_BUFFER_BIT);n++}}\n";
    s += "else{c.fillStyle='rgb('+Math.round(255*k)+','+Math.round(255*(1-k))+',128)';c.fillRect(0,0,64,64);n++}\n";
    s += "requestAnimationFrame(f)})();\n";
    s += "setInterval(function(){a('soak '+kind,Math.round((performance.now()-t0)/1000)+'s, '+n+' frames, context lost '+lost+'x, viewport '+innerWidth+'x'+innerHeight);send()},10000);\n";
    s += "}\n";
    s += "function hlsTest(){loadHls(function(){play(mkVideo('m'),OPEN_HLS,'hls.js test stream')})}\n";
    s += "function image(){\n";
    s += "md('image');\n";
    s += "var i=el('img',null,'full');\n";
    s += "i.onload=function(){a('TerraViz image','loaded '+i.naturalWidth+'x'+i.naturalHeight);send();T.style.display='none'};\n";
    s += "i.onerror=function(){a('TerraViz image','failed to load');send()};\n";
    s += "i.src=TV_IMG;\n";
    s += "}\n";
    s += "function video(){\n";
    s += "md('video');\n";
    s += "var v=mkVideo(null,'full');\n";
    s += "function viaOpen(){play(v,OPEN_HLS,'test stream via hls.js (not TerraViz data)')}\n";
    s += "function viaHlsjs(){loadHls(function(){play(v,TV_HLS,'TerraViz stream via hls.js',viaOpen)})}\n";
    s += "if(v.canPlayType('application/vnd.apple.mpegurl'))play(v,'NATIVE:'+TV_HLS,'TerraViz stream, native HLS',viaHlsjs);\n";
    s += "else{a('native HLS','no');send();viaHlsjs()}\n";
    s += "setTimeout(function(){T.style.display='none'},40000);\n";
    s += "}\n";
    s += "window.onhashchange=function(){var v=document.querySelector('video');\n";
    s += "a('hash',location.hash+(v?', video t='+v.currentTime.toFixed(1)+'s, '+(v.paused?'paused':'playing')+', readyState '+v.readyState:', no video'));send()};\n";
    s += "if(MODE=='image')image();else if(MODE=='video')video();\n";
    s += "else if(MODE=='soak')soak('webgl');else if(MODE=='soak2d')soak('2d');else probe();\n";
    s += "</script></body></html>\n";
    return s;
}

// The run number in a query string, or -1.
integer runOf(string query)
{
    list q = llParseString2List(query, ["&"], []);
    integer i;
    integer len = llGetListLength(q);
    for (i = 0; i < len; ++i)
    {
        string t = llList2String(q, i);
        if (llGetSubString(t, 0, 1) == "n=") return (integer)llGetSubString(t, 2, -1);
    }
    return -1;
}

// Starts, or restarts, the current watch's countdown. The deadline is
// kept beside the timer because restarting the timer may not withdraw a
// timer event already queued, and that event must not count as this one.
// The SL wiki doesn't say either way; a 2006 forum report describes a
// cleared timer still firing. The deadline is right in either case.
countdown(float wait)
{
    gDeadline = llGetTime() + wait;
    llSetTimerEvent(wait);
}

arm(integer watch)
{
    gWatch = watch;
    gSoakLast = "";
    if (watch == WATCH_FRAMES) countdown(FRAMES_WAIT);
    else if (watch == WATCH_HEARTBEAT) countdown(HEARTBEAT_WAIT);
    else llSetTimerEvent(0.0);
}

// Milliseconds since the latest # change, or -1 once nothing is waited
// on. Past HASH_WAIT a report no longer answers that change: the face's
// address still carries the #, so every later reload carries it too.
integer hashAge()
{
    if (gHashAt <= 0.0) return -1;
    float age = llGetTime() - gHashAt;
    if (age > HASH_WAIT) { gHashAt = 0.0; return -1; }
    return llRound(age * 1000.0);
}

integer watchFor(string mode)
{
    if (mode == "probe") return WATCH_FRAMES;
    if (mode == "soak" || mode == "soak2d") return WATCH_HEARTBEAT;
    return WATCH_NONE;
}

// Every command that changes the page comes through here. A new run
// gets a new address, because the viewer does not reload media whose
// address is unchanged; the pages read only their own parameters.
// Returns FALSE if the media was refused.
integer show(string mode, string url)
{
    // Nothing changes until the media has, so a refused change leaves
    // the page that is still showing watched exactly as it was.
    integer run = gRun + 1;
    if (llSubStringIndex(url, "?") == -1) url += "?n=" + (string)run;
    else url += "&n=" + (string)run;
    integer r = llSetPrimMediaParams(gFace, [
        PRIM_MEDIA_CURRENT_URL, url,
        PRIM_MEDIA_HOME_URL, url,
        PRIM_MEDIA_AUTO_PLAY, TRUE,
        PRIM_MEDIA_AUTO_SCALE, FALSE,
        PRIM_MEDIA_WIDTH_PIXELS, MEDIA_W,
        PRIM_MEDIA_HEIGHT_PIXELS, MEDIA_H,
        PRIM_MEDIA_PERMS_INTERACT, PRIM_MEDIA_PERM_OWNER,
        PRIM_MEDIA_PERMS_CONTROL, PRIM_MEDIA_PERM_NONE]);
    if (r != STATUS_OK)
    {
        llOwnerSay("[probe] Could not set media on face " + (string)gFace + " (status " + (string)r
            + "). Whatever was showing still is.");
        return FALSE;
    }
    if (watchFor(gMode) == WATCH_HEARTBEAT && gSoakLast != "")
        llOwnerSay("[probe] Soak ended by a new command. Last heartbeat: " + gSoakLast);
    gRun = run;
    gMode = mode;
    gUrl = url;
    gHashAt = 0.0;
    gHashSaidAt = 0.0;
    gStarts = 0;
    arm(watchFor(mode));
    llOwnerSay("[probe] Face " + (string)gFace + " now shows " + url);
    return TRUE;
}

applyTexture()
{
    llRotateTexture(gTexRot * DEG_TO_RAD, gFace);
    llScaleTexture(llList2Float([1.0, -1.0], gMirror), 1.0, gFace);
    llOwnerSay("[probe] Texture rotation " + (string)gTexRot + " degrees, "
        + llList2String(["not mirrored", "mirrored"], gMirror)
        + ". Prim rotation (degrees): " + (string)(llRot2Euler(llGetRot()) * RAD_TO_DEG));
}

default
{
    state_entry()
    {
        llListen(CHAN, "", llGetOwner(), "");
        llOwnerSay("[probe] Starting. " + HELP);
        gUrlReq = llRequestSecureURL();
    }

    on_rez(integer p) { llResetScript(); }

    changed(integer c)
    {
        // Region restarts and crossings take the script's web address away.
        if (c & (CHANGED_OWNER | CHANGED_REGION | CHANGED_REGION_START)) llResetScript();
    }

    listen(integer ch, string name, key id, string msg)
    {
        list w = llParseString2List(llToLower(llStringTrim(msg, STRING_TRIM)), [" "], []);
        string cmd = llList2String(w, 0);
        if (cmd == "api") return;   // node-check.lsl's command
        if (cmd == "globe")
        {
            // Rotating -90 degrees about Y carries local +X to world up.
            llSetRot(llEuler2Rot(<0.0, -PI_BY_TWO, 0.0>));
            gTexRot = 90;
            applyTexture();
            return;
        }
        if (cmd == "turn") { gTexRot = (gTexRot + 90) % 360; applyTexture(); return; }
        if (cmd == "mirror") { gMirror = !gMirror; applyTexture(); return; }
        if (cmd == "reset")
        {
            llSetRot(ZERO_ROTATION);
            gTexRot = 0;
            gMirror = FALSE;
            applyTexture();
            return;
        }
        if (cmd == "app") { show("app", NODE + "/?embed=1"); return; }
        // `/output.html` falls through to the main app; this is the page.
        if (cmd == "sos") { show("sos", NODE + "/output/output"); return; }
        if (cmd == "hash")
        {
            // A browser treats an address that differs only after # as the
            // same page: no reload, just a hashchange event. Whether Second
            // Life's viewers pass such a change on, and how, is the test.
            // The run number is before the #, so the page keeps its run.
            // The change reaches every viewer the same way, the owner's
            // included - as an update to the object - so the owner's own
            // viewer answers for every viewer of its kind.
            if (gUrl == "") { llOwnerSay("[probe] Show a page first: video, probe, app or sos."); return; }
            // The face's own address rather than show()'s: a click inside
            // the app navigates it, and the viewer reports that back.
            string url = llList2String(llGetPrimMediaParams(gFace, [PRIM_MEDIA_CURRENT_URL]), 0);
            if (url == "") url = gUrl;
            integer cut = llSubStringIndex(url, "#");
            if (cut > 0) url = llGetSubString(url, 0, cut - 1);
            integer h = gHashes + 1;
            url += "#h=" + (string)h;
            // Timed from before the call, because the call sleeps the
            // script for a second after the address has already changed.
            // Home too, so a viewer reloading to its home address keeps it.
            float t = llGetTime();
            integer r = llSetPrimMediaParams(gFace, [PRIM_MEDIA_CURRENT_URL, url, PRIM_MEDIA_HOME_URL, url]);
            if (r != STATUS_OK)
            {
                llOwnerSay("[probe] Could not change the address (status " + (string)r + ").");
                return;
            }
            gHashes = h;
            gHashAt = t;
            gHashSaidAt = 0.0;
            string said = "[probe] Changed only the part after # to h=" + (string)h + ". ";
            if (gMode == "app" || gMode == "sos")
                llOwnerSay(said + "This page can't report, so watching it shows one thing only: if it starts over, "
                    + "the viewer reloaded it. If it doesn't, the change may have arrived quietly or not at all. "
                    + "The test page tells those apart: /7 video, then /7 hash.");
            else if (gStarts == 0)
                llOwnerSay(said + "But the page hasn't reported starting (is media auto-play on?), "
                    + "so its silence means nothing. Click the face, then try again.");
            else
                llOwnerSay(said + "If no answer about it comes within half a minute, the viewer didn't pass it on.");
            return;
        }
        if (gBase == "") { llOwnerSay("[probe] Still waiting for a web address from the region."); return; }
        if (cmd == "probe" || cmd == "image" || cmd == "video" || cmd == "soak" || cmd == "soak2d")
        {
            show(cmd, gBase + "?" + cmd);
            return;
        }
        if (cmd == "face")
        {
            // Checked before anything is cleared, so a typo cannot leave
            // the probe pointing at a face the object does not have.
            string arg = llList2String(w, 1);
            integer face = (integer)arg;
            integer sides = llGetNumberOfSides();
            if (arg == "" || (string)face != arg || face < 0 || face >= sides)
            {
                llOwnerSay("[probe] This object has faces 0 to " + (string)(sides - 1) + ".");
                return;
            }
            // The old face is cleared only once the new one has taken the
            // media, so a refused change leaves the old page showing, and
            // watched, as show() says. Not cleared at all if it is the same
            // face, which would remove the page just put there.
            integer old = gFace;
            gFace = face;
            if (!show("probe", gBase + "?probe")) { gFace = old; return; }
            if (old != face) llClearPrimMedia(old);
            applyTexture();
            return;
        }
        llOwnerSay("[probe] " + HELP);
    }

    http_request(key id, string method, string body)
    {
        if (id == gUrlReq)
        {
            if (method == URL_REQUEST_DENIED)
            {
                llOwnerSay("[probe] The region would not give this script a web address: " + body);
                return;
            }
            gBase = body;
            show("probe", gBase + "?probe");
            return;
        }
        // Headers have to be read before responding.
        string path = llGetHTTPHeader(id, "x-path-info");
        integer run = runOf(llGetHTTPHeader(id, "x-query-string"));
        if (method == "GET")
        {
            if (path != "" && path != "/") { llHTTPResponse(id, 404, ""); return; }   // favicon etc.
            llScriptProfiler(PROFILE_SCRIPT_MEMORY);
            llSetContentType(id, CONTENT_TYPE_HTML);
            llHTTPResponse(id, 200, page());
            llScriptProfiler(PROFILE_NONE);
            // Once per run, whoever fetched first; the page's own first
            // report is what says it ran.
            if (run != gServedRun)
            {
                gServedRun = run;
                llOwnerSay("[probe] Served the page. Peak script memory while building it: "
                    + (string)llGetSPMaxMemory() + " of " + (string)llGetMemoryLimit() + " bytes");
            }
            return;
        }
        if (method == "POST")
        {
            llHTTPResponse(id, 200, "ok");
            if (run != gRun) return;   // a page from an earlier command, still reporting
            list lines = llParseString2List(body, ["~"], []);
            integer i;
            integer n = llGetListLength(lines);
            for (i = 0; i < n; ++i)
            {
                string line = llList2String(lines, i);
                if (llSubStringIndex(line, "mode: ") == 0)
                {
                    // The page has started. A second start on the same run
                    // is the viewer reloading it, which it sometimes does
                    // unasked and at a different size. The line ends with
                    // the # part the page loaded with, if any, so a reload
                    // soon after /7 hash says which of three things it was.
                    integer age = hashAge();
                    if (++gStarts > 1)
                    {
                        string after = " ms after the # change. ";
                        if (age < 0)
                            llOwnerSay("[probe] The page started again without a command: the viewer reloaded it.");
                        else if (gHashSaidAt > 0.0)
                            llOwnerSay("[probe] The viewer then reloaded the page anyway, " + (string)age + after
                                + "Count the change as costing a reload.");
                        else if (llSubStringIndex(line + " ", " #h=" + (string)gHashes + " ") != -1)
                            llOwnerSay("[probe] The viewer reloaded the page to apply the change, " + (string)age + after
                                + "Here, a change after # costs a reload.");
                        else
                            llOwnerSay("[probe] The viewer reloaded the page " + (string)age + after
                                + "But the reload lost the # part, so the change didn't arrive at all.");
                        if (age >= 0) gHashAt = 0.0;
                    }
                    arm(watchFor(gMode));
                }
                else if (llSubStringIndex(line, "webgl frames") == 0 && gWatch == WATCH_FRAMES)
                    arm(WATCH_NONE);
                else if (llSubStringIndex(line, "hash: #h=" + (string)gHashes + ",") == 0 && gHashSaidAt == 0.0)
                {
                    // Only the latest change's report counts, and only once.
                    // The time includes the report's own trip back, so the
                    // page saw the change sooner than this, never later.
                    // The wait stays open, so a reload that follows the
                    // report is caught by the mode line above.
                    integer age = hashAge();
                    if (age >= 0)
                    {
                        string video = "";
                        if (llSubStringIndex(line, ", playing, readyState 3") != -1
                            || llSubStringIndex(line, ", playing, readyState 4") != -1)
                            video = " The video kept playing.";
                        else if (llSubStringIndex(line, ", no video") == -1)
                            video = " But the video wasn't playing normally at that moment (see the next line).";
                        llOwnerSay("[probe] The page took the change without reloading, at most " + (string)age
                            + " ms after the script made it." + video);
                        gHashSaidAt = llGetTime();
                    }
                }
                else if (llSubStringIndex(line, "soak ") == 0 && watchFor(gMode) == WATCH_HEARTBEAT)
                {
                    if (llSubStringIndex(line, "s, ") != -1)
                    {
                        // Accepted even after the watch fired: a gap that
                        // recovers is not the end of the soak, and the
                        // watch has to be back for the one that is.
                        if (gWatch != WATCH_HEARTBEAT)
                            llOwnerSay("[probe] Heartbeats resumed, so the gap was not the end of the soak.");
                        gWatch = WATCH_HEARTBEAT;
                        gSoakLast = line;
                        countdown(HEARTBEAT_WAIT);
                    }
                    else
                        // The soak said it cannot run - no WebGL 2 context,
                        // say. That is an answer, not a page gone quiet.
                        arm(WATCH_NONE);
                }
                llOwnerSay("[page] " + line);
            }
            return;
        }
        llHTTPResponse(id, 405, "");
    }

    timer()
    {
        // A timer event already queued when a command cleared or restarted
        // the countdown can still arrive. With nothing armed it belongs to
        // a watch that no longer exists; with the deadline still ahead it
        // belongs to an earlier countdown, and the current one runs on.
        // Half a second of slack, so a timer that fires on time is never
        // sent round again for a rounding difference.
        if (gWatch == WATCH_NONE) { llSetTimerEvent(0.0); return; }
        float left = gDeadline - llGetTime();
        if (left > 0.5) { llSetTimerEvent(left); return; }
        if (gStarts == 0)
            llOwnerSay("[probe] The page never reported starting. Is media auto-play on? Clicking the face starts it.");
        else if (gWatch == WATCH_FRAMES)
            llOwnerSay("[probe] No WebGL frame report within " + (string)((integer)FRAMES_WAIT)
                + " seconds. The page stopped responding or the viewer unloaded it.");
        else if (gWatch == WATCH_HEARTBEAT && gSoakLast == "")
            llOwnerSay("[probe] The soak sent no heartbeat within " + (string)((integer)HEARTBEAT_WAIT)
                + " seconds of starting. The page stopped responding or the viewer unloaded it.");
        else if (gWatch == WATCH_HEARTBEAT)
            llOwnerSay("[probe] Heartbeats stopped. Last one: " + gSoakLast);
        arm(WATCH_NONE);
    }
}
