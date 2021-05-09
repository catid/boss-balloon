import { RenderContext } from "./RenderContext";
import { ImageData, WebGLProgram, WebGLUniformLocation, WebGLBuffer, GLint, WebGLTexture } from "./WebGL";
import { JSON } from "assemblyscript-json";
import { consoleLog } from "../../netcode/netcode";

const kVertexShaderCode: string = `
    precision highp float;

    // Input from application:
    attribute vec2 a_position;
    uniform vec2 u_xy;
    uniform float u_scale;

    // Output to fragment shader:
    varying vec2 v_coord;

    void main() {
        vec2 p = a_position;
        v_coord = p * u_scale + u_xy;
        gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
    }
`;

const kFragmentShaderCode: string = `
    precision highp float;

    // Input from vertex shader:
    varying vec2 v_coord;

    uniform float u_t;

    const float cloudscale = 0.8;
    const float speed = 0.03;
    const float clouddark = 0.5;
    const float cloudlight = 0.3;
    const float cloudcover = 0.2;
    const float cloudalpha = 8.0;
    const float skytint = 0.5;
    const vec3 skycolour1 = vec3(0.2, 0.4, 0.6);
    const vec3 skycolour2 = vec3(0.4, 0.7, 1.0);

    const mat2 m = mat2( 1.6,  1.2, -1.2,  1.6 );

    vec2 hash( vec2 p ) {
        p = vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3)));
        return -1.0 + 2.0*fract(sin(p)*43758.5453123);
    }

    float noise( in vec2 p ) {
        const float K1 = 0.366025404; // (sqrt(3)-1)/2;
        const float K2 = 0.211324865; // (3-sqrt(3))/6;
        vec2 i = floor(p + (p.x+p.y)*K1);	
        vec2 a = p - i + (i.x+i.y)*K2;
        vec2 o = (a.x>a.y) ? vec2(1.0,0.0) : vec2(0.0,1.0); //vec2 of = 0.5 + 0.5*vec2(sign(a.x-a.y), sign(a.y-a.x));
        vec2 b = a - o + K2;
        vec2 c = a - 1.0 + 2.0*K2;
        vec3 h = max(0.5-vec3(dot(a,a), dot(b,b), dot(c,c) ), 0.0 );
        vec3 n = h*h*h*h*vec3( dot(a,hash(i+0.0)), dot(b,hash(i+o)), dot(c,hash(i+1.0)));
        return dot(n, vec3(70.0));	
    }

    float fbm(vec2 n) {
        float total = 0.0, amplitude = 0.1;
        for (int i = 0; i < 7; i++) {
            total += noise(n) * amplitude;
            n = m * n;
            amplitude *= 0.4;
        }
        return total;
    }

    void main() {
        vec2 p = v_coord.xy;
        vec2 uv = p;
        float time = u_t * speed * 100.0;
        float q = fbm(uv * cloudscale * 0.5);
        
        //ridged noise shape
        float r = 0.0;
        uv *= cloudscale;
        uv -= q - time;
        float weight = 0.8;
        for (int i=0; i<8; i++){
            r += abs(weight*noise( uv ));
            uv = m*uv + time;
            weight *= 0.7;
        }
        
        //noise shape
        float f = 0.0;
        uv = p;
        uv *= cloudscale;
        uv -= q - time;
        weight = 0.7;
        for (int i=0; i<8; i++){
            f += weight*noise( uv );
            uv = m*uv + time;
            weight *= 0.6;
        }
        
        f *= r + f;
        
        //noise colour
        float c = 0.0;
        time = u_t * speed * 2.0;
        uv = p;
        uv *= cloudscale*2.0;
        uv -= q - time;
        weight = 0.4;
        for (int i=0; i<7; i++){
            c += weight*noise( uv );
            uv = m*uv + time;
            weight *= 0.6;
        }

        //noise ridge colour
        float c1 = 0.0;
        time = u_t * speed * 3.0;
        uv = p;
        uv *= cloudscale*3.0;
        uv -= q - time;
        weight = 0.4;
        for (int i=0; i<7; i++){
            c1 += abs(weight*noise( uv ));
            uv = m*uv + time;
            weight *= 0.6;
        }
        
        c += c1;
        
        vec3 skycolour = skycolour2;
        vec3 cloudcolour = vec3(1.1, 1.1, 0.9) * clamp((clouddark + cloudlight*c), 0.0, 1.0);
       
        f = cloudcover + cloudalpha*f*r;
        
        vec3 result = mix(skycolour, clamp(skytint * skycolour + cloudcolour, 0.0, 1.0), clamp(f + c, 0.0, 1.0));

        gl_FragColor = vec4( result, 1.0 );
    }
`;

export class RenderMapProgram {
    shader_program: WebGLProgram;

    // Vertex shader attributes/uniforms:
    a_position: GLint;
    u_xy: WebGLUniformLocation;
    u_scale: WebGLUniformLocation;
    u_t: WebGLUniformLocation;

    vertices_buffer: WebGLBuffer;
    indices_buffer: WebGLBuffer;

    constructor() {
        const gl = RenderContext.I.gl;

        gl.getExtension('OES_standard_derivatives');
        gl.getExtension('OES_texture_float_linear');
        //gl.getExtension('OES_texture_border_clamp');

        const vertex_shader = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vertex_shader, kVertexShaderCode);
        gl.compileShader(vertex_shader);

        const fragment_shader = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fragment_shader, kFragmentShaderCode);
        gl.compileShader(fragment_shader);

        this.shader_program = gl.createProgram();
        gl.attachShader(this.shader_program, vertex_shader);
        gl.attachShader(this.shader_program, fragment_shader);
        gl.linkProgram(this.shader_program);
        gl.useProgram(this.shader_program);

        this.a_position = gl.getAttribLocation(this.shader_program, "a_position");

        this.u_xy = gl.getUniformLocation(this.shader_program, "u_xy");
        this.u_scale = gl.getUniformLocation(this.shader_program, "u_scale");
        this.u_t = gl.getUniformLocation(this.shader_program, "u_t");

        this.vertices_buffer = gl.createBuffer();
        this.indices_buffer = gl.createBuffer();

        let vertex_data: StaticArray<f32> = new StaticArray<f32>(8);
        vertex_data[0] = -1.0;
        vertex_data[1] = -1.0;
        vertex_data[2] = 1.0;
        vertex_data[3] = -1.0;
        vertex_data[4] = 1.0;
        vertex_data[5] = 1.0;
        vertex_data[6] = -1.0;
        vertex_data[7] = 1.0;

        let index_data: StaticArray<u8> = new StaticArray<u8>(6);
        index_data[0] = 0;
        index_data[1] = 1;
        index_data[2] = 3;
        index_data[3] = 1;
        index_data[4] = 2;
        index_data[5] = 3;

        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices_buffer);
        gl.bufferData<f32>(gl.ARRAY_BUFFER, vertex_data, gl.STATIC_DRAW);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices_buffer);
        gl.bufferData<u8>(gl.ELEMENT_ARRAY_BUFFER, index_data, gl.STATIC_DRAW);
    }

    public DrawMap(
        x: f32, y: f32,
        scale: f32,
        t: u64): void {
        const gl = RenderContext.I.gl;

        gl.useProgram(this.shader_program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices_buffer);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices_buffer);

        gl.enableVertexAttribArray(this.a_position);

        // attribute | dimensions | data type | normalize | stride bytes | offset bytes
        gl.vertexAttribPointer(this.a_position, 2, gl.FLOAT, +false, 8, 0);

        gl.uniform2f(this.u_xy, x, y);
        gl.uniform1f(this.u_scale, scale);
        gl.uniform1f(this.u_t, f32(t % 1000000) / 1000000.0);

        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0);
     }
}
