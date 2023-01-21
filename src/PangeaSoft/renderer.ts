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
import * as DebugJunk from "../DebugJunk";

import { AnimatedEntity, Entity, FriendlyNames, getFriendlyName } from "./entity";
import { AlphaType, Qd3DMesh, Qd3DTexture, textureArrayToCanvas } from "./QuickDraw3D";
import { AnimationData, SkeletalMesh } from "./skeleton";
import { Magenta, Red } from "../Color";


export const enum RenderFlags {
	Translucent		 = 0x400,
	Skinned			 = 0x200,
	Reflective       = 0x100,
	//DrawBackfacesSeparately = 0x80,
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

	constructor(flags : RenderFlags, numLights : number, maxBones : number, instanceCount : number){
		super();

		this.setDefineString("NUM_LIGHTS", numLights.toString());
		this.setDefineString("MAX_BONES", maxBones.toString());
		this.setDefineString("MAX_INSTANCES", instanceCount.toString());

		this.setDefineBool("INSTANCED", instanceCount > 1);

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

layout(std140) uniform InstanceParams {
	Mat4x3 ui_WorldFromModelMatrix;
	vec4 ui_Colour;
	#ifdef SKINNED
		Mat4x3 ui_Bones[MAX_BONES];
	#endif

	#ifdef INSTANCED
		#define INSTANCEID gl_InstanceID
	#else
		#define INSTANCEID 0
	#endif
	#define u_WorldFromModelMatrix ub_InstanceParams[INSTANCEID].ui_WorldFromModelMatrix
	#define u_Colour ub_InstanceParams[INSTANCEID].ui_Colour
	#define u_Bones ub_InstanceParams[INSTANCEID].ui_Bones
} ub_InstanceParams[MAX_INSTANCES];

layout(std140) uniform ub_PerMeshParams {
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


	vec4 colour = u_Colour * u_MeshColour;
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

	instancedPrograms = new Map<RenderFlags, GfxProgram>();
	singlePrograms = new Map<RenderFlags, GfxProgram>();
	maxBones = 0;
	maxInstances = 1;
	numLights = 1;

	viewerTextures : Viewer.Texture[] = [];
	onnewtextures: (() => void) | null = null;


	getProgram(renderFlags : RenderFlags, numInstances : number){
		if (numInstances > this.maxInstances){
			this.maxInstances = numInstances;
			this.instancedPrograms.clear();
			console.warn("too many instances, regenerating all instance shaders");
			// leak old shaders
		}

		const isInstanced = numInstances > 1;
		const programs = isInstanced ? this.instancedPrograms : this.singlePrograms;

		let program = programs.get(renderFlags);
		if (program)
			return program;
		program = this.createProgram(new Program(renderFlags, this.numLights, this.maxBones, isInstanced ? this.maxInstances : 1));
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
	modelMatrix? : mat4 = undefined;
	aabb : AABB;
	colour : GfxColor;
	scrollUVs : vec2 = [0,0];
	renderFlags : RenderFlags = 0;
	textureMapping : TextureMapping[] = [];
	renderLayerOffset = 0;
	animatedObjectParent? : AnimatedObject;

	constructor(device : GfxDevice, cache : Cache, mesh : Qd3DMesh, name : string){
		this.indexCount = mesh.numTriangles * 3;
		this.aabb = mesh.aabb;
		this.colour = mesh.colour;
		if (mesh.baseTransform)
			this.modelMatrix = mat4.clone(mesh.baseTransform);

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

	prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, cache : Cache, entityOrNumEntities : Entity | number): void {
        const renderInst = renderInstManager.newRenderInst();

		const renderFlags = this.renderFlags;
		const translucent = !!(renderFlags & RenderFlags.Translucent);

		const isInstanced = typeof(entityOrNumEntities) === "number";
		const numEntites = isInstanced ? entityOrNumEntities : 1;

		const isSkinned = this.animatedObjectParent !== undefined;

		const gfxProgram = cache.getProgram(renderFlags, numEntites);
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
		//const drawBackfacesSeparately = renderFlags & RenderFlags.DrawBackfacesSeparately;
		//if (drawBackfacesSeparately)
		//	renderInst.setMegaStateFlags({ cullMode: flipBackfaces ? GfxCullMode.Front : GfxCullMode.Back });
		//else
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
		
		

		if (isInstanced)
			renderInst.drawIndexesInstanced(this.indexCount, numEntites);
		else {
        	renderInst.drawIndexes(this.indexCount);

			const instanceBlockSize = 4*3 + 4 + (isSkinned ? 4*3*cache.maxBones : 0);
			let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_InstanceParams, instanceBlockSize);
			const uniformData = renderInst.mapUniformBufferF32(Program.ub_InstanceParams);
			entityOrNumEntities.populateInstanceBlock(uniformData, uniformOffset);
		}

		/*
		let renderLayer = GfxRendererLayer.OPAQUE + this.renderLayerOffset;
		if (translucent)
			renderLayer |= GfxRendererLayer.TRANSLUCENT;

		renderInst.sortKey = setSortKeyDepth(
			makeSortKey(renderLayer, gfxProgram.ResourceUniqueId),
			computeViewSpaceDepthFromWorldSpacePoint(viewerInput.camera.viewMatrix, entity.position)
		);
		*/

        renderInstManager.submitRenderInst(renderInst);

		//if (drawBackfacesSeparately && !flipBackfaces)
		//	this.prepareToRender(device, renderInstManager, viewerInput, cache, entity, true);
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
		this.meshes = skeleton.meshes.map((mesh, index)=>{
			const staticObject = new StaticObject(device, cache, mesh, getFriendlyName(friendlyNames, name, index, 0));
			staticObject.animatedObjectParent = this;
			return staticObject;
		});
		this.animationData = skeleton.animation;
	}

	destroy(device: GfxDevice): void {
		for (const mesh of this.meshes)
			mesh.destroy(device);
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

type MeshSet = {
	meshes : StaticObject[],
	entities : Entity[],
};

export class SceneRenderer implements Viewer.SceneGfx{
    renderHelper: GfxRenderHelper;
	cache : Cache;
	sceneSettings : SceneSettings;

	entitiesByMesh : MeshSet[] = [];

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

	protected initEntities(allEntities : Entity[]){
		
		// partition entities by mesh
		const meshes = new Map<StaticObject, MeshSet>();
		for (const e of allEntities){
			assert(e.meshes.length > 0, "todo: entities without meshes");
			const set = meshes.get(e.meshes[0]);
			if (set){
				assert(set.meshes.length === e.meshes.length && set.meshes.every((mesh, index)=>mesh === e.meshes[index]), "mesh set mismatch!");
				set.entities.push(e);
			} else {
				const set : MeshSet = {
					meshes: [...e.meshes],
					entities : [e],
				};
				meshes.set(e.meshes[0], set);
				this.entitiesByMesh.push(set);
			}
		}

		// init shader instance counts
		const cache = this.cache;
		for (const set of this.entitiesByMesh){
			set.entities.length = 1; // todo
			cache.maxInstances = Math.max(cache.maxInstances, set.entities.length);
			for (const mesh of set.meshes){
				const anim = mesh.animatedObjectParent;
				if (anim){
					cache.maxBones = Math.max(cache.maxBones, anim.animationData.numBones);
				}
			}
		}
	}

	prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput){
		const renderInst = this.renderHelper.pushTemplateRenderInst();

		renderInst.setBindingLayouts([{
			numUniformBuffers : 2,
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

		const dt = Math.min(viewerInput.deltaTime * 0.001, 1/15);
		const frustum = viewerInput.camera.frustum;

		const visibleEntities : Entity[] = [];
		for (const set of this.entitiesByMesh){
			visibleEntities.length = 0;
			for (const e of set.entities){
				const visible = e.doUpdate(dt, frustum);
				if (visible)
					visibleEntities.push(e)
			}
			if (visibleEntities.length == 0)
				continue;

			this.prepareToRenderMeshSet(device, viewerInput, renderInstManager, set.meshes, visibleEntities);
		}
		
        renderInstManager.popTemplateRenderInst();
        this.renderHelper.prepareToRender();
	}

	prepareToRenderMeshSet(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput, renderInstManager: GfxRenderInstManager, meshes : StaticObject[], entities : Entity[]){
		const renderInst = renderInstManager.pushTemplateRenderInst();
		const cache = this.cache;

		const hasScroll = !!(meshes[0].renderFlags & RenderFlags.ScrollUVs);
		assert(meshes.every((m)=>!!(m.renderFlags & RenderFlags.ScrollUVs) == hasScroll), "inconsistent uniforms");

		const isSkinned = meshes[0].animatedObjectParent !== undefined;
		assert(meshes.every((m)=>(m.animatedObjectParent !== undefined) === isSkinned), "inconsistent skinning");
		assert(entities.every((e)=>((e as AnimatedEntity).animationController !== undefined) === isSkinned), "inconsistent entity skinning");

		const isInstanced = entities.length > 1;

		renderInst.setBindingLayouts([{
			numUniformBuffers : 3,
			numSamplers : 1,
		}]);


		const canvas = DebugJunk.getDebugOverlayCanvas2D();

		{ // populate mesh uniform
			let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_MeshParams, hasScroll ? 8 : 4);
			const uniformData = renderInst.mapUniformBufferF32(Program.ub_MeshParams);
			
			uniformOffset += fillColor(uniformData, uniformOffset, meshes[0].colour);
			if (hasScroll){
				uniformData[uniformOffset++] = meshes[0].scrollUVs[0];
				uniformData[uniformOffset++] = meshes[0].scrollUVs[1];
				uniformData[uniformOffset++] = meshes[0].scrollUVs[0]; // padding
				uniformData[uniformOffset++] = meshes[0].scrollUVs[1];
			}
		}

		const instanceBlockSize = 4*3 + 4 + (isSkinned ? 4*3*cache.maxBones : 0);
		if (isInstanced){
			 // populate instance uniforms
			const numInstanceSlots = cache.maxInstances;

			let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_InstanceParams, instanceBlockSize * numInstanceSlots);
			const uniformData = renderInst.mapUniformBufferF32(Program.ub_InstanceParams);
			for (const e of entities){
				DebugJunk.drawWorldSpaceAABB(canvas, viewerInput.camera.clipFromWorldMatrix, e.aabb, null, Red);
				e.populateInstanceBlock(uniformData, uniformOffset);
				uniformOffset += instanceBlockSize;
			}
			
			// draw
			for (const mesh of meshes){
				mesh.prepareToRender(device, renderInstManager, viewerInput, cache, entities.length);
			}
		} else { // not instanced
			for (const e of entities){
				DebugJunk.drawWorldSpaceAABB(canvas, viewerInput.camera.clipFromWorldMatrix, e.aabb, null, Magenta);
				for (const mesh of meshes){
					mesh.prepareToRender(device, renderInstManager, viewerInput, cache, e);
				}
			}
		}


		renderInstManager.popTemplateRenderInst();
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

