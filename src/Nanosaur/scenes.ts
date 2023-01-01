
import * as Viewer from '../viewer';
import * as UI from "../ui";

import { GfxBuffer, GfxBufferUsage, GfxDevice, GfxFormat, GfxIndexBufferDescriptor, GfxInputLayout, GfxVertexBufferFrequency, GfxInputLayoutBufferDescriptor, GfxInputLayoutDescriptor, GfxInputState, GfxVertexAttributeDescriptor, GfxVertexBufferDescriptor, GfxWrapMode, GfxProgram, GfxProgramDescriptorSimple, GfxColor, GfxBlendFactor, GfxBlendMode, GfxSampler, makeTextureDescriptor2D, GfxTexture, GfxCullMode, GfxTexFilterMode, GfxMipFilterMode, GfxTextureUsage, GfxTextureDimension, GfxCompareMode } from "../gfx/platform/GfxPlatform";
import { Destroyable, GraphObjBase, SceneContext } from "../SceneBase";
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper';

import { GridPlane } from "../InteractiveExamples/GridPlane";
import { makeAttachmentClearDescriptor, makeBackbufferDescSimple, opaqueBlackFullClearRenderPassDescriptor, pushAntialiasingPostProcessPass, standardFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers";
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph";
import { GfxRendererLayer, GfxRenderInstManager, makeSortKey, makeSortKeyOpaque, makeSortKeyTranslucent, setSortKeyDepth } from "../gfx/render/GfxRenderInstManager";
import { DataFetcher, NamedArrayBufferSlice } from "../DataFetcher";
import { assert, readString } from "../util";
import { Endianness } from "../endian";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { DeviceProgram } from "../Program";
import { mat4, quat, ReadonlyMat4, vec2, vec3, vec4 } from "gl-matrix";
import { fillColor, fillMatrix4x3, fillMatrix4x4, fillVec3v, fillVec4, fillVec4v } from "../gfx/helpers/UniformBufferHelpers";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { TextureMapping } from "../TextureHolder";
import { convertToCanvas } from "../gfx/helpers/TextureConversionHelpers";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { Qd3DMesh, Qd3DTexture, parseQd3DMeshGroup } from "./QuickDraw3D";
import { parseTerrain, LevelObjectDef, createMenuObjectList, createTitleObjectList, createLogoObjectList } from "./terrain";
import { AnimationController, AnimationData, parseSkeleton, SkeletalMesh} from "./skeleton";
import { colorNewFromRGBA } from "../Color";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { MathConstants, quatFromEulerRadians, Vec3UnitY, Vec3Zero } from "../MathHelpers";
import { AABB, Frustum } from "../Geometry";
import { CullMode } from "../gx/gx_enum";
import { computeViewSpaceDepthFromWorldSpacePoint } from "../Camera";
import { parseAppleDouble } from "./AppleDouble";
import { mat4PostTranslate } from "../StarFoxAdventures/util";
import { drawWorldSpaceLine, getDebugOverlayCanvas2D } from "../DebugJunk";

const pathBase = "nanosaur";

class Program extends DeviceProgram {
	static a_Position = 0;
	static a_UVs = 1;
	static a_Colours = 2;
	static a_Normals = 3;
	static a_TextureIds = 4;
	static a_BoneIds = 5;

	static Max_Bones = 20;

	static ub_SceneParams = 0;
	static ub_DrawParams = 1;
	static ub_Bones = 2;

	constructor(flags : RenderFlags){
		super();

		this.setDefineBool("UNLIT", (flags & RenderFlags.Unlit) !== 0);
		this.setDefineBool("HAS_VERTEX_COLOURS", (flags & RenderFlags.HasVertexColours) !== 0);
		this.setDefineBool("HAS_TEXTURE", (flags & RenderFlags.HasTexture) !== 0);
		this.setDefineBool("TEXTURE_HAS_ALPHA", (flags & RenderFlags.TextureHasAlpha) !== 0);
		this.setDefineBool("TILEMAP", (flags & RenderFlags.TextureTilemap) !== 0);
		this.setDefineBool("SCROLL_UVS", (flags & RenderFlags.ScrollUVs) !== 0);
		this.setDefineBool("SKINNED", (flags & RenderFlags.Skinned) !== 0);
		this.setDefineBool("REFLECTIVE", (flags & RenderFlags.Reflective) !== 0);
	}

	override both = 
`
#define NUM_LIGHTS 1
struct Light {
	vec4 direction;
	vec4 colour;
};

layout(std140) uniform ub_SceneParams {
	Mat4x4 u_ClipFromWorldMatrix;
	vec4 u_CameraPos;
	vec4 u_AmbientColour;
	Light u_Lights[NUM_LIGHTS];
	float u_Time;
};
layout(std140) uniform ub_DrawParams {
	Mat4x3 u_WorldFromModelMatrix;
	vec4 u_Colour;
	#ifdef SCROLL_UVS
	vec2 u_UVScroll;
	#endif
};
#ifdef SKINNED
layout(std140) uniform ub_Bones {
	Mat4x3 u_Bones[${Program.Max_Bones}];
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

out vec4 v_Colour;
out vec3 v_Normal;
out vec2 v_UV;
flat out int v_Id;

${GfxShaderLibrary.MulNormalMatrix}

void main() {
	v_Colour = vec4(a_Colour, 1.0);
	v_UV = a_UV;
	#ifdef TILEMAP
		v_UV = a_Position.xz;
		v_Id = int(a_TextureId);
	#endif

	vec3 pos = a_Position;
	vec3 normal = a_Normal;

	#ifdef SKINNED
		int boneId = int(a_BoneId);

		pos = Mul(u_Bones[boneId], vec4(pos, 1.0));
		//normal = normalize(MulNormalMatrix(u_Bones[boneId.y], normal));
		normal = Mul(u_Bones[boneId], vec4(normal, 0.0));
	#endif
	
	vec3 worldPos = Mul(u_WorldFromModelMatrix, vec4(pos, 1.0));
	vec3 worldNormal = normalize(MulNormalMatrix(u_WorldFromModelMatrix, normal));

	#ifdef REFLECTIVE
		v_UV = normalize(reflect(u_CameraPos.xyz - worldPos, worldNormal)).xy * 0.5 + 0.5;
	#endif

	v_Normal = worldNormal;
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
in vec3 v_Normal;

void main(){
	vec4 colour = u_Colour;
	
	
	#ifdef HAS_TEXTURE

		#ifndef TILEMAP
			vec2 uv = v_UV;
			#ifdef SCROLL_UVS
				uv += u_UVScroll * u_Time;
			#endif
			colour *= texture(SAMPLER_2D(u_Texture), uv);
		#else
			//vec2 uv = mix(vec2(0.015625,0.015625), vec2(0.984375,0.984375), fract(v_UV));
			vec2 uv = fract(v_UV);

			const int TILE_FLIPX_MASK = (1<<15);
			const int TILE_FLIPY_MASK = (1<<14);
			const int TILE_FLIPXY_MASK = (TILE_FLIPY_MASK|TILE_FLIPX_MASK);
			const int TILE_ROTATE_MASK = ((1<<13)|(1<<12));
			const int TILE_ROT1 = (1<<12);
			const int TILE_ROT2 = (2<<12);
			const int TILE_ROT3 = (3<<12);

			int flipBits = v_Id & (TILE_FLIPXY_MASK | TILE_ROTATE_MASK);
			int textureId = v_Id & 0xFFF;

			switch (flipBits) {
				case 0:
				case TILE_FLIPXY_MASK | TILE_ROT2:
					break;
				case TILE_FLIPX_MASK:
				case TILE_FLIPY_MASK | TILE_ROT2:
					uv.x = 1.0 - uv.x;
					//textureId = 254;
					break;
				case TILE_FLIPY_MASK:
				case TILE_FLIPX_MASK | TILE_ROT2:
					uv.y = 1.0 - uv.y;
					//textureId = 254;
					break;
				case TILE_FLIPXY_MASK:
				case TILE_ROT2:
					uv = 1.0 - uv;
					//textureId = 254;
					break;
				case TILE_ROT1:
				case TILE_FLIPXY_MASK | TILE_ROT3:
					uv = vec2(uv.y, 1.0 - uv.x); // todo verify
					//textureId = 254;
					break;
				case TILE_ROT3:
				case TILE_FLIPXY_MASK | TILE_ROT1:
					uv = vec2(1.0 - uv.y, uv.x); // todo verify
					//textureId = 254;
					break;
				case TILE_FLIPX_MASK | TILE_ROT1:
				case TILE_FLIPY_MASK | TILE_ROT3:
					uv = vec2(1.0 - uv.y, 1.0 - uv.x); // todo verify
					//textureId = 254;
					break;	
				case TILE_FLIPX_MASK | TILE_ROT3:
				case TILE_FLIPY_MASK | TILE_ROT1:
					uv = uv.yx; // todo verify
					//textureId = 254;
				default:
					//textureId = 254;
					break;
			}

			colour *= texture(SAMPLER_2D(u_TilemapTexture), vec3(uv, textureId));
		#endif // end ifdef tilemap

		#ifdef TEXTURE_HAS_ALPHA
			if (colour.a < 0.5) { discard; }
		#endif
	#endif
	
	#ifdef HAS_VERTEX_COLOURS
		colour *= v_Colour;
	#endif

	#ifndef UNLIT
		vec3 normal = normalize(v_Normal);
		vec3 lightColour = u_AmbientColour.xyz;
		for (int i = 0; i < NUM_LIGHTS; ++i){
			lightColour += max(0.0, dot(u_Lights[i].direction.xyz, normal)) * u_Lights[i].colour.xyz;
		}
		colour.xyz *= lightColour;
	#endif

	gl_FragColor = colour;
}
`;
};

// hack to identify program ids
type NanosaurGfxProgram = GfxProgram & {nanosaurId : number};

class Cache extends GfxRenderCache implements UI.TextureListHolder {
	textures = new WeakMap<Qd3DTexture, GfxTexture>();

	modelIdCount = 0;

	assets : ProcessedAssets;
	allTextures : GfxTexture[] = [];

	programs = new Map<RenderFlags, NanosaurGfxProgram>();

	viewerTextures : Viewer.Texture[] = [];
	onnewtextures: (() => void) | null = null;

	getProgram(renderFlags : RenderFlags){
		let program = this.programs.get(renderFlags);
		if (program) return program;
		program = this.createProgram(new Program(renderFlags)) as NanosaurGfxProgram;
		this.programs.set(renderFlags, program);
		if (!program.nanosaurId)
			program.nanosaurId = this.programs.size;
		return program;
	}

	createTexture(texture : Qd3DTexture){
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

			if (texture.numTextures == 1){
				this.viewerTextures.push({
					name : `Texture ${this.viewerTextures.length + 1}`,
					surfaces : [convertToCanvas(new ArrayBufferSlice(texture.pixels.buffer), texture.width, texture.height, texture.pixelFormat)],
				});
				if (this.onnewtextures)
					this.onnewtextures();
			}
		}
		return result;
	}

	createTextureMapping(texture : Qd3DTexture){
		const mapping = new TextureMapping();
		mapping.gfxTexture = this.createTexture(texture);

		
		mapping.gfxSampler = this.createSampler({
			magFilter : GfxTexFilterMode.Point,
			minFilter : GfxTexFilterMode.Point,
			wrapS : texture.wrapU,
			wrapT : texture.wrapV,
			mipFilter : GfxMipFilterMode.NoMip,
		});
		
		
		
		return mapping;
	}

	createModels(rawAssets : RawAssets){
		const cache = this;
		const device = this.device;

		function make(meshes : Qd3DMesh[][]) : StaticObject[][]{
			return meshes.map((list)=>
				list.map((mesh)=>
					new StaticObject(device, cache, mesh)
				)
			);
		}
		
		const skeletons : any = {};
		for (const name of SkeletonNames){
			const raw = rawAssets.skeletons[name];
			if (raw)
				skeletons[name] = new AnimatedObject(device, cache, raw);
		}

		this.assets = {
			globalModels : make(rawAssets.globalModels),
			level1Models : make(rawAssets.level1Models),
			menuModels : make(rawAssets.menuModels),
			titleModels : make(rawAssets.titleModels),
			terrainModel : rawAssets.terrainModel && new StaticObject(device, this, rawAssets.terrainModel),
			skeletons,
		}
	}
	destroyModels(){
		const device = this.device;
		function destroyModels(models : StaticObject[][]){
			for (const list of models)
				for (const model of list)
					model.destroy(device);
		}
		destroyModels(this.assets.globalModels);
		destroyModels(this.assets.level1Models);
		destroyModels(this.assets.titleModels);
		for (const name of SkeletonNames){
			this.assets.skeletons[name]?.destroy(device);
		}
		this.assets.terrainModel?.destroy(device);
	}

	public override destroy(): void {
		const device = this.device;

		this.allTextures.forEach((tex)=>device.destroyTexture(tex));
		this.destroyModels();

		super.destroy();
	}

}

const enum RenderFlags {
	Translucent		 = 0x40000,
	Skinned			 = 0x20000,
	Reflective       = 0x10000,
	DrawBackfacesSeparately = 0x8000,
	KeepBackfaces    = 0x4000,
	Unlit			 = 0x2000,
	ScrollUVs        = 0x1000,
	HasTexture		 = 0x800,
	TextureHasAlpha  = 0x400,
	TextureTilemap	 = 0x200,
	HasVertexColours = 0x100,
	ModelIndex = 0xFF
}

class StaticObject implements Destroyable {
	gfxProgram : GfxProgram | null = null;
	indexCount : number;
	buffers : GfxBuffer[] = [];
	inputLayout : GfxInputLayout;
	inputState : GfxInputState;
	modelMatrix? : mat4;
	aabb : AABB;
	colour : GfxColor;
	scrollUVs : vec2 = [0,0];
	renderFlags : RenderFlags = 0;
	textureMapping : TextureMapping[] = [];
	modelId = 0;

	constructor(device : GfxDevice, cache : Cache, mesh : Qd3DMesh){
		this.indexCount = mesh.numTriangles * 3;
		this.aabb = mesh.aabb;
		this.colour = mesh.colour;
		if (mesh.baseTransform)
			this.modelMatrix = mat4.clone(mesh.baseTransform);
		this.modelId = ++cache.modelIdCount;

		this.renderFlags |= this.modelId;
		assert((this.renderFlags & RenderFlags.ModelIndex) == this.modelId);

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
		const hasColours = pushBuffer(mesh.vertexColours?.buffer, 12, Program.a_Colours, GfxFormat.F32_RGB);
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

			this.textureMapping.push(cache.createTextureMapping(texture));

			this.renderFlags |= RenderFlags.HasTexture;
			if (texture.hasAlpha)
				this.renderFlags |= RenderFlags.TextureHasAlpha;
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

		const renderFlags = this.renderFlags | entity.extraRenderFlags;
		const translucent = !!(renderFlags & RenderFlags.Translucent);

		const gfxProgram = cache.getProgram(renderFlags);

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
				depthWrite: true,
			});
			setAttachmentStateSimple(megaState, {
				blendMode: GfxBlendMode.Add,
				blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
				blendSrcFactor: GfxBlendFactor.SrcAlpha,
			});
		}
		
		
        renderInst.drawIndexes(this.indexCount);

		const scrollUVs = renderFlags & RenderFlags.ScrollUVs;

		let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_DrawParams, 4*4 + 4 + (scrollUVs?2:0));
		const uniformData = renderInst.mapUniformBufferF32(Program.ub_DrawParams);
		
		let modelMatrix : ReadonlyMat4 = entity.modelMatrix;
		if (this.modelMatrix){
			modelMatrix = mat4.mul(mat4.create(), modelMatrix, this.modelMatrix); // todo verify multiplication order
		}
		
		uniformOffset += fillMatrix4x3(uniformData, uniformOffset, modelMatrix);
		uniformOffset += fillVec4(uniformData, uniformOffset, this.colour.r * entity.colour.r, this.colour.g * entity.colour.g, this.colour.b * entity.colour.b, this.colour.a * entity.colour.a);

		if (scrollUVs){
			uniformData[uniformOffset++] = this.scrollUVs[0];
			uniformData[uniformOffset++] = this.scrollUVs[1];
		}

		renderInst.sortKey = setSortKeyDepth(
			makeSortKey(translucent ? GfxRendererLayer.TRANSLUCENT : GfxRendererLayer.OPAQUE, gfxProgram.nanosaurId),
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
}

class AnimatedObject implements Destroyable{
	meshes : StaticObject[];
	animationData : AnimationData;

	constructor(device : GfxDevice, cache : Cache, skeleton : SkeletalMesh){
		this.meshes = skeleton.meshes.map((mesh)=>new StaticObject(device, cache, mesh));
		this.animationData = skeleton.animation;
	}

	destroy(device: GfxDevice): void {
		for (const mesh of this.meshes)
			mesh.destroy(device);
	}
};

// nothing, delete us, spawn new entity
type EntityUpdateResult = void | false | Entity;

class Entity {
	meshes : StaticObject[];
	position: vec3;
	rotX = 0;
	rotation: number;
	rotZ = 0;
	scale: vec3;
	modelMatrix : mat4 = mat4.create();
	aabb : AABB = new AABB();
	colour : GfxColor = {r:1,g:1,b:1,a:1};
	extraRenderFlags : RenderFlags = 0;

	constructor(meshes : StaticObject | StaticObject[], position : vec3, rotation : number | null, scale : number, pushUp : boolean){
		if (!Array.isArray(meshes))
			meshes = [meshes];
		this.meshes = meshes;

		if (rotation === null)
			rotation = Math.random() * MathConstants.TAU;

		if (pushUp){
			let lowestY = Infinity;
			for (const mesh of meshes){
				const y = mesh.aabb.minY;
				if (y < lowestY) lowestY = y;
			}
			position[1] -= lowestY * scale;
		}

		this.position = position;
		this.rotation = rotation;
		this.scale = [scale, scale, scale];

		this.updateMatrix();
	}

	makeTranslucent(alpha : number, unlit : boolean, keepBackfaces : boolean){
		this.colour.a = alpha;
		this.extraRenderFlags |= RenderFlags.Translucent;
		if (unlit)
			this.extraRenderFlags |= RenderFlags.Unlit;
		if (keepBackfaces)
			this.extraRenderFlags |= RenderFlags.KeepBackfaces;
	}
	makeReflective() {
		this.extraRenderFlags |= RenderFlags.Reflective;
	}

	scrollUVs(xy : vec2){
		for (const mesh of this.meshes){
			mesh.scrollUVs = xy;
			mesh.renderFlags |= RenderFlags.ScrollUVs;
		}
	}

	updateMatrix(){
		const rot : quat = [0,0,0,0];
		quatFromEulerRadians(rot, this.rotX, this.rotation, this.rotZ);
		mat4.fromRotationTranslationScale(this.modelMatrix, rot, this.position, this.scale);

		this.aabb.reset();
		for (const mesh of this.meshes){
			this.aabb.union(this.aabb, mesh.aabb);
		}
		this.aabb.transform(this.aabb, this.modelMatrix);
	}

	checkVisible(frustum : Frustum){
		return frustum.contains(this.aabb);
	}

	prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, cache : Cache): void {
		for (const mesh of this.meshes)
			mesh.prepareToRender(device, renderInstManager, viewerInput, cache, this);
	}
	
	update(dt : number) : EntityUpdateResult {}
}

class AnimatedEntity extends Entity{
	animationController : AnimationController;

	constructor(mesh : AnimatedObject, position : vec3, rotation : number | null, scale : number, pushUp : boolean, startAnim : number){
		super(mesh.meshes, position, rotation, scale, pushUp);
		this.animationController = new AnimationController(mesh.animationData);
		this.animationController.currentAnimation = startAnim;
		this.animationController.setRandomTime();
	}

	override update(dt : number) : void {
		this.animationController.update(dt);
		// todo: update bbox?
	}

	setAnimation(animationIndex : number, animationSpeed : number){
		this.animationController.setAnimation(animationIndex, animationSpeed);
	}

	debugDrawSkeleton(clipFromWorldMatrix : mat4){
		
		const bones = this.animationController.animation.bones;
		const transforms = this.animationController.boneTransforms;
		const c = getDebugOverlayCanvas2D();
		const p1 : vec3 = [0,0,0];
		const p2 : vec3 = [0,0,0];

		for (let i = 0; i < bones.length; ++i){
			const parentIndex = bones[i].parent;
			if (parentIndex < 0)
				continue;
			
			mat4.getTranslation(p1, transforms[i]);
			vec3.transformMat4(p1, p1, this.modelMatrix);

			mat4.getTranslation(p2, transforms[parentIndex]);
			vec3.transformMat4(p2, p2, this.modelMatrix);

			drawWorldSpaceLine(c, clipFromWorldMatrix, p1, p2);
		}
	}

	override prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, cache : Cache): void {

		if (!viewerInput.camera.frustum.contains(this.aabb)){
			return;
		}

		//this.debugDrawSkeleton(viewerInput.camera.clipFromWorldMatrix);

		const renderInst = renderInstManager.pushTemplateRenderInst();
		
		renderInst.setBindingLayouts([{
			numUniformBuffers : 3,
			numSamplers : 1,
		}]);
		
		const numTransforms = this.animationController.boneTransforms.length;
		let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_Bones, Program.Max_Bones * 4*3);
		const uniformData = renderInst.mapUniformBufferF32(Program.ub_Bones);
		for (let i = 0; i < numTransforms; ++i)
			uniformOffset += fillMatrix4x3(uniformData, uniformOffset, this.animationController.boneTransforms[i]);

		for (const mesh of this.meshes)
			mesh.prepareToRender(device, renderInstManager, viewerInput, cache, this);

		renderInstManager.popTemplateRenderInst();
	}
}

class SpinningEntity extends Entity {
	spinSpeed = 1;

	override update(dt : number) {
		this.rotation = (this.rotation + this.spinSpeed * dt) % MathConstants.TAU;
		this.updateMatrix();
	}
}
class UndulateEntity extends Entity {
	t = Math.random() * MathConstants.TAU;
	baseScale = 1;
	period = 1;
	amplitude = 1;

	override update(dt: number): void {
		this.t = (this.t + dt * this.period) % MathConstants.TAU;
		this.scale[1] = this.baseScale + Math.sin(this.t) * this.amplitude;
		this.updateMatrix();
	}
}

function spawnTriceratops(def : LevelObjectDef, assets : ProcessedAssets){ // 2
	// todo: animate, mesh, push up?
	return new AnimatedEntity(assets.skeletons.Tricer!, [def.x, def.y, def.z], null, 2.2, false, 1);
};
const EntityCreationFunctions : ((def:LevelObjectDef, assets : ProcessedAssets)=>Entity|Entity[]|void)[] = [
	function spawnPlayer(def, assets){ // 0
		// todo shadow
		const mainMenu = def.param0; // main menu hack
		const result = new AnimatedEntity(assets.skeletons.Deinon!, [def.x, def.y, def.z], def.rot ?? 0, def.scale ?? 1, !mainMenu, mainMenu);
		if (mainMenu)
			result.animationController.t = 0;
		return result;
	},
	function spawnPowerup(def, assets){ // 1
		const meshIndices = [11, 12, 14, 15, 16, 17, 18];
		const type = def.param0;
		assert(type >= 0 && type <= 6, "powerup type out of range");
		// todo: y pos quick
		// todo darken shadow?
		return new SpinningEntity(assets.globalModels[meshIndices[type]], [def.x, def.y + 0.5, def.z], null, 1, false);
	},
	spawnTriceratops, // 2
	function spawnRex(def, assets){ // 3
		// todo: rotation, shadow (for eveerything)
		const title = def.param0 === 1; // title hack
		const result = new AnimatedEntity(assets.skeletons.Rex!, [def.x, def.y, def.z], def.rot ?? null, def.scale ?? 1.2, false, title ? 1 : 0);
		if (title) {
			result.animationController.t = 0;
			result.animationController.animSpeed = 0.8;
		}
		return result;
	},
	function spawnLava(def, assets){ // 4

		const fireballMesh = assets.level1Models[26];
		const smokeMesh = assets.globalModels[3];

		class SmokePuffEntity extends Entity {
			t = 0.5;
			decayRate = Math.random() * 0.3 + 0.9;

			override update(dt : number) : void | false {
				this.t -= dt * this.decayRate;
				if (this.t < 0)
					return false;

				this.colour.a = Math.min(1, 3 * this.t);

				for (let i = 0; i < 3; ++i){
					this.scale[i] += dt * 0.5;
				}
				this.rotX += dt * Math.PI;

				this.updateMatrix();
			}
		}

		class FireballEntity extends Entity {

			velocity : vec3 = [(Math.random() - 0.5) * 300,300 + Math.random() * 400,(Math.random() - 0.5) * 300]
			puffTimer = 0;
			killY = 0;

			override update(dt : number) : void | SmokePuffEntity | false {
				this.velocity[1] -= 560 * dt;
				for (let i = 0; i < 3; ++i)
					this.position[i] += this.velocity[i] * dt;

				if (this.position[1] < this.killY){
					// todo destroy when hit ground
					return false;
				}

				this.rotX += dt * 3 * Math.PI;
				this.rotZ -= dt * MathConstants.TAU;

				this.updateMatrix();

				this.puffTimer += dt;
				if (this.puffTimer > 0.06){
					this.puffTimer %= 0.06;
					const puff = new SmokePuffEntity(smokeMesh, [...this.position] as vec3, null, Math.random() * 0.1 + 0.4, false);
					puff.makeTranslucent(0.5, false, true); // todo backfaces?
					return puff;
				}
			}
		}

		class LavaEntity extends UndulateEntity {
			fireballTimer = Math.random() * 0.4;
			override update(dt : number) : FireballEntity | void {
				super.update(dt);
				this.fireballTimer += dt;
				if (this.fireballTimer > 0.4){
					this.fireballTimer %= 0.4;

					const pos : vec3 = [
						this.position[0] + (Math.random() - 0.5) * 700,
						this.position[1] - 20,
						this.position[2] + (Math.random() - 0.5) * 700
					];
					const fireball = new FireballEntity(fireballMesh, pos, 0, 0.3, false);
					fireball.killY = this.position[1] - 20;
					return fireball;
				}
			}
		}
		

		const x = Math.floor(def.x / 140) * 140 + 140/2
		const z = Math.floor(def.z / 140) * 140 + 140/2
		const y = (def.param3 & 1) ? def.y + 50 : 305;
		const scale = (def.param3 & (1<<2)) ? 1 : 2;
		const shootFireballs = (def.param3 & (1<<1)) !== 0;
		let result : UndulateEntity;
		if (shootFireballs && false) // todo optimize
			result = new LavaEntity(assets.level1Models[1], [x,y,z], 0, scale, false);
		else
			result = new UndulateEntity(assets.level1Models[1], [x,y,z], 0, scale, false);
		result.scrollUVs([0.07, 0.03]);
		result.baseScale = 0.501;
		result.amplitude = 0.5;
		result.period = 2.0;
		//result.t = 1;
		return result;
	},
	function spawnEgg(def, assets){ // 5
		const eggType = def.param0;
		assert(eggType < 5, "egg type out of range");
		const egg = new Entity(assets.level1Models[3 + eggType], [def.x, def.y, def.z], null, 0.6, true);
		if (def.param3 & 1){
			// make nest
			const nest = new Entity(assets.level1Models[15], [def.x, def.y, def.z], 0, 1, false);
			return [egg, nest];
		}
		return egg;
	},
	function spawnGasVent(def, assets){ // 6
		// todo:billboard? animate

		class GasVentEntity extends Entity {
			override update(dt : number){
				this.scale[1] = Math.random() * 0.3 + 0.5;
				this.updateMatrix();
			}
		};

		const result = new GasVentEntity(assets.level1Models[22], [def.x, def.y, def.z], 0, 0.5, false);
		result.makeTranslucent(0.7, true, true);
		return result;
	},
	function spawnPteranodon(def, assets){ // 7
		// todo fly and stuff
		const hasRock = (def.param3 & (1<<1)) !== 0;
		const ptera = new AnimatedEntity(assets.skeletons.Ptera!, [def.x, def.y + 100, def.z], null, 1, false, hasRock ? 2 : 0)
		if (hasRock) {
			// todo attach
			const rock = new Entity(assets.level1Models[9], [def.x, def.y + 100, def.z], 0, 0.4, false);
			return [rock, ptera];
		}
		return ptera;
	},
	function spawnStegosaurus(def, assets){ // 8
		return new AnimatedEntity(assets.skeletons.Stego!, [def.x, def.y, def.z], null, 1.4, true, 1);
	},
	function spawnTimePortal(def, assets){ // 9
		class TimePortalRingEntity extends Entity {
			startY = 0;
			t = 0;
			override update(dt : number){
				this.t = (this.t + dt) % 2.7;
				if (this.t <= 0.8){
					const scale = 5 - this.t * 5;
					this.scale.fill(scale);
					this.position[1] = this.startY + this.t * 20;
					this.colour.a = (5 - scale) / 4;
				} else {
					const t = this.t - 0.8;
					this.scale.fill(1);
					// dy += 250dt
					// y += dy
					this.position[1] = this.startY + t * t * 125 + t * 50 + 16;
					this.colour.a = Math.max(0, 1 - t * 0.6);
				}
				this.updateMatrix();
			}
		};

		const results : Entity[] = [];
		for (let i = 0; i < 9; ++i){
			const ring = new TimePortalRingEntity(assets.globalModels[10], [def.x, def.y + 15, def.z], 0, 5, false);
			ring.startY = ring.position[1];
			ring.t = i * 0.3;
			ring.makeTranslucent(1, false, true);
			results.push(ring);
		}
		return results;
	},
	function spawnTree(def, assets){ // 10
		const treeScales = [
			1,   // fern
			1.1, // stickpalm
			1.0, // bamboo
			4.0, // cypress,
			1.2, // main palm
			1.3, // pine palm
		] as const;
		const treeIndex = def.param0;
		assert(treeIndex >=0 && treeIndex <= 5, "tree type out of range");
		return new Entity(assets.level1Models[16 + treeIndex], [def.x, def.y, def.z], null, treeScales[treeIndex] + Math.random() * 0.5, true);
	},
	function spawnBoulder(def, assets){ // 11
		return new Entity(assets.level1Models[8], [def.x, def.y - 10, def.z], null, 1 + Math.random(), true);
	},
	function spawnMushroom(def, assets){ //12
		return new Entity(assets.level1Models[10], [def.x, def.y, def.z], null, 1 + Math.random(), false);
	},
	function spawnBush(def, assets){ // 13
		const bush = new Entity(assets.level1Models[11], [def.x, def.y, def.z], null, 4.2, true);
		if (def.param3 & 1){
			const triceratops = spawnTriceratops(def, assets);
			return [bush, triceratops];
		}
		return bush;
	},
	function spawnWater(def, assets){ // 14
		// todo translucency and stuff
		const x = Math.floor(def.x / 140) * 140 + 140/2
		const z = Math.floor(def.z / 140) * 140 + 140/2
		const y = (def.param3 & 1) ? def.y + 50 : 210;

		const result = new UndulateEntity(assets.level1Models[2], [x,y,z], 0, 2, false);
		result.makeTranslucent(0.8, false, true);
		result.scrollUVs([-0.04, 0.08]);
		//result.t = 1;
		result.period = 3;
		result.amplitude = 0.5;
		result.baseScale = 0.501;
		return result;
	},
	function spawnCrystal(def, assets){ // 15
		const crystalMeshIndices = [12, 13, 14];
		const type = def.param0;
		assert(type >= 0 && type <= 2, "crystal type out of range");
		// todo: y coord quick
		const result = new Entity(assets.level1Models[crystalMeshIndices[type]], [def.x, def.y, def.z], 0, 1.5 + Math.random(), false);
		result.makeTranslucent(0.7, false, true);
		result.extraRenderFlags |= RenderFlags.DrawBackfacesSeparately;
		return result;
	},
	function spawnSpitter(def, assets){ // 16
		return new AnimatedEntity(assets.skeletons.Diloph!, [def.x, def.y, def.z], null, 0.8, false, 0);
	},
	function spawnStepStone(def, assets){ // 17
		// todo: quick y
		const LAVA_Y_OFFSET = 50 / 2;
		return new Entity(assets.level1Models[23], [def.x, def.y + LAVA_Y_OFFSET, def.z], 0, 1, false);
	},
	function spawnRollingBoulder(def, assets){ // 18
		const scale = 3;
		// todo: roll
		return new Entity(assets.level1Models[9], [def.x, def.y + 30 * scale, def.z], null, scale, false);
	},
	function spawnSporePod(def, assets){ // 19
		const result = new UndulateEntity(assets.level1Models[24], [def.x, def.y, def.z], 0, 0.5, false);
		result.baseScale = result.scale[1];
		result.amplitude = 0.1;
		result.period = 2.5;
		return result;
	},
	// main menu stuff
	function spawnMenuBackground(def, assets){ // 20

		const eggModel = assets.menuModels[4];

		class EggEntity extends Entity {
			override update(dt : number) : false | void {
				this.rotX += dt;
				this.rotation += dt;
				this.rotZ += dt;
				this.position[1] -= dt * 70;
				if (this.position[1] < -250)
					return false;
				this.updateMatrix();
			}
		}

		class EggSpawnerEntity extends Entity{
			t = 0;

			override update(dt : number) : EggEntity | void{

				this.rotation = (this.rotation + dt) % MathConstants.TAU;
				this.updateMatrix();

				this.t += dt;
				if (this.t > 0.2){
					this.t %= 0.2;

					const pos : vec3 = [
						(Math.random() - 0.5) * 700,
						400,
						(Math.random() - 0.5) * 700 + 150
					];
					const egg = new EggEntity(eggModel, pos, null, 1, false);
					egg.rotX = Math.random() * Math.PI;
					egg.rotZ = Math.random() * Math.PI;
					return egg;
				}
			}
		};

		const result = new EggSpawnerEntity(assets.menuModels[5], [def.x, def.y, def.z], def.rot ?? 0, def.scale ?? 1, false);
		result.scale[1] *= 0.5;
		result.makeReflective();
		return result;
	},
	function spawnOptionsIcon(def, assets){ // 21
		return new Entity(assets.menuModels[1], [def.x, def.y, def.z], def.rot ?? 0, def.scale ?? 1, false);
	},
	function spawnInfoIcon(def, assets){ // 22
		return new Entity(assets.menuModels[2], [def.x, def.y, def.z], def.rot ?? 0, def.scale ?? 1, false);
	},
	function spawnQuitIcon(def, assets){ // 23
		return new Entity(assets.menuModels[0], [def.x, def.y, def.z], def.rot ?? 0, def.scale ?? 1, false);
	},
	function spawnHighScoresIcon(def, assets){ // 24
		return new Entity(assets.menuModels[3], [def.x, def.y, def.z], def.rot ?? 0, def.scale ?? 1, false);
	},
	// title stuff
	function spawnPangeaLogo(def, assets){ // 25
		class LogoEntity extends Entity {
			t = 0;
			startZ = 0;
			override checkVisible(frustum: Frustum): boolean {
				return true;
			}
			override update(dt: number): EntityUpdateResult {
				this.t = (this.t + dt) % 10;
				this.position[2] = this.startZ + this.t * 45;
				this.rotation = Math.PI * -0.5 + this.t * Math.PI / 9;
				this.rotX = Math.sin(this.t * 1.5) * 0.3;
				// fade in
				this.colour.r = this.colour.g = this.colour.b = Math.min(1, this.t * 1.3);
				this.updateMatrix();
			}
		}
		const result = new LogoEntity(assets.titleModels[1], [def.x, def.y, def.z], 0, def.scale ?? 0.2, false);
		result.makeReflective();
		result.startZ = def.z;
		return result;
	},
	function spawnGameName(def, assets){ // 26
		class WobbleEntity extends Entity{
			t = 0;
			override update(dt : number){
				this.t = (this.t + dt * 1.8) % MathConstants.TAU;
				this.rotation = 0.3 + Math.sin(this.t) * 0.3;
				this.updateMatrix();
			}
		}
		const result = new WobbleEntity(assets.titleModels[0], [def.x, def.y, def.z], 0, def.scale ?? 1, false);
		result.rotX = -0.3;
		result.makeReflective();
		return result;
	},
	function spawnTitleBackround(def, assets){ //27
		class TitleBackgroundEntity extends Entity {
			override checkVisible(frustum: Frustum): boolean {
				return true;
			}
			override update(dt : number){
				this.position[0] -= dt * 65;
				while (this.position[0] < -600*2.6){
					this.position[0] += 300*2.6*3
				}
				this.updateMatrix();
			}
		}
		return new TitleBackgroundEntity(assets.titleModels[2], [def.x, def.y, def.z], def.rot ?? 0, def.scale ?? 1, false);
	},
];
function invalidEntityType(def : LevelObjectDef, assets : ProcessedAssets) {
	console.log("invalid object type", def);
}

type ProcessedAssets = Assets<StaticObject, AnimatedObject>;

type SceneSettings = {
	clearColour : GfxColor,
	ambientColour : GfxColor,
	lightDir : vec4,
	lightColour : GfxColor,
	cameraPos : vec3, // initial camera posiiton
	cameraTarget? : vec3, // initial camera look at (or zero)
	// todo: fog
};


class NanosaurSceneRenderer implements Viewer.SceneGfx{
    renderHelper: GfxRenderHelper;
    entities: Entity[] = [];
	cache : Cache;
	sceneSettings : SceneSettings;

	textureHolder : UI.TextureListHolder;


	constructor(device : GfxDevice, context : SceneContext, assets : RawAssets, objectList : LevelObjectDef[], sceneSettings : SceneSettings){
		const cache = new Cache(device);
		this.cache = cache;
		this.textureHolder = cache;
		this.renderHelper = new GfxRenderHelper(device, context, cache);
		this.sceneSettings = sceneSettings;

		vec4.normalize(sceneSettings.lightDir, sceneSettings.lightDir);

		cache.createModels(assets);

		if (cache.assets.terrainModel)
			this.entities.push(new Entity(cache.assets.terrainModel, [0,0,0],0,1,false));

		for (const objectDef of objectList){
			const entity = (EntityCreationFunctions[objectDef.type] ?? invalidEntityType)(objectDef, cache.assets);
			if (entity){
				if (Array.isArray(entity))
					this.entities.push(...entity);
				else
					this.entities.push(entity);
			}
		}
	}

	getDefaultWorldMatrix(out : mat4){
		mat4.targetTo(out, this.sceneSettings.cameraPos, this.sceneSettings.cameraTarget ?? Vec3Zero, Vec3UnitY);
	}	

	prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput){
		const renderInst = this.renderHelper.pushTemplateRenderInst();

		renderInst.setBindingLayouts([{
			numUniformBuffers : 2,
			numSamplers : 1,
		}]);
		// set scene uniforms
		let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_SceneParams, 4*4 + 4 + 4 + 8*1 + 1);
		const uniformData = renderInst.mapUniformBufferF32(Program.ub_SceneParams);
		// camera matrix
		uniformOffset += fillMatrix4x4(uniformData, uniformOffset, viewerInput.camera.clipFromWorldMatrix);
		// camera pos
		const cameraPos = mat4.getTranslation([0,0,0], viewerInput.camera.worldMatrix);
		// todo: fix camera pos?
		uniformOffset += fillVec4(uniformData, uniformOffset, cameraPos[0], cameraPos[1], cameraPos[2], 1.0);
		// ambient colour
		uniformOffset += fillColor(uniformData, uniformOffset, this.sceneSettings.ambientColour);
		// light direction
		uniformOffset += fillVec4v(uniformData, uniformOffset, this.sceneSettings.lightDir);
		// light colour
		uniformOffset += fillColor(uniformData, uniformOffset, this.sceneSettings.lightColour);
		uniformData[uniformOffset] = viewerInput.time * 0.001;
		uniformOffset += 1;

        const renderInstManager = this.renderHelper.renderInstManager;

		const dt = Math.min(viewerInput.deltaTime * 0.001, 1/15);
		for (let i = 0; i < this.entities.length; ++i){
			const entity = this.entities[i];
			const visible = entity.checkVisible(viewerInput.camera.frustum);
			if (!visible)
				continue; // todo: update some entities while not visible (eg. lava fireballs)

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
		this.renderHelper.getCache().destroy();
		this.renderHelper.destroy();
	}

}

const SkeletonNames = [
	"Ptera", "Rex", "Stego", "Deinon", "Tricer", "Diloph",
] as const;

type Assets<MeshType, SkeletonType> = {
	globalModels : MeshType[][],
	level1Models : MeshType[][],
	menuModels : MeshType[][],
	titleModels : MeshType[][],
	terrainModel? : MeshType,
	skeletons : {
		[String in typeof SkeletonNames[number]]? : SkeletonType
	}
};
type RawAssets = Assets<Qd3DMesh, SkeletalMesh>;

class NanosaurSceneDesc implements Viewer.SceneDesc {
	constructor(public id : string, public name : string, public levelName : string){}

	loadSkeleton(dataFetcher : DataFetcher, name : typeof SkeletonNames[number]){
		return Promise.all([
			dataFetcher.fetchData(`${pathBase}/Skeletons/${name}.3dmf`).then(parseQd3DMeshGroup),
			dataFetcher.fetchData(`${pathBase}/Skeletons/${name}.skeleton.rsrc`).then(parseAppleDouble),
		]).then(([model, skeletonData])=>parseSkeleton(model, skeletonData));
	}

	async createMenuScene(device : GfxDevice, context : SceneContext) : Promise<Viewer.SceneGfx> {
		
		const menuModelsPromise = context.dataFetcher.fetchData(pathBase + "/Models/MenuInterface2.3dmf")
			.then(parseQd3DMeshGroup);
		const playerSkeletonPromise = this.loadSkeleton(context.dataFetcher, "Deinon");

		const assets : RawAssets = {
			globalModels : [],
			level1Models : [],
			menuModels : await menuModelsPromise,
			titleModels : [],
			skeletons : {
				Deinon : await playerSkeletonPromise
			}
		};
		
		const settings : SceneSettings = {
			clearColour : {r:0, g:0, b:0, a:1},
			ambientColour : {r:0.25, g:0.25, b:0.25, a:1.0},
			lightDir : [-1, 0.7, 1, 0],
			lightColour : {r:1.3,g:1.3,b:1.3,a:1},
			cameraPos : [0, 0, 600],
		};

		return new NanosaurSceneRenderer(device, context, assets, createMenuObjectList(), settings);
	}

	async createLogoScene(device : GfxDevice, context : SceneContext) : Promise<NanosaurSceneRenderer>{
		const titleModelsPromise = context.dataFetcher.fetchData(pathBase + "/Models/Title.3dmf").then(parseQd3DMeshGroup);
		const assets : RawAssets = {
			globalModels : [],
			level1Models : [],
			menuModels : [],
			titleModels : await titleModelsPromise,
			skeletons : {}
		}
		
		const settings : SceneSettings = {
			clearColour : {r:0, g:0, b:0, a:1},
			ambientColour : {r:0.25, g:0.25, b:0.25, a:1.0},
			lightDir : [-1, 0.7, 1, 0],
			lightColour : {r:1.3,g:1.3,b:1.3,a:1},
			cameraPos : [0, 0, 70],
		};
		
		return new NanosaurSceneRenderer(device, context, assets, createLogoObjectList(), settings);
	}
	async createTitleScene(device : GfxDevice, context : SceneContext) : Promise<Viewer.SceneGfx> {
		const titleModelsPromise = context.dataFetcher.fetchData(pathBase + "/Models/Title.3dmf").then(parseQd3DMeshGroup);
		const rexPromise = this.loadSkeleton(context.dataFetcher, "Rex");
		const assets : RawAssets = {
			globalModels : [],
			level1Models : [],
			menuModels : [],
			titleModels : await titleModelsPromise,
			skeletons : {
				Rex : await rexPromise
			}
		}
		
		const settings : SceneSettings = {
			clearColour : {r:1, g:1, b:1, a:1},
			ambientColour : {r:0.25, g:0.25, b:0.25, a:1.0},
			lightDir : [-1, 0.7, 1, 0],
			lightColour : {r:1.3,g:1.3,b:1.3,a:1},
			cameraPos : [110, 90, 190],
		};
		
		return new NanosaurSceneRenderer(device, context, assets, createTitleObjectList(), settings);
	}


	async createGameScene(device : GfxDevice, context : SceneContext, levelName : string) : Promise<Viewer.SceneGfx> {
		const terrainPromise = Promise.all([
			context.dataFetcher.fetchData(`${pathBase}/terrain/${levelName}.ter`),
			context.dataFetcher.fetchData(pathBase + "/terrain/Level1.trt"),
		]).then(([terrainData, terrainTexture]) => parseTerrain(terrainData, terrainTexture));
		
		const globalModelsPromise = context.dataFetcher.fetchData(pathBase + "/Models/Global_Models.3dmf")
			.then(parseQd3DMeshGroup);
		const level1ModelsPromise = context.dataFetcher.fetchData(pathBase + "/Models/Level1_Models.3dmf")
			.then(parseQd3DMeshGroup);

		const skeletonPromises = SkeletonNames.map((name)=>this.loadSkeleton(context.dataFetcher, name))

		const [terrainModel, objectList] = await terrainPromise;

		const skeletons : any = {};
		for (let i = 0; i < SkeletonNames.length; ++i){
			skeletons[SkeletonNames[i]] = await skeletonPromises[i];
		}

		const assets : RawAssets = {
			globalModels : await globalModelsPromise,
			level1Models : await level1ModelsPromise,
			menuModels : [],
			titleModels : [],
			terrainModel,
			skeletons,
		}

		const settings : SceneSettings = {
			clearColour : {r:0.95, g:0.95, b:0.75, a:1.0},
			ambientColour: {r:0.2, g:0.2, b:0.2, a:1.0},
			lightDir : [-1, 0.7, 1, 0],
			lightColour : {r:1.2, g:1.2, b:1.2, a:1},
			cameraPos : [4795, 493, 15280],
			cameraTarget : [4795, 406, 14980],
		};

		return new NanosaurSceneRenderer(device, context, assets, objectList, settings);
	}

	public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {

		switch(this.levelName){
			case "Logo":
				return this.createLogoScene(device, context);
			case "Title":
				return this.createTitleScene(device, context);
			case "MainMenu":
				return this.createMenuScene(device, context);
			default:
				return this.createGameScene(device, context, this.levelName);
		}
	}
	
}

const id = "nanosaur";
const name = "Nanosaur";
const sceneDescs = [
	new NanosaurSceneDesc("logo", "Logo", "Logo"),
	new NanosaurSceneDesc("title", "Title", "Title"),
	new NanosaurSceneDesc("mainmenu", "Main Menu", "MainMenu"),
	new NanosaurSceneDesc("level1", "Level 1", "Level1"),
	new NanosaurSceneDesc("level1Extreme", "Level 1 (Extreme)", "Level1Pro"),
];


export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs };
