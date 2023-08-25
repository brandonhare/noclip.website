import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase.js";
import { GfxDevice, GfxFormat, GfxMipFilterMode, GfxSampler, GfxSamplerBinding, GfxTexFilterMode, GfxTexture, GfxTextureDimension, GfxTextureUsage, GfxWrapMode } from "../gfx/platform/GfxPlatform.js";
import { TextureListHolder } from "../ui";
import { SceneGfx, ViewerRenderInput, Texture as ViewerTexture } from "../viewer.js";
import { MtiTexture, parseDti, parseMti, parseMto, parseSni } from "./data.js";


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


class MdkRenderer implements SceneGfx, TextureListHolder {
	viewerTextures: ViewerTexture[] = [];
	textureHolder = this;
	onnewtextures: (() => void) | null = null;

	device: GfxDevice;
	textures: GfxTexture[] = [];
	pointSampler: GfxSampler;
	lookupTexture: GfxSamplerBinding;

	constructor(device: GfxDevice) {
		this.device = device;

		this.pointSampler = device.createSampler({
			wrapS: GfxWrapMode.Repeat,
			wrapT: GfxWrapMode.Repeat,
			minFilter: GfxTexFilterMode.Point,
			magFilter: GfxTexFilterMode.Point,
			mipFilter: GfxMipFilterMode.Nearest
		});

		const lookupData = new Uint8Array(0x100);
		for (let i = 0; i < 0x100; ++i)
			lookupData[i] = i;
		this.lookupTexture = this.createTexture("ColourLookupTex", 0x100, 1, GfxFormat.U8_R_NORM, lookupData);
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

	render(device: GfxDevice, renderInput: ViewerRenderInput) { }
	destroy(device: GfxDevice) {
		for (const tex of this.textures) {
			device.destroyTexture(tex);
		}
		device.destroySampler(this.pointSampler);
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
		const dtiPromise = dataFetcher.fetchData(path + ".DTI").then(parseDti);
		const mtoPromise = dataFetcher.fetchData(path + "O.MTO").then(parseMto);
		const mtiPromise = dataFetcher.fetchData(path + "S.MTI").then(parseMti);
		const sniPromise = dataFetcher.fetchData(path + "O.SNI").then(parseSni);

		const renderer = new MdkRenderer(device);
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
		mto.arenas.forEach((arena, arenaName) => {
			const arenaPalette = mergePalettes(dti.levelPalette, arena.palettePart, 4 * 16 * 3);
			if (!previewPalette)
				previewPalette = arenaPalette;

			const arenaPaletteTex = renderer.createTexture(arenaName + " Palette", 0x100, 1, GfxFormat.U8_RGB_NORM, arenaPalette);
			arenaPalettes.set(arenaName, arenaPaletteTex);

			addTextures(arena.materials.textures, arenaPalette);
		});
		const mti = await mtiPromise;
		addTextures(mti.textures, previewPalette!);

		return renderer;
	}
}

export const sceneGroup: SceneGroup = {
	id: "mdk",
	name: "MDK",
	sceneDescs: [
		new MdkSceneDesc("LEVEL3", "Level 3"),
		new MdkSceneDesc("LEVEL4", "Level 4"),
		new MdkSceneDesc("LEVEL5", "Level 5"),
		new MdkSceneDesc("LEVEL6", "Level 6"),
		new MdkSceneDesc("LEVEL7", "Level 7"),
		new MdkSceneDesc("LEVEL8", "Level 8"),
	]
};
