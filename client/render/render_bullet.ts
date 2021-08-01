import { RenderContext } from "./render_context"
import { WebGLProgram, WebGLUniformLocation, WebGLBuffer, GLint } from "./WebGL"
import { RenderColor } from "./render_common"


const kVS: string = `
    precision highp float;

    // Input from application:
    attribute vec2 a_position;
    uniform vec2 u_xy;
    uniform float u_scale;
    uniform float u_angle;

    // Output to fragment shader:
    varying vec2 v_pos;

    void main() {
        vec2 p = a_position;
        v_pos = p;
        p = vec2(-p.x * sin(u_angle) + p.y * cos(u_angle), p.x * cos(u_angle) + p.y * sin(u_angle));
        p = p * u_scale + u_xy;
        gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
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
        float x = 1.0 - abs(v_pos.x);
        float y = 1.0 - abs(v_pos.y);
        float alpha = clamp((x * x + y * y) * 0.5, 0.0, 1.0);
        float gamma = 1.0 - (v_pos.x * v_pos.x + v_pos.y * v_pos.y);

        float t = (sin(u_t) + 1.0) * 0.5;

        float beta = pow(alpha, 4.0 + t);

        vec3 flare_color = mix(u_color, vec3(0.0, 0.0, 0.0), beta);

        vec4 color;
        if (alpha > 0.90) {
            color = vec4(u_color, 1.0);
        } else {
            color = vec4(flare_color, beta*gamma);
        }

        gl_FragColor = color;
    }
`;

// Render program shared between all bombs
export class RenderBulletProgram {
    program: WebGLProgram;
    a_position: GLint;
    u_xy: WebGLUniformLocation;
    u_color: WebGLUniformLocation;
    u_scale: WebGLUniformLocation;
    u_angle: WebGLUniformLocation;
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
        this.u_angle = gl.getUniformLocation(this.program, "u_angle");
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

    public BeginBullets(t: u64, scale: f32): void {
        const gl = RenderContext.I.gl;

        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices_buffer);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices_buffer);

        gl.enableVertexAttribArray(this.a_position);

        // attribute | dimensions | data type | normalize | stride bytes | offset bytes
        gl.vertexAttribPointer(this.a_position, 2, gl.FLOAT, +false, 8, 0);

        gl.uniform1f(this.u_t, f32((t + 333333)/4 % 1024) * 3.0 * Mathf.PI / 1024.0);
        gl.uniform1f(this.u_scale, scale);
    }

    public DrawBullet(color: RenderColor, x: f32, y: f32, angle: f32): void {
        const gl = RenderContext.I.gl;

        gl.uniform3f(this.u_color, color.r, color.g, color.b);
        gl.uniform2f(this.u_xy, x, y);
        gl.uniform1f(this.u_angle, angle);

        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0);
    }
}
