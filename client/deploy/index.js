//import { initASWebGLue, ASWebGLReady } from './ASWebGLue.js';
import { initASWebGLue, ASWebGLReady } from './ASWebGLue2.js'; // No try..catch
import * as loader from './loader.esm.js'

const ClientSessionId = Math.random().toString(36).substr(2, 9);

let wasmExports;
let wasmInstanceExports;

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

function StartWebRTC() {
    webrtc_conn = new RTCPeerConnection(servers);
    
    let sendChannel = localConnection.createDataChannel('sendDataChannel');
    
    localConnection.onicecandidate = e => {
        console.log("onicecandidate");
        console.log(e);
    };
    
    function onSendChannelStateChange() {
        const readyState = sendChannel.readyState;
        console.log('Send channel state is: ' + readyState);
    }
    
    sendChannel.onopen = onSendChannelStateChange;
    sendChannel.onclose = onSendChannelStateChange;
    
    localConnection.createOffer().then((offer) => {
        console.log("Got offer")
        console.log(offer);
        localConnection.setLocalDescription(offer);
        // Send offer here
    }).catch((reason) => {
        console.log("createOffer failed: " + reason);
    });
    
    // Get answer from peer and set it here! localConnection.setRemoteDescription(desc);
}


//------------------------------------------------------------------------------
// WebSocket

var ws_conn = null;

function StartWebsocket() {
    ws_conn = new WebSocket('wss://localhost:8443/ss/' + ClientSessionId, [], {
        perMessageDeflate: false
    });
    
    ws_conn.onopen = (ev) => {
        console.log("WebSocket client connected");
        ws_conn.send('foo');
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
    };
}

StartWebsocket();


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
    wasmInstanceExports.RenderFrame(performance.now(), finger_x, finger_y);

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
        const wasm = await fetch(wasm_file);

        loader.instantiateStreaming(wasm, importObject).then(obj => {
            wasmExports = obj.exports;
            wasmInstanceExports = obj.instance.exports;

            ASWebGLReady(obj, importObject);

            wasmInstanceExports.Initialize();

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
