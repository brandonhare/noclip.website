import ArrayBufferSlice from "../ArrayBufferSlice.js";
import { readString } from "../util.js";

type DtiData = {
	levelPalette : Uint8Array
};
export function parseDti(file : ArrayBufferSlice) : DtiData {
	const data = file.createDataView();

	const palOffset = data.getUint32(20+4*3, true) + 8;
	const levelPalette = file.createTypedArray(Uint8Array, palOffset, 0x300);

	// todo: everything else

	return { levelPalette };
}

type MtoData = MtoArenaData[];
type MtoArenaData = {
	name : string,
	palette : Uint8Array,
	materials: MtiData
};
export function parseMto(file : ArrayBufferSlice) : MtoData{
	const data = file.createDataView();

	const numArenas = data.getUint32(20, true);
	const result : MtoArenaData[] = [];
	for (let i = 0; i < numArenas; ++i){
		const name = readString(file, 24 + i * 12, 8);
		const offset = data.getUint32(32 + i * 12, true) + 4;

		const dataOffset = data.getUint32(offset, true) + offset;
		const palOffset = data.getUint32(offset + 4, true) + offset;
		const bspOffset = data.getUint32(offset + 8, true) + offset;

		// todo: data, bsp

		const palette = file.createTypedArray(Uint8Array, palOffset, 336);
		const materials = parseMti(file.subarray(offset + 12));

		result.push({name, palette, materials});
	}

	return result;
}
export function parseSni(file : ArrayBufferSlice){
	return "sni!"
}
type MtiData = Map<string, MtiMaterial>;
export type MtiMaterial = number | {width : number, height : number, pixels : Uint8Array};
export function parseMti(file : ArrayBufferSlice) : MtiData{
	const data = file.createDataView();

	const numMaterials = data.getUint32(20, true);
	let offset = 24;
	const materials = new Map<string, MtiMaterial>();
	for (let i = 0; i < numMaterials; ++i){
		const name = readString(file, offset, 8);
		const a = data.getInt32(offset + 8, true);
		if (a === -1) {
			const palIndex = data.getInt32(offset + 12, true);
			materials.set(name, palIndex);
		} else {
			const b = data.getFloat32(offset + 12, true);
			const c = data.getFloat32(offset + 16, true);
			let imgOffset = data.getUint32(offset + 20, true) + 4;

			if (a & 0x30000) {
				imgOffset += 4;
				// todo ignored value here
			}
			const width = data.getUint16(imgOffset, true);
			const height = data.getUint16(imgOffset + 2, true);
			const pixels = file.createTypedArray(Uint8Array, imgOffset + 4, width * height);

			// todo a, b, c

			materials.set(name, {width, height, pixels});
		}
		offset += 24;
	}

	return materials
}
