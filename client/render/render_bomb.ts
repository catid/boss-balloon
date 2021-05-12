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
        v_pos = p * 8.0;
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
        float d = length(v_pos);
        float f = 0.;
        float phase = u_t;
        float dir = 1.;
        float a = 0.;
        float len = -d*(cos(u_t)*.2+.2);
        for(float i = 0.; i<10.0; i+=1.){
            float p = phase +(sin(i+u_t)-1.)*.05+len;
            a = dot(normalize(v_pos), normalize(vec2(cos((p)*dir), sin((p)*dir))));
            a = max(0., a);
            a = pow(a, 10.);
            dir*=-1.;
            phase+=mod(i,6.28);
            f += a;
            f = abs(mod(f+1., 2.)-1.);
        }    
        f+=1.7-d*(.7+sin(u_t+dot(normalize(v_pos), vec2(1., 0.))*12.)*.02);
        f = max(f, 0.);
        vec3 c = mix( vec3(0.5, 0., 0.), u_color, f);
        c = clamp(c, 0., 1.);
        c = 1.0-vec3(1.0, .8, .6)*3.*(1.0-c);
        gl_FragColor = vec4(c,f);
    }
`;

// Render program shared between all bombs
export class RenderBombProgram {
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

    public DrawBomb(
        color: RenderColor,
        x: f32, y: f32,
        scale: f32, angle: f32,
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
        gl.uniform1f(this.u_angle, angle);
        gl.uniform1f(this.u_t, f32(t/40 % 1000000) * 0.01);

        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0);
    }
}
