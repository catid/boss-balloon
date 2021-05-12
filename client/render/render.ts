import { RenderContext } from "./render_context"
import { RenderTextData, RenderTextProgram, RenderTextHorizontal, RenderTextVertical } from "./render_text"
import { RenderPlayerProgram, RenderPlayerData } from "./render_player"
import { RenderStringProgram } from "./render_string"
import { RenderBombProgram } from "./render_bomb"
import { RenderBulletProgram } from "./render_bullet"
import { RenderMapProgram } from "./render_map"
import { RenderArrowProgram } from "./render_arrow"
import { RenderSunProgram } from "./render_sun"
import { RenderColor } from "./render_common"
import { Physics } from "../../common/physics"


//------------------------------------------------------------------------------
// Constants

const kTeamColors = [
    new RenderColor(0.8, 0.4, 0.2), // red
    new RenderColor(0.2, 1.0, 0.2), // green
    new RenderColor(0.2, 0.4, 0.8), // blue
    new RenderColor(0.8, 0.3, 0.8), // purple
    new RenderColor(0.8, 0.8, 0.5)  // pink
];

const kTeamTextColors = [
    new RenderColor(1.0, 0.4, 0.2), // red
    new RenderColor(0.6, 1.0, 0.6), // green
    new RenderColor(0.2, 0.4, 1.0), // blue
    new RenderColor(1.0, 0.3, 1.0), // purple
    new RenderColor(1.0, 1.0, 0.5)  // pink
];

const kTextStrokeColor = new RenderColor(0.0, 0.0, 0.0);

const kStringColor = new RenderColor(1.0, 1.0, 1.0);


//------------------------------------------------------------------------------
// Programs

export let FontProgram: RenderTextProgram;
export let PlayerProgram: RenderPlayerProgram;
export let StringProgram: RenderStringProgram;
export let BombProgram: RenderBombProgram;
export let BulletProgram: RenderBulletProgram;
export let MapProgram: RenderMapProgram;
export let ArrowProgram: RenderArrowProgram;
export let SunProgram: RenderSunProgram;


//------------------------------------------------------------------------------
// Tools

function clamp(x: f32, maxval: f32, minval: f32): f32 {
    return max(maxval, min(minval, x));
}


//------------------------------------------------------------------------------
// Render

function RenderPlayers(t: u64): void {
    Physics.ForEachPlayerOnScreen((p: Physics.Player, sx: f32, sy: f32) => void {
        let sun_x: f32 = p.x;
        if (sun_x > Physics.kMapWidth * 0.5) {
            sun_x -= Physics.kMapWidth;
        }
        let sun_y: f32 = p.y;
        if (sun_y > Physics.kMapWidth * 0.5) {
            sun_y -= Physics.kMapWidth;
        }
        const shine_angle: f32 = Mathf.atan2(sun_y, sun_x);
        const shine_max: f32 = 10000.0;
        const shine_dist: f32 = clamp(1.0 - (sun_x * sun_x + sun_y * sun_y) / (shine_max * shine_max), 0.5, 1.0);

        PlayerProgram.DrawPlayer(
            kTeamColors[p.team],
            sx, sy, p.r, shine_angle, shine_dist, t);

        StringProgram.DrawString(kTeamColors[p.team], sx, sy, sx + p.vx * 0.1, sy + p.vy * 0.1, t);

        if (p.render_name_data != null) {
            FontProgram.BeginRender();
            FontProgram.SetColor(kTeamTextColors[player.team],  kTextStrokeColor);

            FontProgram.Render(
                RenderTextHorizontal.Center, RenderTextVertical.Center,
                sx, sy + 0.06,
                0.32/p.render_name_data!.width, p.render_name_data!);
        }
    });
}

function RenderProjectiles(t: u64): void {
    let last_was_bullet = false;
    let last_was_bomb = false;

    Physics.ForEachProjectileOnScreen((p: Physics.Projectile, sx: f32, sy: f32) => void {
        if (p.is_bomb) {
            last_was_bullet = false;
            if (!last_was_bomb) {
                last_was_bomb = true;
                BombProgram.BeginBombs(t, 0.1);
            }
            BombProgram.DrawBomb(kTeamColors[p.team], sx, sy, p.angle0 + angle);
        } else {
            last_was_bomb = false;
            if (!last_was_bullet) {
                last_was_bullet = true;
                BulletProgram.BeginBullets(t, 0.1);
            }
            BulletProgram.DrawBullet(kTeamColors[p.team], sx, sy, p.angle0 + angle);
        }
    });
}

function RenderArrows(t: u64): void {
    const players_count = player_list.length;

    if (players_count == 0) {
        return;
    }

    for (let i: i32 = 0; i < players_count; ++i) {
        const p = player_list[i];

        if (p.on_screen || p.is_self || p.Collider.is_ghost) {
            continue;
        }

        let x: f32 = Physics.MapToScreenX(p.Collider.x);
        let y: f32 = Physics.MapToScreenY(p.Collider.y);
        const dist: f32 = Mathf.sqrt(x * x + y * y);
        const scale_min: f32 = 0.01;
        const scale_max: f32 = 0.04;
        const scale: f32 = scale_min + clamp(scale_max - dist * 0.004, 0.0, scale_max - scale_min);

        const angle: f32 = Mathf.atan2(y, x);

        if (x > y) {
            if (x > -y) {
                // right
                x = 1.0;
                y = Mathf.tan(angle);
            } else {
                // top
                x = Mathf.tan(angle - Mathf.PI * 0.5);
                y = -1.0;
            }
        } else {
            if (x > -y) {
                // bottom
                x = -Mathf.tan(angle + Mathf.PI * 0.5);
                y = 1.0;
            } else {
                // left
                x = -1.0;
                y = -Mathf.tan(angle);
            }
        }

        const edge_limit: f32 = 0.04;
        if (x < -1.0 + edge_limit) {
            x = -1.0 + edge_limit;
        } else if (x > 1.0 - edge_limit) {
            x = 1.0 - edge_limit;
        }
        if (y < -1.0 + edge_limit) {
            y = -1.0 + edge_limit;
        } else if (y > 1.0 - edge_limit) {
            y = 1.0 - edge_limit;
        }

        ArrowProgram.DrawArrow(
            kTeamColors[p.team],
            x, y, scale, angle, t);
    }
}


//------------------------------------------------------------------------------
// Initialize

export function InitializeRender(): void {
    new RenderContext();

    FontProgram = new RenderTextProgram("gfx/fira_code_sdf.png");
    PlayerProgram = new RenderPlayerProgram();
    StringProgram = new RenderStringProgram();
    BombProgram = new RenderBombProgram();
    BulletProgram = new RenderBulletProgram();
    MapProgram = new RenderMapProgram();
    ArrowProgram = new RenderArrowProgram();
    SunProgram = new RenderSunProgram();
}
