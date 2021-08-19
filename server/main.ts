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

    // Is the player dead and respawning?
    spawning: bool = true; // Initially spawning
    spawn_timer_start_ts: u64 = 0;

    // Counter for OnSendTimer() that reduces the data for players farther away
    position_subsample_counter: u8 = 0;
    send_position_info: bool = false;
    send_shot_info: bool = false;

    Collider: Physics.PlayerCollider;
    TimeSync: Netcode.TimeSync = new Netcode.TimeSync();
    MessageCombiner: Netcode.MessageCombiner = new Netcode.MessageCombiner();

    constructor(javascript_id: i32, team: u8) {
        this.javascript_id = javascript_id;
        this.Collider = Physics.CreatePlayerCollider(team);
    }
};

const ClientList: Array<ConnectedClient> = new Array<ConnectedClient>(0);

function RemoveClient(client: ConnectedClient): void {
    const client_count: i32 = ClientList.length;
    for (let i: i32 = 0; i < client_count; ++i) {
        const client_i = ClientList[i];
        if (client_i == client) {
            const new_count = client_count - 1;
            ClientList[i] = ClientList[new_count];
            ClientList.length = new_count;
            break;
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
        const team: i32 = i32(ClientList[i].Collider.team);

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

    const team: u8 = ChooseNewPlayerTeam();

    let client = new ConnectedClient(javascript_id, team);

    // Make sure they spawn right away
    client.spawning = true;
    client.spawn_timer_start_ts = Physics.MasterTimestamp - 10_000 * 4;

    client.network_id = IdAssigner.Acquire();
    client.name = "Player " + client.network_id.toString();

    // Insert into client list
    ClientList.push(client);

    jsConsoleLog("Connection open javascript_id=" + client.javascript_id.toString()
        + " network_id=" + client.network_id.toString());

    SendTimeSync(client, now_msec);

    jsSendReliable(client.javascript_id, Netcode.MakeSetId(client.network_id));

    // Update all the remote player lists
    let new_player = Netcode.MakeSetPlayer(
        client.network_id, client.score, client.wins, client.losses,
        client.skin, client.Collider.team, client.name);

    if (new_player != null) {
        const client_count: i32 = ClientList.length;
        for (let i: i32 = 0; i < client_count; ++i) {
            let old = ClientList[i];
            old.MessageCombiner.Push(new_player);

            if (old.network_id != client.network_id) {
                let old_player = Netcode.MakeSetPlayer(
                    old.network_id, old.score, old.wins, old.losses,
                    old.skin, old.Collider.team, old.name);
                client.MessageCombiner.Push(old_player);
            }
        }
    }

    return client;
}

/*
    In the worst case, players can approach distant bullets at 2.5 map units per millisecond,
    which ends up being 25_000 map units when bullets age out, and the map is 32_000 units in size.

    Player positions are different, since they change within a half second or so.
    And players can approach eachother at 2.0 map units per millisecond, which would be
    1_000 map units, which is the same as the screen radius.

    So, for the first implementation we need to send bullet positions to everyone on the map.
    And we can send players who are within two screen radii more often: 10 FPS or so.

    Useful improvements:
    (1) Only send bullet info if player position is not important. [DONE]
    (2) Send current and last bullet instead of sending the same info twice, to reduce packet send rate. [DONE]
    (3) Take velocities into account and avoid sending player positions or bullets that they will never see. [TODO]
*/
function SendPositionsTo(client: ConnectedClient, send_shots: bool): void {
    // Position of client we are sending to
    const x0: f32 = client.Collider.x, y0: f32 = client.Collider.y;

    // Larger scale = Client sees farther
    const scale: f32 = Physics.ScaleForSize(client.Collider.size) * Physics.kMapScreenWidth;

    // Distance past which we only send projectile info
    const pos_limit: f32 = scale * 2.0;
    const pos_limit2: f32 = pos_limit * pos_limit;

    let pos_count: i32 = 0, shot_count: i32 = 0;

    const total_clients: i32 = ClientList.length;
    for (let i: i32 = 0; i < total_clients; ++i) {
        let c = ClientList[i];

        c.send_position_info = false;
        c.send_shot_info = false;

        // Always send shot info if we can
        if (c.Collider.has_last_shot) {
            c.send_shot_info = true;
            ++shot_count;
        }

        // Do not send a player his own position, just his own shots
        if (c.network_id == client.network_id) {
            continue;
        }

        const dx = Physics.MapDiff(c.Collider.x, x0);
        const dy = Physics.MapDiff(c.Collider.y, y0);
        const mag2 = dx * dx + dy * dy;

        //jsConsoleLog("mag2 = " + mag2.toString() + " pos_limit2 = " + pos_limit2.toString() + " c.Collider.x=" + c.Collider.x.toString() + " x0=" + x0.toString() + " dx=" + dx.toString());

        if (mag2 < pos_limit2) {
            c.send_position_info = true;
            ++pos_count;
        }
    }

    const bytes_per_shot: i32 = 10;
    const bytes_per_position: i32 = 9;

    let physics_ts: u32 = u32(Physics.MasterTimestamp) & 0x7fffff;

    let player_index: i32 = 0;

    if (send_shots && shot_count > 0) {
        // Combine shots and positions in messages to reduce number of packets.
        // Send shots first because that information is more important.

        const max_shots_per_datagram = (Netcode.kMaxPacketBytes - 5) / bytes_per_shot;

        // While sending purely shot datagrams:

        while (shot_count >= max_shots_per_datagram) {
            let write_count: i32 = max_shots_per_datagram;

            const buffer: Uint8Array = new Uint8Array(5 + write_count * bytes_per_shot);
            let ptr: usize = buffer.dataStart;

            store<u8>(ptr, Netcode.UnreliableType.ServerShot, 0);
            Netcode.Store24(ptr, 1, physics_ts);
            store<u8>(ptr, u8(write_count), 4);
            ptr += 5;

            const player_count: i32 = ClientList.length;
            for (; player_index < player_count; ++player_index) {
                const client_i = ClientList[player_index];

                if (!client_i.send_shot_info) {
                    continue;
                }

                const physics_i = client_i.Collider;

                store<u8>(ptr, client_i.network_id, 0);
                store<u8>(ptr, physics_i.size, 1);
                store<u16>(ptr, Netcode.ConvertXto16(physics_i.last_shot_x), 2);
                store<u16>(ptr, Netcode.ConvertXto16(physics_i.last_shot_y), 4);
                store<i16>(ptr, Netcode.ConvertVXto16(physics_i.last_shot_vx), 6);
                store<i16>(ptr, Netcode.ConvertVXto16(physics_i.last_shot_vy), 8);

                ptr += bytes_per_shot;

                --shot_count;
                if (--write_count <= 0) {
                    break;
                }
            }

            jsSendUnreliable(client.javascript_id, buffer);
        }

        // Overlap packet that has some of each:
        if (shot_count > 0)
        {
            let combined_buffer_size: i32 = 5 + shot_count * bytes_per_shot;
            let pos_write_count: i32 = (Netcode.kMaxPacketBytes - combined_buffer_size - 5) / bytes_per_position;
            if (pos_write_count > pos_count) {
                pos_write_count = pos_count;
            }
            if (pos_write_count > 0) {
                combined_buffer_size += 5 + pos_write_count * bytes_per_position;
            }

            const buffer: Uint8Array = new Uint8Array(combined_buffer_size);
            let ptr: usize = buffer.dataStart;

            // Shots first
            store<u8>(ptr, Netcode.UnreliableType.ServerShot, 0);
            Netcode.Store24(ptr, 1, physics_ts);
            store<u8>(ptr, u8(shot_count), 4);
            ptr += 5;

            const player_count: i32 = ClientList.length;
            for (; player_index < player_count; ++player_index) {
                const client_i = ClientList[player_index];

                if (!client_i.send_shot_info) {
                    continue;
                }

                const physics_i = client_i.Collider;

                store<u8>(ptr, client_i.network_id, 0);
                store<u8>(ptr, physics_i.size, 1);
                store<u16>(ptr, Netcode.ConvertXto16(physics_i.last_shot_x), 2);
                store<u16>(ptr, Netcode.ConvertXto16(physics_i.last_shot_y), 4);
                store<i16>(ptr, Netcode.ConvertVXto16(physics_i.last_shot_vx), 6);
                store<i16>(ptr, Netcode.ConvertVXto16(physics_i.last_shot_vy), 8);

                ptr += bytes_per_shot;

                if (--shot_count <= 0) {
                    break;
                }
            }

            // Restart player list
            player_index = 0;

            if (pos_write_count > 0) {
                // Positions second
                store<u8>(ptr, Netcode.UnreliableType.ServerPosition, 0);
                Netcode.Store24(ptr, 1, physics_ts);
                store<u8>(ptr, u8(pos_write_count), 4);
                ptr += 5;

                for (; player_index < player_count; ++player_index) {
                    const client_i = ClientList[player_index];

                    if (!client_i.send_position_info) {
                        continue;
                    }

                    const physics_i = client_i.Collider;

                    store<u8>(ptr, client_i.network_id, 0);
                    store<u16>(ptr, Netcode.ConvertXto16(physics_i.x), 1);
                    store<u16>(ptr, Netcode.ConvertXto16(physics_i.y), 3);
                    store<i8>(ptr, Netcode.ConvertVXto8(physics_i.vx), 5);
                    store<i8>(ptr, Netcode.ConvertVXto8(physics_i.vy), 6);
                    store<u16>(ptr, Netcode.ConvertAccelto16(physics_i.ax, physics_i.ay), 7);

                    ptr += bytes_per_position;

                    --pos_count;
                    if (--pos_write_count <= 0) {
                        break;
                    }
                }
            }

            jsSendUnreliable(client.javascript_id, buffer);
        } else {
            player_index = 0;
        }
    }

    if (pos_count <= 0) {
        return;
    }

    // Send player positions:

    const pos_bytes = 5 + pos_count * bytes_per_position;
    const max_pos_per_datagram = (Netcode.kMaxPacketBytes - 5) / bytes_per_position;

    while (pos_count > 0) {
        let write_count: i32 = pos_count;
        if (write_count > max_pos_per_datagram) {
            write_count = max_pos_per_datagram;
        }

        // Break the player list up into separate packets

        const buffer: Uint8Array = new Uint8Array(5 + write_count * bytes_per_position);
        let ptr: usize = buffer.dataStart;

        store<u8>(ptr, Netcode.UnreliableType.ServerPosition, 0);
        Netcode.Store24(ptr, 1, physics_ts);
        store<u8>(ptr, u8(write_count), 4);
        ptr += 5;

        const player_count: i32 = ClientList.length;
        for (; player_index < player_count; ++player_index) {
            const client_i = ClientList[player_index];

            if (!client_i.send_position_info) {
                continue;
            }

            const physics_i = client_i.Collider;

            store<u8>(ptr, client_i.network_id, 0);
            store<u16>(ptr, Netcode.ConvertXto16(physics_i.x), 1);
            store<u16>(ptr, Netcode.ConvertXto16(physics_i.y), 3);
            store<i8>(ptr, Netcode.ConvertVXto8(physics_i.vx), 5);
            store<i8>(ptr, Netcode.ConvertVXto8(physics_i.vy), 6);
            store<u16>(ptr, Netcode.ConvertAccelto16(physics_i.ax, physics_i.ay), 7);

            ptr += bytes_per_position;

            --pos_count;
            if (--write_count <= 0) {
                break;
            }
        }

        jsSendUnreliable(client.javascript_id, buffer);
    }
}

// Called at 12 Hz
export function OnSendTimer(client: ConnectedClient): void {
    // Every 4 calls:
    let send_shots: bool = false;
    if (++client.position_subsample_counter >= 4) {
        send_shots = true;
        client.position_subsample_counter = 0;
    }

    SendPositionsTo(client, send_shots);

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

    Physics.RemovePlayerCollider(client.Collider);

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

export const UINT8ARRAY_ID = idof<Uint8Array>();

export function Initialize(t_msec: f64): void {
    Physics.Initialize(true, t_msec, (killee: Physics.PlayerCollider, killer: Physics.PlayerCollider) => {
        jsConsoleLog("Player hit!");
    });
}


//------------------------------------------------------------------------------
// Server Main Loop

export function OnTick(now_msec: f64): void {
    // Convert timestamp to integer with 1/4 msec (desired) precision
    let t: u64 = Physics.ConvertWallclock(now_msec);

    Physics.SimulateTo(t, t);

    // Spawn clients
    const count: i32 = ClientList.length;
    for (let i: i32 = 0; i < count; ++i) {
        const client = ClientList[i];
        if (client.spawning) {
            const dt: i32 = i32(t - client.spawn_timer_start_ts);
            // 8 seconds between spawns
            if (dt > 8_000 * 4) {
                client.spawning = false;
                Physics.SetRandomSpawnPosition(client.Collider);
            }
        }
    }
}
