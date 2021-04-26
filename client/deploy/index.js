//import { initASWebGLue, ASWebGLReady } from './ASWebGLue.js';
import { initASWebGLue, ASWebGLReady } from './ASWebGLue2.js'; // No try..catch
import * as loader from './loader.esm.js'

const ClientSessionId = Math.random().toString(36).substr(2, 9);

let wasmModule;

var cnvs = document.getElementById("cnvs");


//------------------------------------------------------------------------------
// Audio

var song = new Audio('audio/song-hq.mp3')
var laser = new Audio('audio/laserSmall_000.ogg')
var enemyLaser = new Audio('audio/laserSmall_003.ogg')
var explosion = new Audio('audio/explosion-hq.mp3')
var cloakOn = new Audio('audio/phaserUp2.ogg')
var cloakOff = new Audio('audio/phaserDown2.ogg')


//------------------------------------------------------------------------------
// WebRTC

let webrtc_conn = null;
let webrtc_chan = null;
let ws_conn = null;

function StopWebsocket() {
    if (ws_conn != null) {
        ws_conn.close();
        ws_conn = null;
    }
}

function StopWebRTC() {
    if (webrtc_chan != null) {
        webrtc_chan.close();
        webrtc_chan = null;
    }
    if (webrtc_conn != null) {
        webrtc_conn.close();
        webrtc_conn = null;
    }
}

function StartRTCPeerConnection(on_offer) {
    if (webrtc_conn != null) {
        console.error("StartRTCPeerConnection: webrtc_conn not null");
        return;
    }
    console.log("Starting WebRTC connection");
    webrtc_conn = new RTCPeerConnection();

    webrtc_conn.onicecandidate = e => {
        console.log("onicecandidate");
        console.log(e);
    };
    webrtc_conn.onconnectionstatechange = e => {
        console.log("onconnectionstatechange");
        console.log(e);
    }
    webrtc_conn.oniceconnectionstatechange = e => {
        console.log("oniceconnectionstatechange");
        console.log(e);
    }
    webrtc_conn.ondatachannel = e => {
        console.log("ondatachannel");
        console.log(e);
    }
    webrtc_conn.onicegatheringstatechange = e => {
        console.log("onicegatheringstatechange");
        console.log(e);
    }
    webrtc_conn.onidentityresult = e => {
        console.log("onidentityresult");
        console.log(e);
    }
    webrtc_conn.onnegotiationneeded = e => {
        console.log("onnegotiationneeded");
        console.log(e);
    }
    webrtc_conn.onremovestream = e => {
        console.log("onremovestream");
        console.log(e);
    }
    webrtc_conn.onsignalingstatechange = e => {
        console.log("onsignalingstatechange");
        console.log(e);
    }
    webrtc_conn.ontrack = e => {
        console.log("ontrack");
        console.log(e);
    }

    webrtc_chan = webrtc_conn.createDataChannel('ss', {
        "ordered": false,
        //"maxPacketLifeTime": 100, // msec
        "maxRetransmits": 1
    });

    webrtc_chan.onopen = ev => {
        const readyState = webrtc_chan.readyState;
        console.log('onopen: ' + readyState);
        console.log(ev);
        wasmModule.exports.OnConnectionOpen();
    };
    webrtc_chan.onerror = ev => {
        const readyState = webrtc_chan.readyState;
        console.log('onerror: ' + readyState);
        console.log(ev);
    };
    webrtc_chan.onclose = ev => {
        const readyState = webrtc_chan.readyState;
        console.log('onclose: ' + readyState);
        console.log(ev);
        wasmModule.exports.OnConnectionClose();
        StopWebsocket();
        StopWebRTC();
    };
    webrtc_chan.onmessage = ev => {
        const readyState = webrtc_chan.readyState;
        console.log('onmessage: ' + readyState);
        console.log(ev);

        // Make a copy of the buffer into wasm memory
        const dataRef = wasmModule.exports.__retain(wasmModule.exports.__allocArray(wasmModule.exports.UINT8ARRAY_ID, ev.data));

        wasmModule.exports.OnConnectionData(dataRef);

        // Release ARC resource
        wasmModule.exports.__release(dataRef);
    };
    webrtc_chan.onbufferedamountlow = ev => {
        const readyState = webrtc_chan.readyState;
        console.log('onbufferedamountlow: ' + readyState);
        console.log(ev);
    };

    webrtc_conn.createOffer().then((offer) => {
        console.log("Created offer=", offer)
        return webrtc_conn.setLocalDescription(offer);
    }).then(() => {
        console.log("webrtc_conn.localDescription = ", webrtc_conn.localDescription);
        on_offer(webrtc_conn.localDescription);
    }).catch((reason) => {
        console.log("createOffer failed: " + reason);
        StopWebsocket();
        StopWebRTC();
    });
}


//------------------------------------------------------------------------------
// WebSocket

function StartWebsocket() {
    ws_conn = new WebSocket('wss://localhost:8443/ss/' + ClientSessionId, [], {
        perMessageDeflate: false
    });
    
    ws_conn.onopen = (ev) => {
        console.log("WebSocket client connected");

        if (!webrtc_conn) {
            StartRTCPeerConnection((offer) => {
                if (ws_conn != null) {
                    ws_conn.send(JSON.stringify({
                        type: "offer",
                        offer: offer
                    }));
                } else {
                    StopWebRTC();
                }
            });
        }
    };
    ws_conn.onclose = (ev) => {
        console.log("WebSocket client disconnected");
        ws_conn = null;

        setTimeout(() => {
            StartWebsocket();
        }, 1_000);
    };
    ws_conn.onerror = (ev) => {
        console.log("WebSocket error");
    };
    ws_conn.onmessage = (ev) => {
        console.log("WebSocket server message");
        try {
            var m = JSON.parse(ev.data);

            if (m.type == "answer" && webrtc_conn != null) {
                console.log("Got peer answer: setRemoteDescription sdp=", m.sdp);
                webrtc_conn.setRemoteDescription({
                    type: "answer",
                    sdp: m.sdp
                });
            } else if (m.type == "candidate" && webrtc_conn != null) {
                console.log("Got peer candidate: addIceCandidate sdp=", m.sdp, " mid=", m.mid);
                webrtc_conn.addIceCandidate({
                    candidate: m.candidate,
                    sdpMid: m.mid
                });
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
        document.body.style.backgroundColor = "black";
        margin_left = parseInt(window.getComputedStyle(cnvs.parentNode).getPropertyValue("margin-left"));
        margin_top = parseInt(window.getComputedStyle(cnvs.parentNode).getPropertyValue("margin-top"));
        if (can_use_audio) {
            song.play();
        }
    }
}

function deactivate() {
    if (is_active) {
        is_active = false;
        document.body.style.backgroundColor = "white";
        if (can_use_audio) {
            song.pause();
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
        song.play();
        song.loop = true;
    }
}, { passive: true });


//------------------------------------------------------------------------------
// Render

// Each frame render runs this function
function renderFrame() {
    // call the LoopCallback function in the WASM module
    wasmModule.exports.RenderFrame(performance.now(), finger_x, finger_y);

    // requestAnimationFrame calls renderFrame the next time a frame is rendered
    requestAnimationFrame(renderFrame);
}


//------------------------------------------------------------------------------
// WebAssembly Frame Loop

const wasmImports = {
    client: {
        consoleLog: (m) => {
            // Make a copy because the memory may have moved by the next tick
            var copy = wasmModule.exports.__getString(m);
            setTimeout(() => {
                console.log(copy);
            }, 50);
        },
        sendBuffer: (buffer) => {
            if (webrtc_chan != null) {
                var resultArray = wasmModule.exports.__getUint8ArrayView(buffer);
                webrtc_chan.send(resultArray);
            }
        },
        playExplosion: () => {
            setTimeout(() => {
                if (can_use_audio) {
                    explosion.pause();
                    explosion.play();
                }
            }, 0);
        },
        playLaser: () => {
            setTimeout(() => {
                if (can_use_audio) {
                    laser.pause();
                    laser.play();
                }
            }, 0);
        }
    }
};

function startRender(wasm_file) {
    // Linear memory
    const memory = new WebAssembly.Memory({ initial: 10_000 });

    var importObject = {
        ...wasmImports,
        env: {
            memory: memory
        }
    };

    initASWebGLue(importObject);

    (async () => {
        const wasm_fetch = await fetch(wasm_file);

        loader.instantiateStreaming(wasm_fetch, importObject).then(obj => {
            wasmModule = obj;

            ASWebGLReady(obj, importObject);

            wasmModule.exports.Initialize();

            StartWebsocket();

            requestAnimationFrame(renderFrame);
        });
    })();
}


//------------------------------------------------------------------------------
// Initialization

// Make play area a square that fills the space
var w = window.innerWidth * 0.98 - 32; // Make sure smaller than scrollbar width
var h = window.innerHeight * 0.98;
if (w > h) {
    w = h;
}
cnvs.width = w;
cnvs.height = w;
cnvs.style.width = w + "px";
cnvs.style.height = w + "px";

startRender("client.wasm");
