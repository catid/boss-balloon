import { RenderContext } from "./RenderContext";
import { WebGLProgram, WebGLUniformLocation, WebGLBuffer, GLint } from "./WebGL";
import { consoleLog } from "../../netcode/netcode";
import { RenderColor } from "./RenderCommon";

const kVS: string = `
    precision highp float;

    // Input from application:
    attribute vec2 a_position;

    // Output to fragment shader:
    varying float v_dist;

    void main() {
        vec2 p = a_position;
        v_dist = clamp(1.0 - length(p), 0.0, 1.0);
        gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
    }
`;

const kFS: string = `
    precision highp float;

    // Input from application:
    uniform vec3 u_color;
    uniform float u_t;

    // Input from vertex shader:
    varying float v_dist;

    void main() {
        float alpha = (sin(u_t + v_dist * 16.0) + 1.0) * 0.5 * 0.8 + 0.2;

        gl_FragColor = vec4(u_color * alpha, 1.0);
    }
`;

export class RenderStringProgram {
    program: WebGLProgram;
    a_position: GLint;
    a_dist: GLint;
    u_color: WebGLUniformLocation;
    u_t: WebGLUniformLocation;

    vertices_buffer: WebGLBuffer;
    data: StaticArray<f32> = new StaticArray<f32>(4);

    constructor() {
        const gl = RenderContext.I.gl;

        gl.getExtension('OES_standard_derivatives');
        gl.getExtension('OES_texture_float_linear');
        //gl.getExtension('OES_texture_border_clamp');

        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, kVS);
        gl.compileShader(vs);

        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, kFS);
        gl.compileShader(fs);

        this.program = gl.createProgram();
        gl.attachShader(this.program, vs);
        gl.attachShader(this.program, fs);
        gl.linkProgram(this.program);
        gl.useProgram(this.program);

        this.a_position = gl.getAttribLocation(this.program, "a_position");
        this.u_color = gl.getUniformLocation(this.program, "u_color");
        this.u_t = gl.getUniformLocation(this.program, "u_t");

        this.vertices_buffer = gl.createBuffer();
    }

    public DrawString(
        color: RenderColor,
        x0: f32, y0: f32,
        x1: f32, y1: f32,
        t: u64): void {
        const gl = RenderContext.I.gl;

        const data = this.data;

        data[0] = x0;
        data[1] = y0;
        data[2] = x1;
        data[3] = y1;

        gl.useProgram(this.program);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices_buffer);

        gl.enableVertexAttribArray(this.a_position);

        // attribute | dimensions | data type | normalize | stride bytes | offset bytes
        gl.vertexAttribPointer(this.a_position, 2, gl.FLOAT, +false, 8, 0);

        gl.uniform3f(this.u_color, color.r, color.g, color.b);
        gl.uniform1f(this.u_t, f32(t/4 % 1024) * 4.0 * f32(Math.PI) / 1024.0);

        // Use DYNAMIC_DRAW because we want to change this for each line we render
        gl.bufferData<f32>(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);

        gl.drawArrays(gl.LINES, 0, 2);
    }
}
