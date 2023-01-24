import * as UI from "../ui";
import * as Viewer from '../viewer';

import { mat4, vec2, vec3, vec4 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { computeViewSpaceDepthFromWorldSpacePoint } from "../Camera";
import { AABB } from "../Geometry";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { makeAttachmentClearDescriptor, makeBackbufferDescSimple, pushAntialiasingPostProcessPass } from "../gfx/helpers/RenderGraphHelpers";
import { convertToCanvas } from "../gfx/helpers/TextureConversionHelpers";
import { fillColor, fillMatrix4x3, fillMatrix4x4, fillVec4, fillVec4v } from "../gfx/helpers/UniformBufferHelpers";
import { GfxBindingLayoutSamplerDescriptor, GfxBlendFactor, GfxBlendMode, GfxBufferUsage, GfxColor, GfxCullMode, GfxDevice, GfxIndexBufferDescriptor, GfxInputLayoutBufferDescriptor, GfxMipFilterMode, GfxSamplerFormatKind, GfxTexFilterMode, GfxTextureDimension, GfxTextureUsage, GfxVertexAttributeDescriptor, GfxVertexBufferDescriptor, GfxVertexBufferFrequency, GfxWrapMode } from "../gfx/platform/GfxPlatform";
import { GfxFormat } from "../gfx/platform/GfxPlatformFormat";
import { GfxBuffer, GfxInputLayout, GfxInputState, GfxProgram, GfxTexture } from "../gfx/platform/GfxPlatformImpl";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper";
import { GfxRendererLayer, GfxRenderInstManager, makeSortKey, setSortKeyDepth } from "../gfx/render/GfxRenderInstManager";
import { computeNormalMatrix, Vec3UnitY, Vec3Zero } from "../MathHelpers";
import { DeviceProgram } from "../Program";
import { Destroyable, SceneContext } from "../SceneBase";
import { TextureMapping } from "../TextureHolder";
import { assert, assertExists } from "../util";

import { AnimatedEntity, Entity, EntityUpdateResult, FriendlyNames, getFriendlyName } from "./entity";
import { AlphaType, Qd3DMesh, Qd3DTexture, textureArrayToCanvas } from "./QuickDraw3D";
import { AnimationController, AnimationData, calculateAnimationTransforms, SkeletalMesh } from "./skeleton";

// Settings
const enum Settings {
	AnimationTextureFps = 30,
	DefaultTexFilter = GfxTexFilterMode.Bilinear,
	MaxInstances = 64,
	MinInstances = 4,
};


export const enum RenderFlags {
	Translucent = 1<<11,
	TextureHasOneBitAlpha = 1<<10,
	Skinned = 1<<9,
	HasTexture = 1<<8,
	HasMeshColour = 1<<7,
	KeepBackfaces = 1<<6,
	DrawBackfacesSeparately = 1<<5,
	Unlit = 1<<4,
	ScrollUVs = 1<<3,
	Reflective = 1<<2,
	TextureTilemap = 1<<1,
	HasVertexColours = 1<<0,
}

export class Program extends DeviceProgram {
	static readonly a_Position = 0;
	static readonly a_UVs = 1;
	static readonly a_Colours = 2;
	static readonly a_Normals = 3;
	static readonly a_TextureIds = 4;
	static readonly a_BoneIds = 5;

	static readonly ub_SceneParams = 0;
	static readonly ub_InstanceParams = 1;
	static readonly ub_MeshParams = 2;

	static readonly s_Texture = 0;
	static readonly s_AnimTexture = 1;

	constructor(flags : RenderFlags, numLights : number, maxInstances : number){
		super();

		this.setDefineString("NUM_LIGHTS", numLights.toString());
		this.setDefineString("MAX_INSTANCES", maxInstances.toString());

		this.setDefineBool("UNLIT", (flags & RenderFlags.Unlit) !== 0);
		this.setDefineBool("HAS_VERTEX_COLOURS", (flags & RenderFlags.HasVertexColours) !== 0);
		this.setDefineBool("HAS_TEXTURE", (flags & RenderFlags.HasTexture) !== 0);
		this.setDefineBool("HAS_MESH_COLOUR", (flags & RenderFlags.HasMeshColour) !== 0);
		this.setDefineBool("TEXTURE_HAS_ONE_BIT_ALPHA", (flags & RenderFlags.TextureHasOneBitAlpha) !== 0);
		this.setDefineBool("TILEMAP", (flags & RenderFlags.TextureTilemap) !== 0);
		this.setDefineBool("SCROLL_UVS", (flags & RenderFlags.ScrollUVs) !== 0);
		this.setDefineBool("SKINNED", (flags & RenderFlags.Skinned) !== 0);
		this.setDefineBool("REFLECTIVE", (flags & RenderFlags.Reflective) !== 0);
	}

	override both = 
`
struct Light {
	vec4 direction;
	vec4 colour;
};

layout(std140) uniform ub_SceneParams {
	Mat4x4 u_ClipFromWorldMatrix;
	vec4 u_CameraPos;
	vec4 u_AmbientColour;
	Light u_Lights[NUM_LIGHTS];
	vec4 u_TimeVec; // x = time, yzw = unused
	#define u_Time (u_TimeVec.x)
};

struct InstanceData {
	Mat4x3 ui_WorldFromModelMatrix;
	vec4 ui_Params; // x = anim time, y = anim texture width; w = opacity
};
layout(std140) uniform InstanceParams {
	InstanceData ub_InstanceParams[MAX_INSTANCES];

	#define u_WorldFromModelMatrix ub_InstanceParams[gl_InstanceID].ui_WorldFromModelMatrix
	#define u_Params ub_InstanceParams[gl_InstanceID].ui_Params
};

#if defined(HAS_MESH_COLOUR) || defined(SCROLL_UVS)
layout(std140) uniform ub_MeshParams {
	#ifdef HAS_MESH_COLOUR
		vec4 u_MeshColour;
	#endif

	#ifdef SCROLL_UVS
		vec4 u_UVScroll; // xy = uv, zw = unused
	#endif
};
#endif
`;
	override vert = 
`
layout(location = ${Program.a_Position}) in vec3 a_Position;
layout(location = ${Program.a_UVs}) in vec2 a_UV;
layout(location = ${Program.a_Normals}) in vec3 a_Normal;
layout(location = ${Program.a_Colours}) in vec3 a_Colour;
layout(location = ${Program.a_TextureIds}) in float a_TextureId;
layout(location = ${Program.a_BoneIds}) in float a_BoneId;

#ifdef SKINNED
	layout(binding=${Program.s_AnimTexture}) uniform sampler2D u_AnimTexture;
#endif

out vec4 v_Colour;
out vec2 v_UV;
flat out int v_Id;


${GfxShaderLibrary.MulNormalMatrix}

void main() {

	vec3 localPos = a_Position;
	vec3 localNormal = a_Normal;

	vec4 colour = vec4(1.0);
	vec2 uv = a_UV;

	#ifdef HAS_MESH_COLOUR
		colour = u_MeshColour;
	#endif

	colour.a *= u_Params.a;

	#ifdef TILEMAP
		uv = a_Position.xz;
		v_Id = int(a_TextureId);
	#endif


	#ifdef SKINNED
	{
		float animT = u_Params.x;
		float texelWidth = u_Params.y;

		vec2 boneUv = vec2((a_BoneId * 3.0 + 0.5) * texelWidth, animT);

		Mat4x3 boneMat = _Mat4x3(1.0);
		boneMat.mx = texture(SAMPLER_2D(u_AnimTexture), boneUv);
		boneMat.my = texture(SAMPLER_2D(u_AnimTexture), boneUv + vec2(texelWidth, 0.0));
		boneMat.mz = texture(SAMPLER_2D(u_AnimTexture), boneUv + vec2(texelWidth * 2.0, 0.0));

		localPos = Mul(boneMat, vec4(localPos, 1.0));
		localNormal = Mul(boneMat, vec4(localNormal, 0.0));
	}
	#endif
	
	vec3 worldPos = Mul(u_WorldFromModelMatrix, vec4(localPos, 1.0));
	vec3 worldNormal = normalize(MulNormalMatrix(u_WorldFromModelMatrix, localNormal));

	#ifdef REFLECTIVE
		uv = normalize(reflect(u_CameraPos.xyz - worldPos, worldNormal)).xy * 0.5 + 0.5;
	#endif


	#ifdef HAS_VERTEX_COLOURS
		colour.xyz *= a_Colour;
	#endif

	#ifndef UNLIT
	{   // do lighting
		vec3 lightColour = u_AmbientColour.xyz;
		for (int i = 0; i < NUM_LIGHTS; ++i){
			lightColour += max(0.0, dot(u_Lights[i].direction.xyz, worldNormal)) * u_Lights[i].colour.xyz;
		}
		colour.xyz *= lightColour;
	}
	#endif

	#ifdef SCROLL_UVS
		uv += u_UVScroll.xy;
	#endif

	v_UV = uv;
	v_Colour = colour;
    gl_Position = Mul(u_ClipFromWorldMatrix, vec4(worldPos,1.0));
}
`;
	override frag = 
`

#ifdef TILEMAP
	layout(binding=${Program.s_Texture}) uniform sampler2DArray u_TilemapTexture;
	precision mediump float;
	precision lowp sampler2DArray;
	flat in int v_Id;
#else
	#ifdef HAS_TEXTURE
		layout(binding=${Program.s_Texture}) uniform sampler2D u_Texture;
	#endif
#endif

in vec4 v_Colour;
in vec2 v_UV;

void main(){
	vec4 colour = v_Colour;
	vec2 uv = v_UV;
	
	#ifdef HAS_TEXTURE
	{
		#ifndef TILEMAP
			// normal texture
			vec4 texColour = texture(SAMPLER_2D(u_Texture), uv);
			#ifdef TEXTURE_HAS_ONE_BIT_ALPHA
				if (texColour.a < 0.5) { discard; }
			#endif
			colour *= texColour;
		#else // tilemap
			uv = fract(uv);

			int textureId = v_Id & 0xFFF;

			if ((v_Id & 0x1000) != 0){ // swizzle
				uv.xy = uv.yx;
			}
			if ((v_Id & 0x2000) != 0){ // flip x
				uv.x = 1.0 - uv.x;
			}
			if ((v_Id & 0x4000) != 0){ // flip y
				uv.y = 1.0 - uv.y;
			}

			vec4 texColour = texture(SAMPLER_2D(u_TilemapTexture), vec3(uv, textureId));
			#ifdef TEXTURE_HAS_ONE_BIT_ALPHA
				if (texColour.a < 0.5) { discard; }
			#endif
			colour *= texColour;
		#endif // end ifdef tilemap
	}
	#endif

	gl_FragColor = colour;
}
`;
};




export class Cache extends GfxRenderCache implements UI.TextureListHolder {
	textureFromSourceCache = new Map<Qd3DTexture, GfxTexture>();
	sourceModels = new Map<StaticObject, Qd3DMesh>();

	allModels : StaticObject[] = [];
	allTextures : GfxTexture[] = [];

	programs = new Map<RenderFlags, GfxProgram>();

	numLights = 1;

	viewerTextures : Viewer.Texture[] = [];
	onnewtextures: (() => void) | null = null;

	getInstanceBufferSize(count : number){
		if (count < Settings.MinInstances)
			return 1;
		else
			return Settings.MaxInstances;
	}


	getProgram(renderFlags : RenderFlags, numInstances : number){
		numInstances = this.getInstanceBufferSize(numInstances);
		const index = renderFlags + (numInstances << 12);
		let program = this.programs.get(index);
		if (program)
			return program;
		program = this.createProgram(new Program(renderFlags, this.numLights, numInstances));
		this.programs.set(index, program);
		return program;
	}

	createTexture(texture : Qd3DTexture, name : string, addToViewer = true){
		let result = this.textureFromSourceCache.get(texture);
		if (result === undefined){
			result = this.device.createTexture({
				depth : texture.numTextures,
				width : texture.width,
				height : texture.height,
				pixelFormat : texture.pixelFormat,
				dimension: texture.numTextures === 1 ? GfxTextureDimension.n2D : GfxTextureDimension.n2DArray,
				usage: GfxTextureUsage.Sampled,
				numLevels : 1
			});
			this.textureFromSourceCache.set(texture, result);
			this.allTextures.push(result);
			this.device.uploadTextureData(result, 0, [texture.pixels]);

			if (addToViewer){
				if (texture.numTextures === 1){
					this.viewerTextures.push({
						name,
						surfaces : [convertToCanvas(new ArrayBufferSlice(texture.pixels.buffer, texture.pixels.byteOffset, texture.pixels.byteLength), texture.width, texture.height, texture.pixelFormat)],
					});
				} else {
					this.viewerTextures.push({
						name: `${name} (${texture.numTextures} tiles)`,
						surfaces : [textureArrayToCanvas(texture)],
					});
				}
			}
		}
		return result;
	}

	createTextureMapping(texture : Qd3DTexture, name : string, addToViewer = true, filtering = texture.filterMode ?? (Settings.DefaultTexFilter as number as GfxTexFilterMode)){
		const mapping = new TextureMapping();
		mapping.gfxTexture = this.createTexture(texture, name, addToViewer);

		
		mapping.gfxSampler = this.createSampler({
			magFilter : filtering,
			minFilter : filtering,
			wrapS : texture.wrapU,
			wrapT : texture.wrapV,
			mipFilter : GfxMipFilterMode.Nearest,
		});
		
		
		
		return mapping;
	}

	deleteTexture(texture : GfxTexture | undefined | null){
		if (!texture) return;
		const index = this.allTextures.indexOf(texture);
		assert(index >= 0, "tried to delete a texture we don't have");
		this.allTextures[index] = this.allTextures[this.allTextures.length - 1];
		this.allTextures.pop();
		this.device.destroyTexture(texture);
	}

	addModel(model : StaticObject, sourceMesh? : Qd3DMesh){
		this.allModels.push(model);
		if (sourceMesh)
			this.sourceModels.set(model, sourceMesh);
	}

	public override destroy(): void {
		const device = this.device;

		for (const tex of this.allTextures)
			device.destroyTexture(tex);
		for (const model of this.allModels)
			model.destroy(device);

		super.destroy();
	}

}



export class StaticObject implements Destroyable {
	gfxProgram : GfxProgram | null = null;
	indexCount : number;
	buffers : GfxBuffer[] = [];
	inputLayout : GfxInputLayout;
	inputState : GfxInputState;
	aabb : AABB;
	colour : GfxColor;
	scrollUVs : vec2 = [0,0];
	renderFlags : RenderFlags = 0;
	textureMapping? : TextureMapping = undefined;
	renderLayerOffset = 0;
	animatedObject? : AnimatedObject = undefined;

	constructor(device : GfxDevice, cache : Cache, mesh : Qd3DMesh, name : string){
		this.indexCount = mesh.numTriangles * 3;
		this.aabb = mesh.aabb;
		this.colour = {...mesh.colour};

		cache.addModel(this, mesh);

		const vertexBufferDescriptors : GfxVertexBufferDescriptor[] = [];
		const vertexLayoutDescriptors : GfxInputLayoutBufferDescriptor[] = [];
		const vertexAttributeDescriptors : GfxVertexAttributeDescriptor[] = [];

		const allBuffers = this.buffers;

		function pushBuffer(inputBuffer : ArrayBufferLike | undefined, byteStride : number, location:number, format: GfxFormat){
			if (!inputBuffer) return false;

			const buffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, inputBuffer);
			vertexBufferDescriptors.push({
				buffer,
				byteOffset : 0
			});
			vertexLayoutDescriptors.push({
				byteStride,
				frequency: GfxVertexBufferFrequency.PerVertex
			});
			vertexAttributeDescriptors.push({
				location,
				format,
				bufferIndex : allBuffers.length,
				bufferByteOffset : 0
			});
			allBuffers.push(buffer);
			return true;
		}
		
		if (mesh.vertices.BYTES_PER_ELEMENT === 2)
			pushBuffer(mesh.vertices.buffer, 6, Program.a_Position, GfxFormat.U16_RGB);
		else
			pushBuffer(mesh.vertices.buffer, 12, Program.a_Position, GfxFormat.F32_RGB);
		const hasUvs = pushBuffer(mesh.UVs?.buffer, 8, Program.a_UVs, GfxFormat.F32_RG);
		const hasNormals = pushBuffer(mesh.normals?.buffer, 12, Program.a_Normals, GfxFormat.F32_RGB);
		const hasColours = mesh.vertexColours !== undefined;
		if (hasColours){
			if (mesh.vertexColours!.BYTES_PER_ELEMENT === 4)
				pushBuffer(mesh.vertexColours!.buffer, 12, Program.a_Colours, GfxFormat.F32_RGB);
			else
				pushBuffer(mesh.vertexColours!.buffer, 3, Program.a_Colours, GfxFormat.U8_RGB_NORM);
		}
		const hasTilemap = pushBuffer(mesh.tilemapIds?.buffer, 2, Program.a_TextureIds, GfxFormat.U16_R);
		const isSkinned = pushBuffer(mesh.boneIds?.buffer, 1, Program.a_BoneIds, GfxFormat.U8_R);

		if (!hasNormals)
			this.renderFlags |= RenderFlags.Unlit; // no lighting without normals

		if (hasColours)
			this.renderFlags |= RenderFlags.HasVertexColours;

		if (this.colour.a < 1){
			this.renderFlags |= RenderFlags.Translucent | RenderFlags.HasMeshColour;
		} else if (this.colour.r !== 1 || this.colour.g !== 1 || this.colour.b != 1) {
			this.renderFlags |= RenderFlags.HasMeshColour;

		}

		if (isSkinned)
			this.renderFlags |= RenderFlags.Skinned;

		const texture = mesh.texture;
		if (texture){
			assert(hasUvs || hasTilemap, "model has texture but no UVs!");

			this.textureMapping = cache.createTextureMapping(texture, name);

			this.renderFlags |= RenderFlags.HasTexture;
			if (texture.alpha === AlphaType.OneBitAlpha)
				this.renderFlags |= RenderFlags.TextureHasOneBitAlpha;
			else if (texture.alpha === AlphaType.Translucent)
				this.renderFlags |= RenderFlags.Translucent;

			if (hasTilemap)
				this.renderFlags |= RenderFlags.TextureTilemap;
		}

		const indexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Index, mesh.indices.buffer);
		let indexBufferFormat : GfxFormat;
		switch(mesh.indices.BYTES_PER_ELEMENT){
			case 2: indexBufferFormat = GfxFormat.U16_R; break;
			case 4: indexBufferFormat = GfxFormat.U32_R; break;
			default: assert(false, "invalid index buffer size"); break;
		}
		this.inputLayout = cache.createInputLayout({
			vertexBufferDescriptors: vertexLayoutDescriptors,
			vertexAttributeDescriptors : vertexAttributeDescriptors,
			indexBufferFormat
		});

		const indexBufferDescriptor : GfxIndexBufferDescriptor = {
			buffer: indexBuffer,
			byteOffset: 0,
		};
		this.inputState = device.createInputState(this.inputLayout, vertexBufferDescriptors, indexBufferDescriptor);
	}

	prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, cache : Cache, instanceCount : number, flipBackfaces = false): void {
        const renderInst = renderInstManager.newRenderInst();

		const renderFlags = this.renderFlags;
		const translucent = !!(renderFlags & RenderFlags.Translucent);

		const skinned = !!(renderFlags & RenderFlags.Skinned);

		const gfxProgram = cache.getProgram(renderFlags, instanceCount);
		const hasTexture = (this.renderFlags & RenderFlags.HasTexture) !== 0;
		const textureArray = (this.renderFlags & RenderFlags.TextureTilemap) !== 0;

		const scrollUVs = renderFlags & RenderFlags.ScrollUVs;
		const hasMeshColour = renderFlags & RenderFlags.HasMeshColour;
		const hasMeshUniforms = scrollUVs || hasMeshColour;
		const numUniformBuffers = 2 + (hasMeshUniforms?1:0);
		const numSamplers = skinned ? 2 : (hasTexture ? 1 : 0);


		const samplerEntries : GfxBindingLayoutSamplerDescriptor[] = numSamplers ? [{
			dimension : textureArray ? GfxTextureDimension.n2DArray : GfxTextureDimension.n2D,
			formatKind : GfxSamplerFormatKind.Float,
		}] : [];
		if (skinned)
			samplerEntries.push({
				dimension :  GfxTextureDimension.n2D,
				formatKind : GfxSamplerFormatKind.Float
			});

		renderInst.setBindingLayouts([{
			numUniformBuffers,
			numSamplers,
			samplerEntries,
		}]);

		
        renderInst.setSamplerBindingsFromTextureMappings([
			this.textureMapping!,
			this.animatedObject?.getAnimTexture(cache)!,
		]);

        renderInst.setGfxProgram(gfxProgram);
        renderInst.setInputLayoutAndState(this.inputLayout, this.inputState);
		const keepBackfaces = renderFlags & RenderFlags.KeepBackfaces;
		const drawBackfacesSeparately = renderFlags & RenderFlags.DrawBackfacesSeparately;
		if (drawBackfacesSeparately)
			renderInst.setMegaStateFlags({ cullMode: flipBackfaces ? GfxCullMode.Front : GfxCullMode.Back });
		else
        	renderInst.setMegaStateFlags({ cullMode: keepBackfaces ? GfxCullMode.None : GfxCullMode.Back });
	
		
		if (translucent){
			const megaState = renderInst.setMegaStateFlags({
				depthWrite: false,
			});
			setAttachmentStateSimple(megaState, {
				blendMode: GfxBlendMode.Add,
				blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
				blendSrcFactor: GfxBlendFactor.SrcAlpha,
			});
		}
		
		
		if (instanceCount === 1)
        	renderInst.drawIndexes(this.indexCount);
		else
			renderInst.drawIndexesInstanced(this.indexCount, instanceCount);


		// fill mesh uniforms
		if (hasMeshColour || scrollUVs){
			let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_MeshParams, (scrollUVs?4:0) + (hasMeshColour?4:0));
			const uniformData = renderInst.mapUniformBufferF32(Program.ub_MeshParams);

			if (hasMeshColour)
				uniformOffset += fillColor(uniformData, uniformOffset, this.colour);
			if (scrollUVs){
				const t = viewerInput.time * 0.001;
				uniformOffset += fillVec4(uniformData, uniformOffset, this.scrollUVs[0] * t, this.scrollUVs[1] * t);
			}
		}

		let renderLayer = GfxRendererLayer.OPAQUE + this.renderLayerOffset;
		if (translucent)
			renderLayer |= GfxRendererLayer.TRANSLUCENT;

		renderInst.sortKey = makeSortKey(renderLayer, gfxProgram.ResourceUniqueId);

        renderInstManager.submitRenderInst(renderInst);

		if (drawBackfacesSeparately && !flipBackfaces)
			this.prepareToRender(device, renderInstManager, viewerInput, cache, instanceCount, true);
	}

	destroy(device: GfxDevice): void {
		device.destroyInputState(this.inputState);
		for (const buf of this.buffers)
			device.destroyBuffer(buf);
	}

	
	makeTranslucent(alpha : number, unlit : boolean, keepBackfaces : boolean){
		this.colour.a = alpha;
		this.renderFlags |= RenderFlags.Translucent | RenderFlags.HasMeshColour;
		if (unlit)
			this.renderFlags |= RenderFlags.Unlit;
		if (keepBackfaces)
			this.renderFlags |= RenderFlags.KeepBackfaces;
	}
	makeReflective() {
		this.renderFlags |= RenderFlags.Reflective;
	}

	makeScrollUVs(xy : vec2){
		this.scrollUVs = xy;
		this.renderFlags |= RenderFlags.ScrollUVs;
	}
}

export class AnimatedObject {
	meshes : StaticObject[];
	animationData : AnimationData;
	_animTexture = new TextureMapping();
	animTextureOffsets : number[]; // pairs of (start, length)
	dirty = false; // if we need to regenerate our texture
	rawAnimTexture : Qd3DTexture = {
		width:0,
		height:0,
		numTextures : 1,
		pixelFormat : GfxFormat.F32_RGBA,
		alpha : AlphaType.Opaque,
		wrapU : GfxWrapMode.Clamp,
		wrapV : GfxWrapMode.Clamp,
		pixels:null!,
	};

	constructor(device : GfxDevice, cache : Cache, skeleton : SkeletalMesh, friendlyNames : FriendlyNames, name : string){
		this.meshes = skeleton.meshes.map((rawMesh, index)=>{
			const mesh = new StaticObject(device, cache, rawMesh, getFriendlyName(friendlyNames, name, index, 0));
			mesh.animatedObject = this;
			return mesh;
		});
		this.animationData = skeleton.animation;
		this.animTextureOffsets = new Array(skeleton.animation.numAnims * 2);
		this.animTextureOffsets.fill(-1);
		this.rawAnimTexture.width = skeleton.animation.numBones * 3;
		this._animTexture.gfxSampler = cache.createSampler({
			magFilter : GfxTexFilterMode.Bilinear,
			minFilter : GfxTexFilterMode.Bilinear,
			wrapS : GfxWrapMode.Clamp,
			wrapT : GfxWrapMode.Clamp,
			mipFilter : GfxMipFilterMode.Nearest,
		});
	}

	generateAnimTexture(index : number){
		if (this.animTextureOffsets[index * 2] >= 0)
			return; // already generated

		const animation = this.animationData;
		const numBones = animation.numBones;
		const anim = animation.anims[index];
		const numFrames = Math.ceil(anim.endTime * Settings.AnimationTextureFps);
		
		const oldHeight = this.rawAnimTexture.height;
		const thisHeight = numFrames;
		const totalHeight = oldHeight + thisHeight;

		const bbox = anim.aabb;
		bbox.reset();
		const scratchAABB = new AABB();

		const stride = this.rawAnimTexture.width * 4;
		const pixels = new Float32Array(stride * totalHeight);
		if (oldHeight){
			// copy old texture
			pixels.set(this.rawAnimTexture.pixels);
		}

		const transforms  = new Array<mat4>(numBones);
		for (let i = 0; i < numBones; ++i)
			transforms[i] = mat4.create();

		for (let row = 0; row < numFrames; ++row){
			const t = row / Settings.AnimationTextureFps;
			calculateAnimationTransforms(animation, index, transforms, t);
			for (let i = 0; i < numBones; ++i){
				const thisBone = transforms[i];
				
				fillMatrix4x3(pixels, (oldHeight + row) * stride + i * 12, thisBone);

				scratchAABB.transform(animation.boneAABBs[i], thisBone);
				bbox.union(bbox, scratchAABB);
			}
		}

		this.animTextureOffsets[index * 2] = oldHeight + 0.5;
		this.animTextureOffsets[index * 2 + 1] = (thisHeight - 1) / anim.endTime;
		this.rawAnimTexture.pixels = pixels;
		this.rawAnimTexture.height = totalHeight;

		this.dirty = true;
	}
	getAnimTexture(cache : Cache){
		if (this.dirty){
			cache.deleteTexture(this._animTexture.gfxTexture);
			this._animTexture.gfxTexture = cache.createTexture(this.rawAnimTexture, "Animation", false);
			this.dirty = false;
		}
		return this._animTexture;
	}

	fillAnimationUniform(target : Float32Array, offset : number, animController : AnimationController){
		const animIndex = animController.currentAnimationIndex;
		let animStartPixels = this.animTextureOffsets[animIndex * 2];
		if (animStartPixels < 0){
			this.generateAnimTexture(animIndex);
			animStartPixels = this.animTextureOffsets[animIndex * 2];
		}
		const animScale = this.animTextureOffsets[animIndex * 2 + 1];

		const t = (animStartPixels + animController.t * animScale) / this.rawAnimTexture.height;
		const texelWidth = 1 / this.rawAnimTexture.width;
		return fillVec4(target, offset, t, texelWidth);
	}
};


export type SceneSettings = {
	clearColour : GfxColor,
	ambientColour : GfxColor,
	fogColour? : GfxColor,
	lightDirs : vec4[],
	lightColours : GfxColor[],
	cameraPos? : vec3, // initial camera posiiton
	cameraTarget? : vec3, // initial camera look at (or zero)
	// todo: fog
};

export class SceneRenderer implements Viewer.SceneGfx{
    renderHelper: GfxRenderHelper;
	cache : Cache;
	sceneSettings : SceneSettings;
	entitySets : Entity[][] = [];
	entitySetMap = new Map<StaticObject, Entity[]>();

	textureHolder : UI.TextureListHolder;


	constructor(device : GfxDevice, context : SceneContext, sceneSettings : SceneSettings){
		const cache = new Cache(device);
		this.cache = cache;
		this.textureHolder = cache;
		this.renderHelper = new GfxRenderHelper(device, context, cache);
		this.sceneSettings = sceneSettings;

		cache.numLights = sceneSettings.lightColours.length;
	}

	getDefaultWorldMatrix(out : mat4){
		if (this.sceneSettings.cameraPos)
			mat4.targetTo(out, this.sceneSettings.cameraPos, this.sceneSettings.cameraTarget ?? Vec3Zero, Vec3UnitY);
	}

	initEntities(device : GfxDevice, entities : Entity[]){
		
		// group entities by type
		for (const entity of entities){
			// insert the entity into the correct entitySet
			this.addEntity(entity);

			// hack: also create animation textures here
			const animEntity = entity as AnimatedEntity;
			const animIndex = animEntity.animationController?.currentAnimationIndex;
			if (animIndex !== undefined){
				// generate animated entity textures
				animEntity.animatedObject.generateAnimTexture(animIndex);
				// hack: their current aabb is garbage, fix it up now
				entity.aabb.transform(entity.baseAABB, entity.modelMatrix);
			}
		}

		// debug validate meshes are consistent
		/*
		for (const set of this.entitySets){
			const meshes = set[0].meshes;
			assert(set.every((entity)=>entity.meshes === meshes), "mismatched mesh types");
		}
		*/

		// roughly sort by mesh type for fun
		this.entitySets.sort((a,b)=>a[0].meshes[0].renderFlags - b[0].meshes[0].renderFlags);

		// generate shaders up front
		for (const set of this.entitySets){
			for (const mesh of set[0].meshes){
				this.cache.getProgram(mesh.renderFlags, set.length);
			}
		}

		// done generating models, done with these caches
		this.cache.sourceModels.clear();
		this.cache.textureFromSourceCache.clear();
	}

	prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput){
		const renderInst = this.renderHelper.pushTemplateRenderInst();

		renderInst.setBindingLayouts([{
			numUniformBuffers : 2,
			numSamplers : 0,
		}]);
		
		// set scene uniforms
		const numLights = this.cache.numLights;
		let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_SceneParams, 4*4 + 4 + 4 + 8*numLights + 4);
		const uniformData = renderInst.mapUniformBufferF32(Program.ub_SceneParams);
		// camera matrix
		uniformOffset += fillMatrix4x4(uniformData, uniformOffset, viewerInput.camera.clipFromWorldMatrix);
		// camera pos
		const cameraPos = mat4.getTranslation([0,0,0], viewerInput.camera.worldMatrix);
		uniformOffset += fillVec4(uniformData, uniformOffset, cameraPos[0], cameraPos[1], cameraPos[2], 1.0);
		// ambient colour
		uniformOffset += fillColor(uniformData, uniformOffset, this.sceneSettings.ambientColour);
		for (let i = 0; i < numLights; ++i){
			// light direction
			uniformOffset += fillVec4v(uniformData, uniformOffset, this.sceneSettings.lightDirs[i]);
			// light colour
			uniformOffset += fillColor(uniformData, uniformOffset, this.sceneSettings.lightColours[i]);
		}
		// time
		const time = viewerInput.time * 0.001;
		uniformData[uniformOffset++] = time;
		// repeat for padding
		uniformData[uniformOffset++] = time;
		uniformData[uniformOffset++] = time;
		uniformData[uniformOffset++] = time;

		
		// update and draw entitis
        const renderInstManager = this.renderHelper.renderInstManager;
		const dt = Math.min(viewerInput.deltaTime * 0.001, 1/15);
		const viewMatrix = viewerInput.camera.viewMatrix;
		const frustum = viewerInput.camera.frustum;
		const cache = this.cache;
		for (const entities of this.entitySets){
			// update
			for (let i = 0; i < entities.length; ++i){
				const e = entities[i];
				const visible = frustum.contains(e.aabb);
				if (!visible)
					e.viewDistance = -Infinity;
				else
					e.viewDistance = computeViewSpaceDepthFromWorldSpacePoint(viewMatrix, e.position);
				
				if (e.update && (visible || e.alwaysUpdate)){
					const updateResult = e.update(dt);
					if (updateResult === false){
						// destroy entity
						entities[i] = entities[entities.length-1];
						entities.pop();
						i--;
						continue;
					} else if (updateResult){
						// spawn a new entity
						this.addEntity(updateResult);
					}
				}
			}
			if (entities.length === 0)
				continue; // check after update since we may have deleted the last one

			const firstEntity = entities[0];
			const firstMesh = firstEntity.meshes[0];
			const translucent = firstMesh.renderFlags & RenderFlags.Translucent;
			const skinned = firstMesh.renderFlags & RenderFlags.Skinned;
		
			// sort
			let startIndex = 0;
			let endIndex = entities.length;
			if (translucent){
				// sort from far to near
				entities.sort((a,b)=>a.viewDistance - b.viewDistance);
				startIndex = entities.findIndex((e)=>e.viewDistance !== -Infinity);
				if (startIndex === -1)
					continue; // everybody's invisible
			} else {
				// sort from near to far
				entities.sort((a,b)=>b.viewDistance - a.viewDistance);
				endIndex = entities.findIndex((e)=>e.viewDistance === -Infinity);
				if (endIndex === -1)
					endIndex = entities.length; // everybody's visible
			}
			const count = endIndex - startIndex;
			if (count === 0)
				continue; // nobody visible

			// draw
			const setSize = cache.getInstanceBufferSize(count);
			for (let setStartIndex = 0; setStartIndex < endIndex; setStartIndex += setSize){
				const setEndIndex = Math.min(setStartIndex + setSize, endIndex);
				const setCount = setEndIndex - setStartIndex;
				
				// populate uniforms
				const renderInst = renderInstManager.pushTemplateRenderInst();
				let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_InstanceParams, cache.getInstanceBufferSize(setCount) * 4*4);
				const uniformData = renderInst.mapUniformBufferF32(Program.ub_InstanceParams);
				for (let i = setStartIndex; i < setEndIndex; ++i){
					const entity = entities[i];
					// push matrix uniform
					uniformOffset += fillMatrix4x3(uniformData, uniformOffset, entity.modelMatrix);
					// push settings unifom
					if (skinned){ // skinned settings
						const animEntity = entity as AnimatedEntity;

						uniformOffset += animEntity.animatedObject.fillAnimationUniform(uniformData, uniformOffset, animEntity.animationController);

						// set opacity to w field
						uniformData[uniformOffset - 1] = entity.opacity;

					} else { // basic settings
						uniformOffset += fillVec4(uniformData, uniformOffset, 0, 0, 0,  entity.opacity);
					}
				}

				// draw
				for (const mesh of firstEntity.meshes){
					mesh.prepareToRender(device, renderInstManager, viewerInput, cache, setCount);
				}

				renderInstManager.popTemplateRenderInst();
			}
		}
			
        renderInstManager.popTemplateRenderInst();
        this.renderHelper.prepareToRender();
	}

	addEntity(entity : Entity){
		const mesh = entity.meshes[0];
		let set = this.entitySetMap.get(mesh);
		if (set)
			set.push(entity);
		else {
			set = [entity];
			this.entitySetMap.set(mesh, set);
			this.entitySets.push(set);
		}
	}

	public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        const renderInstManager = this.renderHelper.renderInstManager;

		const renderPassDescriptor = makeAttachmentClearDescriptor(this.sceneSettings.clearColour); // standardFullClearRenderPassDescriptor;
        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, renderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, renderPassDescriptor);

        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                renderInstManager.drawOnPassRenderer(passRenderer);
            });
        });
        pushAntialiasingPostProcessPass(builder, this.renderHelper, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.prepareToRender(device, viewerInput);
        this.renderHelper.renderGraph.execute(builder);
        renderInstManager.resetRenderInsts();
	}

	public destroy(device: GfxDevice) {
		this.cache.destroy();
		this.renderHelper.destroy();
	}

}

