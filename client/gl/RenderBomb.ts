import { RenderContext } from "./RenderContext";
import { WebGLProgram, WebGLUniformLocation, WebGLBuffer, GLint } from "./WebGL";
import { consoleLog } from "../../netcode/netcode";
import { RenderColor } from "./RenderCommon";

const kVS: string = `
    precision highp float;

    // Input from application:
    attribute vec2 a_position;
    uniform vec2 u_xy;
    uniform float u_scale;

    // Output to fragment shader:
    varying vec2 v_pos;

    void main() {
        v_pos = a_position;
        vec2 p = a_position * u_scale + u_xy;
        // Normalized upper left (0,0) lower right (1,1)
        gl_Position = vec4((p.x - 0.5) * 2.0, (0.5 - p.y) * 2.0, 0.0, 1.0);
    }
`;

const kFS: string = `
    precision highp float;

    // Input from application:
    uniform vec3 u_color;
    uniform float u_t;

    // Input from vertex shader:
    varying vec2 v_pos;

    void main() {
        // Radius of circle is always 1, so dist2 = 1 on the border
        float x = 1.0 - abs(v_pos.x);
        float y = 1.0 - abs(v_pos.y);
        float alpha = clamp((x * x + y * y) * 0.5, 0.0, 1.0);
        float gamma = 1.0 - (v_pos.x * v_pos.x + v_pos.y * v_pos.y);

        float t = (sin(u_t) + 1.0) * 0.5;

        float beta = pow(alpha, 3.0 + cos(u_t * 2.0) * 0.5);

        vec3 flare_color = mix(u_color, vec3(0.0, 0.0, 0.0), beta);

        vec3 color;
        if (alpha > 0.90) {
            color = u_color;
        } else {
            color = flare_color;
        }

        gl_FragColor = vec4(color, beta*gamma);
    }
`;

// Render program shared between all bombs
export class RenderBombProgram {
    program: WebGLProgram;
    a_position: GLint;
    u_xy: WebGLUniformLocation;
    u_color: WebGLUniformLocation;
    u_scale: WebGLUniformLocation;
    u_t: WebGLUniformLocation;

    vertices_buffer: WebGLBuffer;
    indices_buffer: WebGLBuffer;

    constructor() {
        const gl = RenderContext.I.gl;

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
        this.u_xy = gl.getUniformLocation(this.program, "u_xy");
        this.u_color = gl.getUniformLocation(this.program, "u_color");
        this.u_scale = gl.getUniformLocation(this.program, "u_scale");
        this.u_t = gl.getUniformLocation(this.program, "u_t");

        this.vertices_buffer = gl.createBuffer();
        this.indices_buffer = gl.createBuffer();

        let vertex_data: StaticArray<f32> = new StaticArray<f32>(8);
        vertex_data[0] = 0.0;
        vertex_data[1] = -1.0;
        vertex_data[2] = 1.0;
        vertex_data[3] = 0.0;
        vertex_data[4] = 0.0;
        vertex_data[5] = 1.0;
        vertex_data[6] = -1.0;
        vertex_data[7] = 0.0;

        let index_data: StaticArray<u8> = new StaticArray<u8>(6);
        index_data[0] = 0;
        index_data[1] = 3;
        index_data[2] = 1;
        index_data[3] = 1;
        index_data[4] = 3;
        index_data[5] = 2;

        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices_buffer);
        gl.bufferData<f32>(gl.ARRAY_BUFFER, vertex_data, gl.STATIC_DRAW);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices_buffer);
        gl.bufferData<u8>(gl.ELEMENT_ARRAY_BUFFER, index_data, gl.STATIC_DRAW);
    }

    public DrawBomb(
        color: RenderColor,
        x: f32, y: f32,
        scale: f32,
        t: u64): void {
        const gl = RenderContext.I.gl;

        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices_buffer);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices_buffer);

        gl.enableVertexAttribArray(this.a_position);

        // attribute | dimensions | data type | normalize | stride bytes | offset bytes
        gl.vertexAttribPointer(this.a_position, 2, gl.FLOAT, +false, 8, 0);

        gl.uniform3f(this.u_color, color.r, color.g, color.b);
        gl.uniform2f(this.u_xy, x, y);
        gl.uniform1f(this.u_scale, scale);
        gl.uniform1f(this.u_t, f32(t/4 % 1024) * 4.0 * f32(Math.PI) / 1024.0);

        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0);
    }
}
