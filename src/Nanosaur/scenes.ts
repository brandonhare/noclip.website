
import * as Viewer from '../viewer';
import * as UI from "../ui";

import { GfxBuffer, GfxBufferUsage, GfxDevice, GfxFormat, GfxIndexBufferDescriptor, GfxInputLayout, GfxVertexBufferFrequency, GfxInputLayoutBufferDescriptor, GfxInputLayoutDescriptor, GfxInputState, GfxVertexAttributeDescriptor, GfxVertexBufferDescriptor, GfxWrapMode, GfxProgram, GfxProgramDescriptorSimple, GfxColor, GfxBlendFactor, GfxBlendMode, GfxSampler, makeTextureDescriptor2D, GfxTexture, GfxCullMode, GfxTexFilterMode, GfxMipFilterMode, GfxTextureUsage, GfxTextureDimension, GfxCompareMode } from "../gfx/platform/GfxPlatform";
import { GraphObjBase, SceneContext } from "../SceneBase";
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
import { mat4, vec3, vec4 } from "gl-matrix";
import { fillColor, fillMatrix4x3, fillMatrix4x4, fillVec3v, fillVec4 } from "../gfx/helpers/UniformBufferHelpers";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { TextureMapping } from "../TextureHolder";
import { convertToCanvas } from "../gfx/helpers/TextureConversionHelpers";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { Qd3DMesh, Qd3DTexture, parseQd3DMeshGroup, parseTerrain, Qd3DObjectDef } from "./QuickDraw3D";
import { colorNewFromRGBA } from "../Color";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";

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

class StaticObject implements GraphObjBase {
	gfxProgram : GfxProgram;
	indexCount : number;
	buffers : GfxBuffer[] = [];
	inputLayout : GfxInputLayout;
	inputState : GfxInputState;
	modelMatrix = mat4.create();
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
	prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
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
		
		//uniformOffset += fillMatrix4x4(uniformData, uniformOffset, viewerInput.camera.projectionMatrix);
		//const scratchMatrix = mat4.create();
		//mat4.mul(scratchMatrix, viewerInput.camera.viewMatrix, this.modelMatrix);
		//uniformOffset += fillMatrix4x4(uniformData, uniformOffset, scratchMatrix);
		uniformOffset += fillMatrix4x3(uniformData, uniformOffset, this.modelMatrix);

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

class NanosaurSceneRenderer implements Viewer.SceneGfx{
    renderHelper: GfxRenderHelper;
    obj: GraphObjBase[] = [];

	textureHolder : UI.TextureListHolder;


	constructor(device : GfxDevice, context : SceneContext, models : Qd3DMesh[][][], objects : Qd3DObjectDef[]){
		const cache = new Cache(device);
		this.textureHolder = cache;
		this.renderHelper = new GfxRenderHelper(device, context, cache);
        this.obj.push(new GridPlane(device, cache));

		const pos : vec3 = [1000,1000, 9000];
		let first = true;
		for (const modelGroup of models){
			for (const meshGroup of modelGroup){
				for (const mesh of meshGroup){
					const obj = new StaticObject(device, cache, mesh);
					if (first){ // terrain hack
						first = false;
					} else {
						mat4.fromTranslation(obj.modelMatrix, pos);
						mat4.scale(obj.modelMatrix, obj.modelMatrix, [-1,1,-1]);
					}
					this.obj.push(obj);
				}
			}
			pos[0] += 200;
			if (pos[0] >= 4000){
				pos[0] = 1000;
				pos[2] += 500;
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
        for (let i = 0; i < this.obj.length; i++)
            this.obj[i].prepareToRender(device, renderInstManager, viewerInput);
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
		this.obj.forEach((obj)=>obj.destroy(device));
		this.renderHelper.getCache().destroy();
		this.renderHelper.destroy();
	}

}


class NanosaurSceneDesc implements Viewer.SceneDesc {
	constructor(public id : string, public name : string){}

	public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {


		const terrainDataPromise = context.dataFetcher.fetchData(pathBase + "/terrain/Level1.ter");
		const terrainTexturePromise = context.dataFetcher.fetchData(pathBase + "/terrain/Level1.trt");
		
		const modelsPromise = Promise.all([
				//"/Models/Global_Models.3dmf",
				"/Models/Global_Models2.3dmf",
				"/Models/HighScores.3dmf",
				"/Models/Infobar_Models.3dmf",
				"/Models/Level1_Models.3dmf",
				"/Models/MenuInterface.3dmf",
				"/Models/Title.3dmf",
				"/Skeletons/Deinon.3dmf",
				//"/Skeletons/Diloph.3dmf" // weird
				"/Skeletons/Ptera.3dmf",
				"/Skeletons/Rex.3dmf",
				"/Skeletons/Stego.3dmf",
				"/Skeletons/Tricer.3dmf",
			].map((path)=>
				context.dataFetcher.fetchData(pathBase + path)
					.then(parseQd3DMeshGroup)
			)
		);

		const [terrainModel, objects] = parseTerrain(await terrainDataPromise, await terrainTexturePromise);
		const models = await modelsPromise;

		models.unshift([[terrainModel]]);

		return new NanosaurSceneRenderer(device, context, models, objects);
	}
	
}

const id = "nanosaur";
const name = "Nanosaur";
const sceneDescs = [
	new NanosaurSceneDesc("level1", "Level 1"),
];


export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs };
