

//------------------------------------------------------------------------------
// Objects

let Clients = new Map<i32, Player>();
let temp_clients: Array<Player>;

const npt_counts: Array<i32> = new Array<i32>(kMaxTeams);


//------------------------------------------------------------------------------
// Player

export class Player {
    // Identifier for javascript
    js_id: i32;

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

    constructor(js_id: i32) {
        this.js_id = js_id;
    }
};


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
// Tools

function ChooseNewPlayerTeam(): u8 {
    npt_counts.fill(0);

    let clients = Clients.values();
    for (let i: i32 = 0; i < clients.length; ++i) {
        const team: i32 = i32(clients[i].team);

        if (team >= 0 && team < Netcode.kMaxTeams) {
            npt_counts[team]++;
        }
    }

    let min_count: i32 = npt_counts[0];
    let best_team: u8 = 0;

    for (let i: i32 = 1; i < Netcode.kMaxTeams; ++i) {
        const count: i32 = npt_counts[i];

        if (count < min_count) {
            best_team = u8(i);
            min_count = count;
        }
    }

    return best_team;
}
