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

    player_id: u8 = 0;

    TimeSync: Netcode.TimeSync = new Netcode.TimeSync();

    MessageCombiner: Netcode.MessageCombiner = new Netcode.MessageCombiner();

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

export function OnReliableSendTimer(client: ConnectedClient): void {
    let buffer : Uint8Array | null = client.MessageCombiner.PopNextDatagram();
    if (buffer == null) {
        return;
    }

    sendReliable(client.id, buffer);
}

export function OnConnectionClose(client: ConnectedClient): void {
    consoleLog("Connection close id=" + client.id.toString());

    Clients.delete(client.id);
}


//------------------------------------------------------------------------------
// Message Deserializers

export function OnUnreliableData(client: ConnectedClient, recv_msec: f64, buffer: Uint8Array): void {
    if (buffer.length < 1) {
        // Ignore short messages
        return;
    }

    // Convert timestamp to integer with 1/4 msec (desired) precision
    let t: u64 = Netcode.MsecToTime(recv_msec);

    let offset: i32 = 0;
    while (offset < buffer.length) {
        let ptr: usize = buffer.dataStart + offset;
        const remaining: i32 = buffer.length - offset;
        const type: u8 = load<u8>(ptr, 0);

        if (type == Netcode.UnreliableType.TimeSync && remaining >= 7) {
            let peer_ts: u32 = Netcode.Load24(ptr, 1);

            let min_delta: u32 = Netcode.Load24(ptr, 4);

            client.TimeSync.OnTimeSample(t, peer_ts);
            client.TimeSync.OnTimeMinDelta(t, min_delta);

            offset += 7;
        } else if (type == Netcode.UnreliableType.ClientPosition && remaining >= 6) {
            let peer_ts: u32 = Netcode.Load24(ptr, 1);

            client.TimeSync.OnTimeSample(t, peer_ts);
            t = client.TimeSync.PeerToLocalTime_TS23(t, peer_ts);

            const x: u16 = load<u16>(ptr, 4);
            const y: u16 = load<u16>(ptr, 6);

            offset += 8;
        } else {
            consoleLog("Client sent invalid unreliable data");
            return;
        }
    }
}

export function OnReliableData(client: ConnectedClient, buffer: Uint8Array): void {
    if (buffer.length < 1) {
        // Ignore short messages
        return;
    }

    let offset: i32 = 0;
    while (offset < buffer.length) {
        let ptr = buffer.dataStart + offset;
        const remaining: i32 = buffer.length - offset;
        const type: u8 = load<u8>(ptr, 0);

        if (type == Netcode.ReliableType.ChatRequest && remaining >= 4) {
            let m_len: u16 = load<u16>(ptr, 1);

            if (3 + m_len > remaining) {
                consoleLog("Truncated chat");
                return;
            }

            // FIXME: Chat rate limiting, censorship

            let m: string = String.UTF8.decodeUnsafe(ptr + 3, m_len, false);

            let chat = Netcode.MakeChat(client.player_id, m);

            let clients = Clients.values();
            for (let i: i32 = 0; i < clients.length; ++i) {
                clients[i].MessageCombiner.Push(chat);
            }

            offset += 4 + m_len;
        } else {
            consoleLog("Client sent invalid reliable data");
            return;
        }
    }
}


//------------------------------------------------------------------------------
// Message Serializers

export function SendTimeSync(client: ConnectedClient, send_msec: f64): void {
    sendUnreliable(client.id, client.TimeSync.MakeTimeSync(send_msec));
}
