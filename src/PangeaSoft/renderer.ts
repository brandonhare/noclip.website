import { mat4, ReadonlyMat4, vec2, vec3, vec4 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { computeViewSpaceDepthFromWorldSpacePoint } from "../Camera";
import { AABB } from "../Geometry";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { makeAttachmentClearDescriptor, makeBackbufferDescSimple, pushAntialiasingPostProcessPass } from "../gfx/helpers/RenderGraphHelpers";
import { convertToCanvas } from "../gfx/helpers/TextureConversionHelpers";
import { fillColor, fillMatrix4x3, fillMatrix4x4, fillVec4, fillVec4v } from "../gfx/helpers/UniformBufferHelpers";
import { GfxBlendFactor, GfxBlendMode, GfxBufferUsage, GfxColor, GfxCullMode, GfxDevice, GfxIndexBufferDescriptor, GfxInputLayoutBufferDescriptor, GfxMipFilterMode, GfxSamplerFormatKind, GfxTexFilterMode, GfxTextureDimension, GfxTextureUsage, GfxVertexAttributeDescriptor, GfxVertexBufferDescriptor, GfxVertexBufferFrequency } from "../gfx/platform/GfxPlatform";
import { GfxFormat } from "../gfx/platform/GfxPlatformFormat";
import { GfxBuffer, GfxInputLayout, GfxInputState, GfxProgram, GfxTexture } from "../gfx/platform/GfxPlatformImpl";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper";
import { GfxRendererLayer, GfxRenderInstManager, makeSortKey, setSortKeyDepth } from "../gfx/render/GfxRenderInstManager";
import { Vec3UnitY, Vec3Zero } from "../MathHelpers";
import { DeviceProgram } from "../Program";
import { Destroyable, SceneContext } from "../SceneBase";
import { TextureMapping } from "../TextureHolder";
import * as UI from "../ui";
import { assert } from "../util";
import * as Viewer from '../viewer';

import { AnimatedEntity, Entity, EntityUpdateResult, FriendlyNames, getFriendlyName } from "./entity";
import { AlphaType, Qd3DMesh, Qd3DTexture, textureArrayToCanvas } from "./QuickDraw3D";
import { AnimationData, SkeletalMesh } from "./skeleton";


export const enum RenderFlags {
	Translucent		 = 0x400, // must be the highest value
	Skinned			 = 0x200,
	Reflective       = 0x100,
	DrawBackfacesSeparately = 0x80,
	KeepBackfaces    = 0x40,
	Unlit			 = 0x20,
	ScrollUVs        = 0x10,
	HasTexture		 = 0x8,
	TextureHasOneBitAlpha  = 0x4,
	TextureTilemap	 = 0x2,
	HasVertexColours = 0x1,
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

	// which flags affect per-instance uniform layout
	static readonly InstanceUniformRenderFlags = RenderFlags.Skinned;
	// which flags affect per-mesh uniform layout
	static readonly MeshUniformRenderFlags = RenderFlags.ScrollUVs;

	constructor(flags : RenderFlags, numLights : number, maxBones : number, maxInstances : number){
		super();

		this.setDefineString("NUM_LIGHTS", numLights.toString());
		this.setDefineString("MAX_BONES", maxBones.toString());
		this.setDefineString("MAX_INSTANCES", maxInstances.toString());

		this.setDefineBool("UNLIT", (flags & RenderFlags.Unlit) !== 0);
		this.setDefineBool("HAS_VERTEX_COLOURS", (flags & RenderFlags.HasVertexColours) !== 0);
		this.setDefineBool("HAS_TEXTURE", (flags & RenderFlags.HasTexture) !== 0);
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

struct Params {
	Mat4x3 ui_WorldFromModelMatrix;
	vec4 ui_InstanceColour;
	
	#ifdef SKINNED
		Mat4x3 ui_Bones[MAX_BONES];
	#endif
};
layout(std140) uniform InstanceParams {
	Params ub_InstanceParams[MAX_INSTANCES];

	#define u_WorldFromModelMatrix ub_InstanceParams[gl_InstanceID].ui_WorldFromModelMatrix
	#define u_InstanceColour ub_InstanceParams[gl_InstanceID].ui_InstanceColour
	#define u_Bones ub_InstanceParams[gl_InstanceID].ui_Bones
};

layout(std140) uniform ub_MeshParams {
	vec4 u_MeshColour;

	#ifdef SCROLL_UVS
		vec4 u_UVScrollVec; // xy = uv, zw = unused
		#define u_UVScroll (u_UVScrollVec.xy)
	#endif
};
`;
	override vert = 
`
layout(location = ${Program.a_Position}) in vec3 a_Position;
layout(location = ${Program.a_UVs}) in vec2 a_UV;
layout(location = ${Program.a_Normals}) in vec3 a_Normal;
layout(location = ${Program.a_Colours}) in vec3 a_Colour;
layout(location = ${Program.a_TextureIds}) in float a_TextureId;
layout(location = ${Program.a_BoneIds}) in float a_BoneId;

out vec4 v_Colour;
out vec2 v_UV;
flat out int v_Id;

${GfxShaderLibrary.MulNormalMatrix}

void main() {
	v_UV = a_UV;
	#ifdef TILEMAP
		v_UV = a_Position.xz;
		v_Id = int(a_TextureId);
	#endif

	vec3 localPos = a_Position;
	vec3 localNormal = a_Normal;

	#ifdef SKINNED
		int boneId = int(a_BoneId);

		localPos = Mul(u_Bones[boneId], vec4(localPos, 1.0));
		//localNormal = MulNormalMatrix(u_Bones[boneId], localNormal);
		localNormal = Mul(u_Bones[boneId], vec4(localNormal, 0.0));
	#endif
	
	vec3 worldPos = Mul(u_WorldFromModelMatrix, vec4(localPos, 1.0));
	vec3 worldNormal = normalize(MulNormalMatrix(u_WorldFromModelMatrix, localNormal));

	#ifdef REFLECTIVE
		v_UV = normalize(reflect(u_CameraPos.xyz - worldPos, worldNormal)).xy * 0.5 + 0.5;
	#endif


	vec4 colour = u_MeshColour * u_InstanceColour;
	#ifdef HAS_VERTEX_COLOURS
		colour.xyz *= a_Colour;
	#endif

	#ifndef UNLIT
		vec3 lightColour = u_AmbientColour.xyz;
		for (int i = 0; i < NUM_LIGHTS; ++i){
			lightColour += max(0.0, dot(u_Lights[i].direction.xyz, worldNormal)) * u_Lights[i].colour.xyz;
		}
		colour.xyz *= lightColour;
	#endif

	v_Colour = colour;
    gl_Position = Mul(u_ClipFromWorldMatrix, vec4(worldPos,1.0));
}
`;
	override frag = 
`
#ifdef TILEMAP
	precision mediump float;
	precision lowp sampler2DArray;
	uniform sampler2DArray u_TilemapTexture;
	flat in int v_Id;
#else
	uniform sampler2D u_Texture;
#endif
in vec4 v_Colour;
in vec2 v_UV;

void main(){
	vec4 colour = v_Colour;
	
	#ifdef HAS_TEXTURE

		#ifndef TILEMAP
			vec2 uv = v_UV;
			#ifdef SCROLL_UVS
				uv += u_UVScroll * u_Time;
			#endif
			vec4 texColour = texture(SAMPLER_2D(u_Texture), uv);
			#ifdef TEXTURE_HAS_ONE_BIT_ALPHA
				if (texColour.a < 0.5) { discard; }
			#endif
			colour *= texColour;
		#else
			//vec2 uv = mix(vec2(0.015625,0.015625), vec2(0.984375,0.984375), fract(v_UV));
			vec2 uv = fract(v_UV);

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
	#endif
	

	gl_FragColor = colour;
}
`;
};




export class Cache extends GfxRenderCache implements UI.TextureListHolder {
	textures = new WeakMap<Qd3DTexture, GfxTexture>();

	allModels : StaticObject[] = [];
	allTextures : GfxTexture[] = [];

	singlePrograms = new Map<RenderFlags, GfxProgram>();
	instancedPrograms = new Map<RenderFlags, GfxProgram>();
	instanceCounts = new Map<RenderFlags, number>();

	numLights = 1;
	maxBones = 0;

	viewerTextures : Viewer.Texture[] = [];
	onnewtextures: (() => void) | null = null;

	
	getNumInstances(renderFlags: RenderFlags | StaticObject[], numInstances : number){
		if (numInstances === 1)
			return 1;

		if (typeof(renderFlags) !== "number"){
			let max = 0;
			for (const mesh of renderFlags)
				max = Math.max(max, this.getNumInstances(mesh.renderFlags, numInstances));
			return max;
		}
		
		let prevCount = this.instanceCounts.get(renderFlags) ?? 0;
		if (numInstances <= prevCount)
			return prevCount;
		
		console.log(`updating num instances for flags ${renderFlags} from ${prevCount} to ${numInstances}`);
		this.instancedPrograms.delete(renderFlags); // todo: dont leak program
		this.instanceCounts.set(renderFlags, numInstances);
		return numInstances;
	}

	getProgram(renderFlags : RenderFlags, numInstances : number){
		let programs : Map<RenderFlags, GfxProgram>;
		if (numInstances === 1){
			programs = this.singlePrograms;
		} else {
			programs = this.instancedPrograms;
			numInstances = this.getNumInstances(renderFlags, numInstances);
		}

		let program = programs.get(renderFlags);
		if (program)
			return program;
		program = this.createProgram(new Program(renderFlags, this.numLights, this.maxBones, numInstances));
		programs.set(renderFlags, program);
		return program;
	}

	createTexture(texture : Qd3DTexture, name : string){
		let result = this.textures.get(texture);
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
			this.textures.set(texture, result);
			this.allTextures.push(result);
			this.device.uploadTextureData(result, 0, [texture.pixels]);

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
		return result;
	}

	createTextureMapping(texture : Qd3DTexture, name : string){
		const mapping = new TextureMapping();
		mapping.gfxTexture = this.createTexture(texture, name);

		
		mapping.gfxSampler = this.createSampler({
			magFilter : GfxTexFilterMode.Point,
			minFilter : GfxTexFilterMode.Point,
			wrapS : texture.wrapU,
			wrapT : texture.wrapV,
			mipFilter : GfxMipFilterMode.NoMip,
		});
		
		
		
		return mapping;
	}

	addModel(model : StaticObject | StaticObject[] | StaticObject[][]){
		if (Array.isArray(model)){
			for (const m of model)
				this.addModel(m)
			return;
		}
		this.allModels.push(model);
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
	textureMapping : TextureMapping[] = [];
	renderLayerOffset = 0;

	constructor(device : GfxDevice, cache : Cache, mesh : Qd3DMesh, public name : string){
		this.indexCount = mesh.numTriangles * 3;
		this.aabb = mesh.aabb;
		this.colour = mesh.colour;

		cache.addModel(this);

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
			this.renderFlags |= RenderFlags.Translucent;
		}

		if (isSkinned)
			this.renderFlags |= RenderFlags.Skinned;

		const texture = mesh.texture;
		if (texture){
			assert(hasUvs || hasTilemap, "model has texture but no UVs!");

			this.textureMapping.push(cache.createTextureMapping(texture, name));

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

	prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, cache : Cache, entityOrCount : Entity | number, flipBackfaces = false): void {
        const renderInst = renderInstManager.newRenderInst();

		const renderFlags = this.renderFlags;
		const translucent = !!(renderFlags & RenderFlags.Translucent);

		const skinned = !!(renderFlags & RenderFlags.Skinned);

		const instanced = typeof(entityOrCount) === "number";

		const gfxProgram = cache.getProgram(renderFlags, instanced ? entityOrCount : 1);

		const hasTexture = (this.renderFlags & RenderFlags.HasTexture) !== 0;
		const textureArray = (this.renderFlags & RenderFlags.TextureTilemap) !== 0;

		if (!hasTexture || textureArray){
			renderInst.setBindingLayouts([{
				numUniformBuffers : 3,
				numSamplers : hasTexture ? 1 : 0,
				samplerEntries : textureArray ? [{
					dimension : GfxTextureDimension.n2DArray,
					formatKind : GfxSamplerFormatKind.Float,
				}] : undefined
			}]);
		}

        renderInst.setGfxProgram(gfxProgram);
        renderInst.setInputLayoutAndState(this.inputLayout, this.inputState);
		const keepBackfaces = renderFlags & RenderFlags.KeepBackfaces;
		const drawBackfacesSeparately = renderFlags & RenderFlags.DrawBackfacesSeparately;
		if (drawBackfacesSeparately)
			renderInst.setMegaStateFlags({ cullMode: flipBackfaces ? GfxCullMode.Front : GfxCullMode.Back });
		else
        	renderInst.setMegaStateFlags({ cullMode: keepBackfaces ? GfxCullMode.None : GfxCullMode.Back });
        renderInst.setSamplerBindingsFromTextureMappings(this.textureMapping);
	
		
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
		
		if (instanced)
			renderInst.drawIndexesInstanced(this.indexCount, entityOrCount);
		else
       		renderInst.drawIndexes(this.indexCount);

		const scrollUVs = renderFlags & RenderFlags.ScrollUVs;

		// fill mesh uniforms
		{
			let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_MeshParams, 4 + (scrollUVs?4:0));
			const uniformData = renderInst.mapUniformBufferF32(Program.ub_MeshParams);

			uniformOffset += fillColor(uniformData, uniformOffset, this.colour);

			if (scrollUVs){
				uniformData[uniformOffset++] = this.scrollUVs[0];
				uniformData[uniformOffset++] = this.scrollUVs[1];
				// repeat for padding
				uniformData[uniformOffset++] = this.scrollUVs[0];
				uniformData[uniformOffset++] = this.scrollUVs[1];
			}
		}


		if (!instanced){
			// fill single uniforms
			let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_InstanceParams, 4*3+4+(skinned?4*3*cache.maxBones:0));
			const uniformData = renderInst.mapUniformBufferF32(Program.ub_InstanceParams);

			pushInstUniforms(uniformData, uniformOffset, cache, entityOrCount, skinned);
		}

		let renderLayer = GfxRendererLayer.OPAQUE + this.renderLayerOffset;
		if (translucent)
			renderLayer |= GfxRendererLayer.TRANSLUCENT;

		renderInst.sortKey = makeSortKey(renderLayer, gfxProgram.ResourceUniqueId);
		if (!instanced)
			renderInst.sortKey = setSortKeyDepth(renderInst.sortKey, computeViewSpaceDepthFromWorldSpacePoint(viewerInput.camera.viewMatrix, entityOrCount.position));

        renderInstManager.submitRenderInst(renderInst);

		// todo backfaces
		//if (drawBackfacesSeparately && !flipBackfaces)
			//this.prepareToRender(device, renderInstManager, viewerInput, cache, entity, true);
	}

	destroy(device: GfxDevice): void {
		device.destroyInputState(this.inputState);
		for (const buf of this.buffers)
			device.destroyBuffer(buf);
	}

	
	makeTranslucent(alpha : number, unlit : boolean, keepBackfaces : boolean){
		this.colour.a = alpha;
		this.renderFlags |= RenderFlags.Translucent;
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

export class AnimatedObject implements Destroyable{
	meshes : StaticObject[];
	animationData : AnimationData;

	constructor(device : GfxDevice, cache : Cache, skeleton : SkeletalMesh, friendlyNames : FriendlyNames, name : string){
		this.meshes = skeleton.meshes.map((mesh, index)=>
			new StaticObject(device, cache, mesh, getFriendlyName(friendlyNames, name, index, 0))
		);
		this.animationData = skeleton.animation;

		if (this.animationData.numBones > cache.maxBones)
			cache.maxBones = this.animationData.numBones;
	}

	destroy(device: GfxDevice): void {
		for (const mesh of this.meshes)
			mesh.destroy(device);
	}
};




type MeshSet = {
	meshes : StaticObject[],
	entities : Entity[],
};

const InvisibleViewDistance = -1e20;

function pushInstUniforms(uniformData : Float32Array, uniformOffset : number, cache : Cache, entity : Entity, skinned : boolean){
	const startOffset = uniformOffset;
	uniformOffset += fillMatrix4x3(uniformData, uniformOffset, entity.modelMatrix);
	uniformOffset += fillColor(uniformData, uniformOffset, entity.colour);

	if (skinned){
		const bones = (entity as AnimatedEntity).animationController.boneTransforms;
		for (const bone of bones)
			uniformOffset += fillMatrix4x3(uniformData, uniformOffset, bone);
		uniformOffset += (cache.maxBones - bones.length)*4*3;
	}
	return uniformOffset - startOffset;
}

function prepareToRenderMeshSet(device : GfxDevice, renderInstManager : GfxRenderInstManager, viewerInput : Viewer.ViewerRenderInput, cache : Cache, set : MeshSet){

	let startIndex = 0;
	let endIndex : number;
	if (set.meshes[0].renderFlags & RenderFlags.Translucent) {
		// sort furthest to closest
		set.entities.sort((a,b)=>b.viewDistance - a.viewDistance);
		endIndex = set.entities.findIndex((e)=>e.viewDistance === InvisibleViewDistance);
		if (endIndex === -1)
			endIndex = set.entities.length; // all visible
		else if (endIndex === 0)
			return; // none visible
	} else {
		// sort closest to furthest
		set.entities.sort((a,b)=>a.viewDistance - b.viewDistance);

		startIndex = set.entities.findIndex((e)=>e.viewDistance !== InvisibleViewDistance);
		endIndex = set.entities.length;
		if (startIndex == -1)
			return; // none visible
	}
	let count = endIndex - startIndex;

	if (count == 1){
		for (const mesh of set.meshes){
			mesh.prepareToRender(device, renderInstManager, viewerInput, cache, set.entities[startIndex]);
		}
		return;
	}


	const skinned = !!(set.meshes[0].renderFlags&RenderFlags.Skinned);
	const blockSize = 4*3+4+(skinned?4*3*cache.maxBones:0);

	const max = device.queryLimits().uniformBufferMaxPageWordSize;
	const otherBlocks = (8+4*4 + 4 + 4 + 8*cache.numLights + 1);
	const count2 = Math.min(count, (max - otherBlocks/4) / (blockSize/4));
	if (count !== count2) console.log(count, count2);
	count = count2;

	// set instance uniforms
	const renderInst = renderInstManager.pushTemplateRenderInst();
	let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_InstanceParams, blockSize*cache.getNumInstances(set.meshes, count));
	const uniformData = renderInst.mapUniformBufferF32(Program.ub_InstanceParams);

	for (let i = startIndex; i < endIndex; ++i){
		uniformOffset += pushInstUniforms(uniformData, uniformOffset, cache, set.entities[i], skinned);
	}

	// draw
	for (const mesh of set.meshes){
		mesh.prepareToRender(device, renderInstManager, viewerInput, cache, count);
	}

	renderInstManager.popTemplateRenderInst();
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
	cache : Cache;
	sceneSettings : SceneSettings;

    entities: Entity[] = [];
	meshSets : MeshSet[] = [];

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

	initEntities(){
		const map = new Map<StaticObject, MeshSet>();
		for (const entity of this.entities){

			const mask = Program.MeshUniformRenderFlags | Program.InstanceUniformRenderFlags;
			const targetFlags = entity.meshes[0].renderFlags & mask;
			for (let i = 1; i < entity.meshes.length; ++i){
				if ((entity.meshes[i].renderFlags & mask) !== targetFlags){
					assert(false, "todo: mismatched render types");
					break;
				}
			}

			assert(entity.meshes.length > 0, "todo: non-visible entities");
			const set = map.get(entity.meshes[0]);
			if (set){
				assert(set.meshes.length === entity.meshes.length && set.meshes.every((m,index)=>entity.meshes[index] === m), "mismatched meshes");
				set.entities.push(entity);
			} else {
				const set = {
					meshes : [...entity.meshes],
					entities : [entity],
				}
				map.set(entity.meshes[0], set);
				this.meshSets.push(set);
			}
		}

		// init shader instance counts
		/*for (const set of this.meshSets){
			this.cache.getNumInstances(set.meshes, set.entities.length);
		}
		console.log("instance counts", this.cache.instanceCounts);
		*/

		// just a rough sort for fun since per-set meshes can have different settings
		this.meshSets.sort((a,b)=>
			a.meshes[0].renderFlags - b.meshes[0].renderFlags
			// tranlucents is the highest value flag so this will partition them
		);
	}

	prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput){
		const renderInst = this.renderHelper.pushTemplateRenderInst();

		renderInst.setBindingLayouts([{
			numUniformBuffers : 3,
			numSamplers : 1,
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


		// update entities
		const dt = Math.min(viewerInput.deltaTime * 0.001, 1/15);
		for (let i = 0; i < this.entities.length; ++i){
			const entity = this.entities[i];
			const visible = viewerInput.camera.frustum.contains(entity.aabb);

			if (visible || entity.alwaysUpdate){
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

			entity.viewDistance = visible ? computeViewSpaceDepthFromWorldSpacePoint(viewerInput.camera.viewMatrix, entity.position) : InvisibleViewDistance;
		}

		// draw
		for (const set of this.meshSets){
			prepareToRenderMeshSet(device, renderInstManager, viewerInput, this.cache, set);
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

