//------------------------------------------------------------------------------
// Imports

import { Netcode } from "../netcode/netcode";

declare function consoleLog(message: string): void
declare function sendReliable(id: i32, buffer: Uint8Array): void
declare function sendUnreliable(id: i32, buffer: Uint8Array): void
declare function broadcastReliable(exclude_id: i32, buffer: Uint8Array): void
declare function broadcastUnreliable(exclude_id: i32, buffer: Uint8Array): void

export const UINT8ARRAY_ID = idof<Uint8Array>();

let Clients = new Map<i32, ConnectedClient>();


//------------------------------------------------------------------------------
// Authoritative Physics Loop

let last_msec : f64 = 0;

export function OnTick(now_msec: f64): void {
    let dt : f64 = now_msec - last_msec;
    if (dt > 5000) {
        dt = 0;
    }
    last_msec = now_msec;

    // Collect GC after simulation tasks are done
    __collect();
}


//------------------------------------------------------------------------------
// Connection

export class ConnectedClient {
    id: i32;
    // For netcode we use timestamps relative to the connection open time, because
    // we waste fewer mantissa bits on useless huge values.
    netcode_start_msec: f64 = 0;

    constructor(id: i32, netcode_start_msec: f64) {
        this.id = id;
        this.netcode_start_msec = netcode_start_msec;
    }
};

export function OnConnectionOpen(id: i32, now_msec: f64): ConnectedClient | null {
    let client = new ConnectedClient(id, now_msec);
    consoleLog("Connection open id=" + client.id.toString());

    const data = new Uint8Array(10);
    for (let i: i32 = 0; i < 10; ++i) {
        data[i] = i as u8;
    }

    sendReliable(id, data);

    Clients.set(id, client);

    return client;
}

export function OnConnectionClose(client: ConnectedClient): void {
    consoleLog("Connection close id=" + client.id.toString());

    Clients.delete(client.id);
}

export function OnUnreliableData(client: ConnectedClient, recv_msec: f64, buffer: Uint8Array): void {
    if (buffer.length < 2) {
        // Ignore short messages
        return;
    }

    const type: u8 = buffer[0];
    if (type == Netcode.Type.TimeSync) {
        // Convert timestamp to integer with 0.1 msec (desired) precision
        let t: i64 = (recv_msec - client.netcode_start_msec * 10.0) as i64;

    }
    else if (type == Netcode.Type.Position) {

    }
}

export function OnReliableData(client: ConnectedClient, buffer: Uint8Array): void {
    consoleLog("Reliable data: len=" + buffer.length.toString() + " id=" + client.id.toString());
}
