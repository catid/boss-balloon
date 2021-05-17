import { Netcode } from "../common/netcode"
import { Physics } from "../common/physics"
import { jsConsoleLog, jsGetMilliseconds } from "../common/javascript"
import { jsSendUnreliable, jsSendReliable } from "./javascript"


//------------------------------------------------------------------------------
// Player

class ConnectedClient {
    // Identifier for javascript
    javascript_id: i32;

    // Identifier for network
    network_id: u8 = 0;

    name: string = "";
    score: u16 = 0;
    wins: u32 = 0;
    losses: u32 = 0;
    skin: u8 = 0;
    team: u8 = 0;

    Collider: Physics.PlayerCollider;
    TimeSync: Netcode.TimeSync = new Netcode.TimeSync();
    MessageCombiner: Netcode.MessageCombiner = new Netcode.MessageCombiner();

    constructor(javascript_id: i32) {
        this.javascript_id = javascript_id;
    }
};

const ClientList: Array<ConnectedClient> = new Array<ConnectedClient>(0);

function RemoveClient(client: ConnectedClient): void {
    const client_count: i32 = ClientList.length;
    for (let i: i32 = 0; i < client_count; ++i) {
        const client_i = ClientList[i];
        if (client_i != client) {
            const new_count = client_count - 1;
            ClientList[i] = ClientList[new_count];
            ClientList.length = new_count;
            return;
        }
    }
}


//------------------------------------------------------------------------------
// NetworkIdAssigner

class NetworkIdAssigner {
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

let IdAssigner: NetworkIdAssigner = new NetworkIdAssigner();


//------------------------------------------------------------------------------
// Tools

const npt_counts: Array<i32> = new Array<i32>(Physics.kNumTeams);

function ChooseNewPlayerTeam(): u8 {
    npt_counts.fill(0);

    const client_count: i32 = ClientList.length;
    for (let i: i32 = 0; i < client_count; ++i) {
        const team: i32 = i32(ClientList[i].team);

        if (team >= 0 && team < Physics.kNumTeams) {
            npt_counts[team]++;
        }
    }

    let min_count: i32 = npt_counts[0];
    let best_team: u8 = 0;

    for (let i: i32 = 1; i < Physics.kNumTeams; ++i) {
        const count: i32 = npt_counts[i];

        if (count < min_count) {
            best_team = u8(i);
            min_count = count;
        }
    }

    return best_team;
}


//------------------------------------------------------------------------------
// Network Events

export function OnConnectionOpen(javascript_id: i32): ConnectedClient | null {
    if (IdAssigner.IsFull()) {
        jsConsoleLog("Server full - Connection denied");
        return null;
    }

    const now_msec: f64 = jsGetMilliseconds();

    let client = new ConnectedClient(javascript_id);

    client.network_id = IdAssigner.Acquire();
    client.name = "Player " + client.network_id.toString();
    client.team = ChooseNewPlayerTeam();

    // Insert into client list
    ClientList.push(client);

    jsConsoleLog("Connection open javascript_id=" + client.javascript_id.toString()
        + " network_id=" + client.network_id.toString());

    SendTimeSync(client, now_msec);

    jsSendReliable(client.javascript_id, Netcode.MakeSetId(client.network_id));

    // Update all the remote player lists
    let new_player = Netcode.MakeSetPlayer(
        client.network_id, client.score, client.wins, client.losses,
        client.skin, client.team, client.name);

    if (new_player != null) {
        const client_count: i32 = ClientList.length;
        for (let i: i32 = 0; i < client_count; ++i) {
            let old = ClientList[i];
            old.MessageCombiner.Push(new_player);

            if (old.network_id != client.network_id) {
                let old_player = Netcode.MakeSetPlayer(
                    old.network_id, old.score, old.wins, old.losses,
                    old.skin, old.team, old.name);
                client.MessageCombiner.Push(old_player);
            }
        }
    }

    return client;
}

export function OnSendTimer(client: ConnectedClient): void {
    // Send all player position data.
    // It's possible to hit someone almost entirely across the map from anywhere.
    const client_count: i32 = ClientList.length;
    if (client_count > 0) {
        const max_clients_per_datagram: i32 = 55;
        const bytes_per_client: i32 = 20;

        let local_ts: u32 = u32(Physics.MasterTimestamp) & 0x7fffff;
        let datagram_count: i32 = (client_count + max_clients_per_datagram - 1) / max_clients_per_datagram;

        let j: i32 = 0;

        for (let i: i32 = 0; i < datagram_count; ++i) {
            const remaining: i32 = client_count - j;
            let actual_count: i32 = datagram_count;
            if (actual_count > remaining) {
                actual_count = remaining;
            }

            const buffer: Uint8Array = new Uint8Array(6 + bytes_per_client * actual_count);
            let ptr: usize = buffer.dataStart;

            store<u8>(ptr, Netcode.UnreliableType.ServerPosition, 0);
            Netcode.Store24(ptr, 1, local_ts);
            store<u8>(ptr, u8(client.Collider.size), 4);
            store<u8>(ptr, u8(actual_count), 5);

            let pptr: usize = ptr + 6;
            for (let k: i32 = 0; k < actual_count; ++k) {
                const client_j = ClientList[j];
                const physics_j = client.Collider;

                store<u8>(pptr, client_j.network_id, 0);
                store<u8>(pptr, physics_j.size, 1);
                store<u16>(pptr, Netcode.ConvertXto16(physics_j.x), 2);
                store<u16>(pptr, Netcode.ConvertXto16(physics_j.y), 4);
                store<i16>(pptr, Netcode.ConvertVXto16(physics_j.vx), 6);
                store<i16>(pptr, Netcode.ConvertVXto16(physics_j.vy), 8);
                store<u16>(pptr, Netcode.ConvertAccelto16(physics_j.ax, physics_j.ay), 10);
                store<u16>(pptr, Netcode.ConvertXto16(physics_j.last_shot_x), 12);
                store<u16>(pptr, Netcode.ConvertXto16(physics_j.last_shot_y), 14);
                store<i16>(pptr, Netcode.ConvertVXto16(physics_j.last_shot_vx), 16);
                store<i16>(pptr, Netcode.ConvertVXto16(physics_j.last_shot_vy), 18);

                pptr += bytes_per_client;
                ++j;
            }

            jsSendUnreliable(client.javascript_id, buffer);
        }
    }

    // Send queued reliable data:

    let buffer : Uint8Array | null = client.MessageCombiner.PopNextDatagram();
    if (buffer == null) {
        return;
    }

    jsSendReliable(client.javascript_id, buffer);
}

export function OnConnectionClose(client: ConnectedClient): void {
    jsConsoleLog("Connection close javascript_id=" + client.javascript_id.toString() + " network_id=" + client.network_id.toString());

    IdAssigner.Release(client.network_id);

    RemoveClient(client);

    let remove_msg = Netcode.MakeRemovePlayer(client.network_id);
    const client_count: i32 = ClientList.length;
    for (let i: i32 = 0; i < client_count; ++i) {
        ClientList[i].MessageCombiner.Push(remove_msg);
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
    let local_recv_ts: u64 = Physics.ConvertWallclock(recv_msec);

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

            client.TimeSync.OnPeerSync(local_recv_ts, remote_send_ts, min_trip_send_ts24_trunc, min_trip_recv_ts24_trunc, slope);

            //jsSendUnreliable(client.id, Netcode.MakeTimeSyncPong(remote_send_ts, client.TimeSync.LocalToPeerTime_ToTS23(t)));

            offset += 14;
        } else if (type == Netcode.UnreliableType.TimeSyncPong && remaining >= 7) {
            let ping_ts: u32 = Netcode.Load24(ptr, 1);
            let pong_ts: u32 = Netcode.Load24(ptr, 4);

            let ping: u64 = client.TimeSync.ExpandLocalTime_FromTS23(local_recv_ts, ping_ts);
            let pong: u64 = client.TimeSync.ExpandLocalTime_FromTS23(local_recv_ts, pong_ts);

            if (pong < ping || local_recv_ts + 1 < pong) {
                jsConsoleLog("*** TEST FAILED!");
                jsConsoleLog("Ping T = " + ping.toString());
                jsConsoleLog("Pong T = " + pong.toString());
                jsConsoleLog("Recv T = " + local_recv_ts.toString());
                client.TimeSync.DumpState();
            }

            offset += 7;
        } else if (type == Netcode.UnreliableType.ClientPosition && remaining >= 14) {
            const client_ts: u32 = Netcode.Load24(ptr, 1);
            const client_send_ts: u64 = client.TimeSync.PeerToLocalTime_FromTS23(client_ts);

            const c: Physics.PlayerCollider = client.Collider;

            c.x = Netcode.Convert16toX(load<u16>(ptr, 4));
            c.y = Netcode.Convert16toX(load<u16>(ptr, 6));
            c.vx = Netcode.Convert16toVX(load<i16>(ptr, 8));
            c.vy = Netcode.Convert16toVX(load<i16>(ptr, 10));
            const aa: u16 = load<u16>(ptr, 12);

            let ax: f32 = 0.0, ay: f32 = 0.0;
            if (aa != 0) {
                const angle: f32 = (aa - 1) * Netcode.inv_aa_factor;
                ax = Mathf.cos(angle);
                ay = Mathf.sin(angle);
            }

            const send_delay: i32 = i32(local_recv_ts - client_send_ts);

            Physics.IncorporateClientPosition(client.Collider, local_recv_ts, send_delay);

            offset += 14;
        } else {
            jsConsoleLog("Client sent invalid unreliable data");
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
                jsConsoleLog("Truncated chat");
                return;
            }

            // FIXME: Chat rate limiting, censorship

            let m: string = String.UTF8.decodeUnsafe(ptr + 3, m_len, false);

            let chat = Netcode.MakeChat(client.network_id, m);

            const client_count: i32 = ClientList.length;
            for (let i: i32 = 0; i < client_count; ++i) {
                ClientList[i].MessageCombiner.Push(chat);
            }

            offset += 4 + m_len;
        } else {
            jsConsoleLog("Client sent invalid reliable data");
            return;
        }
    }
}


//------------------------------------------------------------------------------
// Message Serializers

export function SendTimeSync(client: ConnectedClient, send_msec: f64): void {
    jsSendUnreliable(client.javascript_id, client.TimeSync.MakeTimeSync(Physics.ConvertWallclock(send_msec)));
}


//------------------------------------------------------------------------------
// Initialization

export function Initialize(t_msec: f64): void {
    Physics.Initialize(t_msec, (killee: Physics.PlayerCollider, killer: Physics.PlayerCollider) => {
        // FIXME
    });
}


//------------------------------------------------------------------------------
// Server Main Loop

export function OnTick(now_msec: f64): void {
    // Convert timestamp to integer with 1/4 msec (desired) precision
    let t: u64 = Physics.ConvertWallclock(now_msec);

    Physics.SimulateTo(t, t);

    // Collect GC after simulation tasks are done
    __collect();
}
