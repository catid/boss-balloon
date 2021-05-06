import { WebGLRenderingContext } from "./WebGL";

export class RenderContext {
    public static I: RenderContext;
    public gl!: WebGLRenderingContext;

    public w: i32 = 0;
    public h: i32 = 0;

    constructor() {
        if (RenderContext.I == null) {
            RenderContext.I = this;
        }
        this.gl = new WebGLRenderingContext('cnvs', 'webgl2');

        this.Clear();
        this.gl.colorMask(true, true, true, false);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
        this.gl.enable(this.gl.BLEND);
    }

    public UpdateViewport(canvas_w: i32, canvas_h: i32): void {
        if (canvas_w == this.w && canvas_h == this.h) {
            return;
        }
        this.w = canvas_w;
        this.h = canvas_h;

        this.gl.viewport(0, 0, canvas_w, canvas_h);
    }

    public Clear(): void {
        this.gl.clearColor(0.0, 0.0, 0.0, 1.0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }

    public Flush(): void {
        this.gl.flush();
    }
}
