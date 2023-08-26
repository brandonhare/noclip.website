import { GfxDevice, GfxProgram } from "../gfx/platform/GfxPlatform.js";
import * as Shaders from "../gfx/shaderc/GfxShaderCompiler.js";

export function CreateMainShader(device: GfxDevice): GfxProgram {
	const vert = `
layout(std140) uniform ub_SceneParams {
	Mat4x4 ub_WorldToClip;
};
layout(std140) uniform ub_InstanceParams {
	Mat4x3 ub_ModelToWorld;
};

layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec2 a_UV;
out vec2 v_TexCoord;

void main(){
	gl_Position = Mul(ub_WorldToClip, Mul(_Mat4x4(ub_ModelToWorld), vec4(a_Position, 1.0)));
	v_TexCoord = a_UV;
}`;

	const frag = `
uniform sampler2D u_Texture;
uniform sampler2D u_LUT;

in vec2 v_TexCoord;

void main(){
	float index = texture(SAMPLER_2D(u_Texture), v_TexCoord).r;
	index = mix(${0.5 / 0x100}, ${(0x100 - 0.5) / 0x100}, index);
	vec4 result = texture(SAMPLER_2D(u_LUT), vec2(index, 0.5));
	gl_FragColor = result;
}`;

	const processed = Shaders.preprocessProgram_GLSL(device.queryVendorInfo(), vert, frag);
	return device.createProgramSimple(processed);
}
