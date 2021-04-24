import { WebGLRenderingContext } from "./WebGL";

export class RenderContext {
    public static I: RenderContext;
    public gl!: WebGLRenderingContext;

    constructor() {
        if (RenderContext.I == null) {
            RenderContext.I = this;
        }
        this.gl = new WebGLRenderingContext('cnvs', 'webgl2');
    }

    public clear(): void {
        this.gl.clearColor(0.5, 0.5, 0.0, 1.0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }
}
