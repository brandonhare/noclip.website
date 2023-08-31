import { GfxDevice, GfxProgram } from "../gfx/platform/GfxPlatform.js";
import * as Shaders from "../gfx/shaderc/GfxShaderCompiler.js";

function makeShader(device: GfxDevice, vert: string, frag: string): GfxProgram {
	return device.createProgramSimple(
		Shaders.preprocessProgram_GLSL(device.queryVendorInfo(), vert, frag)
	);
}

export function createSolidColourShader(device: GfxDevice): GfxProgram {
	const vert = `
layout(std140) uniform ub_SceneParams {
	Mat4x4 ub_WorldToClip;
};
layout(std140) uniform ub_InstanceParams {
	Mat4x3 ub_ModelToWorld;
};

layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec2 a_UV;

uniform sampler2D u_LUT;

out vec4 v_Colour;

void main(){
	v_Colour = texture(SAMPLER_2D(u_LUT), a_UV);
	vec4 worldPosition = Mul(_Mat4x4(ub_ModelToWorld), vec4(a_Position, 1.0));
	gl_Position = Mul(ub_WorldToClip, worldPosition);
}`;
	const frag = `
in vec4 v_Colour;
void main(){
	gl_FragColor = v_Colour;
}
`;
	return makeShader(device, vert, frag);
}

export function createTexturedShader(device: GfxDevice): GfxProgram {
	const vert = `
layout(std140) uniform ub_SceneParams {
	Mat4x4 ub_WorldToClip;
};
layout(std140) uniform ub_InstanceParams {
	Mat4x3 ub_ModelToWorld;
};

layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec2 a_UV;

out vec2 v_UV;

void main(){
	vec4 worldPosition = Mul(_Mat4x4(ub_ModelToWorld), vec4(a_Position, 1.0));
	gl_Position = Mul(ub_WorldToClip, worldPosition);
	v_UV = a_UV;
}`;
	const frag = `
uniform sampler2D u_Texture;
in vec2 v_UV;
void main(){
	gl_FragColor = texture(SAMPLER_2D(u_Texture), v_UV);
}
`;
	return makeShader(device, vert, frag);
}

export function createDebugShader(device: GfxDevice): GfxProgram {
	const vert = `
layout(std140) uniform ub_SceneParams {
	Mat4x4 ub_WorldToClip;
};
layout(std140) uniform ub_InstanceParams {
	Mat4x3 ub_ModelToWorld;
};

layout(location = 0) in vec3 a_Position;
out vec3 v_WorldPosition;

void main(){
	vec4 worldPosition = Mul(_Mat4x4(ub_ModelToWorld), vec4(a_Position, 1.0));
	v_WorldPosition = worldPosition.xyz;
	gl_Position = Mul(ub_WorldToClip, worldPosition);
}`;

	const frag = `
in vec3 v_WorldPosition;

void main(){

	vec3 dx = dFdx(v_WorldPosition);
	vec3 dy = dFdy(v_WorldPosition);
	vec3 worldNormal = normalize(cross(dx, dy));

	gl_FragColor = vec4(abs(worldNormal), 1.0);
}`;

	return makeShader(device, vert, frag);
}
