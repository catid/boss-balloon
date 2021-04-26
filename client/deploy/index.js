//import { initASWebGLue, ASWebGLReady } from './ASWebGLue.js';
import { initASWebGLue, ASWebGLReady } from './ASWebGLue2.js'; // No try..catch
import * as loader from './loader.esm.js'

const ClientSessionId = Math.random().toString(36).substr(2, 9);

let wasmModule;
let wasmExports; // Shortcut for wasmExports

var cnvs = document.getElementById("cnvs");


//------------------------------------------------------------------------------
// Audio

var song = new Audio('audio/song-hq.mp3')
var laser = new Audio('audio/laserSmall_000.ogg')
var explosion = new Audio('audio/explosion-hq.mp3')


//------------------------------------------------------------------------------
// WebRTC

let webrtc_conn = null;
let webrtc_unreliable = null;
let webrtc_reliable = null;
let ws_conn = null;
let webrtc_dc_count = 0;

function StopWebsocket() {
    if (ws_conn != null) {
        ws_conn.close();
        ws_conn = null;
    }
}

function StopWebRTC() {
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
    webrtc_conn = new RTCPeerConnection();

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

    webrtc_unreliable = webrtc_conn.createDataChannel('unreliable', {
        "ordered": false,
        "maxRetransmits": 0 // no retransmits
    });

    webrtc_unreliable.onopen = ev => {
        //console.log('onopen:', webrtc_unreliable.readyState, ev);
        webrtc_dc_count++;
        if (webrtc_dc_count >= 2) {
            wasmExports.OnConnectionOpen();
        }
    };
    webrtc_unreliable.onerror = ev => {
        console.log('onerror:', webrtc_unreliable.readyState, ev);
    };
    webrtc_unreliable.onclose = ev => {
        //console.log('onclose:', webrtc_unreliable.readyState, ev);
        wasmExports.OnConnectionClose();
        StopWebsocket();
        StopWebRTC();
    };
    webrtc_unreliable.onmessage = ev => {
        let recv_msec = performance.now();
        //console.log('onmessage:', webrtc_unreliable.readyState, ev);

        // Make a copy of the buffer into wasm memory
        const dataRef = wasmExports.__pin(wasmExports.__newArray(wasmExports.UINT8ARRAY_ID, new Uint8Array(ev.data)));

        wasmExports.OnConnectionUnreliableData(recv_msec, dataRef);

        // Release resource
        wasmExports.__unpin(dataRef);
    };
    webrtc_unreliable.onbufferedamountlow = ev => {
        //console.log('onbufferedamountlow:', webrtc_unreliable.readyState, ev);
    };

    webrtc_reliable = webrtc_conn.createDataChannel('reliable', {
        "ordered": true,
        "maxRetransmits": null // unlimited
    });

    webrtc_reliable.onopen = ev => {
        //console.log('onopen:', webrtc_reliable.readyState, ev);
        webrtc_dc_count++;
        if (webrtc_dc_count >= 2) {
            wasmExports.OnConnectionOpen();
        }
    };
    webrtc_reliable.onerror = ev => {
        console.log('onerror:', webrtc_reliable.readyState, ev);
    };
    webrtc_reliable.onclose = ev => {
        //console.log('onclose:', webrtc_reliable.readyState, ev);
        wasmExports.OnConnectionClose();
        StopWebsocket();
        StopWebRTC();
    };
    webrtc_reliable.onmessage = ev => {
        //console.log('onmessage:', webrtc_reliable.readyState, ev);

        // Make a copy of the buffer into wasm memory
        const dataRef = wasmExports.__pin(wasmExports.__newArray(wasmExports.UINT8ARRAY_ID, new Uint8Array(ev.data)));

        wasmExports.OnConnectionReliableData(dataRef);

        // Release resource
        wasmExports.__unpin(dataRef);
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
    ws_conn = new WebSocket('wss://localhost:8443/bb/' + ClientSessionId, [], {
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
        console.error("WebSocket client disconnected");
        ws_conn = null;

        setTimeout(() => {
            StartWebsocket();
        }, 1_000);
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
                webrtc_conn.setRemoteDescription({
                    type: "answer",
                    sdp: m.sdp
                });
            } else if (m.type == "candidate" && webrtc_conn != null) {
                //console.log("Got peer candidate: addIceCandidate sdp=", m.sdp, " mid=", m.mid);
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
    wasmExports.RenderFrame(performance.now(), finger_x, finger_y);

    // requestAnimationFrame calls renderFrame the next time a frame is rendered
    requestAnimationFrame(renderFrame);
}


//------------------------------------------------------------------------------
// WebAssembly Frame Loop

const wasmImports = {
    client: {
        consoleLog: (m) => {
            // Make a copy because the memory may have moved by the next tick
            var copy = wasmExports.__getString(m);
            setTimeout(() => {
                console.log(copy);
            }, 50);
        },
        sendReliable: (buffer) => {
            if (webrtc_reliable != null) {
                webrtc_reliable.send(wasmExports.__getUint8ArrayView(buffer));
            }
        },
        sendUnreliable: (buffer) => {
            if (webrtc_unreliable != null) {
                webrtc_unreliable.send(wasmExports.__getUint8ArrayView(buffer));
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
            wasmExports = wasmModule.exports;

            ASWebGLReady(obj, importObject);

            wasmExports.Initialize();

            StartWebsocket();

            requestAnimationFrame(renderFrame);
        });
    })();
}


//------------------------------------------------------------------------------
// Initialization

// FIXME: This should change the canvas size if window is resized

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
