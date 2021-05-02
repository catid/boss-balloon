/*
    Web Server

    Hosts static content for debugging
    Hosts HTTPS websocket server to set up WebRTC
    Hosts WebRTC datachannel-only server for browser
*/


//------------------------------------------------------------------------------
// Dependencies

const fs = require("fs");
const path = require('path');
const url = require('url');
const express = require('express');
const https = require('https');
const WebSocket = require('ws');
const loader = require("@assemblyscript/loader");
const node_datachannel = require('node-datachannel');
const { performance } = require('perf_hooks');

let wasmModule;
let wasmExports;


//------------------------------------------------------------------------------
// HTTPS

// Key generated by `npm run keygen`
var privateKey  = fs.readFileSync(__dirname + "/../key.pem", 'utf8');
var certificate = fs.readFileSync(__dirname + "/../cert.pem", 'utf8');
var credentials = { key: privateKey, cert: certificate };

var app = express();

app.use("/", express.static(path.join(__dirname, '../client/deploy')));

var httpsServer = https.createServer(credentials, app);
httpsServer.listen(8443);


//------------------------------------------------------------------------------
// WebRTC DataChannel

var ws_remote_map = new Map(); // Lookup by remote's self-assigned id
var webrtc_remote_map = new Map(); // Lookup by remote's self-assigned id

// We have an internal id for each client so that we do not need to use strings
// to identify clients from the Web Assembly, which has a lot of extra overhead.
var webrtc_local_map = new Map(); // Lookup by local numeric id
var next_local_id = 1; // Increments by 1 for each new unique remote id

node_datachannel.initLogger("Warning");

class WebRTCClient {
    constructor(remote_id, ip) {
        let local_id = next_local_id++;
        this.remote_id = remote_id;
        this.local_id = local_id;
        this.ip = ip;
        this.alive = true;
        this.client_id_str = remote_id + "(" + ip + ")";
        this.channels_open = 0;
        this.connected = false; // Connected if we get all datachannels open

        this.conn = new node_datachannel.PeerConnection("bb", {
            enableIceTcp: false,
            iceServers: ["stun:stun.l.google.com:19302"],
            // Support up to 20k clients - These UDP ports must be open in firewall of server
            portRangeBegin: 10_000,
            portRangeEnd: 30_000,
            maxMessageSize: 1_100
        });

        this.setupTimeout = setTimeout(() => {
            if (!this.connected) {
                console.error(this.client_id_str + " Session timed out waiting for data channels to open");
                this.Close();
            }
        }, 5_000);

        this.conn.onStateChange((state) => {
            //console.log(this.client_id_str + " onStateChange state=", state);
            if (state == "closed" || state == "disconnected") {
                this.Close();
            }
        });
        this.conn.onGatheringStateChange((state) => {
            //console.log(this.client_id_str + " onGatheringStateChange state=", state);
        });
        this.conn.onLocalDescription((sdp, type) => {
            //console.log(this.client_id_str + " onLocalDescription type=", type);
            if (type == "answer") {
                let ws = ws_remote_map.get(this.remote_id);
                if (!ws) {
                    console.error(this.client_id_str + " No websocket found for WebRTC client: Aborting connection");
                    this.Close();
                } else {
                    ws.send(JSON.stringify({
                        type: "answer",
                        sdp: sdp
                    }));
                    //console.log(this.client_id_str + " Sending answer to client");
                }
            } else {
                console.error(this.client_id_str + " Ignoring non-answer type");
            }
        });
        this.conn.onLocalCandidate((candidate, mid) => {
            //console.log(this.client_id_str + " onLocalCandidate candidate=", candidate, " mid=", mid);
            let ws = ws_remote_map.get(this.remote_id);
            if (!ws) {
                console.error(this.client_id_str + " No websocket found for WebRTC client: Aborting connection");
                this.Close();
            } else {
                ws.send(JSON.stringify({
                    type: "candidate",
                    candidate: candidate,
                    mid: mid
                }));
                //console.log(this.client_id_str + " Sending candidate to client");
            }
        });
        this.conn.onDataChannel((dc) => {
            // Note: onOpen() only works for the createDataChannel() version of API.
            // This callback indicates channel is open.
            //console.log(this.client_id_str + " DataChannel Open");
            let label = dc.getLabel();
            if (label == "unreliable") {
                if (this.dc_unreliable != null) {
                    console.error("Duplicate unreliable channels");
                    this.Close();
                    return;
                }
                this.channels_open++;
                this.dc_unreliable = dc;
                dc.onClosed(() => {
                    //console.log(this.client_id_str + " WebRTC Unreliable DataChannel Closed");
                    this.Close();
                });
                dc.onError((err) => {
                    console.log(this.client_id_str + " WebRTC Unreliable DataChannel Error: ", err);
                });
            } else if (label == "reliable") {
                if (this.dc_reliable != null) {
                    console.error("Duplicate reliable channels");
                    this.Close();
                    return;
                }
                this.channels_open++;
                this.dc_reliable = dc;
                dc.onClosed(() => {
                    //console.log(this.client_id_str + " WebRTC Reliable DataChannel Closed");
                    this.Close();
                });
                dc.onError((err) => {
                    console.log(this.client_id_str + " WebRTC Reliable DataChannel Error: ", err);
                });
            } else {
                console.error("Unrecognized channel label ignored:", label);
                return;
            }

            if (this.channels_open >= 2) {
                this.connected = true;
                clearTimeout(this.setupTimeout);
                this.setupTimeout = null;

                this.client = wasmExports.__pin(wasmExports.OnConnectionOpen(this.local_id));
                if (this.client == null) {
                    console.error("OnConnectionOpen failed");
                    this.Close();
                    return;
                }

                this.syncTimer = setInterval(() => {
                    if (this.client != null) {
                        wasmExports.SendTimeSync(this.client);
                    }
                }, 1_000);
            
                this.reliableSendTimer = setInterval(() => {
                    if (this.client != null) {
                        wasmExports.OnReliableSendTimer(this.client);
                    }
                }, 100);

                // Start accepting messages
                this.dc_unreliable.onMessage((msg) => {
                    var t_msec = performance.now();

                    if (this.client != null) {
                        // Make a copy of the buffer into wasm memory
                        const dataRef = wasmExports.__pin(wasmExports.__newArray(wasmExports.UINT8ARRAY_ID, msg));

                        wasmExports.OnUnreliableData(this.client, t_msec, dataRef);

                        // Release resource
                        wasmExports.__unpin(dataRef);
                    }
                });
                this.dc_reliable.onMessage((msg) => {
                    if (this.client != null) {
                        // Make a copy of the buffer into wasm memory
                        const dataRef = wasmExports.__pin(wasmExports.__newArray(wasmExports.UINT8ARRAY_ID, msg));

                        wasmExports.OnReliableData(this.client, dataRef);

                        // Release resource
                        wasmExports.__unpin(dataRef);
                    }
                });
            }
        });

        webrtc_remote_map.set(this.remote_id, this);
        webrtc_local_map.set(this.local_id, this);
    }

    Close() {
        this.connected = false;
        if (this.syncTimer != null) {
            clearInterval(this.syncTimer);
            this.syncTimer= null;
        }
        if (this.reliableSendTimer != null) {
            clearInterval(this.reliableSendTimer);
            this.reliableSendTimer= null;
        }
        if (this.setupTimeout != null) {
            clearTimeout(this.setupTimeout);
            this.setupTimeout = null;
        }
        if (this.client != null) {
            wasmExports.OnConnectionClose(this.client);
            wasmExports.__unpin(this.client);
            this.client = null;
        }
        if (this.dc_unreliable != null) {
            this.dc_unreliable.close();
            this.dc_unreliable = null;
            //console.log(this.client_id_str + " we closed data channel (unreliable)");
        }
        if (this.dc_reliable != null) {
            this.dc_reliable.close();
            this.dc_reliable = null;
            //console.log(this.client_id_str + " we closed data channel (reliable)");
        }
        if (this.conn != null) {
            this.conn.close();
            this.conn = null;
            console.log(this.client_id_str + " we closed peer connection");
        }
        if (this.alive) {
            this.alive = false;
            webrtc_local_map.delete(this.local_id);
            webrtc_remote_map.delete(this.remote_id);
        }
    }

    OnOffer(offer) {
        this.conn.setRemoteDescription(offer.sdp, "offer");
    }
};


//------------------------------------------------------------------------------
// WebSocket

const wss = new WebSocket.Server({
    noServer: true,
    backlog: 1024,
    clientTracking: false,
    perMessageDeflate: false
}, () => {
    console.log("WebSocket Server listening");
});

wss.on('close', () => {
    console.log("WebSocket connection closed");
});

wss.on('connection', (ws, req, url) => {
    const ip = req.socket.remoteAddress;
    const remote_id = url;
    console.log("WebSocket connected to " + ip, ", id = '", remote_id, "'");

    if (ws_remote_map.has(remote_id)) {
        console.error("Ignoring second WebSocket connection using the same id");
        ws.close();
        return;
    }

    ws.alive = true;
    ws_remote_map.set(remote_id, ws);

    var heartbeat = () => {
        // Send ping
        ws.ping(() => {});

        // Wait for pong timeout
        ws.pongTimeout = setTimeout(() => {
            console.error("Client heartbeat timeout: id=", remote_id);
            ws.terminate();
        }, 25_000);
    };

    ws.on('pong', () => {
        //console.log("Client heartbeat");
        clearTimeout(ws.pingTimeout);
        clearTimeout(ws.pongTimeout);

        // Wait 10 seconds and ping again
        ws.pingTimeout = setTimeout(heartbeat, 10_000);
    });
    heartbeat();

    ws.on('message', (ev) => {
        try {
            let m = JSON.parse(ev);
            if (m.type == "offer" && m.offer != null) {
                //console.log("Got client offer");

                let client = null;
                try {
                    // If the client is sending a new offer, we should disconnect the old datachannel and recreate it,
                    // because it means from the client perspective the connection died.
                    client = webrtc_remote_map.get(remote_id);
                    if (client != null) {
                        console.log("Client is reconnecting: Closing old WebRTC session");
                        client.Close();
                    }

                    //console.log("Creating new WebRTC client");
                    client = new WebRTCClient(remote_id, ip);
                } catch (err) {
                    console.error("Assertion during creating WebRTC client");
                    ws.close();
                }

                if (client == null) {
                    console.error("Disconnecting client due to setup problem");
                    ws.close();
                } else {
                    client.OnOffer(m.offer);
                }
            }
        } catch (err) {
            console.error("Websocket message parse failed: err=", err);
        }
    });

    ws.on('error', () => {
        //console.log(`WebSocket Client error`);
    });

    ws.on('close', () => {
        //console.log(`WebSocket Client disconnected`);
        ws.alive = false;
        ws_remote_map.delete(remote_id);
    });
});

httpsServer.on('upgrade', function upgrade(request, socket, head) {
    const url = request.url;
    if (url && url.startsWith("/bb")) {
      wss.handleUpgrade(request, socket, head, function done(ws) {
        wss.emit('connection', ws, request, url);
      });
    } else {
      socket.destroy();
    }
});


//------------------------------------------------------------------------------
// AssemblyScript

const wasmImports = {
    netcode: {
        consoleLog: (m) => {
            // Make a copy because the memory may have moved by the next tick
            var copy = wasmExports.__getString(m);
            console.log(copy); // sync version
            //setTimeout(() => { console.log(copy); }, 50); // async version
        },
        getMilliseconds: () => {
            return performance.now();
        }
    },
    server: {
        sendReliable: (id, buffer) => {
            let client = webrtc_local_map.get(id);
            if (client == null) {
                console.error("sendBuffer: Invalid id");
                return;
            }
            if (client.dc_reliable == null) {
                console.error("sendBuffer: WebRTC reliable datachannel is null");
                return;
            }

            client.dc_reliable.sendMessageBinary(wasmExports.__getUint8ArrayView(buffer));
        },
        sendUnreliable: (id, buffer) => {
            let client = webrtc_local_map.get(id);
            if (client == null) {
                console.error("sendBuffer: Invalid id");
                return;
            }
            if (client.dc_unreliable == null) {
                console.error("sendBuffer: WebRTC unreliable datachannel is null");
                return;
            }

            client.dc_unreliable.sendMessageBinary(wasmExports.__getUint8ArrayView(buffer));
        },
        broadcastReliable: (exclude_id, buffer) => {
            var resultArray = wasmExports.__getUint8ArrayView(buffer);

            for (let client of webrtc_local_map.values()) {
                if (client == null) {
                    continue;
                }
                if (client.local_id == exclude_id) {
                    continue;
                }
                if (client.dc_reliable == null) {
                    continue;
                }
    
                client.dc_reliable.sendMessageBinary(resultArray);
            }
        },
        broadcastUnreliable: (exclude_id, buffer) => {
            var resultArray = wasmExports.__getUint8ArrayView(buffer);

            for (let client of webrtc_local_map.values()) {
                if (client == null) {
                    continue;
                }
                if (client.local_id == exclude_id) {
                    continue;
                }
                if (client.dc_unreliable == null) {
                    continue;
                }
    
                client.dc_unreliable.sendMessageBinary(resultArray);
            }
        }
    }
};

const memory = new WebAssembly.Memory({ initial: 10_000 });

var importObject = {
    ...wasmImports,
    env: {
        memory: memory
    }
};

wasmModule = loader.instantiateSync(fs.readFileSync(__dirname + "/server.wasm"), importObject);
wasmExports = wasmModule.exports;


//------------------------------------------------------------------------------
// Authoritative Physics Loop

function NextLoop() {
    wasmExports.OnTick(performance.now());

    setTimeout(NextLoop, 20_000);
}

NextLoop();
