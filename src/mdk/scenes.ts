import { mat4 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { CameraController } from "../Camera";
import { NamedArrayBufferSlice } from "../DataFetcher";
import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase";
import { GfxDevice } from "../gfx/platform/GfxPlatform";
import { TextureListHolder, Panel } from "../ui";
import { assert, readString } from "../util.js";
import { SceneGfx, Texture, ViewerRenderInput } from "../viewer";
import { MtiMaterial, parseDti, parseMti, parseMto, parseSni } from "./data.js";

const pathBase = "mdk";

class MdkRenderer implements SceneGfx, TextureListHolder {
	textureHolder = this;
	onnewtextures = null;
	
	constructor(public viewerTextures: Texture[]){}
	
	
	render(device: GfxDevice, renderInput: ViewerRenderInput) {}
	destroy(device: GfxDevice) {}
}

class MdkSceneDesc implements SceneDesc {
	constructor(public id : string, public name : string){}

	async createScene(device: GfxDevice, context: SceneContext): Promise<SceneGfx> {
		const dataFetcher = context.dataFetcher;


		const path = `${pathBase}/TRAVERSE/${this.id}/${this.id}`;
		const dtiPromise = dataFetcher.fetchData(path + ".DTI").then(parseDti);
		const mtoPromise = dataFetcher.fetchData(path + "O.MTO").then(parseMto);
		const sniPromise = "sni"// dataFetcher.fetchData(path + "O.SNI").then(parseSni);
		const mtiPromise = dataFetcher.fetchData(path + "S.MTI").then(parseMti);

		const mats : Texture[] = [];

		function createMat(name : string, mat : MtiMaterial, pal : Uint8Array, arenaName?: string){
			if (typeof(mat) === "number") return;

			const canvas = document.createElement("canvas");
			const width = mat.width;
			const height = mat.height;
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d")!;
			const imgData = ctx.getImageData(0, 0, width, height);
			const src = mat.pixels;
			const dest = imgData.data;
			for (let i = 0; i < width*height; ++i){
				const p = src[i]*3;
				dest[i*4] = pal[p];
				dest[i*4+1] = pal[p+1];
				dest[i*4+2] = pal[p+2];
				dest[i*4+3] = (p === 0) ? 0 : 255;
			}
			ctx.putImageData(imgData, 0, 0);
			const result : Texture = {name, surfaces:[canvas]};
			if (arenaName){
				result.extraInfo = new Map();
				result.extraInfo.set("Arena index", arenaName);
			}
			mats.push(result);
		}

		const levelPalette = (await dtiPromise).levelPalette;
		let firstArenaPalette : Uint8Array|null = null;
		for (const arena of await mtoPromise){
			const arenaPalette = new Uint8Array(0x300);
			arenaPalette.set(levelPalette);
			arenaPalette.set(arena.palette, 4*16*3);
			if (!firstArenaPalette)
				firstArenaPalette = arenaPalette;
			arena.materials.forEach((mat, name)=>createMat(name, mat, arenaPalette, arena.name));
		}
		(await mtiPromise).forEach((mat, name)=> createMat(name, mat, firstArenaPalette!));

		return new MdkRenderer(mats);
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

