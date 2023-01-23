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
import { AnimationData, calculateAnimationTransforms, SkeletalMesh } from "./skeleton";

// Settings
const enum Settings {
	MeshMergeThreshold = 10,
	AnimationTextureFps = 30,
	DefaultTexFilter = GfxTexFilterMode.Bilinear,
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

	constructor(flags : RenderFlags, numLights : number){
		super();

		this.setDefineString("NUM_LIGHTS", numLights.toString());
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

layout(std140) uniform ub_DrawParams {
	Mat4x3 u_WorldFromModelMatrix;
	vec4 u_Params; // x = anim time, y = anim texture width; w = opacity
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

	getProgram(renderFlags : RenderFlags){
		let program = this.programs.get(renderFlags);
		if (program) return program;
		program = this.createProgram(new Program(renderFlags, this.numLights));
		//if (!this.programIds.has(program))
		//	this.programIds.set(program, this.programs.size);
		this.programs.set(renderFlags, program);
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

	prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, cache : Cache, entity : Entity, flipBackfaces = false): void {
        const renderInst = renderInstManager.newRenderInst();

		const renderFlags = this.renderFlags;
		const translucent = !!(renderFlags & RenderFlags.Translucent);

		const skinned = !!(renderFlags & RenderFlags.Skinned);

		const gfxProgram = cache.getProgram(renderFlags);
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

		
		const animEntity = (entity as AnimatedEntity);
        renderInst.setSamplerBindingsFromTextureMappings([
			this.textureMapping ?? null,
			skinned ? assertExists(animEntity.animatedObject!.animTextures[animEntity.animationController.currentAnimationIndex], "anim texture missing!") : null
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
		
		
        renderInst.drawIndexes(this.indexCount);


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

		{ // fill instance uniforms
			let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_InstanceParams, 4*3 + 4);
			const uniformData = renderInst.mapUniformBufferF32(Program.ub_InstanceParams);
			
			uniformOffset += fillMatrix4x3(uniformData, uniformOffset, entity.modelMatrix);
			if (skinned){
				const animController = (entity as AnimatedEntity).animationController;
				const t = animController.t / animController.animation.anims[animController.currentAnimationIndex].endTime;
				const texelWidth = 1 / (animController.animation.numBones * 3);
				uniformOffset += fillVec4(uniformData, uniformOffset, t, texelWidth, 0, entity.colour.a);
			} else {
				uniformOffset += fillVec4(uniformData, uniformOffset, 0,0,0, entity.colour.a);
			}
		}

		let renderLayer = GfxRendererLayer.OPAQUE + this.renderLayerOffset;
		if (translucent)
			renderLayer |= GfxRendererLayer.TRANSLUCENT;

		renderInst.sortKey = setSortKeyDepth(
			makeSortKey(renderLayer, gfxProgram.ResourceUniqueId),
			computeViewSpaceDepthFromWorldSpacePoint(viewerInput.camera.viewMatrix, entity.position)
		);

        renderInstManager.submitRenderInst(renderInst);

		if (drawBackfacesSeparately && !flipBackfaces)
			this.prepareToRender(device, renderInstManager, viewerInput, cache, entity, true);
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
	animTextures : (TextureMapping|undefined)[];

	constructor(device : GfxDevice, cache : Cache, skeleton : SkeletalMesh, friendlyNames : FriendlyNames, name : string){
		this.meshes = skeleton.meshes.map((mesh, index)=>
			new StaticObject(device, cache, mesh, getFriendlyName(friendlyNames, name, index, 0))
		);
		this.animationData = skeleton.animation;
		this.animTextures = new Array(skeleton.animation.numAnims);
	}

	generateAnimTexture(cache : Cache, index : number){
		if (this.animTextures[index])
			return; // already generated
		const animation = this.animationData;
		const numBones = animation.numBones;
		const anim = animation.anims[index];
		const numFrames = Math.ceil(anim.endTime * Settings.AnimationTextureFps);
		
		const width = numBones * 3; // one mat4x3 per bone
		const height = numFrames;

		const bbox = anim.aabb;
		bbox.reset();
		const scratchAABB = new AABB();

		const stride = width * 4;
		const pixels = new Float32Array(stride * height);

		const transforms  = new Array<mat4>(numBones);
		for (let i = 0; i < numBones; ++i)
			transforms[i] = mat4.create();

		for (let row = 0; row < numFrames; ++row){
			const t = row / Settings.AnimationTextureFps;
			calculateAnimationTransforms(animation, index, transforms, t);
			for (let i = 0; i < numBones; ++i){
				const thisBone = transforms[i];
				
				fillMatrix4x3(pixels, row * stride + i * 12, thisBone);

				scratchAABB.transform(animation.boneAABBs[i], thisBone);
				bbox.union(bbox, scratchAABB);
			}
		}

		const texture : Qd3DTexture = {
			width,
			height,
			numTextures : 1,
			pixelFormat : GfxFormat.F32_RGBA,
			alpha : AlphaType.Opaque,
			wrapU : GfxWrapMode.Clamp,
			wrapV : GfxWrapMode.Clamp,
			pixels,
		};
		this.animTextures[index] = cache.createTextureMapping(texture, "Animation", false, GfxTexFilterMode.Bilinear);
	}
};


function mergeMeshes(device : GfxDevice, cache : Cache, entities : Entity[]) : Entity {

	const pos : vec3 = [0,0,0];
	const norm : vec4 = [0,0,0,0];
	const normalTransform = mat4.create();

	const newMeshes = entities[0].meshes.map((mesh)=>{
		const rawMesh = assertExists(cache.sourceModels.get(mesh), "missing source mesh");

		const count = entities.length;
		const numVertices = rawMesh.numVertices * count;
		const numTriangles = rawMesh.numTriangles * count;
		const numIndices = numTriangles * 3;

		const indexStride = rawMesh.numTriangles * 3;
		const vertexStride = rawMesh.numVertices * 3;
		const uvStride = rawMesh.numVertices * 2;
		

		const aabb = new AABB();
		const indices = (numVertices <= 0x10000) ? new Uint16Array(numIndices) : new Uint32Array(numIndices);
		const vertices = new Float32Array(numVertices*3);
		const UVs = rawMesh.UVs ? new Float32Array(numVertices*2) : undefined;
		const normals = rawMesh.normals ? new Float32Array(numVertices*3) : undefined;
		const vertexColours = rawMesh.vertexColours ? (
			rawMesh.vertexColours.BYTES_PER_ELEMENT === 1 ? new Uint8Array(numVertices * 3) : new Float32Array(numVertices * 3)
		) : undefined;
		assert(!rawMesh.tilemapIds && !rawMesh.boneIds, "cannot merge tilemaps or bones");

		for (let i = 0; i < count; ++i){

			UVs?.set(rawMesh.UVs!, uvStride * i);
			vertexColours?.set(rawMesh.vertexColours!, vertexStride * i);

			// merge indices
			for (let j = 0; j < indexStride; ++j)
				indices[indexStride * i + j] = rawMesh.indices[j] + rawMesh.numVertices * i;

			// merge verts
			const transform = entities[i].modelMatrix;
			for (let j = 0; j < vertexStride; j += 3){
				for (let k = 0; k < 3; ++k)
					pos[k] = rawMesh.vertices[j+k];
				vec3.transformMat4(pos, pos, transform);
				aabb.unionPoint(pos);
				for (let k = 0; k < 3; ++k)
					vertices[i*vertexStride+j+k] = pos[k];
			}
			
			if (normals){
				// merge normals
				computeNormalMatrix(normalTransform, transform);
				for (let j = 0; j < vertexStride; j += 3){
					for (let k = 0; k < 3; ++k)
						norm[k] = rawMesh.normals![j+k];
					vec4.transformMat4(norm, norm, normalTransform);
					vec4.normalize(norm, norm);
					for (let k = 0; k < 3; ++k)
						normals[i*vertexStride+j+k] = norm[k];
				}
			}
		}

		const mergedMesh : Qd3DMesh = {
			numTriangles,
			numVertices,
			aabb,
			colour : mesh.colour,
			texture : rawMesh.texture,

			indices,
			vertices,
			UVs,
			normals,
			vertexColours,
		};

		const result = new StaticObject(device, cache, mergedMesh, "Merged mesh");
		result.renderFlags = mesh.renderFlags;
		result.renderLayerOffset = mesh.renderLayerOffset;
		result.scrollUVs = mesh.scrollUVs;
		return result;
	});
	return new Entity(newMeshes, [0,0,0], 0, 1, false);
}


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
    entities: Entity[] = [];
	cache : Cache;
	sceneSettings : SceneSettings;

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

	initEntities(device : GfxDevice){
		const staticEntityMap = new Map<StaticObject, Entity[]>();


		this.entities = this.entities.filter((e)=>{
			if (e.update !== undefined || e.isDynamic){

				// calculate animation textures and bboxes up front
				const animEntity = e as AnimatedEntity;
				const animIndex = animEntity.animationController?.currentAnimationIndex;
				if (animIndex !== undefined){
					// generate animated entity textures
					animEntity.animatedObject.generateAnimTexture(this.cache, animIndex);
					e.aabb.transform(e.baseAABB, e.modelMatrix);
				}
				

				return true; // not a static entity, keep it in the main entity list
			}
			// else this is a static entity, see if we can merge it

			const mesh = e.meshes[0];
			const set = staticEntityMap.get(mesh);
			if (set){
				// assert(set.every((e2)=>e2.meshes === e.meshes), "entity mesh mismatch!");
				set.push(e);
			} else 
				staticEntityMap.set(mesh, [e]);
			return false;
		});

		// merge static entities
		staticEntityMap.forEach((entities, firstMesh)=>{
			if (entities.length <= Settings.MeshMergeThreshold){
				// never mind, put them back
				this.entities.push(...entities);
				staticEntityMap.delete(firstMesh);
				return;
			} else {
				// todo: split into area-based batches
				this.entities.push(mergeMeshes(device, this.cache, entities));
			}
		});

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
		const numLights = this.cache.numLights;
		// set scene uniforms
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

        const renderInstManager = this.renderHelper.renderInstManager;

		const dt = Math.min(viewerInput.deltaTime * 0.001, 1/15);
		for (let i = 0; i < this.entities.length; ++i){
			const entity = this.entities[i];
			const visible = entity.checkVisible(viewerInput.camera.frustum);

			if (!visible && !entity.alwaysUpdate)
				continue;

			if (entity.update){
				const result : EntityUpdateResult = entity.update(dt);
				if (result === false){
					// destroy this entity
					this.entities.splice(i, 1);
					--i;
					continue;
				}
				if (result){
					// created new entity
					this.entities.push(result);
				}
			}

			if (visible)
				entity.prepareToRender(device, renderInstManager, viewerInput, this.cache);
		}
			
        renderInstManager.popTemplateRenderInst();
        this.renderHelper.prepareToRender();
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

