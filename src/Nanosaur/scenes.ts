
import * as Viewer from '../viewer';
import * as UI from "../ui";

import { GfxBuffer, GfxBufferUsage, GfxDevice, GfxFormat, GfxIndexBufferDescriptor, GfxInputLayout, GfxVertexBufferFrequency, GfxInputLayoutBufferDescriptor, GfxInputLayoutDescriptor, GfxInputState, GfxVertexAttributeDescriptor, GfxVertexBufferDescriptor, GfxWrapMode, GfxProgram, GfxProgramDescriptorSimple, GfxColor, GfxBlendFactor, GfxBlendMode, GfxSampler, makeTextureDescriptor2D, GfxTexture, GfxCullMode, GfxTexFilterMode, GfxMipFilterMode, GfxTextureUsage, GfxTextureDimension, GfxCompareMode } from "../gfx/platform/GfxPlatform";
import { Destroyable, GraphObjBase, SceneContext } from "../SceneBase";
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper';

import { GridPlane } from "../InteractiveExamples/GridPlane";
import { makeAttachmentClearDescriptor, makeBackbufferDescSimple, opaqueBlackFullClearRenderPassDescriptor, pushAntialiasingPostProcessPass, standardFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers";
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph";
import { GfxRenderInstManager } from "../gfx/render/GfxRenderInstManager";
import { DataFetcher, NamedArrayBufferSlice } from "../DataFetcher";
import { assert, readString } from "../util";
import { Endianness } from "../endian";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { DeviceProgram } from "../Program";
import { mat4, ReadonlyMat4, vec2, vec3, vec4 } from "gl-matrix";
import { fillColor, fillMatrix4x3, fillMatrix4x4, fillVec3v, fillVec4 } from "../gfx/helpers/UniformBufferHelpers";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { TextureMapping } from "../TextureHolder";
import { convertToCanvas } from "../gfx/helpers/TextureConversionHelpers";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { Qd3DMesh, Qd3DTexture, parseQd3DMeshGroup, Qd3DSkeleton } from "./QuickDraw3D";
import { parseTerrain, LevelObjectDef, createMenuObjectList } from "./terrain";
import { colorNewFromRGBA } from "../Color";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { MathConstants } from "../MathHelpers";
import { AABB } from "../Geometry";
import { CullMode } from "../gx/gx_enum";

const pathBase = "nanosaur";

class Program extends DeviceProgram {
	static a_Position = 0;
	static a_UVs = 1;
	static a_Colours = 2;
	static a_Normals = 3;
	static a_TextureIds = 4;

	static ub_SceneParams = 0;
	static ub_DrawParams = 1;

	constructor(flags : RenderFlags){
		super();

		this.setDefineBool("UNLIT", (flags & RenderFlags.Unlit) !== 0);
		this.setDefineBool("HAS_VERTEX_COLOURS", (flags & RenderFlags.HasVertexColours) !== 0);
		this.setDefineBool("HAS_TEXTURE", (flags & RenderFlags.HasTexture) !== 0);
		this.setDefineBool("TEXTURE_HAS_ALPHA", (flags & RenderFlags.TextureHasAlpha) !== 0);
		this.setDefineBool("TILEMAP", (flags & RenderFlags.TextureTilemap) !== 0);
		this.setDefineBool("SCROLL_UVS", (flags & RenderFlags.ScrollUVs) !== 0);
	}

	/*
	constructor(uvs : boolean, normals : boolean, colours : boolean, texture : boolean, textureHasAlpha : boolean, terrain : boolean){
		super();
		assert(uvs === texture || terrain, "uv/texture mismatch!");
		assert(!terrain || texture, "terrian/texture mismatch");
		if (terrain) texture = false;
		this.setDefineBool("HAS_NORMALS", normals);
		this.setDefineBool("HAS_COLOURS", colours);
		this.setDefineBool("HAS_TEXTURE", texture);
		this.setDefineBool("TEXTURE_HAS_ALPHA", textureHasAlpha);
		this.setDefineBool("TERRAIN", terrain);
	}
	*/

	override both = 
`
#define NUM_LIGHTS 1
struct Light {
	vec4 direction;
	vec4 colour;
};

layout(std140) uniform ub_SceneParams {
	Mat4x4 u_ClipFromWorldMatrix;
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
`;
	override vert = 
`
layout(location = ${Program.a_Position}) in vec3 a_Position;
layout(location = ${Program.a_UVs}) in vec2 a_UV;
layout(location = ${Program.a_Normals}) in vec3 a_Normal;
layout(location = ${Program.a_Colours}) in vec3 a_Colour;
layout(location = ${Program.a_TextureIds}) in float a_TextureId;

out vec4 v_Colour;
out vec3 v_Normal;
out vec2 v_UV;
flat out int v_Id;

${GfxShaderLibrary.MulNormalMatrix}

void main() {
	v_Colour = vec4(a_Colour, 1.0);
	v_Normal = MulNormalMatrix(u_WorldFromModelMatrix, a_Normal);
	v_UV = a_UV;
	#ifdef TILEMAP
	v_UV = a_Position.xz;
	v_Id = int(a_TextureId);
	#endif

    gl_Position = Mul(u_ClipFromWorldMatrix, vec4(Mul(u_WorldFromModelMatrix, vec4(a_Position, 1.0)),1.0));
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


class Cache extends GfxRenderCache implements UI.TextureListHolder {
	textures = new WeakMap<Qd3DTexture, GfxTexture>();

	modelIdCount = 0;

	assets : ProcessedAssets;
	allTextures : GfxTexture[] = [];

	programs = new Map<RenderFlags, GfxProgram>();

	viewerTextures : Viewer.Texture[] = [];
	onnewtextures: (() => void) | null = null;

	getProgram(renderFlags : RenderFlags){
		let program = this.programs.get(renderFlags);
		if (program) return program;
		program = this.createProgram(new Program(renderFlags));
		this.programs.set(renderFlags, program);
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
			skeletons[name] = make(rawAssets.skeletons[name] ?? []);
		}

		this.assets = {
			globalModels : make(rawAssets.globalModels),
			level1Models : make(rawAssets.level1Models),
			menuModels : make(rawAssets.menuModels),
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
		for (const name of SkeletonNames){
			destroyModels(this.assets.skeletons[name] ?? []);
		}
		this.assets.terrainModel?.destroy(device);
	}

	public override destroy(): void {
		const device = this.device;

		this.allTextures.forEach((tex)=>device.destroyTexture(tex));
		this.programs.forEach((program)=>device.destroyProgram(program));
		this.destroyModels();

		super.destroy();
	}

}

const enum RenderFlags {
	Translucent		 = 0x8000,
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

		if (!hasNormals)
			this.renderFlags |= RenderFlags.Unlit; // no lighting without normals

		if (hasColours)
			this.renderFlags |= RenderFlags.HasVertexColours;

		if (this.colour.a < 1){
			this.renderFlags |= RenderFlags.Translucent;
		}

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
	prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, cache : Cache, instanceModelMatrix : ReadonlyMat4): void {
        const renderInst = renderInstManager.newRenderInst();
		/*
        renderInst.setBindingLayouts([{
			numUniformBuffers : 2,
			numSamplers : 1,
		}]);
		*/

		const gfxProgram = cache.getProgram(this.renderFlags);

        renderInst.setGfxProgram(gfxProgram);
        renderInst.setInputLayoutAndState(this.inputLayout, this.inputState);
		const keepBackfaces = this.renderFlags & RenderFlags.KeepBackfaces;
        renderInst.setMegaStateFlags({ cullMode: keepBackfaces ? GfxCullMode.None : GfxCullMode.Back });
        renderInst.setSamplerBindingsFromTextureMappings(this.textureMapping);
	
		if (this.renderFlags & RenderFlags.Translucent){
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

		const scrollUVs = this.renderFlags & RenderFlags.ScrollUVs;

		let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_DrawParams, 4*4 + 4 + (scrollUVs?2:0));
		const uniformData = renderInst.mapUniformBufferF32(Program.ub_DrawParams);
		
		let modelMatrix : ReadonlyMat4 = instanceModelMatrix;
		if (this.modelMatrix){
			modelMatrix = mat4.mul(mat4.create(), modelMatrix, this.modelMatrix); // todo verify multiplication order
		}
		//uniformOffset += fillMatrix4x4(uniformData, uniformOffset, viewerInput.camera.projectionMatrix);
		//const scratchMatrix = mat4.create();
		//mat4.mul(scratchMatrix, viewerInput.camera.viewMatrix, this.modelMatrix);
		//uniformOffset += fillMatrix4x4(uniformData, uniformOffset, scratchMatrix);
		uniformOffset += fillMatrix4x3(uniformData, uniformOffset, modelMatrix);

		//const scratchMatrix = mat4.fromYRotation(mat4.create(), viewerInput.time / 2000);
		//mat4.mul(scratchMatrix, this.modelMatrix, scratchMatrix);
		//uniformOffset += fillMatrix4x3(uniformData, uniformOffset, scratchMatrix);
		uniformOffset += fillColor(uniformData, uniformOffset, this.colour);

		if (scrollUVs){
			uniformData[uniformOffset++] = this.scrollUVs[0];
			uniformData[uniformOffset++] = this.scrollUVs[1];
		}

        renderInstManager.submitRenderInst(renderInst);
	}
	destroy(device: GfxDevice): void {
		device.destroyInputState(this.inputState);
		for (const buf of this.buffers)
			device.destroyBuffer(buf);
	}
}

class Entity {
	meshes : StaticObject[];
	position: vec3;
	rotation: number;
	scale: vec3;
	modelMatrix : mat4 = mat4.create();
	aabb : AABB = new AABB();

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
		for (const mesh of this.meshes){
			mesh.colour.a = alpha;
			mesh.renderFlags |= RenderFlags.Translucent;
			if (unlit)
				mesh.renderFlags |= RenderFlags.Unlit;
			if (keepBackfaces)
				mesh.renderFlags |= RenderFlags.KeepBackfaces;
		}
	}

	scrollUVs(xy : vec2){
		for (const mesh of this.meshes){
			mesh.scrollUVs = xy;
			mesh.renderFlags |= RenderFlags.ScrollUVs;
		}
	}

	updateMatrix(){
		this.modelMatrix = mat4.fromYRotation(mat4.create(), this.rotation); //mat4.fromScaling(mat4.create(), [scale,scale,scale]);
		mat4.scale(this.modelMatrix, this.modelMatrix, this.scale);
		this.modelMatrix[12] = this.position[0];
		this.modelMatrix[13] = this.position[1];
		this.modelMatrix[14] = this.position[2];

		this.aabb.reset();
		for (const mesh of this.meshes){
			this.aabb.union(this.aabb, mesh.aabb);
		}
		this.aabb.transform(this.aabb, this.modelMatrix);
	}

	prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, cache : Cache): void {

		if (!viewerInput.camera.frustum.contains(this.aabb)){
			return;
		}
		
		for (const mesh of this.meshes)
			mesh.prepareToRender(device, renderInstManager, viewerInput, cache, this.modelMatrix);
	}
	
	update(dt : number){}
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
	return new Entity(assets.skeletons.Tricer!.flat(), [def.x, def.y, def.z], null, 2.2, false);
};
const EntityCreationFunctions : ((def:LevelObjectDef, assets : ProcessedAssets)=>Entity|Entity[]|void)[] = [
	function spawnPlayer(def, assets){ // 0
		// todo animate, shadow
		return new Entity(assets.skeletons.Deinon!.flat(), [def.x, def.y, def.z], 0, 1, true);
	},
	function spawnPowerup(def, assets){ // 1
		const meshIndices = [11, 12, 14, 15, 16, 17, 18];
		const type = def.param0;
		assert(type >= 0 && type <= 6, "powerup type out of range");
		// todo: y pos quick
		// todo: rotate
		return new SpinningEntity(assets.globalModels[meshIndices[type]], [def.x, def.y + 0.5, def.z], 0, 1, false);
	},
	spawnTriceratops, // 2
	function spawnRex(def, assets){ // 3
		// todo: animate, mesh, push up, rotation, shadow (ffor eveerything)
		return new Entity(assets.skeletons.Rex!.flat(), [def.x, def.y, def.z], null, 1.2, true);
	},
	function spawnLava(def, assets){ // 4
		// todo: fireballs, highfilter, etc?
		const x = Math.floor(def.x / 140) * 140 + 140/2
		const z = Math.floor(def.z / 140) * 140 + 140/2
		const y = (def.param3 & 1) ? def.y + 50 : 305;
		const scale = (def.param3 & (1<<2)) ? 1 : 2;
		const result = new UndulateEntity(assets.level1Models[1], [x,y,z], 0, scale, false);
		result.scrollUVs([0.07, 0.03]);
		result.baseScale = 0.501;
		result.amplitude = 0.5;
		result.period = 2.0;
		result.t = 1;
		return result;
	},
	function spawnEgg(def, assets){ // 5
		const eggType = def.param0;
		assert(eggType < 5, "egg type out of range");
		const egg = new Entity(assets.level1Models[3 + eggType], [def.x, def.y - 5, def.z], null, 0.6, true);
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
		const ptera = new Entity(assets.skeletons.Ptera!.flat(), [def.x, def.y + 100, def.z], null, 1, true)
		if (def.param3 & (1<<1)) {
			// todo attach
			const rock = new Entity(assets.level1Models[9], [def.x, def.y + 100, def.z], 0, 0.4, false);
			return [rock, ptera];
		}
		return ptera;
	},
	function spawnStegosaurus(def, assets){ // 8
		return new Entity(assets.skeletons.Stego!.flat(), [def.x, def.y, def.z], null, 1.4, true);
	},
	function spawnTimePortal(def, assets){ // 9
		// todo: everything
		return new Entity(assets.globalModels[10], [def.x, def.y + 50, def.z], 0, 5, false);
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
		result.t = 1;
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
		// todo make not unlit?
		const result = new Entity(assets.level1Models[crystalMeshIndices[type]], [def.x, def.y, def.z], 0, 1.5 + Math.random(), false);
		result.makeTranslucent(0.7, false, true);
		return result;
	},
	function spawnSpitter(def, assets){ // 16
		return new Entity(assets.skeletons.Diloph!.flat(), [def.x, def.y, def.z], null, 0.8, true);
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
];
function invalidEntityType(def : LevelObjectDef, assets : ProcessedAssets) {
	console.log("invalid object type", def);
}

type ProcessedAssets = Assets<StaticObject, StaticObject>;

class NanosaurSceneRenderer implements Viewer.SceneGfx{
    renderHelper: GfxRenderHelper;
    entities: Entity[] = [];
	cache : Cache;

	textureHolder : UI.TextureListHolder;


	constructor(device : GfxDevice, context : SceneContext, assets : RawAssets, objectList : LevelObjectDef[]){
		const cache = new Cache(device);
		this.cache = cache;
		this.textureHolder = cache;
		this.renderHelper = new GfxRenderHelper(device, context, cache);

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


	prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput){
		const renderInst = this.renderHelper.pushTemplateRenderInst();

		renderInst.setBindingLayouts([{
			numUniformBuffers : 2,
			numSamplers : 1,
		}]);
		// set scene uniforms
		let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_SceneParams, 4*4 + 4 + 8*1 + 1);
		const uniformData = renderInst.mapUniformBufferF32(Program.ub_SceneParams);
		// camera matrix
		uniformOffset += fillMatrix4x4(uniformData, uniformOffset, viewerInput.camera.clipFromWorldMatrix);
		// ambient colour
		uniformOffset += fillVec4(uniformData, uniformOffset, 0.2, 0.2, 0.2, 1);
		// light[0].direction
		//uniformOffset += fillVec4(uniformData, uniformOffset, 1, -0.7, -1, 0);
		uniformOffset += fillVec4(uniformData, uniformOffset, -0.6337242505244779134653933449776, 0.44360697536713453942577534148432, 0.6337242505244779134653933449776, 0);
		// light[0].colour
		uniformOffset += fillVec4(uniformData, uniformOffset, 1.2, 1.2, 1.2, 1);
		// light[1].direction
		//uniformOffset += fillVec4(uniformData, uniformOffset, -1, -1, 0.2, 0);
		//uniformOffset += fillVec4(uniformData, uniformOffset, 0.70014004201400490176464704033012, 0.70014004201400490176464704033012, -0.14002800840280098035292940806602, 0);
		// light[1].colour
		//uniformOffset += fillVec4(uniformData, uniformOffset, 0.4, 0.36, 0.24, 1);
		uniformData[uniformOffset] = viewerInput.time * 0.001;
		uniformOffset += 1;


		const dt = viewerInput.deltaTime * 0.001;
		for (const entity of this.entities)
			entity.update(dt);

		// todo multiple meshes
		this.entities.sort((e1,e2)=>{
			// todo better depth sort and stuff
			const flag1 = e1.meshes[0].renderFlags;
			const flag2 = e2.meshes[0].renderFlags;
			return flag1 - flag2;
		});

        const renderInstManager = this.renderHelper.renderInstManager;
        for (let i = 0; i < this.entities.length; i++)
            this.entities[i].prepareToRender(device, renderInstManager, viewerInput, this.cache);
			
        renderInstManager.popTemplateRenderInst();
        this.renderHelper.prepareToRender();
	}

	public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        const renderInstManager = this.renderHelper.renderInstManager;

		const renderPassDescriptor = makeAttachmentClearDescriptor({r:0.95, g:0.95, b:0.75, a:1.0}); // standardFullClearRenderPassDescriptor;
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
	terrainModel? : MeshType,
	skeletons : {
		[String in typeof SkeletonNames[number]]? : SkeletonType[][]
	}
};
type RawAssets = Assets<Qd3DMesh, Qd3DSkeleton>;

class NanosaurSceneDesc implements Viewer.SceneDesc {
	constructor(public id : string, public name : string, public levelName : string){}

	loadSkeleton(dataFetcher : DataFetcher, name : typeof SkeletonNames[number]){
		return Promise.all([
			dataFetcher.fetchData(`${pathBase}/Skeletons/${name}.3dmf`).then(parseQd3DMeshGroup),
			null,//context.dataFetcher.fetchData(`${pathBase}/Skeletons/${name}.skeleton.rsrc`),
		]).then(([modelData, skeletonData])=>modelData);
	}

	async createMenuScene(device : GfxDevice, context : SceneContext) : Promise<Viewer.SceneGfx> {
		
		const menuModelsPromise = context.dataFetcher.fetchData(pathBase + "/Models/MenuInterface.3dmf")
			.then(parseQd3DMeshGroup);
		const playerSkeletonPromise = this.loadSkeleton(context.dataFetcher, "Deinon");

		const assets : RawAssets = {
			globalModels : [],
			level1Models : [],
			menuModels : await menuModelsPromise,
			skeletons : {
				Deinon : await playerSkeletonPromise
			}
		};
		return new NanosaurSceneRenderer(device, context, assets, createMenuObjectList());
	}

	public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {

		if (this.levelName === "MainMenu")
			return this.createMenuScene(device, context);

		const terrainPromise = Promise.all([
			context.dataFetcher.fetchData(`${pathBase}/terrain/${this.levelName}.ter`),
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
			terrainModel,
			skeletons,
		}

		return new NanosaurSceneRenderer(device, context, assets, objectList);
	}
	
}

const id = "nanosaur";
const name = "Nanosaur";
const sceneDescs = [
	new NanosaurSceneDesc("level1", "Level 1", "Level1"),
	new NanosaurSceneDesc("level1Extreme", "Level 1 (Extreme)", "Level1Pro"),
	new NanosaurSceneDesc("mainmenu", "Main Menu", "MainMenu"),
];


export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs };
