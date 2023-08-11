import { mat4 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { CameraController } from "../Camera";
import { NamedArrayBufferSlice } from "../DataFetcher";
import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase";
import { GfxDevice } from "../gfx/platform/GfxPlatform";
import { TextureListHolder, Panel } from "../ui";
import { assert, readString } from "../util.js";
import { SceneGfx, Texture, ViewerRenderInput } from "../viewer";

const files = {
	FALL3D : ["FALL3D_1.MTI", "FALL3D_2.MTI", "FALL3D_3.MTI", "FALL3D_4.MTI", "FALL3D_5.MTI", "FALL3D.BNI", /*"FALL3D.SNI"*/],
	MISC:["OPTIONS.BNI",/*"MDKSOUND.SNI",*/"STATS.BNI","STATS.MTI"],
	STREAM:["STREAM.BNI", "STREAM.MTI"],
	TRAVERSE:["LEVEL3.CMI","LEVEL3.DTI","LEVEL3O.MTO",/*"LEVEL3O.SNI",*/"LEVEL3S.MTI",/*"LEVEL3S.SNI"*/],
}
const files2 = {FALL3D:["FALL3D_1.MTI"]};

interface Image {
	width : number;
	height : number;
	data : ArrayBufferSlice;
}

function parseBni(filename : string, data : ArrayBufferSlice){
	//return {filename};
}
function parseCmd(filename : string, assetName : string, data : ArrayBufferSlice){
	assert(assetName.endsWith(".CMD"));
	//return {filename};
}
function parseDat(filename : string, assetName : string, data : ArrayBufferSlice){
	assert(assetName.endsWith(".DAT"));
	//return {filename};
}
function parseMti(filename : string, assetName : string, data : ArrayBufferSlice, view : DataView){
	assert(assetName.endsWith(".MAT"));
	const numThings = view.getUint32(20, true);
	const result : any = {assetName};
	for (let i = 0; i < numThings; ++i){
		const name = readString(data, i * 24 + 24, 8);
		assert(/^\w+$/.test(name), "invalid name");

		const thing1 = view.getInt32(i * 24 + 32, true);

		if (thing1 === -1){
			const thing2 = view.getInt32(i * 24 + 36, true);
			//const thing3 = view.getUint32(i * 24 + 40, true);
			//const thing4 = view.getUint32(i * 24 + 44, true);
			//assert(thing3 === 0 && thing4 === 0);
			result[name] = thing2;
			continue;
		}

		const thing2 = view.getFloat32(i * 24 + 36, true);
		const thing3 = view.getFloat32(i * 24 + 40, true);
		const thing4 = view.getUint32(i * 24 + 44, true) + 4;

		const img : Image ={width : 0, height: 0, data}
		if ((thing1 & 0x30000) === 0){
			img.width = view.getUint16(thing4, true);
			img.height = view.getUint16(thing4 + 2, true);
			img.data = data.subarray(thing4 + 4, img.width * img.height);
			result[name] = {img, thing1, thing2, thing3};
		} else {
			const a = view.getUint16(thing4, true);
			const b = view.getUint16(thing4 + 2, true);
			img.width = view.getUint16(thing4 + 4, true);
			img.height = view.getUint16(thing4 + 6, true);
			img.data = data.subarray(thing4 + 8, img.width * img.height);
			result[name] = {img, thing1, thing2, thing3, a, b};
		}

	}
	return result;
}
function parseMto(filename : string, assetName : string, data : ArrayBufferSlice, view : DataView){
	return;
	assert(assetName.endsWith(".MAT"));
	const numThings = view.getUint32(20, true);
	const result : any = {assetName};
	for (let i = 0; i < numThings; ++i){
		const name = readString(data, 24 + i * 12, 8);
		assert(/^\w+$/.test(name), "invalid name: " + name);
		const startOffset = view.getUint32(24 + i * 12 + 8, true);
		const endOffset = (i + 1 === numThings) ? (data.byteLength - 12) : view.getUint32(24 + (i + 1) * 12 + 8, true);
		result[name] = data.subarray(startOffset, endOffset - startOffset);
	}
	return result;
}

function parseThing(filename : string, data : ArrayBufferSlice){
	if (filename.endsWith(".BNI"))
		return parseBni(filename, data);

	const view = data.createDataView();
	const filesize = view.getUint32(0, true);
	assert(filesize + 4 === data.byteLength);
	const assetName = readString(data, 4, 12);
	const fs2 = view.getUint32(16, true);
	assert(filesize === fs2 + 8);
	
	if (filename.endsWith(".CMI"))
		return parseCmd(filename, assetName, data);
	else if (filename.endsWith(".MTI"))
		return parseMti(filename, assetName, data, view);
	else if (filename.endsWith(".MTO"))
		return parseMto(filename, assetName, data, view);
	else if (filename.endsWith(".DTI"))
		return parseDat(filename, assetName, data);
	else
		assert(false, "unknown type: " + filename);
}

function createTexture(assetSetName : string, assetName : string, asset: any) : Texture {

	const img = asset.img as Image;

	const pixels = img.data.createTypedArray(Uint8Array);

	const canvas = document.createElement("canvas");
	canvas.width = img.width;
	canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    const imgData = ctx.createImageData(canvas.width, canvas.height);
	for (let i = 0; i < pixels.byteLength; ++i){
		imgData.data[i*4] = imgData.data[i*4+1] = imgData.data[i*4+2] = pixels[i];
		imgData.data[i*4+3] = 255;
	}
	ctx.putImageData(imgData, 0, 0);

	return {
		name : assetSetName + "/" + assetName,
		surfaces: [canvas],
		extraInfo: new Map(
			Object.keys(asset).map(key=>[key,asset[key]] as [string,string])
			.filter(([_,value])=>typeof(value) !== "object")
		)
	};
}

class MdkRenderer implements SceneGfx, TextureListHolder {
	textureHolder = this;
	constructor(public assets : any){
		for (const assetSetName in assets){
			const assetSet = assets[assetSetName];
			for (const assetName in assetSet){
				const asset = assetSet[assetName];
				if (typeof(asset) !== "object" || asset.img === undefined)
					continue;
				this.viewerTextures.push(createTexture(assetSetName, assetName, asset));
			}
		}
	}
	viewerTextures: Texture[] = [];
	onnewtextures = null;
	
	render(device: GfxDevice, renderInput: ViewerRenderInput) {}
	destroy(device: GfxDevice) {}
}

class MdkSceneDesc implements SceneDesc {
	constructor(public id : string, public name : string){}

	async createScene(device: GfxDevice, context: SceneContext): Promise<SceneGfx> {
		const f = context.dataFetcher;

		const promises : Promise<any>[] = [];
		const result : any = {};

		function loadThings(name: string, names:string[]){
			const newPromises = names.map(thing=>f.fetchData(`MDK/${name}/${thing}`).then((data)=>{
				const parsed = parseThing(name+"/"+thing, data);
				if (parsed){
					result[parsed.assetName ?? parsed.filename ?? parsed.name ?? thing] = parsed;
				}
			}));
			promises.push(...newPromises);
		}
		for (const name of Object.keys(files)){
			const names = files[name as keyof typeof files];
			if (name === "TRAVERSE") {
				for (let i = 3; i <= 8; ++i){
					loadThings(name, names.map(name=>`LEVEL${i}/` + name.replace(/3/g, i.toString())));
				}
			} else {
				loadThings(name, names);
			}
		}

		await Promise.all(promises);

		return new MdkRenderer(result);
	}
}

export const sceneGroup: SceneGroup = {
	id: "mdk",
	name: "MDK",
	sceneDescs: [
		new MdkSceneDesc("mdk", "MDK"),
	]
};

