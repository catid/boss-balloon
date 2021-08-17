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
        p = vec2(p.x * cos(u_angle) - p.y * sin(u_angle), p.x * sin(u_angle) + p.y * cos(u_angle));
        p = p * u_scale + u_xy;
        gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
    }
`;

const kFS: string = `
    precision highp float;

    // Input from application:
    uniform vec3 u_color;
    uniform float u_t;
    uniform float u_fire;

    // Input from vertex shader:
    varying vec2 v_pos;



    float rand(vec2 n) {
        return fract(sin(cos(dot(n, vec2(12.9898,12.1414)))) * 83758.5453);
    }
    
    float noise(vec2 n) {
        const vec2 d = vec2(0.0, 1.0);
        vec2 b = floor(n), f = smoothstep(vec2(0.0), vec2(1.0), fract(n));
        return mix(mix(rand(b), rand(b + d.yx), f.x), mix(rand(b + d.xy), rand(b + d.yy), f.x), f.y);
    }
    
    float fbm(vec2 n) {
        float total = 0.0, amplitude = 1.0;
        for (int i = 0; i <5; i++) {
            total += noise(n) * amplitude;
            n += n*1.7;
            amplitude *= 0.47;
        }
        return total;
    }
    
    vec4 GetFireBeam() {
        vec3 c1 = u_color;
        vec3 c2 = u_color;
        vec3 c3 = u_color * 0.2;
        vec3 c4 = u_color * 0.5;
        const vec3 c5 = vec3(0.1);
        const vec3 c6 = vec3(0.9);

        float t = u_t / 16.0;

        vec2 speed = vec2(0.1, 0.9);
        float shift = 1.327+sin(t*2.0)/2.4;
        float alpha = 1.0;

        float dist = 15.0;

        vec2 p = vec2(v_pos.x * sign(v_pos.y) * dist, abs(v_pos.y) * dist);
        p += sin(p.yx*4.0+vec2(.2,-.3)*t)*0.04;
        p += sin(p.yx*8.0+vec2(.6,+.1)*t)*0.01;

        float q = fbm(p - t * 0.3+1.0*sin(t+0.5)/2.0);
        float qb = fbm(p - t * 0.4+0.1*cos(t)/2.0);
        float q2 = fbm(p - t * 0.44 - 5.0*cos(t)/2.0) - 6.0;
        float q3 = fbm(p - t * 0.9 - 10.0*cos(t)/15.0)-4.0;
        float q4 = fbm(p - t * 1.4 - 20.0*sin(t)/14.0)+2.0;
        q = (q + qb - .4 * q2 -2.0*q3  + .6*q4)/3.8;
        vec2 r = vec2(fbm(p + q /2.0 + t * speed.x - p.x - p.y), fbm(p + q - t * speed.y));
        vec3 c = mix(c1, c2, fbm(p + r)) + mix(c3, c4, r.x) - mix(c5, c6, r.y);
        vec3 color = vec3( 1.0/(pow(c+1.61,vec3(4.0))) );

        color=u_color/(pow((r.y+r.y)* max(.0,p.y)+0.1, 4.0));
        color = color/(1.0+max(vec3(0),color));
        return vec4(color, alpha);
    }

    vec4 GetWarningBeam() {
        // pulsate
        float pulse_x = sin(v_pos.x * 40.0 - u_t * 2.0) + 1.0;
        float pulse_t = sin(u_t) * 0.5 + 1.0;
        vec3 h_color = u_color * pulse_x * pulse_t;

        // grating
        float back_value = 1.0;
        if (mod(v_pos.y * 80.0, 1.0) > 0.75 || mod(v_pos.x * 80.0, 1.0) > 0.75) {
            back_value = 1.7;
        }

        // beamize
        float beam_width = abs(1.0 / (300.0 * v_pos.y));

        float alpha = back_value * beam_width;
        float edge = ( 5.0 - clamp(abs(v_pos.x), 4.8, 5.0) ) * 20.0;
        alpha *= edge;

        return vec4(alpha * h_color, clamp(alpha, 0.0, 0.4));
    }

    void main() {
        gl_FragColor = mix(GetWarningBeam(), GetFireBeam(), u_fire);
    }
`;

// Render program shared between all lasers
export class RenderLaserProgram {
    program: WebGLProgram;
    a_position: GLint;
    u_xy: WebGLUniformLocation;
    u_color: WebGLUniformLocation;
    u_scale: WebGLUniformLocation;
    u_angle: WebGLUniformLocation;
    u_t: WebGLUniformLocation;
    u_fire: WebGLUniformLocation;

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
        this.u_fire = gl.getUniformLocation(this.program, "u_fire");

        this.vertices_buffer = gl.createBuffer();
        this.indices_buffer = gl.createBuffer();

        const w: f32 = 0.04;
        const h: f32 = 5;

        let vertex_data: StaticArray<f32> = new StaticArray<f32>(8);
        vertex_data[0] = -h;
        vertex_data[1] = -w;
        vertex_data[2] = h;
        vertex_data[3] = -w;
        vertex_data[4] = h;
        vertex_data[5] = w;
        vertex_data[6] = -h;
        vertex_data[7] = w;

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

    public BeginLasers(): void {
        const gl = RenderContext.I.gl;

        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices_buffer);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices_buffer);

        gl.enableVertexAttribArray(this.a_position);

        // attribute | dimensions | data type | normalize | stride bytes | offset bytes
        gl.vertexAttribPointer(this.a_position, 2, gl.FLOAT, +false, 8, 0);
    }

    public DrawLaser(color: RenderColor, x: f32, y: f32, t: u64, scale: f32, angle: f32, pulserate: f32, fire: f32): void {
        const gl = RenderContext.I.gl;

        gl.uniform3f(this.u_color, color.r, color.g, color.b);
        gl.uniform2f(this.u_xy, x, y);
        gl.uniform1f(this.u_angle, angle);
        gl.uniform1f(this.u_t, f32(t) * Mathf.PI / 1024.0 + pulserate * pulserate * Mathf.PI * 2.0);
        gl.uniform1f(this.u_scale, scale);
        gl.uniform1f(this.u_fire, fire);

        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0);
    }
}
