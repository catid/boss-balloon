import { WebGLRenderingContext } from "./WebGL";


namespace Render {


let gl: WebGLRenderingContext;


export class RenderContext {
    public static I: RenderContext;
    public gl!: WebGLRenderingContext;

    public w: i32 = 0;
    public h: i32 = 0;

    constructor() {
        if (RenderContext.I == null) {
            RenderContext.I = this;
        }
        gl = this.gl = new WebGLRenderingContext('cnvs', 'webgl2');

        this.Clear();

        gl.colorMask(true, true, true, false);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
    }

    public UpdateViewport(canvas_w: i32, canvas_h: i32): void {
        if (canvas_w == this.w && canvas_h == this.h) {
            return;
        }
        this.w = canvas_w;
        this.h = canvas_h;

        gl.viewport(0, 0, canvas_w, canvas_h);
    }

    public Clear(): void {
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    public Flush(): void {
        gl.flush();
    }
}


} // namespace Render
