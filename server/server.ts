//------------------------------------------------------------------------------
// Imports

declare function consoleLog(message: string): void
declare function sendBuffer(id: i32, buffer: Uint8Array): void
declare function broadcastBuffer(exclude_id: i32, buffer: Uint8Array): void

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

    constructor(id: i32) {
        this.id = id;
    }
};

export function OnConnectionOpen(id: i32): ConnectedClient | null {
    let client = new ConnectedClient(id);
    consoleLog("Connection open id=" + client.id.toString());

    const data = new Uint8Array(10);
    for (let i: i32 = 0; i < 10; ++i) {
        data[i] = i as u8;
    }

    sendBuffer(id, data);

    Clients.set(id, client);

    return client;
}

export function OnConnectionClose(client: ConnectedClient): void {
    consoleLog("Connection close id=" + client.id.toString());

    Clients.delete(client.id);
}

export function OnConnectionData(client: ConnectedClient, buffer: Uint8Array): void {
    consoleLog("Connection data: len=" + buffer.length.toString() + " id=" + client.id.toString());
}
