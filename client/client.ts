import { RenderContext } from "./gl/RenderContext";
import { Box3 } from "../node_modules/as-3d-math/src/as/index";


//------------------------------------------------------------------------------
// Imports

declare function consoleLog(message: string): void
declare function sendReliable(buffer: Uint8Array): void
declare function sendUnreliable(buffer: Uint8Array): void

export const UINT8ARRAY_ID = idof<Uint8Array>();


//------------------------------------------------------------------------------
// Initialization

export function Initialize(): void {
    new RenderContext();
}


//------------------------------------------------------------------------------
// Render

let last_msec : f64 = 0;

export function RenderFrame(now_msec: f64, finger_x: f64, finger_y: f64): void {
    let dt : f64 = now_msec - last_msec;
    if (dt > 5000) {
        dt = 0;
    }
    last_msec = now_msec;
    //consoleLog("TEST: " + dt.toString() + " at " + finger_x.toString() + ", " + finger_y.toString());

    RenderContext.I.clear();

    // Collect GC after render tasks are done
    __collect();
}


//------------------------------------------------------------------------------
// Connection

export function OnConnectionOpen(): void {
    consoleLog("UDP link up");

    const data = new Uint8Array(10);
    for (let i: i32 = 0; i < 10; ++i) {
        data[i] = i as u8;
    }

    sendReliable(data);
}

export function OnConnectionClose(): void {
    consoleLog("UDP link down");
}

export function OnConnectionUnreliableData(recv_msec: f64, buffer: Uint8Array): void {
    consoleLog("Unreliable message: len=" + buffer.length.toString());
}

export function OnConnectionReliableData(buffer: Uint8Array): void {
    consoleLog("Reliable message: len=" + buffer.length.toString());
}
