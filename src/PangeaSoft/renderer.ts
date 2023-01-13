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

import { Entity, EntityUpdateResult, FriendlyNames, getFriendlyName } from "./entity";
import { AlphaType, Qd3DMesh, Qd3DTexture, textureArrayToCanvas } from "./QuickDraw3D";
import { AnimationData, SkeletalMesh } from "./skeleton";


export const enum RenderFlags {
	Translucent		 = 0x400,
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

	constructor(flags : RenderFlags, numLights : number){
		super();

		this.setDefineString("NUM_LIGHTS", numLights.toString());
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
};
#define u_Time (u_TimeVec.x)
layout(std140) uniform ub_DrawParams {
	Mat4x3 u_WorldFromModelMatrix;
	vec4 u_Colour;
	#ifdef SCROLL_UVS
	vec4 u_UVScrollVec; // xy = uv, zw = unused
	#endif
};
#define u_UVScroll (u_UVScrollVec.xy)
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


	vec4 colour = u_Colour;
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

	programs = new Map<RenderFlags, GfxProgram>();
	//programIds = new WeakMap<GfxProgram, number>();

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

			const canvas = texture.numTextures === 1
				? convertToCanvas(new ArrayBufferSlice(texture.pixels.buffer, texture.pixels.byteOffset, texture.pixels.byteLength), texture.width, texture.height, texture.pixelFormat)
				: textureArrayToCanvas(texture);

			this.viewerTextures.push({
				name,
				surfaces : [canvas],
			});
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
		const hasColours = pushBuffer(mesh.vertexColours?.buffer, 12, Program.a_Colours, (mesh.vertexColours?.BYTES_PER_ELEMENT === 4) ? GfxFormat.F32_RGB : GfxFormat.U16_RGBA_5551);
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
	prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, cache : Cache, entity : Entity, flipBackfaces = false): void {
        const renderInst = renderInstManager.newRenderInst();

		const renderFlags = this.renderFlags | entity.extraRenderFlags;
		const translucent = !!(renderFlags & RenderFlags.Translucent);

		const gfxProgram = cache.getProgram(renderFlags);
		const hasTexture = (this.renderFlags & RenderFlags.HasTexture) !== 0;
		const textureArray = (this.renderFlags & RenderFlags.TextureTilemap) !== 0;

		if (!hasTexture || textureArray){
			renderInst.setBindingLayouts([{
				numUniformBuffers : (renderFlags & RenderFlags.Skinned) ? 3 : 2,
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

		let uniformOffset = renderInst.allocateUniformBuffer(Program.ub_DrawParams, 4*4 + 4 + (scrollUVs?4:0));
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
			// repeat for padding
			uniformData[uniformOffset++] = this.scrollUVs[0];
			uniformData[uniformOffset++] = this.scrollUVs[1];
		}

		renderInst.sortKey = setSortKeyDepth(
			makeSortKey(translucent ? GfxRendererLayer.TRANSLUCENT : GfxRendererLayer.OPAQUE, gfxProgram.ResourceUniqueId),
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

export class AnimatedObject implements Destroyable{
	meshes : StaticObject[];
	animationData : AnimationData;

	constructor(device : GfxDevice, cache : Cache, skeleton : SkeletalMesh, friendlyNames : FriendlyNames, name : string){
		this.meshes = skeleton.meshes.map((mesh, index)=>
			new StaticObject(device, cache, mesh, getFriendlyName(friendlyNames, name, index, 0))
		);
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

		const dt = viewerInput.deltaTime * 0.001;
		for (let i = 0; i < this.entities.length; ++i){
			const entity = this.entities[i];
			const visible = entity.checkVisible(viewerInput.camera.frustum);

			if (!visible && !entity.alwaysUpdate)
				continue;

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

