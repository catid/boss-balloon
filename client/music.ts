//------------------------------------------------------------------------------
// Music

let last_music_change: u64 = 0;
let active_music: string = "chill";
let next_music: string = "";
let next_music_ts: u64 = 0;

function UpdateMusic(t: u64, sx: f32, sy: f32): void {
    if (temp_self == null) {
        return;
    }

    // Do not change music faster than 10 seconds.
    const dt: i64 = i64(t - last_music_change);
    if (dt < 10_000 * 4) {
        return;
    }

    let enemy_near: bool = false;
    let highest_size: i32 = 0;

    const players_count = player_list.length;
    for (let i: i32 = 0; i < players_count; ++i) {
        const player = player_list[i];

        if (player.team == temp_self!.team) {
            continue;
        }

        // Wide radius around screen
        if (IsObjectOnScreen(player.temp_screen_x, player.temp_screen_y, 0.5)) {
            enemy_near = true;
            if (highest_size < i32(player.size)) {
                highest_size = i32(player.size);
            }
        }
    }

    let music: string = "chill";

    if (enemy_near) {
        const diff: i32 = i32(temp_self!.size) - highest_size;
        if (diff > 3) {
            music = "fight2";
        } else {
            music = "fight1";
        }
    }

    // Require new music to be consistent for at least 5 seconds before changing.
    if (next_music != music) {
        next_music_ts = t;
        next_music = music;
        return;
    }

    const next_dt: i64 = i64(t - next_music_ts);
    if (next_dt < 5_000 * 4) {
        return;
    }

    if (active_music != next_music) {
        active_music = next_music;
        last_music_change = t;
        playMusic(active_music);
        next_music = "";
    }
}
