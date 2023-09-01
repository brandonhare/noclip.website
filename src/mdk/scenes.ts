import * as DebugJunk from "../DebugJunk.js";
import { mat4, vec3 } from "gl-matrix";
import AnimationController from "../AnimationController.js";
import ArrayBufferSlice from "../ArrayBufferSlice.js";
import { AABB } from "../Geometry.js";
import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase.js";
import { makeBackbufferDescSimple, opaqueBlackFullClearRenderPassDescriptor, pushAntialiasingPostProcessPass } from "../gfx/helpers/RenderGraphHelpers.js";
import { convertToCanvas } from "../gfx/helpers/TextureConversionHelpers.js";
import { fillMatrix4x3, fillMatrix4x4 } from "../gfx/helpers/UniformBufferHelpers.js";
import { GfxBindingLayoutDescriptor, GfxBuffer, GfxBufferFrequencyHint, GfxBufferUsage, GfxCullMode, GfxDevice, GfxFormat, GfxIndexBufferDescriptor, GfxInputLayout, GfxMipFilterMode, GfxProgram, GfxSampler, GfxSamplerBinding, GfxTexFilterMode, GfxTexture, GfxTextureDimension, GfxTextureUsage, GfxVertexBufferDescriptor, GfxVertexBufferFrequency, GfxWrapMode } from "../gfx/platform/GfxPlatform.js";
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph.js";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper.js";
import { GfxRenderInstManager, executeOnPass } from "../gfx/render/GfxRenderInstManager.js";
import * as UI from "../ui.js";
import { assert, assertExists } from "../util.js";
import * as Viewer from "../viewer.js";
import { MtiData, MtiTexture, RawMesh, parseDti, parseMti, parseMto, parseSni } from "./data.js";
import * as Shaders from "./shaders.js";

type SizedTextureBinding = GfxSamplerBinding & { width: number, height: number; };
type ObjectMaterial = {
	shader: GfxProgram,
	textures: SizedTextureBinding[];
	bindingLayouts: GfxBindingLayoutDescriptor[];
};

type ObjectPrimitive = {
	material: ObjectMaterial;
	numIndices: number;
	inputLayout: GfxInputLayout,
	vertexBuffers: GfxVertexBufferDescriptor[];
	indexBuffer: GfxIndexBufferDescriptor;
};
type ObjectPart = {
	name: string;
	origin: vec3;
	bbox: AABB;
	primitives: ObjectPrimitive[];
};
class ObjectRenderer {
	name: string;
	bbox: AABB;
	parts: ObjectPart[];
	vertexBuffer: GfxBuffer;
	indexBuffer: GfxBuffer;

	constructor(renderer: MdkRenderer, device: GfxDevice, mesh: RawMesh, materialCache: MaterialCreator) {
		this.name = mesh.name;
		this.bbox = mesh.bbox;

		let numVertWords = 0;
		let numUvWords = 0;
		let numIndices = 0;

		for (const part of mesh.parts) {
			for (const prim of part.primitives) {
				numVertWords += prim.positions.length;
				numUvWords += prim.uvs.length;
				numIndices += prim.indices.length;
			}
		}

		const vertexBuffer = device.createBuffer(numVertWords + numUvWords, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static);
		const indexBuffer = device.createBuffer(Math.ceil(numIndices / 2), GfxBufferUsage.Index, GfxBufferFrequencyHint.Static);
		let vertexBufferByteOffset = 0;
		let indexBufferByteOffset = 0;

		this.vertexBuffer = vertexBuffer;
		this.indexBuffer = indexBuffer;

		this.parts = mesh.parts.map(part => {
			return {
				name: part.name,
				origin: part.origin,
				bbox: part.bbox,
				primitives: part.primitives.map(prim => {
					const material = materialCache.getMaterial(prim.material);

					if (!prim.uvsAdjusted) {
						if (material.textures.length !== 0) {
							const uScale = 1 / material.textures[0].width;
							const vScale = 1 / material.textures[0].height;
							for (let i = 0; i < prim.uvs.length; i += 2) {
								prim.uvs[i] *= uScale;
								prim.uvs[i + 1] *= vScale;
							}
						}
						prim.uvsAdjusted = true;
					}

					const positionBufferStart = vertexBufferByteOffset;
					const uvBufferStart = positionBufferStart + prim.positions.byteLength;
					const indexBufferStart = indexBufferByteOffset;

					device.uploadBufferData(vertexBuffer, positionBufferStart, new Uint8Array(prim.positions.buffer));
					device.uploadBufferData(vertexBuffer, uvBufferStart, new Uint8Array(prim.uvs.buffer));
					device.uploadBufferData(indexBuffer, indexBufferStart, new Uint8Array(prim.indices.buffer));

					vertexBufferByteOffset = uvBufferStart + prim.uvs.byteLength;
					indexBufferByteOffset = indexBufferStart + prim.indices.byteLength;

					return {
						material,
						numIndices: prim.indices.length,
						inputLayout: renderer.inputLayout_PosUv,
						vertexBuffers: [{
							buffer: vertexBuffer,
							byteOffset: positionBufferStart
						}, {
							buffer: vertexBuffer,
							byteOffset: uvBufferStart
						}],
						indexBuffer: {
							buffer: indexBuffer,
							byteOffset: indexBufferStart
						}
					};
				})
			};
		});
	}

	prepareToRender(renderer: MdkRenderer, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput) {

		//if (!this.visible || !viewerInput.camera.frustum.contains(this.aabb))
		//	return;

		//const debugCanvas = DebugJunk.getDebugOverlayCanvas2D();
		//DebugJunk.drawWorldSpaceAABB(debugCanvas, viewerInput.camera.clipFromWorldMatrix, this.aabb);

		for (const part of this.parts) {
			for (const prim of part.primitives) {

				const inst = renderInstManager.newRenderInst();

				let off = inst.allocateUniformBuffer(1, 12);

				off += fillMatrix4x3(inst.mapUniformBufferF32(1), off, mat4.fromXRotation(mat4.create(), Math.PI * -0.5));

				const material = prim.material;

				inst.setGfxProgram(material.shader);
				inst.setSamplerBindingsFromTextureMappings(material.textures);
				inst.setBindingLayouts(material.bindingLayouts);

				assert(material.textures.length === material.bindingLayouts[0].numSamplers);

				inst.setVertexInput(prim.inputLayout, prim.vertexBuffers, prim.indexBuffer);
				inst.drawIndexes(prim.numIndices);

				renderInstManager.submitRenderInst(inst);

			}
		}
	}

	destroy(device: GfxDevice) {
		device.destroyBuffer(this.indexBuffer);
		device.destroyBuffer(this.vertexBuffer);
	}
}

/*
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
*/

class MdkRenderer implements Viewer.SceneGfx, UI.TextureListHolder {
	viewerTextures: Viewer.Texture[] = [];
	textureHolder = this;
	onnewtextures: (() => void) | null = null;

	device: GfxDevice;
	animationController: AnimationController;
	renderHelper: GfxRenderHelper;

	textures: GfxTexture[] = [];
	sampler_Nearest: GfxSampler;
	sampler_Bilinear: GfxSampler;
	inputLayout_PosUv: GfxInputLayout;
	shader_Debug: GfxProgram;
	shader_SolidColour: GfxProgram;
	shader_Textured: GfxProgram;

	objects: ObjectRenderer[] = [];

	constructor(device: GfxDevice, context: SceneContext) {
		this.device = device;

		this.animationController = new AnimationController();
		this.renderHelper = new GfxRenderHelper(device, context);

		this.sampler_Nearest = device.createSampler({
			wrapS: GfxWrapMode.Repeat,
			wrapT: GfxWrapMode.Repeat,
			minFilter: GfxTexFilterMode.Point,
			magFilter: GfxTexFilterMode.Point,
			mipFilter: GfxMipFilterMode.Nearest,
		});
		this.sampler_Bilinear = device.createSampler({
			wrapS: GfxWrapMode.Repeat,
			wrapT: GfxWrapMode.Repeat,
			minFilter: GfxTexFilterMode.Bilinear,
			magFilter: GfxTexFilterMode.Bilinear,
			mipFilter: GfxMipFilterMode.Linear,
		});

		this.shader_Debug = Shaders.createDebugShader(device);
		this.shader_SolidColour = Shaders.createSolidColourShader(device);
		this.shader_Textured = Shaders.createTexturedShader(device);

		this.inputLayout_PosUv = device.createInputLayout({
			indexBufferFormat: GfxFormat.U16_R,
			vertexBufferDescriptors: [{
				byteStride: 12,
				frequency: GfxVertexBufferFrequency.PerVertex,
			}, {
				byteStride: 8,
				frequency: GfxVertexBufferFrequency.PerVertex,
			}],
			vertexAttributeDescriptors: [{
				location: 0,
				format: GfxFormat.F32_RGB,
				bufferIndex: 0,
				bufferByteOffset: 0
			}, {
				location: 1,
				format: GfxFormat.F32_RG,
				bufferIndex: 1,
				bufferByteOffset: 0
			}]
		});
	}

	/*
	createPanels(): UI.Panel[] {
		return [new ObjectPanel(this)]
	}
	*/

	createTexture(name: string, width: number, height: number, pixelFormat: GfxFormat, pixels: Uint8Array, filtered: boolean, createPreview: boolean): SizedTextureBinding {

		assert(pixelFormat === GfxFormat.U8_RGBA_NORM || pixelFormat === GfxFormat.U8_RGB_NORM, "invalid texture pixel format");

		const gfxTexture = this.device.createTexture({
			dimension: GfxTextureDimension.n2D,
			pixelFormat,
			width,
			height,
			depth: 1,
			numLevels: 1,
			usage: GfxTextureUsage.Sampled
		});
		//this.device.setResourceName(gfxTexture, name);
		this.device.uploadTextureData(gfxTexture, 0, [pixels]);
		this.textures.push(gfxTexture);

		if (createPreview) {
			this.viewerTextures.push({ name, surfaces: [convertToCanvas(new ArrayBufferSlice(pixels.buffer), width, height)] });
		}

		return {
			gfxTexture,
			gfxSampler: filtered ? this.sampler_Bilinear : this.sampler_Nearest,
			lateBinding: null,
			width, height,
		};
	}

	prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
		const renderInstManager = this.renderHelper.renderInstManager;

		this.animationController.setTimeFromViewerInput(viewerInput);

		//viewerInput.camera.frustum.makeVisualizer();

		const template = this.renderHelper.pushTemplateRenderInst();
		//template.setGfxProgram(this.simpleShader);
		template.setBindingLayouts([{ numUniformBuffers: 2, numSamplers: 0 }]);
		template.setMegaStateFlags({
			cullMode: GfxCullMode.Front
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
	render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
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
		device.destroyProgram(this.shader_Debug);
		device.destroyProgram(this.shader_SolidColour);
		device.destroyProgram(this.shader_Textured);
		device.destroyInputLayout(this.inputLayout_PosUv);
		for (const tex of this.textures) {
			device.destroyTexture(tex);
		}
		device.destroySampler(this.sampler_Nearest);
		device.destroySampler(this.sampler_Bilinear);
		this.renderHelper.destroy();
	}
}

class MaterialCreator {
	renderer: MdkRenderer;
	materials = new Map<string, MtiTexture & { material: ObjectMaterial | null; }>();
	strangeMaterialDefs = new Map<string, number>();
	levelPalette: Uint8Array;
	arenaPalette: Uint8Array;
	arenaName: string = "";
	solidColourMaterial: ObjectMaterial | null = null;

	debugMaterial: ObjectMaterial;
	bindingLayout_2_1: GfxBindingLayoutDescriptor[] = [{
		numUniformBuffers: 2,
		numSamplers: 1,
	}];

	constructor(renderer: MdkRenderer, sharedMaterials: MtiData, levelMaterials: MtiData, levelPalette: Uint8Array) {
		this.renderer = renderer;
		this.renderer = renderer;
		this.levelPalette = levelPalette;

		sharedMaterials.textures.forEach((tex, name) => this.materials.set(name, { ...tex, material: null }));
		sharedMaterials.others.forEach((num, name) => this.strangeMaterialDefs.set(name, num));

		levelMaterials.textures.forEach((tex, name) => this.materials.set(name, { ...tex, material: null }));
		levelMaterials.others.forEach((num, name) => this.strangeMaterialDefs.set(name, num));

		this.arenaPalette = new Uint8Array(0x300);

		this.debugMaterial = {
			shader: renderer.shader_Debug,
			bindingLayouts: [{ numUniformBuffers: 2, numSamplers: 0 }],
			textures: []
		};
	}

	setArena(arenaName: string, arenaMaterials: MtiData, arenaPalette: Uint8Array) {
		this.arenaName = arenaName;
		this.arenaPalette.set(this.levelPalette);
		this.arenaPalette.set(arenaPalette, 4 * 16 * 3);
		this.solidColourMaterial = null;

		arenaMaterials.textures.forEach((tex, name) => this.materials.set(name, { ...tex, material: null }));
		arenaMaterials.others.forEach((num, name) => this.strangeMaterialDefs.set(name, num));
	}

	getMaterial(name: string | number): ObjectMaterial {
		if (name === 0x10000) { // solid colour todo better identifier
			if (!this.solidColourMaterial) {
				this.solidColourMaterial = {
					shader: this.renderer.shader_SolidColour,
					bindingLayouts: this.bindingLayout_2_1,
					textures: [this.renderer.createTexture(this.arenaName, 0x100, 1, GfxFormat.U8_RGB_NORM, this.arenaPalette, false, false)]
				};
				this.solidColourMaterial.textures[0].width = 1;
			}
			return this.solidColourMaterial;
		} else if (typeof (name) !== "string") { // unknown
			return this.debugMaterial;
		} else { // textured
			const result = this.materials.get(name);
			if (!result) {
				console.log("failed to find material", name, "on arena", this.arenaName);
				return this.debugMaterial;
			}
			if (!result.material) {
				const textureData = new Uint8Array(4 * result.width * result.height);
				const palette = this.arenaPalette;
				for (let i = 1; i < result.pixels.length; ++i) {
					const p = result.pixels[i] * 3;
					textureData[i * 4] = palette[p];
					textureData[i * 4 + 1] = palette[p + 1];
					textureData[i * 4 + 2] = palette[p + 2];
					textureData[i * 4 + 3] = 0xFF;
				}
				result.material = {
					bindingLayouts: this.bindingLayout_2_1,
					shader: this.renderer.shader_Textured,
					textures: [this.renderer.createTexture(name, result.width, result.height, GfxFormat.U8_RGBA_NORM, textureData, true, true)]
				};
			}
			return result.material;
		}
	}
}

class MdkSceneDesc implements SceneDesc {
	constructor(public id: string, public name: string) { }

	async createScene(device: GfxDevice, context: SceneContext): Promise<MdkRenderer> {
		const dataFetcher = context.dataFetcher;

		const path = `mdk/TRAVERSE/${this.id}/${this.id}`;
		const dtiPromise = dataFetcher.fetchData(path + ".DTI").then(parseDti);
		const mtiPromise = dataFetcher.fetchData(path + "S.MTI").then(parseMti);
		const mtoPromise = dataFetcher.fetchData(path + "O.MTO").then(parseMto);
		const sniPromise = dataFetcher.fetchData(path + "O.SNI").then(parseSni);

		const dti = await dtiPromise;
		const mti = await mtiPromise;
		const mto = await mtoPromise;
		const sni = await sniPromise;

		const renderer = new MdkRenderer(device, context);
		const materialCreator = new MaterialCreator(renderer, mti, mto.materials, dti.levelPalette);

		const unused = [
			"DANT_8",
			"GUNT_9",
			"HMO_7",
			"OLYM_9",
		];

		for (const arena of mto.arenas) {
			if (unused.includes(arena.name))
				continue;
			materialCreator.setArena(arena.name, arena.materials, arena.palettePart);
			renderer.objects.push(new ObjectRenderer(renderer, device, arena.bsp, materialCreator));

			const targetName = "C" + arena.name;
			for (const sniMesh of sni) {
				if (sniMesh.name === targetName) {
					renderer.objects.push(new ObjectRenderer(renderer, device, sniMesh, materialCreator));
					break;
				}
			}
		}

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
