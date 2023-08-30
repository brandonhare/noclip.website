import { mat4 } from "gl-matrix";
import AnimationController from "../AnimationController.js";
import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase.js";
import { makeBackbufferDescSimple, opaqueBlackFullClearRenderPassDescriptor, pushAntialiasingPostProcessPass } from "../gfx/helpers/RenderGraphHelpers.js";
import { fillMatrix4x3, fillMatrix4x4 } from "../gfx/helpers/UniformBufferHelpers.js";
import { GfxBufferFrequencyHint, GfxBufferUsage, GfxCullMode, GfxDevice, GfxFormat, GfxIndexBufferDescriptor, GfxInputLayout, GfxMipFilterMode, GfxProgram, GfxSampler, GfxSamplerBinding, GfxTexFilterMode, GfxTexture, GfxTextureDimension, GfxTextureUsage, GfxVertexBufferDescriptor, GfxVertexBufferFrequency, GfxWrapMode } from "../gfx/platform/GfxPlatform.js";
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph.js";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper.js";
import { GfxRenderInstManager, executeOnPass } from "../gfx/render/GfxRenderInstManager.js";
import * as UI from "../ui.js";
import { SceneGfx, ViewerRenderInput, Texture as ViewerTexture } from "../viewer.js";
import { MtiTexture, RawMesh, parseDti, parseMti, parseMto, parseSni } from "./data.js";
import * as Shaders from "./shaders.js";
import { AABB } from "../Geometry.js";
import * as DebugJunk from "../DebugJunk.js";


function createCanvasTexture(name: string, width: number, height: number, pixels: Uint8Array, palette: Uint8Array): ViewerTexture {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d")!;
	const imgData = ctx.getImageData(0, 0, width, height);
	const dest = imgData.data;
	for (let i = 0; i < width * height; ++i) {
		const p = pixels[i] * 3;
		dest[i * 4] = palette[p];
		dest[i * 4 + 1] = palette[p + 1];
		dest[i * 4 + 2] = palette[p + 2];
		dest[i * 4 + 3] = (p === 0) ? 0 : 255;
	}
	ctx.putImageData(imgData, 0, 0);
	return {
		name,
		surfaces: [canvas]
	};
}

class ObjectRenderer {

	name : string;
	visible = true;
	numIndexes : number;
	worldTransform : mat4;
	aabb : AABB;

	vertexBuffers : GfxVertexBufferDescriptor[];
	indexBuffer : GfxIndexBufferDescriptor;

	constructor(device : GfxDevice, mesh : RawMesh){
		this.name = mesh.name;
		let numVertWords = 0;
		let numIndices = 0;
		for (const part of mesh.parts){
			numVertWords += part.verts.length;
			numIndices += part.indices.length;
		}
		this.numIndexes = numIndices;

		this.aabb = mesh.bbox.clone();

		this.worldTransform = mat4.create();
		//this.worldTransform = mat4.fromScaling(mat4.create(), [0.01, 0.01, 0.01]);

		const vertexBuffer = device.createBuffer(numVertWords, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static);
		const indexBuffer = device.createBuffer(numIndices / 2, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static);
		let vertOffset = 0;
		let indexOffset = 0;
		for (const part of mesh.parts){
			device.uploadBufferData(vertexBuffer, vertOffset, new Uint8Array(part.verts.buffer));
			device.uploadBufferData(indexBuffer, indexOffset, new Uint8Array(part.indices.buffer));
			vertOffset += part.verts.byteLength;
			indexOffset += part.indices.byteLength;
		}

		this.vertexBuffers = [{
			buffer : vertexBuffer,
			byteOffset : 0
		}];
		this.indexBuffer = {
			buffer : indexBuffer,
			byteOffset : 0
		};
		
	}

	prepareToRender(renderer : MdkRenderer, renderInstManager : GfxRenderInstManager, viewerInput : ViewerRenderInput){

		if (!this.visible || !viewerInput.camera.frustum.contains(this.aabb))
			return;
		
		//const debugCanvas = DebugJunk.getDebugOverlayCanvas2D();
		//DebugJunk.drawWorldSpaceAABB(debugCanvas, viewerInput.camera.clipFromWorldMatrix, this.aabb);

		const inst = renderInstManager.newRenderInst();

		let off = inst.allocateUniformBuffer(1, 12);
		fillMatrix4x3(inst.mapUniformBufferF32(1), off, this.worldTransform);

		inst.drawIndexes(this.numIndexes);
		inst.setVertexInput(renderer.simpleInputLayout, this.vertexBuffers, this.indexBuffer);

		renderInstManager.submitRenderInst(inst);
	}

	destroy(device : GfxDevice){
		device.destroyBuffer(this.indexBuffer.buffer);
		for (const buf of this.vertexBuffers)
			device.destroyBuffer(buf.buffer);
	}
}


class ObjectPanel extends UI.Panel {
	constructor(renderer : MdkRenderer){
		super();
		this.setTitle(UI.RENDER_HACKS_ICON, "Objects");

		for (const object of renderer.objects){
			const checkbox = new UI.Checkbox(object.name, object.visible);
			checkbox.onchanged = ()=>{
				object.visible = checkbox.checked;
			};
			this.contents.appendChild(checkbox.elem);
		}
	}
}

class MdkRenderer implements SceneGfx, UI.TextureListHolder {
	viewerTextures: ViewerTexture[] = [];
	textureHolder = this;
	onnewtextures: (() => void) | null = null;

	device: GfxDevice;
	textures: GfxTexture[] = [];
	pointSampler: GfxSampler;
	lookupTexture: GfxSamplerBinding;

	animationController : AnimationController;
	renderHelper : GfxRenderHelper;
	simpleShader : GfxProgram;

	simpleInputLayout : GfxInputLayout; // destroyed by helper

	objects : ObjectRenderer[] = [];

	constructor(device: GfxDevice, context : SceneContext) {
		this.device = device;

		this.animationController = new AnimationController();
		this.renderHelper = new GfxRenderHelper(device, context);

		this.pointSampler = device.createSampler({
			wrapS: GfxWrapMode.Repeat,
			wrapT: GfxWrapMode.Repeat,
			minFilter: GfxTexFilterMode.Point,
			magFilter: GfxTexFilterMode.Point,
			mipFilter: GfxMipFilterMode.Nearest
		});

		this.simpleShader = Shaders.createDebugShader(device);

		this.simpleInputLayout = this.renderHelper.renderCache.createInputLayout({
			indexBufferFormat: GfxFormat.U16_R,
			vertexBufferDescriptors: [{
				byteStride: 12,
				frequency: GfxVertexBufferFrequency.PerVertex,
			}],
			vertexAttributeDescriptors: [{
				location: 0,
				format: GfxFormat.F32_RGB,
				bufferIndex: 0,
				bufferByteOffset: 0
			}]
		});

		const lookupData = new Uint8Array(0x100);
		for (let i = 0; i < 0x100; ++i)
			lookupData[i] = i;
		this.lookupTexture = this.createTexture("ColourLookupTex", 0x100, 1, GfxFormat.U8_R_NORM, lookupData);
	}


	createPanels(): UI.Panel[] {
		return [new ObjectPanel(this)]
	}

	createTexture(name: string, width: number, height: number, pixelFormat: GfxFormat, pixels: Uint8Array): GfxSamplerBinding {
		const gfxTexture = this.device.createTexture({
			dimension: GfxTextureDimension.n2D,
			pixelFormat,
			width,
			height,
			depth: 1,
			numLevels: 1,
			usage: GfxTextureUsage.Sampled
		});
		this.device.setResourceName(gfxTexture, name);
		this.device.uploadTextureData(gfxTexture, 0, [pixels]);
		this.textures.push(gfxTexture);

		return {
			gfxTexture,
			gfxSampler: this.pointSampler,
			lateBinding: null
		};
	}

	createGreyscaleTextureWithPreview(name: string, width: number, height: number, pixels: Uint8Array, palette: Uint8Array): GfxSamplerBinding {
		this.viewerTextures.push(createCanvasTexture(name, width, height, pixels, palette));
		return this.createTexture(name, width, height, GfxFormat.U8_R_NORM, pixels);
	}

	prepareToRender(device : GfxDevice, viewerInput : ViewerRenderInput){
		const renderInstManager = this.renderHelper.renderInstManager;
		
		this.animationController.setTimeFromViewerInput(viewerInput);
		
		//viewerInput.camera.frustum.makeVisualizer();
		
		const template = this.renderHelper.pushTemplateRenderInst();
		template.setGfxProgram(this.simpleShader);
		template.setBindingLayouts([{numUniformBuffers: 2, numSamplers: 0}]);
		template.setMegaStateFlags({
			cullMode:GfxCullMode.Back
		});
		const sceneParamsUniformLocation = 0;
		let offs = template.allocateUniformBuffer(sceneParamsUniformLocation, 16);
		const sceneParamsMapped = template.mapUniformBufferF32(sceneParamsUniformLocation);
		offs += fillMatrix4x4(sceneParamsMapped, offs, viewerInput.camera.clipFromWorldMatrix);

		for (const object of this.objects)
			object.prepareToRender(this, renderInstManager, viewerInput);

		renderInstManager.popTemplateRenderInst();

		this.renderHelper.prepareToRender();
	}
	render(device: GfxDevice, viewerInput: ViewerRenderInput) {
		const renderInstManager = this.renderHelper.renderInstManager;
		const builder = this.renderHelper.renderGraph.newGraphBuilder();

		const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, opaqueBlackFullClearRenderPassDescriptor);
		const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, opaqueBlackFullClearRenderPassDescriptor);

		const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
		const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
		builder.pushPass((pass) => {
			pass.setDebugName('Main');
			pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
			pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
			pass.exec((passRenderer) => {
				executeOnPass(renderInstManager, passRenderer, 0);
			});
		});
		pushAntialiasingPostProcessPass(builder, this.renderHelper, viewerInput, mainColorTargetID);
		builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

		this.prepareToRender(device, viewerInput);
		this.renderHelper.renderGraph.execute(builder);
		renderInstManager.resetRenderInsts();
	}
	destroy(device: GfxDevice) {
		for (const object of this.objects)
			object.destroy(device);
		device.destroyProgram(this.simpleShader);
		for (const tex of this.textures) {
			device.destroyTexture(tex);
		}
		device.destroySampler(this.pointSampler);
		this.renderHelper.destroy();
	}
}

function mergePalettes(base: Uint8Array, target: Uint8Array, offsetBytes: number): Uint8Array {
	const result = new Uint8Array(base);
	result.set(target, offsetBytes);
	return result;
}

class MdkSceneDesc implements SceneDesc {
	constructor(public id: string, public name: string) { }

	async createScene(device: GfxDevice, context: SceneContext): Promise<MdkRenderer> {
		const dataFetcher = context.dataFetcher;

		const path = `mdk/TRAVERSE/${this.id}/${this.id}`;
		//const dtiPromise = dataFetcher.fetchData(path + ".DTI").then(parseDti);
		const mtoPromise = dataFetcher.fetchData(path + "O.MTO").then(parseMto);
		//const mtiPromise = dataFetcher.fetchData(path + "S.MTI").then(parseMti);
		const sniPromise = dataFetcher.fetchData(path + "O.SNI").then(parseSni);

		const renderer = new MdkRenderer(device, context);


		const mto = await mtoPromise;
		for (const arena of mto.arenas){
			renderer.objects.push(new ObjectRenderer(device, arena.bsp));
		}
		const sni = await sniPromise;
		for (const bsp of sni) {
			renderer.objects.push(new ObjectRenderer(device, bsp));
		}
		const unused = [
			"DANT_8",
			"CDANT_8",
			"GUNT_9",
			"CGUNT_8",
			"HMO_7",
			"CHMO_3",
			"CHMO_7",
			"OLYM_9",
			"COLYM_9",
		];
		for (const object of renderer.objects)
			object.visible = !unused.includes(object.name);



		/*
		const materials = new Map<string, { binding: GfxSamplerBinding, width: number, height: number; }>();

		function addTextures(map: Map<string, MtiTexture>, palette: Uint8Array) {
			map.forEach((tex, name) => {
				if (!materials.has(name)) {
					const binding = renderer.createGreyscaleTextureWithPreview(name, tex.width, tex.height, tex.pixels, palette);
					materials.set(name, {
						binding,
						width: tex.width,
						height: tex.height
					});
				}
			});
		}

		const dti = await dtiPromise;
		const mto = await mtoPromise;

		let previewPalette: Uint8Array | null = null;
		const arenaPalettes = new Map<string, GfxSamplerBinding>();
		for (const arena of mto.arenas) {
			const arenaPalette = mergePalettes(dti.levelPalette, arena.palettePart, 4 * 16 * 3);
			if (!previewPalette)
				previewPalette = arenaPalette;

			const arenaPaletteTex = renderer.createTexture(arena.name + " Palette", 0x100, 1, GfxFormat.U8_RGB_NORM, arenaPalette);
			arenaPalettes.set(arena.name, arenaPaletteTex);

			addTextures(arena.materials.textures, arenaPalette);
		}
		const mti = await mtiPromise;
		addTextures(mti.textures, previewPalette!);
		*/

		return renderer;
	}
}

export const sceneGroup: SceneGroup = {
	id: "mdk",
	name: "MDK",
	sceneDescs: [
		new MdkSceneDesc("LEVEL3", "Level 3"),
		new MdkSceneDesc("LEVEL4", "Level 4"),
		new MdkSceneDesc("LEVEL5", "Level 6"),
		new MdkSceneDesc("LEVEL6", "Level 2"),
		new MdkSceneDesc("LEVEL7", "Level 1"),
		new MdkSceneDesc("LEVEL8", "Level 5"),
	]
};
