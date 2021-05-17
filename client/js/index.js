import { initASWebGLue, ASWebGLReady } from './ASWebGLue2.js';
import * as loader from './loader.esm.js'

const ClientSessionId = Math.random().toString(36).substr(2, 9);

let wasmModule;
let wasmExports; // Shortcut for wasmExports

var cnvs = document.getElementById("cnvs");


//------------------------------------------------------------------------------
// Audio

var chill_song = new Audio('music/replica.mp3')
var fight1_song = new Audio('music/deadly_slot_game.mp3')
var fight2_song = new Audio('music/aesir_chaos.mp3')

var laser_sfx = new Audio('sfx/laserSmall_000.ogg')
var explosion_sfx = new Audio('sfx/explosion-hq.mp3')

var ActiveMusic = "chill";
var MusicMap = {
    "chill": chill_song,
    "fight1": fight1_song,
    "fight2": fight2_song
};

var SoundEffects = {
    "laser": laser_sfx,
    "explosion": explosion_sfx
};


//------------------------------------------------------------------------------
// WebRTC

let webrtc_conn = null;
let webrtc_unreliable = null;
let webrtc_reliable = null;
let ws_conn = null;
let webrtc_dc_count = 0;
let syncTimer = null;
let reliableSendTimer = null;
let timeSyncInterval = 100;

function StopWebsocket() {
    if (ws_conn != null) {
        ws_conn.close();
        ws_conn = null;
    }
}

function OnConnectionOpen() {
    wasmExports["OnConnectionOpen"](performance.now());

    timeSyncInterval = 100;
    var dispatchTimeSync = () => {
        var variance = Math.random() * 20 - 10;
        syncTimer = setTimeout(() => {
            wasmExports["SendTimeSync"]();

            dispatchTimeSync();
        }, timeSyncInterval + variance);
        timeSyncInterval *= 2;
        if (timeSyncInterval > 1000) {
            timeSyncInterval = 1000; // Steady state interval
        }
    };
    dispatchTimeSync();

    reliableSendTimer = setInterval(() => {
        wasmExports["OnReliableSendTimer"]();
    }, 100);
}

function StopWebRTC() {
    if (syncTimer != null) {
        clearTimeout(syncTimer);
        syncTimer= null;
    }
    if (reliableSendTimer != null) {
        clearInterval(reliableSendTimer);
        reliableSendTimer= null;
    }
    if (webrtc_unreliable != null) {
        webrtc_unreliable.close();
        webrtc_unreliable = null;
    }
    if (webrtc_reliable != null) {
        webrtc_reliable.close();
        webrtc_reliable = null;
    }
    if (webrtc_conn != null) {
        webrtc_conn.close();
        webrtc_conn = null;
    }
    webrtc_dc_count = 0;
}

function StartRTCPeerConnection(on_offer) {
    if (webrtc_conn != null) {
        console.error("StartRTCPeerConnection: webrtc_conn not null");
        return;
    }
    //console.log("Starting WebRTC connection");
    webrtc_conn = new RTCPeerConnection(null);
/*
    webrtc_conn.onicecandidate = e => {
        //console.log("onicecandidate", e);
    };
    webrtc_conn.onconnectionstatechange = e => {
        //console.log("onconnectionstatechange", e);
    }
    webrtc_conn.oniceconnectionstatechange = e => {
        //console.log("oniceconnectionstatechange", e);
    }
    webrtc_conn.ondatachannel = e => {
        //console.log("ondatachannel", e);
    }
    webrtc_conn.onicegatheringstatechange = e => {
        //console.log("onicegatheringstatechange", e);
    }
    webrtc_conn.onidentityresult = e => {
        //console.log("onidentityresult", e);
    }
    webrtc_conn.onnegotiationneeded = e => {
        //console.log("onnegotiationneeded", e);
    }
    webrtc_conn.onremovestream = e => {
        //console.log("onremovestream", e);
    }
    webrtc_conn.onsignalingstatechange = e => {
        //console.log("onsignalingstatechange", e);
    }
    webrtc_conn.ontrack = e => {
        //console.log("ontrack", e);
    }
*/
    webrtc_unreliable = webrtc_conn.createDataChannel('unreliable', {
        "ordered": false,
        "maxPacketLifeTime": 100 // msec
    });

    webrtc_unreliable.onopen = ev => {
        //console.log('onopen:', webrtc_unreliable.readyState, ev);
        webrtc_dc_count++;
        if (webrtc_dc_count >= 2) {
            wasmExports["OnConnectionOpen"](performance.now());
        }
    };
    webrtc_unreliable.onerror = ev => {
        console.log('onerror:', webrtc_unreliable.readyState, ev);
    };
    webrtc_unreliable.onclose = ev => {
        //console.log('onclose:', webrtc_unreliable.readyState, ev);
        wasmExports["OnConnectionClose"]();
        StopWebsocket();
        StopWebRTC();
    };
    webrtc_unreliable.onmessage = ev => {
        let recv_msec = performance.now();
        //console.log('onmessage:', webrtc_unreliable.readyState, ev);

        // Make a copy of the buffer into wasm memory
        const dataRef = wasmExports["__pin"](wasmExports["__newArray"](wasmExports["UINT8ARRAY_ID"], new Uint8Array(ev.data)));

        wasmExports["OnConnectionUnreliableData"](recv_msec, dataRef);

        // Release resource
        wasmExports["__unpin"](dataRef);
    };
    webrtc_unreliable.onbufferedamountlow = ev => {
        //console.log('onbufferedamountlow:', webrtc_unreliable.readyState, ev);
    };

    webrtc_reliable = webrtc_conn.createDataChannel('reliable', {
        "ordered": true,
        "maxRetransmits": 1000 // lots
    });

    webrtc_reliable.onopen = ev => {
        //console.log('onopen:', webrtc_reliable.readyState, ev);
        webrtc_dc_count++;
        if (webrtc_dc_count >= 2) {
            OnConnectionOpen();
        }
    };
    webrtc_reliable.onerror = ev => {
        console.log('onerror:', webrtc_reliable.readyState, ev);
    };
    webrtc_reliable.onclose = ev => {
        //console.log('onclose:', webrtc_reliable.readyState, ev);
        wasmExports["OnConnectionClose"]();
        StopWebsocket();
        StopWebRTC();
    };
    webrtc_reliable.onmessage = ev => {
        //console.log('onmessage:', webrtc_reliable.readyState, ev);

        // Make a copy of the buffer into wasm memory
        const dataRef = wasmExports["__pin"](wasmExports["__newArray"](wasmExports["UINT8ARRAY_ID"], new Uint8Array(ev.data)));

        wasmExports["OnConnectionReliableData"](dataRef);

        // Release resource
        wasmExports["__unpin"](dataRef);
    };
    webrtc_reliable.onbufferedamountlow = ev => {
        //console.log('onbufferedamountlow:', webrtc_reliable.readyState, ev);
    };

    // Let's go!

    webrtc_conn.createOffer().then((offer) => {
        //console.log("Created offer=", offer)
        return webrtc_conn.setLocalDescription(offer);
    }).then(() => {
        //console.log("webrtc_conn.localDescription = ", webrtc_conn.localDescription);
        on_offer(webrtc_conn.localDescription);
    }).catch((reason) => {
        console.error("createOffer failed: " + reason);
        StopWebsocket();
        StopWebRTC();
    });
}


//------------------------------------------------------------------------------
// WebSocket

function StartWebsocket() {
    ws_conn = new WebSocket("wss://" + location.hostname + ":8443/bb/" + ClientSessionId);
    
    ws_conn.onopen = (ev) => {
        console.log("WebSocket client connected");

        if (!webrtc_conn) {
            StartRTCPeerConnection((offer) => {
                if (ws_conn != null) {
                    ws_conn.send(JSON.stringify({
                        "type": "offer",
                        "offer": offer
                    }));
                } else {
                    StopWebRTC();
                }
            });
        }
    };
    ws_conn.onclose = (ev) => {
        console.error("WebSocket client disconnected");
        ws_conn = null;

        // FIXME: Remove this
        setTimeout(() => {
            location.reload();
        }, 3000);

        setTimeout(() => {
            StartWebsocket();
        }, 1000);
    };
    ws_conn.onerror = (ev) => {
        console.error("WebSocket error", ev);
    };
    ws_conn.onmessage = (ev) => {
        //console.log("WebSocket server message");
        try {
            var m = JSON.parse(ev.data);

            if (m.type == "answer" && webrtc_conn != null) {
                //console.log("Got peer answer: setRemoteDescription sdp=", m.sdp);
                webrtc_conn.setRemoteDescription(new RTCSessionDescription({
                    "type": "answer",
                    "sdp": m.sdp
                }));
            } else if (m.type == "candidate" && webrtc_conn != null) {
                //console.log("Got peer candidate: addIceCandidate sdp=", m.sdp, " mid=", m.mid);
                webrtc_conn.addIceCandidate(new RTCIceCandidate({
                    "candidate": m.candidate,
                    "sdpMid": m.mid
                }));
            }
        } catch (err) {
            console.error("Websocket message parse failed: err=", err);
        }
    };
}


//------------------------------------------------------------------------------
// Input

var is_active = false;
var margin_left = 0;
var margin_top = 0;
var finger_x = 0;
var finger_y = 0;
var can_use_audio = false;

function activate() {
    if (!is_active) {
        is_active = true;
        document.body.style.backgroundColor = "#444";
        margin_left = parseInt(window.getComputedStyle(cnvs.parentNode).getPropertyValue("margin-left"), 10);
        margin_top = parseInt(window.getComputedStyle(cnvs.parentNode).getPropertyValue("margin-top"), 10);
        if (can_use_audio) {
            MusicMap[ActiveMusic].play();
            MusicMap[ActiveMusic].loop = true;
        }
    }
}

function deactivate() {
    if (is_active) {
        is_active = false;
        finger_x = -1;
        finger_y = -1;
        document.body.style.backgroundColor = "white";
        if (can_use_audio) {
            MusicMap[ActiveMusic].pause();
        }
    }
}

function handle_mouse(e) {
    if (e.touches) {
        finger_x = e.targetTouches[0].clientX - margin_left;
        finger_y = e.targetTouches[0].clientY - margin_top;
    }  else if (e.offsetX) {
        finger_x = e.offsetX;
        finger_y = e.offsetY;
    } else if (e.layerX) {
        finger_x = e.layerX;
        finger_y = e.layerY;
    }
}

cnvs.addEventListener('touchmove', function(e) {
    e.preventDefault();
    handle_mouse(e);
}, { passive: false });
cnvs.addEventListener('MozTouchMove', function(e) {
    e.preventDefault();
    handle_mouse(e);
}, { passive: false });
cnvs.addEventListener('mousemove', function(e) {
    handle_mouse(e);
}, { passive: true });
cnvs.addEventListener('touchstart', function(e) {
    e.preventDefault();
    activate();
}, { passive: false });
cnvs.addEventListener('MozTouchDown', function(e) {
    e.preventDefault();
    activate();
}, { passive: false });
cnvs.addEventListener('mouseover', function(e) {
    activate();
}, { passive: true });
cnvs.addEventListener('touchend', function(e) {
    e.preventDefault();
    deactivate();
}, { passive: false });
cnvs.addEventListener('MozTouchUp', function(e) {
    e.preventDefault();
    deactivate();
}, { passive: false });
cnvs.addEventListener('mouseout', function(e) {
    deactivate();
}, { passive: true });

document.addEventListener('mousedown', () => {
    if (!can_use_audio) {
        can_use_audio = true;
        MusicMap[ActiveMusic].play();
        MusicMap[ActiveMusic].loop = true;
    }
}, { passive: true });


//------------------------------------------------------------------------------
// Render

let window_w = 0, window_h = 0;
let canvas_w = 0, canvas_h = 0;
let last_resize_msec = 0;

function renderFrame() {
    // Update canvas size to window size as user resizes the window
    if (window.innerWidth != window_w || window.innerHeight != window_h) {
        // Resize no more than once every 10th of a second to avoid lag on desktop
        if (performance.now() - last_resize_msec >= 100.0) {
            window_w = window.innerWidth;
            window_h = window.innerHeight;

            // Subtract extra for scrollbars in case they show up for some reason
            canvas_w = window_w * 0.98 - 32;
            canvas_h = window_h * 0.98 - 32;
            if (canvas_w > canvas_h) {
                canvas_w = canvas_h;
            } else {
                canvas_h = canvas_w;
            }
            cnvs.width = canvas_w;
            cnvs.height = canvas_w;
            cnvs.style.width = canvas_w + "px";
            cnvs.style.height = canvas_w + "px";
    
            last_resize_msec = performance.now();
        }
    }

    // Render using wasm
    wasmExports["RenderFrame"](performance.now(), finger_x, finger_y, canvas_w, canvas_h);

    requestAnimationFrame(renderFrame);
}


//------------------------------------------------------------------------------
// WebAssembly Frame Loop

let wasmImports = {};
wasmImports["javascript"] = {};
wasmImports["javascript"]["jsConsoleLog"] = (m) => {
    // Make a copy because the memory may have moved by the next tick
    var copy = wasmExports["__getString"](m);
    console.log(copy); // sync version
    //setTimeout(() => { console.log(copy); }, 50); // async version
};
wasmImports["javascript"]["jsGetMilliseconds"] = () => {
    return performance.now();
};
wasmImports["javascript"]["jsSendReliable"] = (buffer) => {
    if (webrtc_reliable != null) {
        webrtc_reliable.send(wasmExports["__getUint8ArrayView"](buffer));
    }
};
wasmImports["javascript"]["jsSendUnreliable"] = (buffer) => {
    if (webrtc_unreliable != null) {
        webrtc_unreliable.send(wasmExports["__getUint8ArrayView"](buffer));
    }
};
wasmImports["javascript"]["jsPlayMusic"] = (name) => {
    var copy = wasmExports["__getString"](name);
    setTimeout(() => {
        if (ActiveMusic != copy) {
            var old_music = ActiveMusic;
            var anim_out_fn = () => {
                var new_volume = MusicMap[old_music].volume - 0.1;
                if (new_volume <= 0.0) {
                    MusicMap[old_music].pause();
                } else {
                    MusicMap[old_music].volume = new_volume;
                    setTimeout(anim_out_fn, 100);
                }
            };
            anim_out_fn();
        }
        ActiveMusic = copy;
        if (can_use_audio) {
            var new_music = ActiveMusic;
            MusicMap[new_music].volume = 0.1;
            if (is_active) {
                MusicMap[new_music].play();
            }
            var anim_in_fn = () => {
                var new_volume = MusicMap[new_music].volume + 0.1;
                if (new_volume < 1.0) {
                    MusicMap[new_music].volume = new_volume;
                    setTimeout(anim_in_fn, 100);
                } else {
                    MusicMap[new_music].volume = 1.0;
                }
            };
            anim_in_fn();
            MusicMap[ActiveMusic].loop = true;
        }
    }, 0);
};
wasmImports["javascript"]["jsPlaySFX"] = (name) => {
    var copy = wasmExports["__getString"](name);
    setTimeout(() => {
        if (can_use_audio) {
            SoundEffects[copy].pause();
            SoundEffects[copy].play();
        }
    }, 0);
};
wasmImports["javascript"]["jsServerLoginGood"] = () => {
    console.log("LoginGood");
};
wasmImports["javascript"]["jsServerLoginBad"] = (reason) => {
    var copy = wasmExports["__getString"](reason);
    console.error("LoginBad:", copy);
};
wasmImports["env"] = {};

function startRender(wasm_file) {
    // Linear memory
    const memory = new WebAssembly.Memory({ initial: 10000 });

    var importObject = {
        ...wasmImports
    };
    importObject["env"]["memory"] = memory;

    initASWebGLue(importObject);

    (async () => {
        const wasm_fetch = await fetch(wasm_file);

        loader.instantiateStreaming(wasm_fetch, importObject).then(obj => {
            wasmModule = obj;
            wasmExports = wasmModule.exports;

            ASWebGLReady(obj, importObject);

            wasmExports["Initialize"]();

            StartWebsocket();

            requestAnimationFrame(renderFrame);
        });
    })();
}

startRender("bossballoon.wasm");
