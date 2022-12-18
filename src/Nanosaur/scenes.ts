
import * as Viewer from '../viewer';
import * as UI from "../ui";

import { GfxBuffer, GfxBufferUsage, GfxDevice, GfxFormat, GfxIndexBufferDescriptor, GfxInputLayout, GfxVertexBufferFrequency, GfxInputLayoutBufferDescriptor, GfxInputLayoutDescriptor, GfxInputState, GfxVertexAttributeDescriptor, GfxVertexBufferDescriptor, GfxWrapMode, GfxProgram, GfxProgramDescriptorSimple, GfxColor, GfxBlendFactor, GfxBlendMode, GfxSampler, makeTextureDescriptor2D, GfxTexture, GfxCullMode, GfxTexFilterMode, GfxMipFilterMode, GfxTextureUsage, GfxTextureDimension, GfxCompareMode } from "../gfx/platform/GfxPlatform";
import { Destroyable, GraphObjBase, SceneContext } from "../SceneBase";
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper';

import { GridPlane } from "../InteractiveExamples/GridPlane";
import { makeAttachmentClearDescriptor, makeBackbufferDescSimple, opaqueBlackFullClearRenderPassDescriptor, pushAntialiasingPostProcessPass, standardFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers";
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph";
import { GfxRenderInstManager } from "../gfx/render/GfxRenderInstManager";
import { NamedArrayBufferSlice } from "../DataFetcher";
import { assert, readString } from "../util";
import { Endianness } from "../endian";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { DeviceProgram } from "../Program";
import { mat4, ReadonlyMat4, vec3, vec4 } from "gl-matrix";
import { fillColor, fillMatrix4x3, fillMatrix4x4, fillVec3v, fillVec4 } from "../gfx/helpers/UniformBufferHelpers";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { TextureMapping } from "../TextureHolder";
import { convertToCanvas } from "../gfx/helpers/TextureConversionHelpers";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { Qd3DMesh, Qd3DTexture, parseQd3DMeshGroup, parseTerrain, Qd3DObjectDef, Qd3DSkeleton } from "./QuickDraw3D";
import { colorNewFromRGBA } from "../Color";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { MathConstants } from "../MathHelpers";

const pathBase = "nanosaur_raw";

class Program extends DeviceProgram {
	static a_Position = 0;
	static a_UVs = 1;
	static a_Colours = 2;
	static a_Normals = 3;
	static a_TextureIds = 4;

	static ub_SceneParams = 0;
	static ub_DrawParams = 1;

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
};
layout(std140) uniform ub_DrawParams {
	Mat4x3 u_WorldFromModelMatrix;
	vec4 u_Colour;
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
	#ifdef TERRAIN
	v_UV = a_Position.xz;
	v_Id = int(a_TextureId);
	#endif

    gl_Position = Mul(u_ClipFromWorldMatrix, vec4(Mul(u_WorldFromModelMatrix, vec4(a_Position, 1.0)),1.0));
}
`;
	override frag = 
`
#ifdef TERRAIN
precision mediump float;
precision lowp sampler2DArray;
uniform sampler2DArray u_TerrainTexture;
#else
uniform sampler2D u_Texture;
#endif
in vec4 v_Colour;
in vec2 v_UV;
in vec3 v_Normal;
flat in int v_Id;

void main(){
	vec4 colour = u_Colour;
	
	#ifdef HAS_COLOURS
		colour *= v_Colour;
	#endif
	
	#ifdef HAS_TEXTURE
		colour *= texture(SAMPLER_2D(u_Texture), v_UV);
		#ifdef TEXTURE_HAS_ALPHA
			if (colour.a < 0.5) { discard; }
		#endif
	#endif

	#ifdef TERRAIN
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

		colour *= texture(SAMPLER_2D(u_TerrainTexture), vec3(uv, textureId));
	#endif

	#ifdef HAS_NORMALS
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

	textures = new Map<Qd3DTexture, GfxTexture>();

	viewerTextures : Viewer.Texture[] = [];
	onnewtextures: (() => void) | null = null;


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

	public override destroy(): void {
		this.textures.forEach((tex)=>this.device.destroyTexture(tex));
		super.destroy();
	}

}

class StaticObject implements Destroyable {
	gfxProgram : GfxProgram;
	indexCount : number;
	buffers : GfxBuffer[] = [];
	inputLayout : GfxInputLayout;
	inputState : GfxInputState;
	modelMatrix? : mat4;
	colour : GfxColor;
	textureMapping : TextureMapping[] = [];

	constructor(device : GfxDevice, cache : Cache, mesh : Qd3DMesh){
		this.indexCount = mesh.numTriangles * 3;
		this.colour = mesh.colour;
		if (mesh.baseTransform)
			this.modelMatrix = mat4.clone(mesh.baseTransform);
	
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

		const texture = mesh.texture;
		if (texture){
			this.textureMapping.push(cache.createTextureMapping(texture));
		}

		this.gfxProgram = cache.createProgram(new Program(hasUvs, hasNormals, hasColours, texture != null, !!(texture?.hasAlpha), hasTilemap));

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
	prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, instanceModelMatrix : ReadonlyMat4): void {
        const renderInst = renderInstManager.newRenderInst();
		/*
        renderInst.setBindingLayouts([{
			numUniformBuffers : 2,
			numSamplers : 1,
		}]);
		*/
        renderInst.setGfxProgram(this.gfxProgram);
        renderInst.setInputLayoutAndState(this.inputLayout, this.inputState);
        renderInst.setMegaStateFlags({ cullMode: GfxCullMode.Back });
        renderInst.setSamplerBindingsFromTextureMappings(this.textureMapping);
	

		if (this.colour.a < 1.0){
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

		let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_DrawParams, 4*4 + 4);
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
	modelMatrix : mat4;

	constructor(meshes : StaticObject | StaticObject[], matrix? : mat4){
		if (!Array.isArray(meshes))
			meshes = [meshes];
		this.meshes = meshes;
		if (matrix)
			this.modelMatrix = matrix;
		else
			this.modelMatrix = mat4.create();
	}
	prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
		for (const mesh of this.meshes)
			mesh.prepareToRender(device, renderInstManager, viewerInput, this.modelMatrix);
	}
	
}

function transform(x : number, y : number, z : number, yAngle : number, scale : number) : mat4 {
	let result = mat4.fromYRotation(mat4.create(), yAngle); //mat4.fromScaling(mat4.create(), [scale,scale,scale]);
	mat4.scale(result, result, [scale,scale,scale]);
	/*
	const scaleMatrix = mat4.fromScaling(mat4.create(), [scale,scale,scale]);
	const rotMatrix = ;
	*/

	result[12] = x;
	result[13] = y;
	result[14] = z;
	return result;
}

const EntityCreationFunctions : ((def:Qd3DObjectDef, meshLists:StaticObject[][])=>Entity|Entity[]|void)[] = [
	// 0: start coords (spawn player)
	function(def){},
	function spawnPowerup(def, meshLists){ // 1
		// todo: global mesh lists
		/*
		const meshIndices = [11, 12, 14, 15, 16, 17, 18];
		const type = def.param0;
		assert(type >= 0 && type <= 6, "powerup type out of range");
		// todo: y pos quick
		// todo: rotate
		return new Entity(meshLists[meshIndices[type]], transform(def.x, def.y + 0.5, def.z, 0, 1));
		*/
	},
	// 2: triceratops
	function(def){},
	// 3: rex
	function(def){},
	// 4: lava
	function(def){},
	function spawnEgg(def, meshLists){ // 5
		const eggType = def.param0;
		assert(eggType < 5, "egg type out of range");
		const egg = new Entity(meshLists[3 + eggType], transform(def.x, def.y - 5, def.z, Math.random() * MathConstants.TAU, 0.6));
		if (def.param3 & 1){
			// make nest
			const nest = new Entity(meshLists[15], transform(def.x, def.y, def.z, 0, 1));
			return [egg, nest];
		}
		return egg;
	},
	// 6: gas vent
	function(def){},
	// 7: pteranodon
	function(def){},
	// 8: stegosaurus
	function(def){},
	// 9: time portal
	function(def){},
	function spawnTree(def, meshLists){ // 10
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
		// todo: adjust y by bounding box and scale
		return new Entity(meshLists[16 + treeIndex], transform(def.x, def.y, def.z, Math.random() * MathConstants.TAU, treeScales[treeIndex] + Math.random() * 0.5));
	},
	function spawnBoulder(def, meshLists){ // 11
		// todo: adjust y by bounding box and scale
		return new Entity(meshLists[8], transform(def.x, def.y - 10, def.z, Math.random() * MathConstants.TAU, 1 + Math.random()));
	},
	function spawnMushroom(def, meshLists){ //12
		return new Entity(meshLists[10], transform(def.x, def.y, def.z, Math.random() * MathConstants.TAU, 1 + Math.random()));
	},
	function spawnBush(def, meshLists){ // 13
		// todo: adjust y by bounding box and scale
		const bush = new Entity(meshLists[11], transform(def.x, def.y, def.z, Math.random() * MathConstants.TAU, 4.2));
		// todo: spawn triceratops
		//const triceratops = spawnTriceratops(def, meshLists);
		//return [bush, triceratops];
		return bush;
	},
	// 14: water patch
	function(def){},
	// 15: crystal
	function spawnCrystal(def, meshLists){
		const crystalMeshIndices = [12, 13, 14];
		const type = def.param0;
		assert(type >= 0 && type <= 2, "crystal type out of range");
		// todo: y coord quick
		// todo: transparency/backfaces
		return new Entity(meshLists[crystalMeshIndices[type]], transform(def.x, def.y, def.z, 0, 1.5 + Math.random()));
	},
	// 16: spitter
	function(def){},
	function spawnStepStone(def, meshLists){ // 17
		// todo: quick y
		const LAVA_Y_OFFSET = 50 / 2;
		return new Entity(meshLists[23], transform(def.x, def.y + LAVA_Y_OFFSET, def.z, 0, 1));
	},
	function spawnRollingBoulder(def, meshLists){ // 18
		const scale = 3;
		// todo: roll
		return new Entity(meshLists[9], transform(def.x, def.y + 30 * scale, def.z, Math.random() * MathConstants.TAU, scale));
	},
	function spawnSporePod(def, meshLists){ // 19
		// todo: update method
		return new Entity(meshLists[24], transform(def.x, def.y, def.z, 0, 0.5));
	},
];
function invalidEntityType(def : Qd3DObjectDef) {
	console.log("invalid object type", def);
}

class NanosaurSceneRenderer implements Viewer.SceneGfx{
    renderHelper: GfxRenderHelper;
	meshes : Destroyable[] = [];
    entities: Entity[] = [];

	textureHolder : UI.TextureListHolder;


	constructor(device : GfxDevice, context : SceneContext, assets : Assets, objectList : Qd3DObjectDef[]){
		const cache = new Cache(device);
		this.textureHolder = cache;
		this.renderHelper = new GfxRenderHelper(device, context, cache);

		const terrainMesh = new StaticObject(device, cache, assets.terrainModel);
		this.meshes.push(terrainMesh);

		const meshLists = assets.level1Models.map((list)=>
			list.map((mesh)=>{
				const object = new StaticObject(device, cache, mesh);
				this.meshes.push(object);
				return object;
			})
		);

		const terrainEntity = new Entity(terrainMesh);
		this.entities.push(terrainEntity);

		for (const objectDef of objectList){
			const entity = (EntityCreationFunctions[objectDef.type] ?? invalidEntityType)(objectDef, meshLists);
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
		let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_SceneParams, 4*4 + 4 + 8*1);
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

        const renderInstManager = this.renderHelper.renderInstManager;
        for (let i = 0; i < this.entities.length; i++)
            this.entities[i].prepareToRender(device, renderInstManager, viewerInput);
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
		for (const mesh of this.meshes){
			mesh.destroy(device);
		}
		this.renderHelper.getCache().destroy();
		this.renderHelper.destroy();
	}

}

const SkeletonNames = [
	"Ptera", "Rex", "Stego", "Deinon", "Tricer", "Diloph",
] as const;

type SkeletonList = {
	[String in typeof SkeletonNames[number]] : Qd3DMesh[][]
}
type Assets = {
	terrainModel : Qd3DMesh,
	level1Models : Qd3DMesh[][],
	skeletons : SkeletonList,
};

class NanosaurSceneDesc implements Viewer.SceneDesc {
	constructor(public id : string, public name : string){}

	public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {

		const terrainPromise = Promise.all([
			context.dataFetcher.fetchData(pathBase + "/terrain/Level1.ter"),
			context.dataFetcher.fetchData(pathBase + "/terrain/Level1.trt"),
		]).then(([terrainData, terrainTexture]) => parseTerrain(terrainData, terrainTexture));
		
		const level1ModelsPromise = context.dataFetcher.fetchData(pathBase + "/Models/Level1_Models.3dmf")
			.then(parseQd3DMeshGroup);

		const skeletonPromises = SkeletonNames.map((name)=>
			Promise.all([
				context.dataFetcher.fetchData(`${pathBase}/Skeletons/${name}.3dmf`).then(parseQd3DMeshGroup),
				null,//context.dataFetcher.fetchData(`${pathBase}/Skeletons/${name}.skeleton.rsrc`),
			]).then(([modelData, skeletonData])=>modelData)
		)

		const [terrainModel, objectList] = await terrainPromise;

		const skeletons : SkeletonList = {} as SkeletonList;
		for (let i = 0; i < SkeletonNames.length; ++i){
			skeletons[SkeletonNames[i]] = await skeletonPromises[i];
		}

		const assets : Assets = {
			terrainModel,
			level1Models : await level1ModelsPromise,
			skeletons,
		}

		/*
		const modelsPromise = Promise.all([
				//"/Models/Global_Models.3dmf",
				//"/Models/Global_Models2.3dmf",
				//"/Models/HighScores.3dmf",
				//"/Models/Infobar_Models.3dmf",
				"/Models/Level1_Models.3dmf",
				//"/Models/MenuInterface.3dmf",
				//"/Models/Title.3dmf",
				"/Skeletons/Deinon.3dmf",
				"/Skeletons/Diloph.3dmf",
				"/Skeletons/Ptera.3dmf",
				"/Skeletons/Rex.3dmf",
				"/Skeletons/Stego.3dmf",
				"/Skeletons/Tricer.3dmf",
			].map((path)=>
				context.dataFetcher.fetchData(pathBase + path)
					.then(parseQd3DMeshGroup)
			)
		);*/

		return new NanosaurSceneRenderer(device, context, assets, objectList);
	}
	
}

const id = "nanosaur";
const name = "Nanosaur";
const sceneDescs = [
	new NanosaurSceneDesc("level1", "Level 1"),
];


export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs };
