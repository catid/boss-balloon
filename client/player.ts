import { Physics } from "../common/physics"
import { FiracodeFont } from "./render/render"


//------------------------------------------------------------------------------
// Objects

let TimeSync: Netcode.TimeSync = new Netcode.TimeSync();
let MessageCombiner: Netcode.MessageCombiner = new Netcode.MessageCombiner();

let SelfId: i32 = -1;

let player_map = new Map<u8, Player>();
let player_list: Player[]; // temp
let temp_self: Player | null;


//------------------------------------------------------------------------------
// Player

class Player {
    network_id: u8 = 0;
    score: u16 = 0;
    wins: u32 = 0;
    losses: u32 = 0;
    skin: u8 = 0;
    team: u8 = 0;
    name: string = "";

    is_self: bool = false;

    size: u8 = 0;

    temp_screen_x: f32 = 0;
    temp_screen_y: f32 = 0;
    on_screen: bool = false;

    Collider: Physics.Player;

    constructor() {
    }

    SetName(name: string): void {
        this.name = name;
        this.Collider.render_name_data = FiracodeFont.GenerateLine(name);
    }
};
