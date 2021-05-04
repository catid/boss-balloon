//------------------------------------------------------------------------------
// Imports

import { Netcode, consoleLog, getMilliseconds } from "../netcode/netcode";

declare function sendReliable(id: i32, buffer: Uint8Array): void
declare function sendUnreliable(id: i32, buffer: Uint8Array): void
declare function broadcastReliable(exclude_id: i32, buffer: Uint8Array): void
declare function broadcastUnreliable(exclude_id: i32, buffer: Uint8Array): void

export const UINT8ARRAY_ID = idof<Uint8Array>();

let Clients = new Map<i32, ConnectedClient>();


//------------------------------------------------------------------------------
// PlayerIdAssigner

class PlayerIdAssigner {
    Available: Array<u8> = new Array<u8>(256);

    constructor() {
        for (let i: i32 = 0; i < 256; ++i) {
            this.Available[i] = u8(i);
        }
    }

    IsFull(): bool {
        return this.Available.length <= 0;
    }

    Acquire(): u8 {
        return this.Available.shift();
    }

    Release(id: u8): void {
        this.Available.push(id);
    }
}

let IdAssigner: PlayerIdAssigner = new PlayerIdAssigner();


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

    name: string = "";
    score: u16 = 0;
    wins: u32 = 0;
    losses: u32 = 0;
    skin: u8 = 0;
    team: u8 = 0;

    TimeSync: Netcode.TimeSync = new Netcode.TimeSync();
    MessageCombiner: Netcode.MessageCombiner = new Netcode.MessageCombiner();
    TimeConverter: Netcode.TimeConverter;

    constructor(id: i32, netcode_start_msec: f64) {
        this.id = id;
        this.TimeConverter = new Netcode.TimeConverter(netcode_start_msec);
    }
};

export function OnConnectionOpen(id: i32): ConnectedClient | null {
    if (IdAssigner.IsFull()) {
        consoleLog("Server full - Connection denied");
        return null;
    }

    const now_msec: f64 = getMilliseconds();

    let client = new ConnectedClient(id, now_msec);
    consoleLog("Connection open id=" + client.id.toString());

    client.player_id = IdAssigner.Acquire();
    client.name = "Player " + client.player_id.toString();
    client.score = 100;

    SendTimeSync(client, now_msec);

    sendReliable(client.id, Netcode.MakeSetId(client.player_id));

    // Update all the player lists
    let new_player = Netcode.MakeSetPlayer(client.player_id, client.score, client.wins, client.losses, client.skin, client.team, client.name);
    if (new_player != null) {
        let clients = Clients.values();
        for (let i: i32 = 0; i < clients.length; ++i) {
            let old = clients[i];
            old.MessageCombiner.Push(new_player);

            if (old.id != client.id) {
                let old_player = Netcode.MakeSetPlayer(old.player_id, old.score, old.wins, old.losses, old.skin, old.team, old.name);
                client.MessageCombiner.Push(old_player);
            }
        }
    }

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

    IdAssigner.Release(client.player_id);

    Clients.delete(client.id);

    let remove_msg = Netcode.MakeRemovePlayer(client.player_id);
    let clients = Clients.values();
    for (let i: i32 = 0; i < clients.length; ++i) {
        clients[i].MessageCombiner.Push(remove_msg);
    }
}


//------------------------------------------------------------------------------
// Message Deserializers

export function OnUnreliableData(client: ConnectedClient, recv_msec: f64, buffer: Uint8Array): void {
    if (buffer.length < 1) {
        // Ignore short messages
        return;
    }

    // Convert timestamp to integer with 1/4 msec (desired) precision
    let t: u64 = client.TimeConverter.MsecToTime(recv_msec);

    let offset: i32 = 0;
    while (offset < buffer.length) {
        let ptr: usize = buffer.dataStart + offset;
        const remaining: i32 = buffer.length - offset;
        const type: u8 = load<u8>(ptr, 0);

        if (type == Netcode.UnreliableType.TimeSync && remaining >= 14) {
            let remote_send_ts: u32 = Netcode.Load24(ptr, 1);
            let min_trip_send_ts24_trunc: u32 = Netcode.Load24(ptr, 4);
            let min_trip_recv_ts24_trunc: u32 = Netcode.Load24(ptr, 7);
            let slope: f32 = load<f32>(ptr, 10);

            client.TimeSync.OnPeerSync(t, remote_send_ts, min_trip_send_ts24_trunc, min_trip_recv_ts24_trunc, slope);

            sendUnreliable(client.id, Netcode.MakeTimeSyncPong(remote_send_ts, client.TimeSync.LocalToPeerTime_ToTS23(t)));

            offset += 14;
        } else if (type == Netcode.UnreliableType.TimeSyncPong && remaining >= 7) {
            let ping_ts: u32 = Netcode.Load24(ptr, 1);
            let pong_ts: u32 = Netcode.Load24(ptr, 4);

            let ping: u64 = client.TimeSync.ExpandLocalTime_FromTS23(t, ping_ts);
            let pong: u64 = client.TimeSync.ExpandLocalTime_FromTS23(t, pong_ts);

            if (pong < ping || t < pong) {
                consoleLog("*** TEST FAILED!");
                consoleLog("Ping T = " + ping.toString());
                consoleLog("Pong T = " + pong.toString());
                consoleLog("Recv T = " + t.toString());
                client.TimeSync.DumpState();
            }

            offset += 7;
        } else if (type == Netcode.UnreliableType.ClientPosition && remaining >= 6) {
            let peer_ts: u32 = Netcode.Load24(ptr, 1);

            client.TimeSync.OnTimeSample(t, peer_ts);
            t = client.TimeSync.PeerToLocalTime_FromTS23(peer_ts);

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

export function SendTimeSync(client: ConnectedClient): void {
    client.TimeSync.Update();

    const send_msec = getMilliseconds();
    sendUnreliable(client.id, client.TimeSync.MakeTimeSync(client.TimeConverter.MsecToTime(send_msec)));
}
