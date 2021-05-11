export function OnConnectionOpen(id: i32): ConnectedClient | null {
    if (IdAssigner.IsFull()) {
        jsConsoleLog("Server full - Connection denied");
        return null;
    }

    const now_msec: f64 = jsGetMilliseconds();

    let client = new ConnectedClient(id);
    jsConsoleLog("Connection open id=" + client.id.toString());

    client.player_id = IdAssigner.Acquire();
    client.name = "Player " + client.player_id.toString();
    client.score = 100;
    client.team = ChooseNewPlayerTeam();

    SendTimeSync(client, now_msec);

    jsSendReliable(client.id, Netcode.MakeSetId(client.player_id));

    Clients.set(id, client);

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

    return client;
}

export function OnSendTimer(client: ConnectedClient): void {
    // Send all player position data.
    // It's possible to hit someone almost entirely across the map from anywhere.
    const client_count: i32 = temp_clients.length;
    if (client_count > 0) {
        const max_clients_per_datagram: i32 = 57;
        const bytes_per_client: i32 = 19;

        let local_ts: u32 = u32(physics_t) & 0x7fffff;
        let datagram_count: i32 = (client_count + max_clients_per_datagram - 1) / max_clients_per_datagram;

        let j: i32 = 0;

        for (let i: i32 = 0; i < datagram_count; ++i) {
            const remaining: i32 = client_count - j;
            let actual_count: i32 = datagram_count;
            if (actual_count > remaining) {
                actual_count = remaining;
            }

            const buffer: Uint8Array = new Uint8Array(5 + bytes_per_client * actual_count);
            let ptr: usize = buffer.dataStart;

            store<u8>(ptr, Netcode.UnreliableType.ServerPosition, 0);
            Netcode.Store24(ptr, 1, local_ts);
            store<u8>(ptr, u8(actual_count), 4);

            let pptr: usize = ptr + 5;
            for (let k: i32 = 0; k < actual_count; ++k) {
                const client_j = temp_clients[j];

                store<u8>(pptr, client_j.player_id, 0);
                store<u16>(pptr, Netcode.ConvertXto16(client_j.x), 1);
                store<u16>(pptr, Netcode.ConvertXto16(client_j.y), 3);
                store<i16>(pptr, Netcode.ConvertVXto16(client_j.vx), 5);
                store<i16>(pptr, Netcode.ConvertVXto16(client_j.vy), 7);
                store<u16>(pptr, Netcode.ConvertAccelto16(client_j.ax, client_j.ay), 9);
                store<u16>(pptr, Netcode.ConvertXto16(client_j.last_shot_x), 11);
                store<u16>(pptr, Netcode.ConvertXto16(client_j.last_shot_y), 13);
                store<i16>(pptr, Netcode.ConvertVXto16(client_j.last_shot_vx), 15);
                store<i16>(pptr, Netcode.ConvertVXto16(client_j.last_shot_vy), 17);

                pptr += bytes_per_client;
                ++j;
            }

            jsSendUnreliable(client.id, buffer);
        }
    }

    // Send queued reliable data:

    let buffer : Uint8Array | null = client.MessageCombiner.PopNextDatagram();
    if (buffer == null) {
        return;
    }

    jsSendReliable(client.id, buffer);
}

export function OnConnectionClose(client: ConnectedClient): void {
    jsConsoleLog("Connection close id=" + client.id.toString());

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
    let t: u64 = TimeConverter.MsecToTime(recv_msec);

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

            //jsSendUnreliable(client.id, Netcode.MakeTimeSyncPong(remote_send_ts, client.TimeSync.LocalToPeerTime_ToTS23(t)));

            offset += 14;
        } else if (type == Netcode.UnreliableType.TimeSyncPong && remaining >= 7) {
            let ping_ts: u32 = Netcode.Load24(ptr, 1);
            let pong_ts: u32 = Netcode.Load24(ptr, 4);

            let ping: u64 = client.TimeSync.ExpandLocalTime_FromTS23(t, ping_ts);
            let pong: u64 = client.TimeSync.ExpandLocalTime_FromTS23(t, pong_ts);

            if (pong < ping || t + 1 < pong) {
                jsConsoleLog("*** TEST FAILED!");
                jsConsoleLog("Ping T = " + ping.toString());
                jsConsoleLog("Pong T = " + pong.toString());
                jsConsoleLog("Recv T = " + t.toString());
                client.TimeSync.DumpState();
            }

            offset += 7;
        } else if (type == Netcode.UnreliableType.ClientPosition && remaining >= 14) {
            let peer_ts: u32 = Netcode.Load24(ptr, 1);

            // FIXME: Reject new positions too far from our estimate

            const x: u16 = load<u16>(ptr, 4);
            const y: u16 = load<u16>(ptr, 6);
            const vx: i16 = load<i16>(ptr, 8);
            const vy: i16 = load<i16>(ptr, 10);
            const aa: u16 = load<u16>(ptr, 12);

            let local_ts: u64 = client.TimeSync.PeerToLocalTime_FromTS23(peer_ts);

            // Simulate player forward to current time
            let dt: i32 = i32(t - local_ts);
            if (dt < 0) {
                dt = 0;
            } else if (dt > 4000) {
                dt = 4000; // 1 second latency limit
            }
            let fix_t: i32 = i32(t - dt);

            let ax: f32 = 0.0, ay: f32 = 0.0;
            if (aa != 0) {
                const angle: f32 = (aa - 1) * Netcode.inv_aa_factor;
                ax = Mathf.cos(angle);
                ay = Mathf.sin(angle);
            }

            // If the player timestamp is after our last physics iteration:
            let physics_dt: i32 = i32(physics_t - fix_t);
            if (physics_dt > 0) {
                client.simulation_behind = false;
                client.x = Netcode.Convert16toX(x);
                client.y = Netcode.Convert16toX(y);
                client.vx = Netcode.Convert16toVX(vx);
                client.vy = Netcode.Convert16toVX(vy);
                client.ax = ax;
                client.ay = ay;

                // Roll up player position to current time
                SimulateOnePlayer(client, physics_dt);
            } else {
                // Player is ahead of our simulation.
                // We should continue running our simulation until their timestep elapses,
                // and then switch to their state.

                client.simulation_behind = true;
                client.peer_t = fix_t;
                client.peer_x = Netcode.Convert16toX(x);
                client.peer_y = Netcode.Convert16toX(y);
                client.peer_vx = Netcode.Convert16toVX(vx);
                client.peer_vy = Netcode.Convert16toVX(vy);
                client.peer_ax = ax;
                client.peer_ay = ay;
            }

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

            let chat = Netcode.MakeChat(client.player_id, m);

            let clients = Clients.values();
            for (let i: i32 = 0; i < clients.length; ++i) {
                clients[i].MessageCombiner.Push(chat);
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
    jsSendUnreliable(client.id, client.TimeSync.MakeTimeSync(TimeConverter.MsecToTime(send_msec)));
}
