// @ts-nocheck
/* Interstellar procedural film engine.
 *
 * Extracted and adapted from the standalone "Interstellar" procedural WebGL2
 * cinematic study (wormhole / ocean planet / docking / black hole, 206s).
 * The rendering math is unchanged; the engine is reshaped into an embeddable
 * component API for the immersive auth screen:
 *
 * - Renders into any container-sized canvas (ResizeObserver driven).
 * - Plays chapters in REVERSE order: black hole -> docking -> ocean -> wormhole,
 *   via a time-remap. Chapter boundaries keep their original crossfades, so the
 *   reversed sequence blends seamlessly and loops forever.
 * - Auto quality scaling, visibility pause, context-loss recovery.
 *
 * @ts-nocheck is intentional: this is dense graphics math ported verbatim from
 * an untyped source; noUncheckedIndexedAccess would fire on every array read
 * (hundreds of false positives) without catching real porting regressions.
 */

import { NOISE_DATA, SKY_DATA } from "./interstellar-textures";

const PI = Math.PI;
const TAU = PI * 2;
const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (x: number) => {
  x = clamp(x);
  return x * x * (3 - 2 * x);
};

type Vec3 = [number, number, number];
const V = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
const add = (a: Vec3, b: Vec3): Vec3 => a.map((v, i) => v + b[i]) as Vec3;
const sub = (a: Vec3, b: Vec3): Vec3 => a.map((v, i) => v - b[i]) as Vec3;
const mul = (a: number[], s: number) => a.map((v) => v * s);
const dot = (a: number[], b: number[]) => a.reduce((r, v, i) => r + v * b[i], 0);
const cross = (a: number[], b: number[]): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: number[]): Vec3 => mul(a, 1 / (Math.hypot(...a) || 1)) as Vec3;
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => a.map((v, i) => mix(v, b[i], t)) as Vec3;

function matmul(a: Float32Array, b: Float32Array) {
  const c = new Float32Array(16);
  for (let j = 0; j < 4; j++)
    for (let i = 0; i < 4; i++)
      for (let k = 0; k < 4; k++) c[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k];
  return c;
}

// Two flavors share one code path:
// - matrix(): allocates (one-off / build-time paths in Builder and stateAt
//   where the result is captured into longer-lived structures).
// - buildMatrix(scratch, ...): writes into a caller-provided Float32Array; used
//   in the per-frame render loop where the buffer is uploaded immediately and
//   never outlives the call, removing the per-frame allocation.
function buildMatrix(out: Float32Array, pos: number[], rot: number[], scale: number | number[]) {
  let [x, y, z] = rot,
    cx = Math.cos(x),
    sx = Math.sin(x),
    cy = Math.cos(y),
    sy = Math.sin(y),
    cz = Math.cos(z),
    sz = Math.sin(z);
  let s = Array.isArray(scale) ? scale : [scale, scale, scale];
  out[0] = cy * cz * s[0];
  out[1] = cy * sz * s[0];
  out[2] = -sy * s[0];
  out[3] = 0;
  out[4] = (sx * sy * cz - cx * sz) * s[1];
  out[5] = (sx * sy * sz + cx * cz) * s[1];
  out[6] = sx * cy * s[1];
  out[7] = 0;
  out[8] = (cx * sy * cz + sx * sz) * s[2];
  out[9] = (cx * sy * sz - sx * cz) * s[2];
  out[10] = cx * cy * s[2];
  out[11] = 0;
  out[12] = pos[0];
  out[13] = pos[1];
  out[14] = pos[2];
  out[15] = 1;
  return out;
}

// Shared scratch for per-frame model matrices (uploaded to GL immediately).
const MODEL_MATRIX_SCRATCH = new Float32Array(16);

function matrix(
  pos: number[] = [0, 0, 0],
  rot: number[] = [0, 0, 0],
  scale: number | number[] = 1,
) {
  return buildMatrix(new Float32Array(16), pos, rot, scale);
}

function transform(m: Float32Array, v: number[], w = 1) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * w,
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * w,
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * w,
  ];
}

function camera(p: number[], target: number[], fov: number, roll: number, aspect: number) {
  let f = norm(sub(target as Vec3, p as Vec3));
  let r = norm(cross(f, [0, 1, 0]));
  let u = cross(r, f);
  let c = Math.cos(roll),
    s = Math.sin(roll);
  [r, u] = [add(mul(r, c), mul(u, s)), add(mul(u, c), mul(r, -s))];
  const view = new Float32Array([
    r[0],
    u[0],
    -f[0],
    0,
    r[1],
    u[1],
    -f[1],
    0,
    r[2],
    u[2],
    -f[2],
    0,
    -dot(r, p),
    -dot(u, p),
    dot(f, p),
    1,
  ]);
  let k = 1 / Math.tan((fov * PI) / 360),
    near = 0.035,
    far = 4000;
  const proj = new Float32Array([
    k / aspect,
    0,
    0,
    0,
    0,
    k,
    0,
    0,
    0,
    0,
    -(far + near) / (far - near),
    -1,
    0,
    0,
    (-2 * far * near) / (far - near),
    0,
  ]);
  return { vp: matmul(proj, view), r, u, f, lens: 1 / k, p };
}

let randState = 8732;
function rand() {
  randState = (Math.imul(randState, 1664525) + 1013904223) >>> 0;
  return randState / 4294967296;
}

type GL = WebGL2RenderingContext;

interface ProgramBundle {
  p: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

function makeProgram(gl: GL, name: string, vs: string, fs: string): ProgramBundle {
  function compile(type: number, source: string) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error(name + " " + gl.getShaderInfoLog(sh));
    return sh;
  }
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(name + " " + gl.getProgramInfoLog(p));
  const u: Record<string, WebGLUniformLocation | null> = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const q = gl.getActiveUniform(p, i)!;
    u[q.name] = gl.getUniformLocation(p, q.name);
  }
  return { p, u };
}

function setSampler(
  gl: GL,
  pr: ProgramBundle,
  name: string,
  tex: WebGLTexture | null,
  unit: number,
) {
  if (pr.u[name] === undefined) return;
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(pr.u[name]!, unit);
}

const fullVS = `#version 300 es
precision highp float;
out vec2 vUV;
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));vUV=p;gl_Position=vec4(p*2.-1.,0.,1.);}`;

// Long shader sources are carried over verbatim from the original study.
const envFS = `#version 300 es
precision highp float;
in vec2 vUV;out vec4 frag;
uniform vec2 uRes;uniform float uTime,uMode,uLocal,uShot,uPhase,uLens,uWave,uDilate,uCloud;
uniform vec3 uCam,uRight,uUp,uForward,uSun,uCraft;uniform sampler2D uSky,uNoise;
#define PI 3.141592653589793
#define TAU 6.283185307179586
mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
float hash(float n){return fract(sin(n)*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return texture(uNoise,(i+f+.5)/256.).r;}
float fbm(vec2 p){float f=0.,a=.5;for(int i=0;i<5;i++){f+=a*noise(p);p=mat2(1.63,1.18,-1.18,1.63)*p+7.31;a*=.5;}return f;}
float n3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(noise(i.xy+f.xy+vec2(37.,17.)*i.z),noise(i.xy+f.xy+vec2(37.,17.)*(i.z+1.)),f.z);}
vec3 stars(vec3 d,float variant){d.xz=rot(.36+variant*1.42)*d.xz;d.yz=rot(.46+variant*.8)*d.yz;vec2 uv=vec2(atan(d.z,d.x)/TAU+.5,asin(clamp(d.y,-1.,1.))/PI+.5);vec3 c=texture(uSky,uv).rgb;c=pow(c,vec3(1.80))*.73;return c*mix(vec3(.64,.72,.83),vec3(1.18,1.04,.86),variant);}
vec2 sphere(vec3 ro,vec3 rd,vec3 ce,float r){vec3 o=ro-ce;float b=dot(o,rd),c=dot(o,o)-r*r,h=b*b-c;if(h<0.)return vec2(-1.);h=sqrt(h);return vec2(-b-h,-b+h);}
vec3 saturn(vec3 ro,vec3 rd,vec3 base){vec3 center=vec3(-29.,11.,-67.);float radius=10.;vec2 hit=sphere(ro,rd,center,radius);float dh=hit.x>0.?hit.x:1e5;vec3 nor=normalize(vec3(.32,.86,.39));float den=dot(rd,nor);float plane=dot(center-ro,nor)/den;vec3 p=ro+rd*plane-center;float rr=length(p);bool rings=plane>0.&&rr>radius*1.34&&rr<radius*2.30;vec3 col=base;if(dh<1e4){vec3 n=normalize(ro+rd*dh-center);float lat=dot(n,nor);float bands=noise(vec2(lat*58.,.6))* .5+sin(lat*155.+noise(vec2(lat*13.,3.))*3.)*.10;vec3 albedo=mix(vec3(.17,.142,.10),vec3(.62,.52,.37),clamp(bands+.25,0.,1.));float light=max(dot(n,uSun),0.);col=albedo*(light*.73+.013);float haze=pow(1.-max(dot(n,-rd),0.),3.);col+=haze*vec3(.17,.14,.095)*light;}
if(rings&&plane<dh){float stripes=(.6+.4*noise(vec2(rr*8.,2.)))*(.74+.26*sin(rr*57.));float gap=smoothstep(.09,.19,abs(rr-radius*1.91));float edge=smoothstep(radius*1.34,radius*1.42,rr)*(1.-smoothstep(radius*2.23,radius*2.3,rr));float shadow=sphere(ro+rd*plane+uSun*.01,uSun,center,radius).x>0.?.10:1.;vec3 ringColor=vec3(.32,.28,.21)*stripes*gap*shadow;col=mix(col,ringColor,edge*.92);}return col;}
vec3 worm(vec3 ro,vec3 rd){vec3 col=stars(rd,0.);col=saturn(ro,rd,col);float radius=3.2;float along=-dot(ro,rd);float impact=length(cross(ro,rd));float b=impact/radius;vec2 hit=sphere(ro,rd,vec3(0),radius);if(along>0.&&b<1.85){vec3 toward=normalize(-ro-rd*along);float bend=.095*exp(-max(b-1.,0.)*4.);vec3 lensed=normalize(rd+toward*bend);if(b>1.)col=mix(col,stars(lensed,0.),smoothstep(1.85,1.02,b));}
if(hit.x>0.||length(ro)<radius){float d=max(hit.x,0.);vec3 p=ro+rd*d;vec3 n=normalize(p);float incidence=clamp(dot(-rd,n),0.,1.);float a=acos(clamp(incidence,0.,1.));vec3 tangent=normalize(rd-n*dot(rd,n));float travel=a*2.65+.11*sin(a*7.);vec3 other=normalize(-n*cos(travel)+tangent*sin(travel));other.xz=rot(.8+uLocal*.004)*other.xz;other.xy=rot(-.5)*other.xy;vec3 inside=stars(other,1.)*1.9;
float edge=pow(1.-incidence,7.);vec3 reflection=stars(reflect(rd,n),0.);inside=mix(inside,reflection*.9,edge*.35);float bands=pow(.5+.5*cos((1.-incidence)*45.-.9),22.)*pow(1.-incidence,12.);inside+=vec3(.30,.36,.40)*bands*.35;inside+=vec3(.16,.175,.18)*pow(1.-incidence,30.);float attenuation=.71+.29*incidence;col=inside*attenuation;}
float einstein=exp(-abs(b-1.)*370.)*step(0.,along);col+=vec3(.18,.22,.25)*einstein;return col;}
vec3 transit(vec2 q){float t=uLocal-32.;q+=vec2(sin(t*.32),cos(t*.28))*.035;float r=length(q),a=atan(q.y,q.x);float throat=1./(r+.10);float z=throat+t*.60;float twist=a+.16*z+.10*sin(z*.7);vec3 dir=normalize(vec3(cos(twist)*r,sin(twist)*r,.28+.065*sin(t*.5)));dir.xz=rot(t*.06)*dir.xz;vec3 c=stars(dir,1.);float tex=fbm(vec2(twist*5.,z*1.6));float ribs=pow(abs(sin(twist*19.+noise(vec2(z*.5,twist*2.))*5.)),16.);float film=pow(noise(vec2(twist*14.,z*2.)),3.);float folds=pow(max(0.,sin(z*1.8+tex*4.)),5.);vec3 silver=mix(vec3(.065,.10,.14),vec3(.58,.62,.66),tex);c=mix(c*2.,silver*(.25+folds*.33),smoothstep(.17,.9,r)*.75);c+=ribs*film*vec3(.12,.145,.17)*smoothstep(.16,.8,r);c+=vec3(.32,.37,.41)*exp(-abs(r-(.17+.012*sin(a*4.+t*.4)))*48.);float star=texture(uSky,vec2(fract(a/TAU+t*.006),fract(throat*.035-t*.05))).r;c+=pow(star,9.)*smoothstep(.12,.75,r)*vec3(1.2,1.24,1.32);c*=.65+.35*smoothstep(1.65,.35,r);float exit=smoothstep(8.9,12.,t);c=mix(c,vec3(.55,.60,.63)+c*.15,exit*exit);return c;}
vec3 cloudySky(vec3 rd){float y=max(rd.y,0.);vec3 horizon=vec3(.66,.66,.60),zenith=vec3(.28,.34,.38);vec3 c=mix(horizon,zenith,pow(y,.5));vec3 sun=normalize(vec3(-.5,.48,-.7));if(uDilate>.1){float a=uTime*.75;sun=normalize(vec3(cos(a),.15+.65*abs(sin(a)),-.6));float day=.22+.78*(.5+.5*sin(uTime*1.55));c*=mix(1.,day,uDilate);}
float haze=pow(max(dot(rd,sun),0.),8.);c+=vec3(.37,.32,.24)*haze*.7;float sh=pow(max(dot(rd,sun),0.),190.);c+=vec3(1.,.93,.73)*sh*.6;vec2 cp=rd.xz/(.16+abs(rd.y))*.62+vec2(uLocal*.012,0.);float cloud=fbm(cp*2.8);float small=fbm(cp*11.);float cl=smoothstep(.42,.72,cloud+.08*small);c=mix(c,vec3(.66,.665,.63)*(.81+.27*small),cl*.84);c-=smoothstep(.65,.85,cloud)*.11;float lower=exp(-y*12.);c=mix(c,horizon*.91,lower*.4);
if(uDilate>.01&&rd.y>0.){vec3 d=rd;d.xz=rot(uTime*.24)*d.xz;vec3 sc=stars(d,0.);c+=sc*uDilate*(1.2-.8*sin(uTime*1.55));float a=atan(rd.z,rd.x);float circle=sin(acos(clamp(rd.y,-1.,1.))*94.+a*.2);float trails=pow(max(circle,0.),170.)*(.3+.7*noise(vec2(a*60.+uTime*9.,rd.y*10.)));c+=vec3(.17,.15,.12)*trails*uDilate*smoothstep(0.,.16,rd.y);}
return c;}
float smallSea(vec2 p,float t){float h=sin(p.x*.14+t*.61)*sin(p.y*.11+t*.35)*.20;h+=sin(p.x*.29+p.y*.23-t*.7)*.12;h+=sin(p.x*.58-p.y*.41+t*.84)*.046;return h;}
float giant(vec2 p){float z=uWave+sin(p.x*.018)*9.+sin(p.x*.041)*3.;float q=p.y-z;float width=q>0.?22.:81.;float crest=114.+sin(p.x*.013+.4)*8.+sin(p.x*.031)*3.+sin(p.x*.17)*.65;float wall=exp(-pow(abs(q)/width,1.65));return crest*wall;}
float seaH(vec2 p){float t=mix(uLocal,uLocal*.035+31.,uDilate);return giant(p)+smallSea(p,t);}
float detail(vec2 p){float t=mix(uLocal,uLocal*.035+31.,uDilate);float a=.065,h=0.;p*=1.6;for(int i=0;i<4;i++){h+=a*(sin(p.x+t*.7)*cos(p.y+t*.6)+noise(p*2.)-.5);p=mat2(1.7,1.2,-1.2,1.7)*p;a*=.43;}return h;}
vec3 ocean(vec3 ro,vec3 rd){vec3 sky=cloudySky(rd);float t=.08,prev=t;bool hit=false;vec3 p;
for(int i=0;i<78;i++){p=ro+rd*t;if(p.y<seaH(p.xz)){hit=true;break;}prev=t;t+=max(1.1,t*.088);if(t>2100.)break;}
if(!hit){if(rd.y<.012)sky=mix(sky,vec3(.48,.51,.50),.25);return sky;}
for(int i=0;i<7;i++){float mid=(prev+t)*.5;vec3 q=ro+rd*mid;if(q.y<seaH(q.xz))t=mid;else prev=mid;}p=ro+rd*t;
float eps=.075+min(t*.0004,.20);vec2 e=vec2(eps,0.);float detailAtten=1./(1.+t*.018);float h1=seaH(p.xz+e)+detail(p.xz+e)*detailAtten,h2=seaH(p.xz-e)+detail(p.xz-e)*detailAtten,h3=seaH(p.xz+e.yx)+detail(p.xz+e.yx)*detailAtten,h4=seaH(p.xz-e.yx)+detail(p.xz-e.yx)*detailAtten;vec3 n=normalize(vec3(h2-h1,2.*eps,h4-h3));float wh=giant(p.xz);float wallMix=smoothstep(8.,50.,wh);vec2 flow=vec2(p.x*.17,p.y*.23+uLocal*.28);n=normalize(n+vec3(noise(flow)-.5,(noise(flow+13.)-.5)*.5,0.)*wallMix*.19);vec3 refl=reflect(rd,n);vec3 reflected=cloudySky(refl);float fres=.035+.965*pow(1.-max(dot(n,-rd),0.),4.5);vec3 water=mix(vec3(.060,.079,.080),vec3(.019,.037,.041),wallMix);vec3 c=mix(water,reflected,fres*.89+.026);c*=.78+.22*max(n.y,0.);float spec=pow(max(dot(reflect(-normalize(vec3(-.5,.6,-.7)),n),-rd),0.),150.);c+=spec*vec3(.95,.90,.76)*.9;
float textureF=fbm(p.xz*.55+vec2(0.,uLocal*.15));float crest=smoothstep(103.,120.,wh)*smoothstep(.36,.66,textureF);float streaks=smoothstep(.58,.79,fbm(flow*1.3+vec2(noise(flow*.36)*4.,0.)));float whitewater=crest*.74+smoothstep(40.,105.,wh)*streaks*.14;float ripples=pow(max(sin(p.x*1.8+p.z*1.1+uLocal*.25),0.),17.)*.012*exp(-t*.006);whitewater+=ripples*smoothstep(.82,1.,fres);c=mix(c,vec3(.76,.78,.75),clamp(whitewater,0.,.9));
float shadow=exp(-dot((p.xz-uCraft.xz)/vec2(6.5,8.5),(p.xz-uCraft.xz)/vec2(6.5,8.5))*1.5)*exp(-max(uCraft.y-3.,0.)*.11);c*=1.-shadow*.47;
float mist=1.-exp(-t*.00042);c=mix(c,vec3(.59,.61,.60),mist*.78);float shore=exp(-length(p.xz)*.055)*exp(-abs(p.y)*.4);c+=vec3(.055,.064,.062)*shore;
return c;}
vec3 waterScene(vec3 ro,vec3 rd){vec3 c=ocean(ro,rd);if(uCloud>.0){float fog=fbm(rd.xz/(abs(rd.y)+.4)*3.+vec2(uLocal*.03,2.));c=mix(c,vec3(.63,.67,.68),uCloud*smoothstep(.25,.8,fog));}return c;}
vec3 icePlanet(vec3 ro,vec3 rd){vec3 c=stars(rd,0.)*.7;vec3 center=vec3(-12.,-140.,-185.);float radius=145.;vec2 h=sphere(ro,rd,center,radius);if(h.x>0.){vec3 p=ro+rd*h.x;vec3 n=normalize(p-center);float f=n3(n*8.)*.58+n3(n*21.)*.28+n3(n*58.)*.14;float g=n3(n*32.)*.52+n3(n*78.)*.31+n3(n*194.)*.17;float j=n3(n*360.);float land=smoothstep(.32,.72,f);vec3 a=mix(vec3(.10,.14,.17),vec3(.36,.35,.32),land);float clouds=smoothstep(.39,.65,g);a=mix(a,vec3(.55,.58,.57),clouds*.66);a*=.86+.19*j;float light=max(dot(n,uSun),0.);c=a*(light*.69+.025);float limb=pow(1.-max(dot(n,-rd),0.),5.);c+=vec3(.18,.30,.42)*limb*(light+.20)*1.5;}
else{float b=length(cross(center-ro,rd));float atmosphere=exp(-max(b-radius,0.)*.27)*step(radius,b)*step(0.,dot(center-ro,rd));c+=vec3(.15,.26,.37)*atmosphere*.70;}return c;}
vec3 disk(vec3 p){float r=length(p.xz),a=atan(p.z,p.x);float spiral=a-uLocal*.08/(.15+pow(r*.2,1.5));float n=fbm(vec2(r*3.8,spiral*7.));float fine=noise(vec2(r*39.+n*5.,spiral*20.));float bands=.77+.085*sin(r*46.+n*12.)+.045*sin(r*107.+fine*9.)+.12*fine;float turbulence=.38+.78*n;float edge=smoothstep(2.85,3.35,r)*(1.-smoothstep(10.,13.5,r));float hot=pow(3.5/max(r,3.5),1.65);vec3 col=mix(vec3(1.20,.48,.16),vec3(2.05,1.78,1.30),hot);float doppler=.84+.22*p.x/max(r,1.);return col*(2.4*hot+.10)*edge*bands*turbulence*doppler;}
vec3 hole(vec3 ro,vec3 rd){vec3 p=ro,v=rd;float h2=dot(cross(p,v),cross(p,v));vec3 acc=vec3(0.);float transparency=1.;bool captured=false;bool escaped=false;
for(int i=0;i<118;i++){float r=length(p);if(r<1.015){captured=true;break;}if(r>max(length(ro)+6.,34.)){escaped=true;break;}float ds=clamp(r*.10,.035,1.8);vec3 acceleration=-1.5*h2*p/(r*r*r*r*r);vec3 next=p+v*ds+.5*acceleration*ds*ds;float nr=length(next);vec3 na=-1.5*h2*next/(nr*nr*nr*nr*nr);vec3 nv=v+.5*(acceleration+na)*ds;
if(p.y*next.y<0.){float f=abs(p.y)/(abs(p.y)+abs(next.y));vec3 q=mix(p,next,f);float rad=length(q.xz);if(rad>2.85&&rad<13.5){vec3 emit=disk(q);acc+=transparency*emit;transparency*=.16;}}
p=next;v=nv;if(transparency<.022)break;}
if(!captured)acc+=stars(normalize(v),1.)*transparency*.64;
float impact=length(cross(ro,rd));float glow=exp(-abs(impact-2.63)*5.);acc+=vec3(.12,.075,.035)*glow;
return acc;}
void main(){vec2 q=(vUV*2.-1.)*vec2(uRes.x/uRes.y,1.);vec3 rd=normalize(uForward+uRight*q.x*uLens+uUp*q.y*uLens);vec3 c;
if(uMode<.5)c=worm(uCam,rd);else if(uMode<1.5)c=transit(q);else if(uMode<2.5)c=waterScene(uCam,rd);else if(uMode<3.5)c=icePlanet(uCam,rd);else c=hole(uCam,rd);
frag=vec4(max(c,vec3(0.)),1.);}`;

const meshVS = `#version 300 es
precision highp float;layout(location=0)in vec3 aPos;layout(location=1)in vec3 aNormal;layout(location=2)in vec3 aColor;layout(location=3)in vec2 aParam;layout(location=4)in vec4 aSurface;
uniform mat4 uModel,uVP;out vec3 vPos,vNormal,vColor;out vec2 vParam;out vec4 vSurface;
void main(){vec4 w=uModel*vec4(aPos,1.);vPos=w.xyz;vNormal=normalize(mat3(uModel)*aNormal);vColor=aColor;vParam=aParam;vSurface=aSurface;gl_Position=uVP*w;}`;

const meshFS = `#version 300 es
precision highp float;in vec3 vPos,vNormal,vColor;in vec2 vParam;in vec4 vSurface;out vec4 frag;uniform sampler2D uNoise;
uniform vec3 uCam,uSun;uniform float uWater,uAlpha,uBurn,uReflect,uTime;
float hash(vec3 p){return fract(sin(dot(floor(p*85.),vec3(12.9898,78.233,43.73)))*43758.5453);}
void main(){vec3 n=normalize(vNormal),v=normalize(uCam-vPos),l=normalize(uSun);if(!gl_FrontFacing)n=-n;float ndl=max(dot(n,l),0.),ndv=max(dot(n,v),.001);vec3 h=normalize(l+v);float rough=vParam.x,a=rough*rough,a2=a*a,nh=max(dot(n,h),0.),d=nh*nh*(a2-1.)+1.;float D=a2/(3.1415926*d*d+.00001);float k=(rough+1.)*(rough+1.)/8.;float G=ndl/(ndl*(1.-k)+k)*ndv/(ndv*(1.-k)+k);vec3 f0=rough<.15?vec3(.30,.34,.37):vec3(.06);vec3 F=f0+(1.-f0)*pow(1.-max(dot(h,v),0.),5.);vec3 spec=D*G*F/(4.*ndl*ndv+.001);vec3 albedo=vColor;
if(rough>.18&&vParam.y<2.){vec2 uv=vSurface.xy;vec2 edge=min(uv,vSurface.zw-uv);float ao=mix(.64,1.,smoothstep(0.,.025,min(edge.x,edge.y)));vec2 aa=max(fwidth(uv*2.35),vec2(.002));vec2 line=smoothstep(vec2(.488)-aa,vec2(.498)+aa,abs(fract(uv*2.35)-.5));float seam=max(line.x,line.y);float weather=texture(uNoise,(uv*12.+vColor.xy*87.)/256.).r;float micro=texture(uNoise,(uv*182.+5.)/256.).r;albedo*=ao*(.82+.19*weather+.035*micro)*(1.-seam*.13);if(vColor.r>vColor.g*1.25){float wrinkle=sin(uv.x*163.+sin(uv.y*83.)*2.)*sin(uv.y*109.+uv.x*31.);albedo*=.75+.25*wrinkle;}}
vec3 direct=albedo*ndl*.88+spec*ndl*.57;
vec3 fill=albedo*(mix(.016,.29,uWater)+max(n.y,0.)*mix(.015,.22,uWater));vec3 edge=vec3(.45,.55,.63)*pow(1.-ndv,4.)*.07;vec3 col=direct*mix(vec3(1.8,1.63,1.38),vec3(.88,.93,.94),uWater)+fill+edge;
if(rough<.15){vec3 r=reflect(-v,n);col+=mix(vec3(.015,.025,.035),vec3(.35,.42,.45),smoothstep(-.1,.8,r.y))*(.32+F*.6);}
float emission=vParam.y>=2.?uBurn*(vParam.y-1.):vParam.y;if(vParam.y>=2.)col=vec3(.006,.009,.011);col+=vColor*emission*2.0;if(uReflect>.1){col=mix(col,vec3(.20,.28,.28),.45);col*=.65;}
float fog=uWater*(1.-exp(-length(uCam-vPos)*.002));col=mix(col,vec3(.53,.57,.57),fog);frag=vec4(col,uAlpha);}`;

const particleVS = `#version 300 es
precision highp float;layout(location=0)in vec4 aSeed;uniform mat4 uVP,uModel;uniform float uTime,uKind,uAmount,uPixel;out vec4 vColor;
void main(){vec3 p;float size;
if(uKind<.5){float phase=fract(aSeed.x+uTime*.28);float ang=aSeed.y*6.2831853;float radius=(.5+phase*9.)*(.4+aSeed.z);p=vec3(cos(ang)*radius,sin(phase*3.14159)*(1.2+3.*aSeed.z),sin(ang)*radius*.75);size=(.4+aSeed.w*2.8);vColor=vec4(.68,.75,.76,(1.-phase)*.21*uAmount);}
else if(uKind<1.5){float t=uTime;vec3 dir=normalize(aSeed.xyz-.5);p=dir*(2.5+t*(.2+aSeed.w*.4));p.y-=t*.06;size=.07+aSeed.w*.11;vColor=vec4(.60,.54,.44,.65*uAmount);}
else if(uKind<2.5){float phase=fract(aSeed.x-uTime*1.4);float ang=aSeed.y*6.2831853;float radius=(.06+phase*.40)*aSeed.z;p=vec3(cos(ang)*radius,sin(ang)*radius,phase*(2.8+uAmount*1.3));size=.11+phase*.39;vColor=vec4(.35,.63,1.0,(1.-phase)*.34*min(uAmount,1.));}
else{float phase=fract(aSeed.x+uTime*.012);float ang=aSeed.y*6.2831853;p=vec3(cos(ang)*12.,sin(ang)*7.,-phase*18.);size=.007+aSeed.w*.025;vColor=vec4(.9,.77,.5,.6*uAmount);}
vec4 world=uModel*vec4(p,1.);vec4 clip=uVP*world;gl_Position=clip;gl_PointSize=clamp(size*uPixel/max(clip.w,.1),1.,uKind<.5?34.:14.);}`;

const particleFS = `#version 300 es
precision highp float;in vec4 vColor;out vec4 frag;void main(){float r=length(gl_PointCoord-.5)*2.;if(r>1.)discard;float f=exp(-r*r*4.)*(1.-smoothstep(.7,1.,r));frag=vec4(vColor.rgb,vColor.a*f);}`;

const blurFS = `#version 300 es
precision highp float;in vec2 vUV;out vec4 frag;uniform sampler2D uImage;uniform vec2 uStep;uniform float uFirst;
vec3 tap(vec2 uv){vec3 c=texture(uImage,uv).rgb;if(uFirst>.5)c=max(c-vec3(.64),vec3(0.));return c;}
void main(){vec3 c=tap(vUV)*.227027;c+=(tap(vUV+uStep*1.384615)+tap(vUV-uStep*1.384615))*.316216;c+=(tap(vUV+uStep*3.230769)+tap(vUV-uStep*3.230769))*.070270;frag=vec4(c,1.);}`;

const postFS = `#version 300 es
precision highp float;in vec2 vUV;out vec4 frag;uniform sampler2D uImage,uBloom,uSky;uniform vec2 uRes;uniform float uTime,uFade,uWarp,uRollBlur,uCockpit,uDroplet,uFlash,uExposure;
float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
float line(vec2 p,vec2 a,vec2 b){vec2 pa=p-a,ba=b-a;return length(pa-ba*clamp(dot(pa,ba)/dot(ba,ba),0.,1.));}
vec3 drop(vec3 c,vec2 uv,vec2 center,vec2 sz,float strength){vec2 p=(uv-center)/sz;float r=length(p);if(r<1.08){float edge=1.-smoothstep(.94,1.015,r);float z=sqrt(max(0.,1.-r*r));vec2 refr=center+p*sz*.56-vec2(.006,.009)*(1.-z);vec3 inner=texture(uImage,refr).rgb;float a=atan(p.y,p.x);vec2 skyuv=vec2(a/6.2831853+.5+uTime*.07,acos(clamp(z,-1.,1.))/3.14159);vec3 galaxy=pow(texture(uSky,skyuv).rgb,vec3(1.5));inner=mix(inner,galaxy*1.6,.28+.47*pow(r,5.));float glint=pow(max(dot(normalize(vec3(p,z)),normalize(vec3(-.4,.6,.8))),0.),85.);inner+=vec3(.9,.94,.95)*glint*1.7;inner+=vec3(.28,.31,.33)*exp(-abs(r-.96)*75.);c=mix(c,inner,edge*strength);c*=1.-exp(-abs(r-1.025)*80.)*.12*strength;}return c;}
void main(){vec2 uv=vUV,q=uv-.5;vec2 ca=q*dot(q,q)*(.0015+uWarp*.018);vec3 c;c.r=texture(uImage,uv+ca).r;c.g=texture(uImage,uv).g;c.b=texture(uImage,uv-ca).b;
if(uRollBlur>.001){vec2 vel=vec2(-q.y,q.x)*uRollBlur;c=c*.44+(texture(uImage,uv+vel).rgb+texture(uImage,uv-vel).rgb)*.21+(texture(uImage,uv+vel*2.).rgb+texture(uImage,uv-vel*2.).rgb)*.07;}
vec2 pixel=1./uRes;vec3 nw=texture(uImage,uv+pixel*vec2(-1.,-1.)).rgb,ne=texture(uImage,uv+pixel*vec2(1.,-1.)).rgb,sw=texture(uImage,uv+pixel*vec2(-1.,1.)).rgb,se=texture(uImage,uv+pixel).rgb;vec3 lum=vec3(.299,.587,.114);float lnw=dot(nw,lum),lne=dot(ne,lum),lsw=dot(sw,lum),lse=dot(se,lum),lc=dot(c,lum);float lo=min(lc,min(min(lnw,lne),min(lsw,lse))),hi=max(lc,max(max(lnw,lne),max(lsw,lse)));if(hi-lo>max(.035,hi*.16)){vec2 dir=vec2(-((lnw+lne)-(lsw+lse)),(lnw+lsw)-(lne+lse));float reduce=max((lnw+lne+lsw+lse)*.03125,.0078125);dir=clamp(dir/(min(abs(dir.x),abs(dir.y))+reduce),vec2(-5.),vec2(5.))*pixel;vec3 aa=(texture(uImage,uv-dir*.166667).rgb+texture(uImage,uv+dir*.166667).rgb)*.5;c=mix(c,aa,.78);}
vec3 bloom=texture(uBloom,uv).rgb;c+=bloom*.30;for(int i=1;i<5;i++){float off=float(i)*.013;c+=(texture(uBloom,uv+vec2(off,0)).rgb+texture(uBloom,uv-vec2(off,0)).rgb)*(.022/float(i));}
if(uDroplet>.0){c=drop(c,uv,vec2(.715,.54-uDroplet*.012),vec2(.024,.073),uDroplet);c=drop(c,uv,vec2(.674,.67),vec2(.005,.014),uDroplet*.65);c=drop(c,uv,vec2(.79,.38),vec2(.003,.010),uDroplet*.6);}
if(uCockpit>.0){vec2 p=uv*2.-1.;float side=1.-smoothstep(.035,.055,line(p,vec2(-.69,-1.),vec2(-1.07,.92)));side=max(side,1.-smoothstep(.035,.055,line(p,vec2(.69,-1.),vec2(1.07,.92))));side=max(side,smoothstep(.85,.87,-p.y+abs(p.x)*.12));side=max(side,smoothstep(.96,.98,p.y));vec3 metal=vec3(.008,.012,.015)+vec3(.018)*hash(floor(uv*uRes));c=mix(c,metal,side*uCockpit);float edge=exp(-abs(line(p,vec2(-.69,-1.),vec2(-1.07,.92))-.059)*250.);edge+=exp(-abs(line(p,vec2(.69,-1.),vec2(1.07,.92))-.059)*250.);c+=edge*vec3(.035,.044,.051)*uCockpit;for(int i=0;i<9;i++){vec2 led=vec2(-.23+float(i)*.057,-.925);c+=vec3(.26,.14,.04)*exp(-length((p-led)*vec2(1.,2.))*240.)*uCockpit;}}
c+=vec3(uFlash);c=aces(c*uExposure);c=pow(c,vec3(1./2.2));float vignette=1.-dot(q*vec2(.78,1.),q*vec2(.78,1.))*.52;c*=vignette;float grain=(hash(uv*uRes+floor(uTime*24.)*17.73)-.5)*.014;c+=grain;c*=uFade;frag=vec4(max(c,vec3(0.)),1.);}`;

// --- Geometry builders (verbatim logic) -------------------------------------

interface MeshData {
  vao: WebGLVertexArrayObject;
  count: number;
}

class Builder {
  data: number[] = [];
  gl: GL;
  constructor(gl: GL) {
    this.gl = gl;
  }
  face(
    points: number[][],
    col: number[] = [0.65, 0.66, 0.63],
    rough = 0.48,
    em = 0,
    m: Float32Array | null = null,
  ) {
    let n = norm(cross(sub(points[1], points[0]), sub(points[2], points[0])));
    if (m) {
      points = points.map((p) => transform(m, p));
      n = norm(transform(m, n, 0));
    }
    let tx = norm(sub(points[1], points[0])),
      ty = cross(n, tx);
    let uv = points.map((p) => [dot(sub(p, points[0]), tx), dot(sub(p, points[0]), ty)]);
    let ux = Math.min(...uv.map((v) => v[0])),
      uy = Math.min(...uv.map((v) => v[1]));
    let sx = Math.max(...uv.map((v) => v[0])) - ux,
      sy = Math.max(...uv.map((v) => v[1])) - uy;
    for (let i = 1; i < points.length - 1; i++)
      for (const j of [0, i, i + 1])
        this.data.push(...points[j], ...n, ...col, rough, em, uv[j][0] - ux, uv[j][1] - uy, sx, sy);
  }
  outward(
    points: number[][],
    col: number[],
    rough: number,
    em: number,
    m: Float32Array | null = null,
  ) {
    const center = mul(
      points.reduce((a, p) => add(a, p as Vec3), [0, 0, 0]),
      1 / points.length,
    );
    const n = cross(sub(points[1], points[0]), sub(points[2], points[0]));
    if (dot(center, n) < 0) points = points.slice().reverse();
    this.face(points, col, rough, em, m);
  }
  box(
    pos: number[],
    size: number[],
    col: number[] = [0.65, 0.66, 0.63],
    rot: number[] = [0, 0, 0],
    bevel = 0.035,
    rough = 0.48,
    em = 0,
  ) {
    const m = matrix(pos, rot),
      h = size.map((v) => v / 2),
      b = Math.min(bevel, ...h.map((v) => v * 0.35));
    for (let axis = 0; axis < 3; axis++) {
      const j = (axis + 1) % 3,
        k = (axis + 2) % 3;
      for (const sign of [-1, 1]) {
        const pts: number[][] = [];
        for (const [sj, sk] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ]) {
          let p = [0, 0, 0];
          p[axis] = sign * h[axis];
          p[j] = sj * (h[j] - b);
          p[k] = sk * (h[k] - b);
          pts.push(p);
        }
        this.outward(pts, col, rough, em, m);
      }
    }
    if (b > 0) {
      for (let a = 0; a < 3; a++)
        for (let baxis = a + 1; baxis < 3; baxis++) {
          let c = 3 - a - baxis;
          for (let sa of [-1, 1])
            for (let sb of [-1, 1]) {
              let pts: number[][] = [];
              for (let [e, sc] of [
                [0, -1],
                [1, -1],
                [1, 1],
                [0, 1],
              ]) {
                let p = [0, 0, 0];
                p[a] = sa * (h[a] - (e ? b : 0));
                p[baxis] = sb * (h[baxis] - (e ? 0 : b));
                p[c] = sc * (h[c] - b);
                pts.push(p);
              }
              this.outward(pts, col, rough * 0.9, em, m);
            }
        }
      for (let sx of [-1, 1])
        for (let sy of [-1, 1])
          for (let sz of [-1, 1]) {
            let pts = [
              [sx * h[0], sy * (h[1] - b), sz * (h[2] - b)],
              [sx * (h[0] - b), sy * h[1], sz * (h[2] - b)],
              [sx * (h[0] - b), sy * (h[1] - b), sz * h[2]],
            ];
            this.outward(pts, col, rough, em, m);
          }
    }
    return this;
  }
  cylinder(
    pos: number[],
    r: number,
    length: number,
    col: number[] = [0.4, 0.42, 0.42],
    rot: number[] = [0, 0, 0],
    segments = 20,
    rough = 0.4,
    inner = 0,
    em = 0,
  ) {
    let m = matrix(pos, rot);
    for (let i = 0; i < segments; i++) {
      let a = (i * TAU) / segments,
        b = ((i + 1) * TAU) / segments;
      let p0 = [Math.cos(a) * r, Math.sin(a) * r, -length / 2],
        p1 = [Math.cos(b) * r, Math.sin(b) * r, -length / 2],
        p2 = [p1[0], p1[1], length / 2],
        p3 = [p0[0], p0[1], length / 2];
      this.face([p0, p1, p2, p3], col, rough, em, m);
      if (inner > 0) {
        let q0 = [Math.cos(a) * inner, Math.sin(a) * inner, -length / 2],
          q1 = [Math.cos(b) * inner, Math.sin(b) * inner, -length / 2],
          q2 = [q1[0], q1[1], length / 2],
          q3 = [q0[0], q0[1], length / 2];
        this.face([q1, q0, q3, q2], col, rough, em, m);
        this.face([p3, p2, q2, q3], col, rough, em, m);
        this.face([p1, p0, q0, q1], col, rough, em, m);
      } else {
        this.face([[0, 0, length / 2], p3, p2], col, rough, em, m);
        this.face([[0, 0, -length / 2], p1, p0], col, rough, em, m);
      }
    }
    return this;
  }
  rod(a: number[], b: number[], r: number, col: number[] = [0.3, 0.33, 0.33], rough = 0.36) {
    let d = sub(a as Vec3, b as Vec3),
      f = norm(d),
      right = norm(cross(Math.abs(f[1]) > 0.96 ? [1, 0, 0] : [0, 1, 0], f)),
      up = cross(f, right);
    let m = new Float32Array([
      ...right,
      0,
      ...up,
      0,
      ...f,
      0,
      ...mul(add(a as Vec3, b as Vec3), 0.5),
      1,
    ]);
    let len = Math.hypot(...d);
    for (let i = 0; i < 8; i++) {
      let x = (i * TAU) / 8,
        y = ((i + 1) * TAU) / 8;
      this.face(
        [
          [r * Math.cos(x), r * Math.sin(x), -len / 2],
          [r * Math.cos(y), r * Math.sin(y), -len / 2],
          [r * Math.cos(y), r * Math.sin(y), len / 2],
          [r * Math.cos(x), r * Math.sin(x), len / 2],
        ],
        col,
        rough,
        0,
        m,
      );
    }
    return this;
  }
  sphere(
    pos: number[],
    r: number,
    col: number[],
    scale: number[] = [1, 1, 1],
    rough = 0.4,
    em = 0,
  ) {
    let m = matrix(pos, [0, 0, 0], scale);
    for (let i = 0; i < 10; i++)
      for (let j = 0; j < 16; j++) {
        let pts: number[][] = [];
        for (const [di, dj] of [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
        ]) {
          let a = ((i + di) * PI) / 10,
            b = ((j + dj) * TAU) / 16;
          pts.push([r * Math.sin(a) * Math.cos(b), r * Math.cos(a), r * Math.sin(a) * Math.sin(b)]);
        }
        this.outward(pts, col, rough, em, m);
      }
    return this;
  }
  mesh(): MeshData {
    const gl = this.gl;
    let vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    let buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.data), gl.STATIC_DRAW);
    const stride = 60;
    for (const [i, size, offset] of [
      [0, 3, 0],
      [1, 3, 12],
      [2, 3, 24],
      [3, 2, 36],
      [4, 4, 44],
    ] as const) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, size, gl.FLOAT, false, stride, offset);
    }
    return { vao, count: this.data.length / 15 };
  }
}

// --- Timeline ---------------------------------------------------------------
// Original chapter layout: wormhole [0,44) ocean [44,106) docking [106,151)
// black hole [151,206). The auth screen plays chapters in REVERSE order via
// reverseTime(): black hole -> docking -> ocean -> wormhole. Chapter cuts keep
// their own 0.55s crossfades, so every seam stays a smooth fade.

const DURATION = 206;
const cutStarts = [0, 13, 24, 32, 44, 55, 68, 80, 92, 106, 118, 130, 142, 151, 165, 176, 190, 206];

// Reversed chapter starts for the chapter indicator: black hole at 0s.
const REVERSE_CHAPTER_STARTS = [0, 55, 100, 162];
export const FILM_DURATION = DURATION;
export const FILM_CHAPTER_LABELS = ["坠入黑洞", "旋转对接", "海水星球", "进入虫洞"] as const;

function reverseTime(t: number) {
  if (t < 55) return 151 + t; // black hole  [151, 206)
  if (t < 100) return 106 + (t - 55); // docking     [106, 151)
  if (t < 162) return 44 + (t - 100); // ocean world [44, 106)
  return t - 162; // wormhole    [0, 44)
}

function getShot(t: number) {
  let i = 0;
  while (i + 1 < cutStarts.length && t >= cutStarts[i + 1]) i++;
  return Math.min(i, 16);
}

type SceneObject = {
  mesh: MeshData;
  p: number[];
  r: number[];
  scale: number | number[];
  alpha: number;
  burn: number;
  reflection: number;
};
type SceneParticle = {
  p: number[];
  r: number[];
  scale: number;
  kind: number;
  amount: number;
  time: number;
  count: number;
};

type Scene = {
  shot: number;
  mode: number;
  local: number;
  phase: number;
  wave: number;
  dilate: number;
  cloud: number;
  cam: number[];
  target: number[];
  roll: number;
  fov: number;
  sun: Vec3;
  objects: SceneObject[];
  particles: SceneParticle[];
  warp: number;
  blur: number;
  cockpit: number;
  drop: number;
  exposure: number;
  flash: number;
  fade: number;
  craft?: Vec3;
};

function stateAt(t: number, meshes: MeshSet): Scene {
  const shot = getShot(t),
    a = cutStarts[shot],
    b = cutStarts[shot + 1],
    v = clamp((t - a) / (b - a)),
    s = smooth(v),
    st = t - a;
  const S: Scene = {
    shot,
    mode: 0,
    local: t,
    phase: v,
    wave: -430,
    dilate: 0,
    cloud: 0,
    cam: [0, 1, 18],
    target: [0, 0, 0],
    roll: 0,
    fov: 48,
    sun: norm([-0.75, 0.45, 0.85]),
    objects: [],
    particles: [],
    warp: 0,
    blur: 0,
    cockpit: 0,
    drop: 0,
    exposure: 1,
    flash: 0,
    fade: 1,
  };
  const O = (
    mesh: MeshData,
    p: number[],
    r: number[] = [0, 0, 0],
    scale: number | number[] = 1,
    alpha = 1,
    burn = 0,
    reflection = 0,
  ) => S.objects.push({ mesh, p, r, scale, alpha, burn, reflection });
  const P = (
    p: number[],
    r: number[],
    scale: number,
    kind: number,
    amount: number,
    time: number,
    count: number,
  ) => S.particles.push({ p, r, scale, kind, amount, time, count });
  const ship = (p: number[], r: number[], sc: number, burn = 0, land = false, reflect = false) => {
    const craftMesh = shot >= 9 && shot <= 12 ? meshes.lander : meshes.ranger;
    if (reflect) {
      O(meshes.ranger, [p[0], -p[1], p[2]], [-r[0], r[1], -r[2]], [sc, -sc, sc], 0.21, 0, 1);
      if (land)
        O(meshes.gear, [p[0], -p[1], p[2]], [-r[0], r[1], -r[2]], [sc, -sc, sc], 0.12, 0, 1);
    }
    O(craftMesh, p, r, sc, 1, burn);
    if (land) O(meshes.gear, p, r, sc);
    if (burn > 0.01) {
      let m = matrix(p, r, sc);
      for (const pos of craftMesh === meshes.lander
        ? [
            [-1.45, -0.39, 3.36],
            [-1.45, 0.43, 3.36],
            [1.45, -0.39, 3.36],
            [1.45, 0.43, 3.36],
          ]
        : [
            [-0.83, -0.1, 3.2],
            [0.83, -0.1, 3.2],
          ])
        P(transform(m, pos), r, sc, 2, burn, t, 250);
    }
    S.craft = p as Vec3;
  };
  if (shot === 0) {
    S.cam = lerp([8, 2.6, 20], [5.8, 1.8, 17.3], s);
    S.target = [0, 0.1, 0];
    S.fov = 47;
    O(meshes.endurance, [-3.65, -0.9, 6.0], [0.14, -0.43, t * 0.074], 0.28);
  } else if (shot === 1) {
    S.cam = lerp([4.4, 1.1, 10.3], [3.25, 0.68, 8.9], s);
    S.target = [-0.35, 0.05, 0.7];
    S.fov = 52;
    O(meshes.endurance, [-1.63, -0.7, 4.9], [0.18, -0.35, t * 0.074], 0.245);
  } else if (shot === 2) {
    S.cam = lerp([0.95, 0.26, 7.1], [0.02, 0.01, 3.16], s);
    S.target = [0, 0, -2];
    S.fov = mix(52, 64, s);
    O(
      meshes.endurance,
      [0, -0.38, 2.5 - s * 0.8],
      [0.1, -0.15, t * 0.074],
      mix(0.12, 0.021, s),
      1 - smooth((v - 0.62) / 0.23),
    );
    S.warp = s * 0.25;
  } else if (shot === 3) {
    S.mode = 1;
    S.cam = [0, 0, 12];
    S.target = [0, 0, 0];
    S.roll = Math.sin(st * 0.4) * 0.2;
    S.fov = 64;
    S.warp = 0.5 + 0.4 * Math.sin(v * PI);
    S.blur = 0.008;
    S.exposure = 0.8;
    O(
      meshes.endurance,
      [0.08 * Math.sin(st), -0.29, 0],
      [0.1, 0.1, t * 0.21],
      0.04 * (1 - s),
      0.32 * (1 - s),
    );
  } else if (shot >= 4 && shot <= 8) {
    S.mode = 2;
    S.local = t - 44;
    S.fov = 48;
    S.sun = norm([-0.55, 0.69, 0.58]);
    S.exposure = 0.9;
    if (shot === 4) {
      let p = [0, mix(105, 18, s), 0];
      S.cam = lerp([35, 139, 88], [24, 39, 50], s);
      S.target = add(p, [0, 0, -5]);
      S.roll = -0.08 + 0.05 * s;
      S.fov = 52;
      S.cloud = 0.77 * (1 - s);
      S.wave = -650 + s * 80;
      ship(p, [0.1, -0.15, 0.04], 2.1, 0.34, false);
    }
    if (shot === 5) {
      let y = 2.58 + 12 * Math.pow(1 - s, 2);
      let p = [0, y, 0];
      S.cam = lerp([23, 8, 28], [16, 3.5, 23], s);
      S.target = [0, 3, -2];
      S.wave = -510 + s * 60;
      S.fov = 49;
      ship(p, [0.015, mix(-0.15, 1.86, s), 0.008 * Math.sin(t)], 1.9, 0.55 * (1 - s), true, true);
      P([0, 0.1, 0], [0, 0, 0], 1.5, 0, Math.sin(v * PI) * 1.4 + 0.13, t, 1200);
    }
    if (shot === 6) {
      S.cam = lerp([-22, 2.6, 39], [-17.0, 1.9, 32], s);
      S.target = [0, 26, -150];
      S.wave = -278 + s * 30;
      S.fov = 54;
      ship([0, 2.6, -1], [0, 1.86, 0], 1.9, 0, true, true);
      O(meshes.astronaut, [9 + v * 0.7, 0, 5.5 - v * 1.9], [0, -0.5, 0.01 * Math.sin(t * 2)], 1.05);
      O(meshes.astronaut, [11, 0, -12.5 - v * 0.7], [0, 0.1, 0], 0.99);
      O(meshes.robot, [4.7, 0, 3.5], [0, -0.22, 0], 1);
    }
    if (shot === 7) {
      S.cam = lerp([13, 1.8, 31], [12, 1.65, 29.6], s);
      S.target = [-3, 24, -125];
      S.wave = -210 + v * 1.2;
      S.dilate = smooth(v * 7) * smooth((1 - v) * 7);
      S.drop = S.dilate;
      S.fov = 50;
      ship([-3, 2.6, -8], [0, 1.86, 0], 1.9, 0, true, true);
      O(meshes.astronaut, [5.0, 0.01, -4.6 - v * 0.05], [0, -0.13, 0], 1.08);
      O(meshes.robot, [1.5, 0.01, -9], [0, 0.2, 0], 1);
      S.sun = norm([Math.cos(t * 0.69) * 0.8, 0.7, 0.6 + Math.sin(t * 0.69) * 0.4]);
      S.exposure = 0.83 + 0.07 * Math.sin(t * 1.5);
      P([7, 0.08, -4], [0, 0, 0], 0.28, 0, 0.32, 31 + st * 0.035, 160);
    }
    if (shot === 8) {
      let lift = Math.pow(clamp((v - 0.13) / 0.87), 1.8);
      let p = [0, 2.65 + lift * 93, v * v * 34];
      S.cam = lerp([28, 7.2, 29], [55, 27, 77], s);
      S.target = add(p, [0, 5, -7]);
      S.fov = 53;
      S.roll = Math.sin(st * 5) * 0.004 * (1 - v);
      S.wave = -159 + v * 87;
      S.cloud = smooth((v - 0.86) / 0.14) * 0.38;
      ship(
        p,
        [-0.12 * s, mix(1.86, PI - 0.18, s), 0.025 * Math.sin(st * 0.7)],
        1.9,
        0.3 + smooth(v * 4) * 0.8,
        v < 0.24,
        v < 0.26,
      );
      P([0, 0.2, 0], [0, 0, 0], 2.1, 0, 1.4 * (1 - smooth(v * 2.4)), t, 1300);
    }
  } else if (shot >= 9 && shot <= 12) {
    S.mode = 3;
    S.local = t - 106;
    let d = S.local;
    let spin = d < 36 ? d * 1.57 : 36 * 1.57 + 1.57 * (d - 36 - ((d - 36) * (d - 36)) / 18);
    S.sun = norm([0.65, 0.47, 0.79]);
    S.exposure = 0.91;
    let ringR: number[] = [0.07, 0.045, spin];
    if (shot === 9) {
      S.cam = lerp([14, 7.5, 27], [10.8, 5, 24], s);
      S.target = [0, 0, 1];
      S.fov = 51;
      ship(lerp([8, -5.7, 17], [6, -3.8, 12.5], s), [0.06, -0.15, spin * 0.1], 0.65, 0.24);
      S.flash = 0.15 * Math.exp(-st * 2.3);
    }
    if (shot === 10) {
      S.cam = lerp([3.0, -1, 22], [0.8, -0.3, 15.4], s);
      S.target = [0, 0, 0];
      S.fov = 53;
      S.roll = spin * s * 0.24;
      ship(
        [mix(3, 0, s), mix(-2, 0, s), mix(11.5, 7.1, s)],
        [0, 0, mix(spin * 0.18, spin, s)],
        0.65,
        0.52,
      );
      S.blur = 0.006;
    }
    if (shot === 11) {
      S.cam = lerp([0, 0, 13.5], [0, 0, 7.4], s);
      S.target = [0, 0, 0];
      S.roll = spin;
      S.fov = 59;
      S.cockpit = smooth(st * 3) * smooth((12 - st) * 3);
      S.blur = 0.003;
      ringR = [0, 0, spin];
    }
    if (shot === 12) {
      let base = lerp([8.3, 2, 9], [5.2, 1.0, 7], s),
        m = matrix([0, 0, 0], [0, 0, spin]);
      S.cam = transform(m, base);
      S.target = [0, 0, 2.6];
      S.roll = spin;
      S.fov = 49;
      ringR = [0, 0, spin];
      ship([0, 0, mix(4.3, 4.04, s)], [0, 0, spin], 0.65, mix(0.75, 0.16, s));
      S.blur = 0.003 * (1 - s);
    }
    O(meshes.damagedEndurance, [0, 0, 0], ringR, 1);
    for (let i = 0; i < meshes.debris.length; i++) {
      const q = meshes.debris[i];
      let p = add(q.p as Vec3, mul(q.v as number[], d + 3));
      if (Math.hypot(p[0], p[1]) < 5) p[1] += 6;
      O(
        meshes.shard,
        p,
        q.r.map((r, j) => r + d * (j + 1) * 0.055),
        q.s,
      );
    }
    P([0, 4.9, 0], [0, 0, 0], 1, 1, 0.48, d, 350);
  } else {
    S.mode = 4;
    S.local = t - 151;
    S.sun = norm([-0.7, 0.2, -0.45]);
    S.exposure = 0.87;
    S.fov = 49;
    if (shot === 13) {
      S.cam = lerp([0.3, 3.0, 25], [1.0, 2.75, 23], s);
      S.target = [0, 0, 0];
      O(meshes.damagedEndurance, [3.2, 0.45, 17.7], [0.38, 0.51, t * 0.092], 0.102);
      ship([3.2, 0.44, 18.1], [0, 0, t * 0.092], 0.045, 0.05);
    }
    if (shot === 14) {
      S.cam = lerp([3.0, 2, 19.4], [2.2, 1.65, 16.2], s);
      S.target = [0, 0, 0];
      O(
        meshes.damagedEndurance,
        lerp([2.4, -0.08, 12.4], [3.9, 0.7, 10.5], s),
        [0.37, 0.65, t * 0.09],
        0.105,
      );
      let p = lerp([2.2, -0.3, 12.8], [0.25, -0.62, 7.6], s);
      ship(p, [0.22, -0.2, t * 0.25], 0.075, 0.12 * (1 - s));
    }
    if (shot === 15) {
      S.cam = lerp([1.15, 1.37, 14.4], [0.35, 0.45, 5.5], s);
      S.target = [0, 0, 0];
      S.fov = mix(49, 60, s);
      let p = lerp([0.38, -0.25, 6.5], [0.02, -0.055, 1.8], Math.pow(s, 0.8));
      let r = [t * 0.13, t * 0.31, t * 0.25];
      for (let i = 3; i >= 1; i--) {
        let q = add(p as Vec3, [i * 0.07, -i * 0.014, i * 0.23]);
        O(
          meshes.ranger,
          q,
          r.map((x) => x - i * 0.06),
          0.054,
          0.065 * (1 - i / 5) * Math.sin(v * PI),
        );
      }
      ship(p, r, 0.055, 0);
      S.warp = 0.06 + s * 0.2;
      S.blur = 0.002 + s * 0.009;
      S.roll = v * v * 0.27;
      P(add(S.cam as Vec3, [0, 0, -1]), [0, 0, 0], 1, 3, s * 0.7, t, 350);
    }
    if (shot === 16) {
      S.cam = lerp([0.28, 0.38, 5.45], [0, 0.008, 0.81], Math.pow(s, 0.8));
      S.target = [0, 0, 0];
      S.fov = mix(61, 94, s);
      S.roll = 0.27 + s * 1.7;
      S.warp = 0.15 + Math.sin(v * PI) * 0.6;
      S.blur = 0.002 + Math.sin(v * PI) * 0.015;
      S.exposure = 0.87 * (1 - smooth((v - 0.71) / 0.23));
      if (v < 0.62)
        P(add(S.cam as Vec3, [0, 0, -0.2]), [0, 0, 0], 0.1, 3, Math.sin(v * PI) * 0.6, t, 700);
    }
  }
  let fade = smooth(t / 1.8);
  if (t > 202) fade *= 1 - smooth((t - 202) / 2);
  for (const start of [44, 106, 151])
    if (Math.abs(t - start) < 0.55) fade *= smooth(Math.abs(t - start) / 0.55);
  S.fade = fade;
  if ([3, 4, 8, 10, 16].includes(shot)) {
    let amp = shot === 8 ? 0.023 : shot === 4 ? 0.012 : shot === 3 ? 0.014 : 0.004;
    S.cam = add(S.cam as Vec3, [Math.sin(t * 17.3) * amp, Math.sin(t * 23.7 + 0.3) * amp, 0]);
  }
  return S;
}

// --- Render targets ---------------------------------------------------------

type RenderTarget = {
  tex: WebGLTexture;
  fb: WebGLFramebuffer;
  db: WebGLRenderbuffer | null;
  w: number;
  h: number;
};

// --- Public API -------------------------------------------------------------

export type InterstellarChapter = 0 | 1 | 2 | 3;

export interface InterstellarFilm {
  destroy(): void;
  setPaused(paused: boolean): void;
  /** Fired whenever the reversed playback enters a new chapter (0 = black hole). */
  onChapter(listener: (chapter: InterstellarChapter) => void): void;
  /** 仅 stills 模式返回：素材构建完成后 resolve，之后可逐帧离线渲染。 */
  ready?: Promise<void>;
  /** 仅 stills 模式返回：把指定时间点的画面同步渲染到画布（离线采集用）。 */
  renderAt?(seconds: number): void;
}

interface MeshSet {
  endurance: MeshData;
  damagedEndurance: MeshData;
  ranger: MeshData;
  lander: MeshData;
  gear: MeshData;
  astronaut: MeshData;
  robot: MeshData;
  shard: MeshData;
  debris: Array<{ p: number[]; v: number[]; r: number[]; s: number }>;
}

/**
 * @param options.stills 离线采集模式：跳过软渲染守卫（无头浏览器用 SwiftShader
 *   逐帧渲染，帧率无关紧要）、不挂任何交互/可见性监听、构建完成后不启动播放
 *   循环；改用 `ready` + `renderAt(秒)` 由外部逐帧驱动。渲染是纯时间驱动且
 *   随机种子固定，同一时间点的画面完全确定，可离线重放整部电影。
 */
export function createInterstellarFilm(
  canvas: HTMLCanvasElement,
  options: { stills?: boolean } = {},
): InterstellarFilm | null {
  const stills = options.stills === true;
  // stills 采集模式额外开 preserveDrawingBuffer：没有 rAF 循环时，合成器何时
  // 取帧不确定，Preserve 保证截图/离线读回永远拿到最后一次渲染的完整画面。
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    powerPreference: "high-performance",
    ...(stills ? { preserveDrawingBuffer: true } : {}),
  }) as GL | null;
  if (!gl) return null;
  // 软件渲染守卫：SwiftShader / llvmpipe / 远程桌面的基本显示适配跑不动这套
  // 逐像素光线追踪（海洋 78 步 raymarch、黑洞 118 步积分），会把登录首屏整页
  // 拖成幻灯片。直接放弃电影——auth-screen 的深空渐变兜底本身就是无电影外观。
  // stills 采集模式例外：离线逐帧渲染不在乎帧率，恰好要靠软渲染出帧。
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  const gpuName = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : "";
  if (!stills && /swiftshader|llvmpipe|software renderer|basic render/i.test(gpuName)) return null;
  const floating = !!gl.getExtension("EXT_color_buffer_float");

  let envP: ProgramBundle,
    meshP: ProgramBundle,
    particleP: ProgramBundle,
    blurP: ProgramBundle,
    postP: ProgramBundle;
  try {
    envP = makeProgram(gl, "environment", fullVS, envFS);
    meshP = makeProgram(gl, "spacecraft", meshVS, meshFS);
    particleP = makeProgram(gl, "particles", particleVS, particleFS);
    blurP = makeProgram(gl, "bloom", fullVS, blurFS);
    postP = makeProgram(gl, "optics", fullVS, postFS);
  } catch {
    return null;
  }

  const emptyVAO = gl.createVertexArray();
  const white = [0.58, 0.6, 0.58],
    gray = [0.24, 0.27, 0.27],
    dark = [0.035, 0.045, 0.048],
    foil = [0.31, 0.21, 0.09],
    steel = [0.36, 0.39, 0.4],
    glass = [0.006, 0.013, 0.021];

  const buildMesh = (build: (b: Builder) => void) => {
    const b = new Builder(gl);
    build(b);
    return b.mesh();
  };
  const makeEndurance = (damaged = false) =>
    buildMesh((b) => {
      for (let i = 0; i < 12; i++) {
        let a = (i * TAU) / 12 + PI / 12,
          m = matrix([Math.cos(a) * 5.1, Math.sin(a) * 5.1, 0], [0, 0, a - PI / 2]);
        const B = (
          p: number[],
          s: number[],
          c: number[] = white,
          r: number[] = [0, 0, 0],
          be = 0.025,
          ro = 0.5,
          em = 0,
        ) => {
          let p2 = transform(m, p);
          b.box(p2, s, c, [r[0], r[1], r[2] + a - PI / 2], be, ro, em);
        };
        if (damaged && i === 2) {
          for (let j = 0; j < 9; j++) {
            let pp = transform(m, [(rand() - 0.5) * 2, (rand() - 0.5) * 0.6, (rand() - 0.5) * 0.7]);
            b.box(
              pp,
              [0.2 + rand() * 0.4, 0.12 + rand() * 0.2, 0.13],
              j % 3 === 0 ? [0.1, 0.045, 0.017] : [0.08, 0.09, 0.09],
              [rand(), rand(), a],
              0.012,
              0.65,
              j === 3 ? 0.28 : 0,
            );
          }
          continue;
        }
        B([0, 0, 0], [2.27, 1.16, 1.34]);
        B([0, 0.04, 0], [2.4, 0.54, 0.9], gray, [0, 0, 0], 0.035, 0.42);
        B([0, 0, 0.67], [2.08, 1.04, 0.1], white);
        B([0, 0, -0.67], [2.08, 1.04, 0.1], [0.38, 0.4, 0.38]);
        for (const side of [-1, 1]) {
          for (let j = 0; j < 5; j++) {
            B(
              [-0.85 + j * 0.425, 0.03, side * 0.732],
              [0.34, 0.76, 0.023],
              j === 1 ? foil : [0.29, 0.32, 0.32],
              [0, 0, 0],
              0.006,
              0.42,
            );
            for (let k = 0; k < 4; k++)
              B(
                [-0.85 + j * 0.425, -0.28 + k * 0.2, side * 0.752],
                [0.285, 0.014, 0.008],
                [0.11, 0.14, 0.14],
                [0, 0, 0],
                0,
                0.4,
              );
          }
          B([0, -0.42, side * 0.73], [2.08, 0.08, 0.065], white);
          B([0, 0.47, side * 0.73], [2.08, 0.07, 0.055], white);
          B(
            [0.93, 0.32, side * 0.78],
            [0.06, 0.06, 0.035],
            side === 1 ? [0.1, 0.17, 0.19] : [0.24, 0.045, 0.015],
            [0, 0, 0],
            0.009,
            0.3,
            0.32,
          );
        }
        B([0.52, 0.61, 0], [0.65, 0.13, 1.08], dark);
        for (let j = 0; j < 7; j++)
          B([0.25 + j * 0.087, 0.685, 0], [0.022, 0.017, 0.93], steel, [0, 0, 0], 0, 0.3);
        B([-0.62, 0.64, 0], [0.5, 0.2, 0.59], foil);
        B([-0.6, 0.8, 0], [0.42, 0.05, 0.51], white);
        for (const side of [-1, 1]) {
          const p0 = transform(m, [side * 1.1, 0, 0]),
            p1 = transform(m, [side * 1.4, 0, 0]);
          b.rod(p0, p1, 0.17, steel);
          b.rod(transform(m, [-1, -0.42, 0.49]), transform(m, [1, -0.42, 0.49]), 0.025, steel);
        }
        const a2 = a + TAU / 12;
        b.rod(
          [Math.cos(a) * 4.4, Math.sin(a) * 4.4, -0.3],
          [Math.cos(a2) * 4.4, Math.sin(a2) * 4.4, -0.3],
          0.047,
          steel,
        );
      }
      for (let i = 0; i < 3; i++) {
        let a = (i * TAU) / 3 + PI / 2;
        let tip = [Math.cos(a) * 4.65, Math.sin(a) * 4.65, -0.2];
        b.rod([Math.cos(a) * 0.44, Math.sin(a) * 0.44, 0], tip, 0.1, white);
        b.rod(
          [Math.cos(a + 0.2) * 0.48, Math.sin(a + 0.2) * 0.48, 0.38],
          [tip[0], tip[1], 0.28],
          0.035,
          steel,
        );
        b.rod(
          [Math.cos(a - 0.2) * 0.48, Math.sin(a - 0.2) * 0.48, -0.38],
          [tip[0], tip[1], -0.28],
          0.035,
          steel,
        );
      }
      b.cylinder([0, 0, 0], 0.57, 0.89, gray, [0, 0, 0], 28, 0.36);
      b.cylinder([0, 0, 0.63], 0.46, 0.45, white, [0, 0, 0], 28, 0.42, 0.3);
      b.cylinder([0, 0, 1.0], 0.4, 0.29, steel, [0, 0, 0], 28, 0.26, 0.27);
      b.cylinder([0, 0, 1.16], 0.45, 0.09, dark, [0, 0, 0], 28, 0.4, 0.26);
      b.cylinder([0, 0, 1.22], 0.38, 0.035, [0.62, 0.57, 0.45], [0, 0, 0], 28, 0.23, 0.29);
      b.cylinder([0, 0, 1.18], 0.285, 0.015, dark, [0, 0, 0], 28, 0.52);
      for (let i = 0; i < 8; i++) {
        let a = (i * TAU) / 8;
        b.box(
          [Math.cos(a) * 0.41, Math.sin(a) * 0.41, 1.23],
          [0.065, 0.08, 0.13],
          white,
          [0, 0, a],
          0.009,
          0.36,
        );
      }
      b.cylinder([0, 0, -0.72], 0.35, 0.54, white, [0, 0, 0], 18, 0.42);
    });
  const makeRanger = () =>
    buildMesh((b) => {
      const sec = [
        [-4, 0.2, 0.0, -0.18],
        [-2.35, 1.08, 0.53, -0.41],
        [-0.73, 1.39, 1.0, -0.55],
        [1.35, 1.51, 0.72, -0.51],
        [3.0, 1.36, 0.29, -0.4],
      ];
      for (let i = 0; i < sec.length - 1; i++) {
        const [z, w, y, lo] = sec[i],
          [zz, ww, yy, ll] = sec[i + 1];
        b.face(
          [
            [-w, y, z],
            [-ww, yy, zz],
            [ww, yy, zz],
            [w, y, z],
          ],
          white,
          0.47,
        );
        b.face(
          [
            [-w, lo, z],
            [w, lo, z],
            [ww, ll, zz],
            [-ww, ll, zz],
          ],
          dark,
          0.7,
        );
        b.face(
          [
            [w, y, z],
            [ww, yy, zz],
            [ww, ll, zz],
            [w, lo, z],
          ],
          [0.4, 0.43, 0.43],
          0.53,
        );
        b.face(
          [
            [-w, y, z],
            [-w, lo, z],
            [-ww, ll, zz],
            [-ww, yy, zz],
          ],
          [0.47, 0.49, 0.47],
          0.53,
        );
      }
      b.face(
        [
          [-1.36, 0.29, 3],
          [-1.36, -0.4, 3],
          [1.36, -0.4, 3],
          [1.36, 0.29, 3],
        ],
        gray,
        0.55,
      );
      for (const side of [-1, 1]) {
        let pts = [
          [side * 0.95, 0.0, -2.48],
          [side * 3.65, -0.19, 1.78],
          [side * 3.43, -0.21, 2.94],
          [side * 1.23, 0.23, 2.64],
        ];
        if (side < 0) pts.reverse();
        b.face(pts, [0.63, 0.66, 0.65], 0.5);
        let underside = pts.map((p) => [p[0], p[1] - 0.25, p[2]]).reverse();
        b.face(underside, [0.046, 0.058, 0.06], 0.69);
        for (let j = 0; j < pts.length; j++) {
          let p = pts[j],
            q = pts[(j + 1) % pts.length];
          b.face(
            [p, [p[0], p[1] - 0.25, p[2]], [q[0], q[1] - 0.25, q[2]], q],
            j === 0 ? dark : [0.33, 0.36, 0.36],
            0.55,
          );
        }
        b.rod([side * 1.17, 0.025, -2.12], [side * 3.57, -0.16, 1.84], 0.025, dark, 0.6);
        b.rod([side * 1.51, 0.3, 0.45], [side * 3.36, -0.17, 2.68], 0.024, [0.21, 0.24, 0.25], 0.5);
        b.rod(
          [side * 1.47, 0.24, 1.57],
          [side * 2.92, -0.1, 2.74],
          0.018,
          [0.24, 0.27, 0.27],
          0.55,
        );
        b.box([side * 2.95, -0.2, 2.12], [0.6, 0.06, 0.49], dark, [0, side * 0.07, 0], 0.015, 0.7);
        b.box(
          [side * 2.99, -0.154, 2.13],
          [0.38, 0.022, 0.3],
          [0.36, 0.37, 0.33],
          [0, side * 0.07, 0],
          0.004,
          0.5,
        );
        b.cylinder([side * 0.83, -0.1, 3.03], 0.47, 0.25, steel, [0, 0, 0], 20, 0.3, 0.3);
        b.cylinder([side * 0.83, -0.1, 3.18], 0.31, 0.05, dark, [0, 0, 0], 20, 0.6);
        b.cylinder(
          [side * 0.83, -0.1, 3.21],
          0.245,
          0.014,
          [0.27, 0.51, 0.76],
          [0, 0, 0],
          20,
          0.22,
          0,
          4.0,
        );
        b.box([side * 1.3, 0.31, 1.65], [0.19, 0.36, 1.44], white, [0, 0, 0], 0.045, 0.46);
        for (let j = 0; j < 8; j++)
          b.box(
            [side * 1.415, 0.29, 0.98 + j * 0.15],
            [0.03, 0.18, 0.065],
            dark,
            [0, 0, 0],
            0.004,
            0.5,
          );
        b.box(
          [side * 0.77, 0.721, 1.17],
          [0.72, 0.024, 0.62],
          [0.39, 0.42, 0.41],
          [0, 0, 0],
          0.015,
          0.51,
        );
        for (let j = 0; j < 4; j++)
          b.box([side * 0.77, 0.74, 0.97 + j * 0.13], [0.59, 0.01, 0.012], gray, [0, 0, 0], 0, 0.5);
        b.box([side * 0.96, 0.39, 2.48], [0.42, 0.05, 0.54], foil, [0.06, 0, 0], 0.01, 0.53);
      }
      for (const side of [-1, 1]) {
        let pane = [
          [side * 0.09, 0.554, -2.27],
          [side * 0.95, 0.554, -2.27],
          [side * 1.23, 0.973, -0.83],
          [side * 0.09, 0.973, -0.83],
        ];
        if (side > 0) pane.reverse();
        b.face(pane, glass, 0.095);
        let small = [
          [side * 1.105, 0.55, -2.19],
          [side * 1.335, 0.77, -1.05],
          [side * 1.35, 0.41, -0.99],
          [side * 1.075, 0.3, -2.17],
        ];
        if (side < 0) small.reverse();
        b.face(small, glass, 0.1);
      }
      b.rod([0, 0.57, -2.29], [0, 1.025, -0.71], 0.041, [0.73, 0.73, 0.69]);
      b.rod([-1.27, 0.985, -0.8], [1.27, 0.985, -0.8], 0.041, white);
      b.box([0, 1.04, -0.61], [0.22, 0.06, 0.21], gray, [0, 0, 0], 0.014, 0.4);
      b.box([0, 0.86, 0.29], [0.76, 0.08, 0.56], white, [0.12, 0, 0], 0.03, 0.5);
      b.cylinder([0, 0.695, 1.38], 0.3, 0.04, [0.22, 0.25, 0.26], [PI / 2, 0, 0], 20, 0.5);
      b.box([0, 0.675, 1.92], [0.33, 0.07, 0.25], white, [0.08, 0, 0], 0.02, 0.4);
      b.box([0, 0.553, 2.37], [0.16, 0.04, 0.23], gray, [0.1, 0, 0], 0.01, 0.5);
    });
  const makeLander = () =>
    buildMesh((b) => {
      b.box([0, -0.04, 0.28], [2.7, 1.25, 5.85], white, [0, 0, 0], 0.13, 0.53);
      b.box([0, -0.7, 0.34], [3.35, 0.28, 5.49], dark, [0, 0, 0], 0.06, 0.66);
      b.box([0, 0.1, -2.85], [3.14, 0.75, 1.85], white, [0, 0, 0], 0.12, 0.5);
      b.box([0, 0.02, -3.89], [2.9, 0.49, 0.23], gray, [0, 0, 0], 0.025, 0.42);
      b.face(
        [
          [-1.48, 0.52, -3.56],
          [-1.48, 1.04, -1.98],
          [1.48, 1.04, -1.98],
          [1.48, 0.52, -3.56],
        ],
        white,
        0.49,
      );
      for (const side of [-1, 1]) {
        let pane = [
          [side * 0.1, 0.567, -3.43],
          [side * 1.3, 0.567, -3.43],
          [side * 1.3, 0.977, -2.15],
          [side * 0.1, 0.977, -2.15],
        ];
        if (side > 0) pane.reverse();
        b.face(pane, glass, 0.09);
        b.box([side * 1.55, -0.02, 0.77], [1.18, 1.75, 4.73], white, [0, 0, 0], 0.13, 0.54);
        b.box([side * 1.55, 0.91, 0.48], [1.1, 0.15, 3.24], dark, [0, 0, 0], 0.025, 0.48);
        for (let j = 0; j < 7; j++)
          b.box(
            [side * 1.56, 1.0, -0.88 + j * 0.43],
            [0.98, 0.026, 0.23],
            j % 3 === 0 ? foil : steel,
            [0, 0, 0],
            0.008,
            0.43,
          );
        b.box([side * 2.17, 0.07, 0.27], [0.09, 1.3, 2.14], gray, [0, 0, 0], 0.022, 0.5);
        for (let j = 0; j < 6; j++)
          b.box(
            [side * 2.23, 0.08, -0.7 + j * 0.34],
            [0.025, 1.16, 0.065],
            steel,
            [0, 0, 0],
            0.003,
            0.4,
          );
        b.rod([side * 2.19, 0.58, -1.43], [side * 2.19, 0.58, 2.78], 0.047, white);
        b.rod([side * 2.17, -0.57, -1.3], [side * 2.17, -0.57, 2.68], 0.04, steel);
        b.box([side * 1.65, -0.54, 2.87], [1.21, 0.42, 0.87], dark, [0, 0, 0], 0.045, 0.64);
        b.box([side * 1.65, 0.17, 2.89], [1.16, 1.38, 0.34], gray, [0, 0, 0], 0.06, 0.43);
        for (const y of [-0.39, 0.43]) {
          b.cylinder([side * 1.45, y, 3.18], 0.34, 0.33, steel, [0, 0, 0], 18, 0.3, 0.24);
          b.cylinder(
            [side * 1.45, y, 3.36],
            0.245,
            0.06,
            [0.35, 0.56, 0.74],
            [0, 0, 0],
            18,
            0.3,
            0,
            4.0,
          );
        }
        b.box([side * 0.68, 0.71, 1.35], [0.77, 0.2, 1.27], foil, [0, 0, 0], 0.03, 0.5);
        for (let j = 0; j < 4; j++)
          b.box(
            [side * 0.69, 0.85, 0.86 + j * 0.29],
            [0.66, 0.024, 0.043],
            white,
            [0, 0, 0],
            0.003,
            0.42,
          );
      }
      b.rod([0, 0.586, -3.46], [0, 1.034, -2.04], 0.06, white);
      b.box([0, 1.06, -1.84], [2.74, 0.12, 0.26], white, [0, 0, 0], 0.03, 0.4);
      b.cylinder([0, 0, -4.01], 0.38, 0.25, steel, [0, 0, 0], 24, 0.35, 0.25);
      b.cylinder([0, 0, -4.16], 0.3, 0.075, dark, [0, 0, 0], 24, 0.4, 0.24);
      b.box([0, 0.92, -0.77], [0.93, 0.55, 1.28], white, [0, 0, 0], 0.06, 0.55);
      b.box([0, 1.22, -0.77], [0.67, 0.035, 0.96], gray, [0, 0, 0], 0.02, 0.5);
      b.box([0, 0.64, 2.36], [2.61, 0.19, 0.35], white, [0, 0, 0], 0.05, 0.53);
    });
  const makeGear = () =>
    buildMesh((b) => {
      for (const [x, z] of [
        [-1.66, 1.83],
        [1.66, 1.83],
        [0, -2.61],
      ]) {
        b.rod([x, -0.3, z], [x * 1.1, -1.3, z + 0.25], 0.075, steel);
        b.rod([x * 0.75, -0.43, z - 0.43], [x * 1.1, -1.17, z + 0.22], 0.038, gray);
        b.box([x * 1.1, -1.35, z + 0.25], [0.49, 0.11, 0.6], dark, [0, 0, 0], 0.04, 0.65);
      }
    });
  const makeAstronaut = () =>
    buildMesh((b) => {
      const suit = [0.68, 0.67, 0.58];
      b.box([0, 1.04, 0], [0.47, 0.58, 0.3], suit, [0.03, 0, 0], 0.065, 0.78);
      b.box([0, 1.03, 0.25], [0.43, 0.5, 0.23], [0.37, 0.39, 0.36], [0, 0, 0], 0.055, 0.7);
      for (const s of [-1, 1]) {
        b.box([s * 0.14, 0.49, 0], [0.19, 0.54, 0.21], suit, [s * 0.06, 0, s * 0.035], 0.055, 0.8);
        b.box(
          [s * 0.16, 0.1, -0.045],
          [0.23, 0.16, 0.33],
          [0.14, 0.16, 0.15],
          [0, 0, 0],
          0.045,
          0.8,
        );
        b.box([s * 0.335, 1.0, 0], [0.18, 0.48, 0.2], suit, [0.1, 0, s * 0.17], 0.052, 0.8);
        b.sphere([s * 0.377, 0.74, -0.03], 0.115, [0.11, 0.13, 0.13], [0.7, 1, 0.85], 0.72);
      }
      b.sphere([0, 1.51, 0], 0.247, suit, [1, 1.06, 1], 0.45);
      b.sphere([0, 1.53, -0.147], 0.2, [0.019, 0.027, 0.031], [1, 0.73, 0.46], 0.085);
      b.box([0, 1.13, -0.167], [0.29, 0.2, 0.029], gray, [0, 0, 0], 0.016, 0.6);
      b.box(
        [-0.1, 1.22, -0.2],
        [0.052, 0.036, 0.016],
        [0.5, 0.32, 0.12],
        [0, 0, 0],
        0.001,
        0.4,
        0.18,
      );
    });
  const makeRobot = () =>
    buildMesh((b) => {
      for (let i = 0; i < 4; i++) {
        let x = (i - 1.5) * 0.235;
        b.box(
          [x, 0.93, (i % 2) * 0.06],
          [0.225, 1.86, 0.29],
          i % 2 ? steel : [0.22, 0.25, 0.25],
          [0, 0, 0],
          0.025,
          0.28,
        );
        b.box([x, 1.39, -0.151], [0.16, 0.018, 0.008], [0.14, 0.26, 0.26], [0, 0, 0], 0, 0.2, 0.3);
        b.box([x, 1.56, -0.15], [0.14, 0.19, 0.015], dark, [0, 0, 0], 0.008, 0.4);
      }
    });

  // Mesh geometry (hundreds of thousands of triangles across the spacecraft /
  // character meshes) is built in idled slices instead of one long synchronous
  // block: createInterstellarFilm() used to monopolize the main thread for the
  // whole build, delaying the first paint of the login form and freezing its
  // inputs. Slicing at ~8ms per idle callback keeps typing/clicking responsive
  // while the build completes in the background, in parallel with texture
  // fetches. Only the trivial shard/debris remain inline.
  const shard = buildMesh((b) =>
    b.box([0, 0, 0], [0.22, 0.36, 0.05], [0.28, 0.31, 0.31], [0, 0, 0], 0.009, 0.4),
  );
  const emptyMesh: MeshData = { vao: gl.createVertexArray()!, count: 0 };
  const meshes: MeshSet = {
    endurance: emptyMesh,
    damagedEndurance: emptyMesh,
    ranger: emptyMesh,
    lander: emptyMesh,
    gear: emptyMesh,
    astronaut: emptyMesh,
    robot: emptyMesh,
    shard,
    debris: Array.from({ length: 48 }, () => ({
      p: [(rand() - 0.5) * 16, (rand() - 0.5) * 13, (rand() - 0.5) * 8],
      v: [(rand() - 0.5) * 0.14, (rand() - 0.5) * 0.12, (rand() - 0.5) * 0.12],
      r: [rand() * TAU, rand() * TAU, rand() * TAU],
      s: 0.22 + rand() * 1.1,
    })),
  };
  // Safari still ships without requestIdleCallback: fall back to a ~0ms
  // timeout, which still yields to the event loop between slices.
  const scheduleIdle = (callback: (deadline: { timeRemaining?: () => number }) => void) =>
    window.requestIdleCallback
      ? window.requestIdleCallback(callback)
      : (window.setTimeout(() => callback({}), 0) as unknown as number);
  const buildQueue: Array<() => void> = [
    () => {
      meshes.endurance = makeEndurance();
    },
    () => {
      meshes.damagedEndurance = makeEndurance(true);
    },
    () => {
      meshes.ranger = makeRanger();
    },
    () => {
      meshes.lander = makeLander();
    },
    () => {
      meshes.gear = makeGear();
    },
    () => {
      meshes.astronaut = makeAstronaut();
    },
    () => {
      meshes.robot = makeRobot();
    },
  ];
  let meshBuildHandle: number | null = null;
  const buildMeshesSliced = () =>
    new Promise<void>((resolve) => {
      const runSlice = (deadline: { timeRemaining?: () => number }) => {
        const hasBudget = typeof deadline.timeRemaining === "function";
        const startedAt = performance.now();
        while (buildQueue.length) {
          buildQueue.shift()!();
          // Long tasks are the enemy here: yield once a slice has run ~8ms, or
          // when idle-callback budget is reported exhausted.
          if (performance.now() - startedAt > 8 || (hasBudget && deadline.timeRemaining!() <= 2)) {
            meshBuildHandle = scheduleIdle(runSlice);
            return;
          }
        }
        resolve();
      };
      meshBuildHandle = scheduleIdle(runSlice);
    });
  const particleVAO = gl.createVertexArray();
  gl.bindVertexArray(particleVAO);
  const particleBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer);
  const particleSeeds = new Float32Array(1600 * 4);
  for (let i = 0; i < particleSeeds.length; i++) particleSeeds[i] = rand();
  gl.bufferData(gl.ARRAY_BUFFER, particleSeeds, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);

  function loadTexture(src: string) {
    return new Promise<WebGLTexture>((resolve, reject) => {
      const im = new Image();
      im.decoding = "async";
      im.onload = () => {
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, im);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        resolve(tex);
      };
      im.onerror = () => reject(new Error("texture decode failed"));
      im.src = src;
    });
  }

  let width = 1,
    height = 1,
    bufferWidth = 1,
    bufferHeight = 1;
  // 已被写进缓冲区的画质档位；与 quality 不一致时 resize() 必须重建目标。
  let appliedQuality = -1;
  let sceneTarget: RenderTarget | null = null,
    bloomA: RenderTarget | null = null,
    bloomB: RenderTarget | null = null;
  let skyTex: WebGLTexture | null = null,
    noiseTex: WebGLTexture | null = null;

  // Reused uniform scratch vectors (uRes / bloom step): rebuilt on resize only,
  // so render() allocates nothing per frame.
  const RES_SCRATCH = new Float32Array(2);
  const STEP_X_SCRATCH = new Float32Array(2);
  const STEP_Y_SCRATCH = new Float32Array(2);
  function refreshScratch() {
    RES_SCRATCH[0] = bufferWidth;
    RES_SCRATCH[1] = bufferHeight;
    STEP_X_SCRATCH[0] = 1.6 / bufferWidth;
    STEP_X_SCRATCH[1] = 0;
    STEP_Y_SCRATCH[0] = 0;
    STEP_Y_SCRATCH[1] = 1.7 / Math.max(2, bufferHeight >> 2);
  }

  function target(w: number, h: number, depth = false): RenderTarget {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      floating ? gl.RGBA16F : gl.RGBA8,
      w,
      h,
      0,
      gl.RGBA,
      floating ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let db: WebGLRenderbuffer | null = null;
    if (depth) {
      db = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, db);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, db);
    }
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("Framebuffer incomplete");
    return { tex, fb, db, w, h };
  }

  function disposeTarget(t: RenderTarget | null) {
    if (!t) return;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fb);
    if (t.db) gl.deleteRenderbuffer(t.db);
  }

  function resize(force = false) {
    // Fit the canvas to its container (the auth screen surface), not the window.
    const host = canvas.parentElement;
    const nextWidth = Math.max(2, host?.clientWidth || canvas.clientWidth || 2);
    const nextHeight = Math.max(2, host?.clientHeight || canvas.clientHeight || 2);
    // Sub-pixel layout jitter (fonts settling, scrollbar flash) must not rebuild
    // the render targets — that reads as a flicker. 2px dead zone.
    // quality 也在这个守卫里：自适应降档时容器尺寸没变，漏掉它就会让
    // "算出来的档位"永远落不到缓冲区上——实测弱机 quality 已经降到 0.5，
    // 画布仍是满分辨率 1440×900，电影继续吃满 GPU，登录页定格在 ~22fps。
    if (
      !force &&
      sceneTarget &&
      quality === appliedQuality &&
      Math.abs(nextWidth - width) < 2 &&
      Math.abs(nextHeight - height) < 2
    )
      return;
    width = nextWidth;
    height = nextHeight;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    // Resolution policy: the ceiling is the first-order GPU cost knob — every
    // pixel runs the 78-step ocean raymarch / 118-step black-hole integration
    // fragment shaders. 2.3Mpx read sharp on desktop GPUs but pinned iGPUs
    // below 30fps for the whole startup window; 1.4Mpx keeps acceptable
    // crispness at half the shader work, and DPR is honored up to 1.5.
    // The fast adaptation in loop() pays for weak GPUs within seconds.
    const density = Math.min(window.devicePixelRatio || 1, 1.5);
    const budget = Math.sqrt(1_400_000 / (width * height));
    const factor = Math.min(density, budget) * quality;
    bufferWidth = Math.max(2, Math.round(width * factor));
    bufferHeight = Math.max(2, Math.round(height * factor));
    canvas.width = bufferWidth;
    canvas.height = bufferHeight;
    appliedQuality = quality;
    refreshScratch();
    // Build the new targets BEFORE releasing the old ones so there is never a
    // frame without a complete framebuffer (a one-frame black flash).
    try {
      const newScene = target(bufferWidth, bufferHeight, true);
      const newA = target(Math.max(2, bufferWidth >> 2), Math.max(2, bufferHeight >> 2));
      const newB = target(newA.w, newA.h);
      [sceneTarget, bloomA, bloomB].forEach(disposeTarget);
      sceneTarget = newScene;
      bloomA = newA;
      bloomB = newB;
    } catch {
      // Keep the previous targets on failure; the show goes on at old quality.
    }
  }

  function render(filmTime: number) {
    if (!sceneTarget || !bloomA || !bloomB || !skyTex || !noiseTex) return null;
    const t = reverseTime(filmTime);
    const S = stateAt(t, meshes);
    const C = camera(S.cam, S.target, S.fov, S.roll, width / height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneTarget.fb);
    gl.viewport(0, 0, bufferWidth, bufferHeight);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.depthMask(false);
    gl.bindVertexArray(emptyVAO);
    gl.useProgram(envP.p);
    setSampler(gl, envP, "uSky", skyTex, 0);
    setSampler(gl, envP, "uNoise", noiseTex, 1);
    setU(envU[ENV_RES], RES_SCRATCH);
    setU(envU[ENV_TIME], t);
    setU(envU[ENV_MODE], S.mode);
    setU(envU[ENV_LOCAL], S.local);
    setU(envU[ENV_SHOT], S.shot);
    setU(envU[ENV_PHASE], S.phase);
    setU(envU[ENV_LENS], C.lens);
    setU(envU[ENV_WAVE], S.wave);
    setU(envU[ENV_DILATE], S.dilate);
    setU(envU[ENV_CLOUD], S.cloud);
    setU(envU[ENV_CAM], C.p);
    setU(envU[ENV_RIGHT], C.r);
    setU(envU[ENV_UP], C.u);
    setU(envU[ENV_FORWARD], C.f);
    setU(envU[ENV_SUN], S.sun);
    setU(envU[ENV_CRAFT], S.craft || [0, 0, 0]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(meshP.p);
    setSampler(gl, meshP, "uNoise", noiseTex, 3);
    setU(meshU[MESH_VP], C.vp);
    setU(meshU[MESH_CAM], C.p);
    setU(meshU[MESH_SUN], S.sun);
    setU(meshU[MESH_TIME], t);
    setU(meshU[MESH_WATER], S.mode === 2 ? 1 : 0);
    for (const o of S.objects) {
      if (o.alpha < 0.002) continue;
      if (o.alpha < 0.999) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
      } else {
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }
      setU(meshU[MESH_MODEL], buildMatrix(MODEL_MATRIX_SCRATCH, o.p, o.r, o.scale));
      setU(meshU[MESH_ALPHA], o.alpha);
      setU(meshU[MESH_BURN], o.burn);
      setU(meshU[MESH_REFLECT], o.reflection);
      gl.bindVertexArray(o.mesh.vao);
      gl.drawArrays(gl.TRIANGLES, 0, o.mesh.count);
    }
    gl.useProgram(particleP.p);
    setU(particleU[PARTICLE_VP], C.vp);
    setU(particleU[PARTICLE_PIXEL], bufferHeight / (2 * C.lens));
    gl.bindVertexArray(particleVAO);
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    for (const p of S.particles) {
      if (p.amount < 0.003) continue;
      gl.blendFunc(gl.SRC_ALPHA, p.kind === 2 || p.kind === 3 ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      setU(particleU[PARTICLE_MODEL], buildMatrix(MODEL_MATRIX_SCRATCH, p.p, p.r, p.scale));
      setU(particleU[PARTICLE_TIME], p.time);
      setU(particleU[PARTICLE_KIND], p.kind);
      setU(particleU[PARTICLE_AMOUNT], p.amount);
      gl.drawArrays(gl.POINTS, 0, Math.min(1600, p.count));
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(emptyVAO);
    gl.useProgram(blurP.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fb);
    gl.viewport(0, 0, bloomA.w, bloomA.h);
    setSampler(gl, blurP, "uImage", sceneTarget.tex, 0);
    setU(blurU[BLUR_STEP], STEP_X_SCRATCH);
    setU(blurU[BLUR_FIRST], 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomB.fb);
    setSampler(gl, blurP, "uImage", bloomA.tex, 0);
    setU(blurU[BLUR_STEP], STEP_Y_SCRATCH);
    setU(blurU[BLUR_FIRST], 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, bufferWidth, bufferHeight);
    gl.useProgram(postP.p);
    setSampler(gl, postP, "uImage", sceneTarget.tex, 0);
    setSampler(gl, postP, "uBloom", bloomB.tex, 1);
    setSampler(gl, postP, "uSky", skyTex, 2);
    setU(postU[POST_RES], RES_SCRATCH);
    setU(postU[POST_TIME], t);
    setU(postU[POST_FADE], S.fade);
    setU(postU[POST_WARP], S.warp);
    setU(postU[POST_ROLLBLUR], S.blur);
    setU(postU[POST_COCKPIT], S.cockpit);
    setU(postU[POST_DROPLET], S.drop);
    setU(postU[POST_FLASH], S.flash);
    setU(postU[POST_EXPOSURE], S.exposure);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return S;
  }

  // Playback state. Each visit starts at a RANDOM moment of the full 206s
  // timeline — chapter cuts sit at 0/55/100/162 on the reversed timeline with
  // ~0.55s black crossfades, so nudge the pick away from those windows to
  // guarantee the first visible frame is already mid-scene.
  const startOffset = (() => {
    const cuts = REVERSE_CHAPTER_STARTS;
    const ringDistance = (t: number, cut: number) => {
      const d = Math.abs(t - cut) % DURATION;
      return Math.min(d, DURATION - d);
    };
    let pick = Math.random() * DURATION;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (cuts.every((cut) => ringDistance(pick, cut) > 1.5)) break;
      pick = Math.random() * DURATION;
    }
    return pick;
  })();
  let playing = true,
    ready = false,
    lastStamp = 0,
    filmTime = startOffset,
    frameId = 0;
  let chapterListeners: Array<(chapter: InterstellarChapter) => void> = [];
  let currentChapter: InterstellarChapter = chapterAt(startOffset);
  let slowTicks = 0,
    fastTicks = 0,
    lastAdapt = 0,
    lastQualityDrop = -60_000,
    deliveryAverage = 33.4;
  let lastRenderStamp = 0;
  // 最近一次指针/键盘活动的时间戳，供 loop() 判断是否该为交互让路。
  const INTERACTION_IDLE_MS = 500;
  let lastInputAt = 0;
  const markInput = () => {
    lastInputAt = performance.now();
  };
  let resizeObserver: ResizeObserver | null = null;
  let resizeTimer = 0;
  // rAF timestamp of the first rendered frame: anchors the startup fast-track
  // window for quality adaptation (see loop()).
  let startStamp = 0;

  // Cross-surface motion budget: App.tsx samples real fps shortly after load
  // and flags weak GPUs with data-wc-motion="lite" (entry hero animations
  // degrade). The film is far heavier than those layers, so the same flag
  // starts it at reduced quality — on machines where the entry page already
  // chokes, the film would otherwise spend its first seconds pinned at full
  // resolution before the 8s adaptation window even opens. The normal
  // fast-track can still climb back once delivery proves healthy.
  let quality = 1;
  {
    const motionBudget = document.documentElement.dataset.kcMotion;
    if (motionBudget === "lite") {
      // 已被 App.tsx 的采样判定为弱机：起步就落在可维持档位，而不是先全分辨率
      // 卡几秒再靠上面的快速降档兜底。0.66 × 1.4Mpx ≈ 0.9Mpx。
      quality = 0.66;
      lastQualityDrop = 0; // suppress the early fast-track for a while
    }
  }

  function chapterAt(time: number): InterstellarChapter {
    let ch: InterstellarChapter = 0;
    for (let i = 0; i < REVERSE_CHAPTER_STARTS.length; i++)
      if (time >= REVERSE_CHAPTER_STARTS[i]) ch = i as InterstellarChapter;
    return ch;
  }

  // Cinematic pacing: render on a fixed ~30fps cadence instead of every vsync.
  // The procedural chapters (78-step ocean raymarch, 118-step black-hole
  // integration) are borderline for mid GPUs at full vsync — the result was
  // IRREGULAR dropped frames (45→60→30) which reads as stutter, while a lower
  // safety buffer read soft. A steady 30fps cadence (every 2nd tick at 60Hz,
  // 4th at 120Hz) halves GPU load, funds the 1.4Mpx buffer, and even frame
  // intervals read as "filmy" rather than "janky". Scene time still advances
  // with real dt, so motion speed is unchanged.
  const RENDER_MIN_INTERVAL = 1000 / 30;

  // Uniform dispatch without per-frame object allocation: Object.entries in the
  // render path built two arrays + two-element pair arrays at 30fps, plus the
  // string-keyed uniform lookups (hash walk) on every frame. A pre-resolved
  // location list with numeric ids via uniform1f/2f/3f cuts a slice of main-
  // thread time out of every rendered frame.
  type UniformSetter = { location: WebGLUniformLocation; size: 1 | 2 | 3 | 4 | 16 } | null;
  function locationsOf(pr: ProgramBundle, names: string[]): UniformSetter[] {
    return names.map((name) => {
      const location = pr.u[name];
      if (location === undefined || location === null) return null;
      const size = /uVP|uModel/.test(name)
        ? 16
        : /uRes|uStep/.test(name)
          ? 2
          : /uCam|uRight|uUp|uForward|uSun|uCraft/.test(name)
            ? 3
            : 1;
      return { location, size: size as 1 | 2 | 3 | 4 | 16 };
    });
  }
  function setU(entry: UniformSetter, value: number | readonly number[] | Float32Array) {
    if (!entry) return;
    if (entry.size === 16) gl.uniformMatrix4fv(entry.location, false, value as Float32Array);
    else if (entry.size === 3)
      gl.uniform3f(
        entry.location,
        (value as readonly number[])[0] ?? 0,
        (value as readonly number[])[1] ?? 0,
        (value as readonly number[])[2] ?? 0,
      );
    else if (entry.size === 2)
      gl.uniform2f(
        entry.location,
        (value as readonly number[])[0] ?? 0,
        (value as readonly number[])[1] ?? 0,
      );
    else gl.uniform1f(entry.location, value as number);
  }
  // env uniforms, ordered: uRes(2f) uTime uMode uLocal uShot uPhase uLens uWave
  // uDilate uCloud uCam(3f) uRight(3f) uUp(3f) uForward(3f) uSun(3f) uCraft(3f)
  const ENV_UNIFORM_NAMES = [
    "uRes",
    "uTime",
    "uMode",
    "uLocal",
    "uShot",
    "uPhase",
    "uLens",
    "uWave",
    "uDilate",
    "uCloud",
    "uCam",
    "uRight",
    "uUp",
    "uForward",
    "uSun",
    "uCraft",
  ];
  const envU = locationsOf(envP, ENV_UNIFORM_NAMES);
  const meshU = locationsOf(meshP, [
    "uVP",
    "uCam",
    "uSun",
    "uTime",
    "uWater",
    "uModel",
    "uAlpha",
    "uBurn",
    "uReflect",
  ]);
  const MESH_VP = 0,
    MESH_CAM = 1,
    MESH_SUN = 2,
    MESH_TIME = 3,
    MESH_WATER = 4,
    MESH_MODEL = 5,
    MESH_ALPHA = 6,
    MESH_BURN = 7,
    MESH_REFLECT = 8;
  const ENV_RES = 0,
    ENV_TIME = 1,
    ENV_MODE = 2,
    ENV_LOCAL = 3,
    ENV_SHOT = 4,
    ENV_PHASE = 5,
    ENV_LENS = 6,
    ENV_WAVE = 7,
    ENV_DILATE = 8,
    ENV_CLOUD = 9,
    ENV_CAM = 10,
    ENV_RIGHT = 11,
    ENV_UP = 12,
    ENV_FORWARD = 13,
    ENV_SUN = 14,
    ENV_CRAFT = 15;
  const particleU = locationsOf(particleP, [
    "uVP",
    "uModel",
    "uTime",
    "uKind",
    "uAmount",
    "uPixel",
  ]);
  const PARTICLE_VP = 0,
    PARTICLE_MODEL = 1,
    PARTICLE_TIME = 2,
    PARTICLE_KIND = 3,
    PARTICLE_AMOUNT = 4,
    PARTICLE_PIXEL = 5;
  const postU = locationsOf(postP, [
    "uRes",
    "uTime",
    "uFade",
    "uWarp",
    "uRollBlur",
    "uCockpit",
    "uDroplet",
    "uFlash",
    "uExposure",
  ]);
  const POST_RES = 0,
    POST_TIME = 1,
    POST_FADE = 2,
    POST_WARP = 3,
    POST_ROLLBLUR = 4,
    POST_COCKPIT = 5,
    POST_DROPLET = 6,
    POST_FLASH = 7,
    POST_EXPOSURE = 8;
  const blurU = locationsOf(blurP, ["uStep", "uFirst"]);
  const BLUR_STEP = 0,
    BLUR_FIRST = 1;

  function loop(stamp: number) {
    frameId = requestAnimationFrame(loop);
    if (!ready) return;
    const dt = lastStamp ? (stamp - lastStamp) / 1000 : 0;
    lastStamp = stamp;
    if (!playing) return;
    // 交互让路：GPU 被体积渲染占满时，合成器要等电影画完才出帧，用户看到的
    // 是光标追不上手——拖拽发黏、点击延迟。所以只在 GPU 确实顶不住
    // （deliveryAverage 越过 39ms，连 30fps 档位都守不住）时，于指针/键盘
    // 活动期间停画：filmTime 不推进，恢复后无缝续播，不会跳帧。性能达标的
    // 机器完全不受影响，照常全速播放。
    if (deliveryAverage > 39 && stamp - lastInputAt < INTERACTION_IDLE_MS) return;
    filmTime += Math.min(dt, 0.18);
    if (filmTime >= DURATION) filmTime %= DURATION;
    if (stamp - lastRenderStamp < RENDER_MIN_INTERVAL - 1.5) return; // Delivery interval = actual ms between completed renders. Healthy ~33ms;
    // sagging toward 50ms means the GPU is missing even the 30fps target.
    const interval = lastRenderStamp ? stamp - lastRenderStamp : RENDER_MIN_INTERVAL;
    lastRenderStamp = stamp;
    if (!startStamp) startStamp = stamp;
    render(filmTime);
    deliveryAverage = deliveryAverage * 0.95 + Math.min(interval, 150) * 0.05;
    // Quality adaptation with a hysteresis band and a cooldown: without it the
    // up/down thresholds oscillate, and every step rebuilds the render targets
    // (visible sharpness pop = the "flicker" reported on the auth screen).
    // 首屏合同：登录页不允许长时间明显卡顿。旧参数（1.5s 窗口 × 8 次计数、
    // 每档只收 0.82）意味着弱 GPU 要先卡满 ~13s 才落第一档、~27s 才到底——
    // 正是「首屏超级卡」的来源。现在起步 600ms 窗口 × 2 次计数、早段每档
    // 收 0.72、下限放宽到 0.5：最差情形 ~2s 内落第一档、~4s 到底。强 GPU
    // 的画面质量不受影响（delivery 达标就完全不触发）。
    const sinceStart = stamp - startStamp;
    const earlyPhase = sinceStart < 10_000;
    const adaptWindow = earlyPhase ? 600 : 4_000;
    const slowNeeded = earlyPhase ? 2 : 12;
    if (stamp - lastAdapt > adaptWindow && filmTime > 1.2) {
      if (deliveryAverage > 39 && quality > 0.5) {
        slowTicks++;
        if (slowTicks > slowNeeded) {
          quality = Math.max(0.5, quality * (earlyPhase ? 0.72 : 0.85));
          resize();
          lastAdapt = stamp;
          lastQualityDrop = stamp;
          slowTicks = 0;
          fastTicks = 0;
        }
      } else if (deliveryAverage < 34.6 && quality < 0.99 && stamp - lastQualityDrop > 20_000) {
        fastTicks++;
        if (fastTicks > 240) {
          quality = Math.min(1, quality * 1.06);
          resize();
          lastAdapt = stamp;
          fastTicks = 0;
          slowTicks = 0;
        }
      } else {
        slowTicks = 0;
        fastTicks = 0;
      }
    }
    const chapter = chapterAt(filmTime);
    if (chapter !== currentChapter) {
      currentChapter = chapter;
      for (const listener of chapterListeners) listener(chapter);
    }
  }

  const onVisibility = () => {
    if (document.hidden) {
      playing = false;
    } else {
      playing = !pausedByApi && document.hasFocus();
      lastStamp = performance.now();
    }
  };
  // 窗口失焦（分屏、切去聊天窗）时页面仍可见，GPU 会继续烧 30fps 的体积渲染，
  // 挤占用户正在交互的前台应用。失焦即暂停，回焦立即恢复——电影进度不回退，
  // 用户感知只是画面停了一拍。
  const onWindowBlur = () => {
    playing = false;
  };
  const onWindowFocus = () => {
    if (!pausedByApi && !document.hidden) {
      playing = true;
      lastStamp = performance.now();
    }
  };
  let pausedByApi = false;

  const onContextLost = (event: Event) => {
    event.preventDefault();
    ready = false;
  };
  const onContextRestored = () => {
    window.location.reload();
  };

  const scheduleResize = () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resize();
      if (ready) render(filmTime);
    }, 100);
  };

  if (!stills) {
    resizeObserver = new ResizeObserver(scheduleResize);
    if (canvas.parentElement) resizeObserver.observe(canvas.parentElement);
    window.addEventListener("resize", scheduleResize);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("visibilitychange", onVisibility);
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    window.addEventListener("pointermove", markInput, { passive: true });
    window.addEventListener("pointerdown", markInput, { passive: true });
    window.addEventListener("pointerup", markInput, { passive: true });
    window.addEventListener("keydown", markInput, { passive: true });
    window.addEventListener("wheel", markInput, { passive: true });
  }

  let destroyed = false;
  // stills 采集：构建完成即就绪，不启动播放循环，外部用 renderAt 逐帧驱动。
  let resolveStillsReady: (() => void) | null = null;
  const stillsReady = new Promise<void>((resolve) => {
    resolveStillsReady = resolve;
  });
  // Film startup = sliced mesh build ∥ texture fetch. Neither runs as a long
  // synchronous task, so the login form mounts, paints and stays interactive
  // while the scene materializes in the background.
  void Promise.all([
    buildMeshesSliced(),
    Promise.all([loadTexture(SKY_DATA), loadTexture(NOISE_DATA)]),
  ])
    .then(([, [a, b]]) => {
      if (destroyed) return;
      skyTex = a;
      noiseTex = b;
      resize(true);
      ready = true;
      render(filmTime);
      if (stills) {
        resolveStillsReady?.();
        return;
      }
      lastStamp = performance.now();
      frameId = requestAnimationFrame(loop);
      // Align the scene caption with the random starting chapter immediately.
      for (const listener of chapterListeners) listener(currentChapter);
    })
    .catch(() => {
      // Texture decode failed on exotic browsers; the auth form remains usable.
    });

  return {
    destroy() {
      destroyed = true;
      playing = false;
      ready = false;
      cancelAnimationFrame(frameId);
      buildQueue.length = 0; // stop the sliced mesh build if still running
      if (meshBuildHandle !== null && window.cancelIdleCallback)
        window.cancelIdleCallback(meshBuildHandle);
      window.clearTimeout(resizeTimer);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleResize);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      window.removeEventListener("pointermove", markInput);
      window.removeEventListener("pointerdown", markInput);
      window.removeEventListener("pointerup", markInput);
      window.removeEventListener("keydown", markInput);
      window.removeEventListener("wheel", markInput);
      [sceneTarget, bloomA, bloomB].forEach(disposeTarget);
      sceneTarget = bloomA = bloomB = null;
    },
    setPaused(paused: boolean) {
      pausedByApi = paused;
      if (paused) playing = false;
      else if (!document.hidden) {
        playing = true;
        lastStamp = performance.now();
      }
    },
    onChapter(listener: (chapter: InterstellarChapter) => void) {
      chapterListeners.push(listener);
    },
    ...(stills
      ? {
          ready: stillsReady,
          renderAt(seconds: number) {
            filmTime = seconds;
            // 返回渲染结果（null = 目标/贴图未就绪被早退），采集脚本据此断言。
            return ready ? render(filmTime) : null;
          },
        }
      : {}),
  };
}

export type { Scene, Vec3 };
export { V };
