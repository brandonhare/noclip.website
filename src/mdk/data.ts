import { vec3 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice.js";
import { AABB } from "../Geometry.js";
import { align, assert, readString } from "../util.js";

type DtiData = {
	levelPalette: Uint8Array,
};
export function parseDti(file: ArrayBufferSlice): DtiData {
	const data = file.createDataView();

	const palOffset = data.getUint32(20 + 4 * 3, true) + 8;
	const levelPalette = file.createTypedArray(Uint8Array, palOffset, 0x300);

	// todo: everything else

	return { levelPalette };
}

type MtoData = {
	arenas: MtoArenaData[],
	materials: MtiData, // union of all arena materials
};
type MtoArenaData = {
	name: string,
	palettePart: Uint8Array, // 16x7 pixels
	bsp: BspData,
	meshes: RawMesh[],
	materials: MtiData,
};
export function parseMto(file: ArrayBufferSlice): MtoData {
	const data = file.createDataView();

	const numArenas = data.getUint32(20, true);
	const arenas = new Array<MtoArenaData>(numArenas);

	const allMaterials: MtiData = {
		textures: new Map(),
		others: new Map()
	};

	for (let i = 0; i < numArenas; ++i) {
		const arenaName = readString(file, 24 + i * 12, 8);
		const arenaOffset = data.getUint32(32 + i * 12, true) + 4;

		const dataOffset = data.getUint32(arenaOffset, true) + arenaOffset + 4;
		const palOffset = data.getUint32(arenaOffset + 4, true) + arenaOffset;
		const bspOffset = data.getUint32(arenaOffset + 8, true) + arenaOffset;

		const arenaMaterials = parseMti(file.subarray(arenaOffset + 12));
		mergeMtiData(allMaterials, arenaMaterials);

		const numAnimations = data.getUint32(dataOffset, true);
		const numMeshes = data.getUint32(dataOffset + 4, true);
		//const numSounds = data.getUint32(dataOffset + 8, true);

		const meshes = new Array(numMeshes);
		const meshIndexOffset = dataOffset + 12 + numAnimations * 12;
		for (let meshIndex = 0; meshIndex < numMeshes; ++meshIndex) {
			const meshName = readString(file, meshIndexOffset + meshIndex * 12, 8);
			const meshOffset = data.getUint32(meshIndexOffset + meshIndex * 12 + 8, true);
			const isMeshGroup = data.getUint32(dataOffset + meshOffset, true) !== 0;
			meshes[meshIndex] = parseMesh(meshName, file.slice(dataOffset + meshOffset + 4), isMeshGroup);
		}


		const palettePart = file.createTypedArray(Uint8Array, palOffset, 7 * 16 * 3);
		const bsp = parseBsp(arenaName, file.subarray(bspOffset));

		arenas[i] = { name: arenaName, palettePart, bsp, meshes, materials: arenaMaterials };
	}

	return { arenas, materials: allMaterials };
}


export type RawMesh = {
	name: string,
	materials: string[],
	parts: RawMeshPart[],
	bbox: AABB,
};
export type RawMeshPart = {
	name: string,
	origin: vec3,
	bbox: AABB,

	verts: Float32Array,

	// per-triangle properties
	indices: Uint16Array,
	uvs: Float32Array;
	materialIndices: Int16Array,
	flags: Int32Array; // todo what are these
};

function readAABB(data: DataView, offset: number): AABB {
	// swizzle yz
	return new AABB(
		-data.getFloat32(offset, true), // min x
		data.getFloat32(offset + 16, true), // min z
		data.getFloat32(offset + 8, true), // min y
		-data.getFloat32(offset + 4, true), // max x
		data.getFloat32(offset + 20, true), // max z
		data.getFloat32(offset + 12, true), // max y
	);
}

function calculateAABB(points: ArrayLike<number>, numPoints: number): AABB {
	const range = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	for (let i = 0; i < numPoints * 3; i += 3) {
		for (let j = 0; j < 3; ++j) {
			const n = points[i + j];
			range[j] = Math.min(range[j], n);
			range[j + 3] = Math.max(range[j + 3], n);
		}
	}
	return new AABB(range[0], range[1], range[2], range[3], range[4], range[5]);
}

function readVerts(file: ArrayBufferSlice, offset: number, numVerts: number): Float32Array {
	const src = file.createTypedArray(Float32Array, offset, numVerts * 3);
	const result = new Float32Array(numVerts * 3);
	for (let i = 0; i < numVerts * 3; i += 3) {
		result[i] = -src[i];
		result[i + 1] = src[i + 2]; // swizzle yz
		result[i + 2] = src[i + 1];
	}
	return result;
}

function parseMesh(name: string, file: ArrayBufferSlice, isMeshGroup: boolean): RawMesh {
	const data = file.createDataView();

	const numMaterials = data.getUint32(0, true);
	const materials = new Array<string>(numMaterials);
	let offset = 4;
	for (let i = 0; i < numMaterials; ++i) {
		materials[i] = readString(file, offset, 16);
		offset += 16;
	}

	const numParts = isMeshGroup ? data.getUint32(offset, true) : 1;
	const parts = new Array<RawMeshPart>(numParts);
	if (isMeshGroup) {
		assert(numParts < 1000);
		offset += 4;
	}

	for (let meshIndex = 0; meshIndex < numParts; ++meshIndex) {
		let name = "";
		const origin: vec3 = [0, 0, 0];
		if (isMeshGroup) {
			name = readString(file, offset, 12);
			origin[0] = data.getFloat32(offset + 12, true);
			origin[1] = data.getFloat32(offset + 20, true); // swizzle yz
			origin[2] = data.getFloat32(offset + 16, true);
			offset += 24;
		}

		const numVerts = data.getUint32(offset, true);
		const verts = readVerts(file, offset + 4, numVerts);
		offset += 4 + numVerts * 12;

		const numTris = data.getUint32(offset, true);
		offset += 4;

		const indices = new Uint16Array(numTris * 3);
		const uvs = new Float32Array(numTris * 6);
		const materialIndices = new Int16Array(numTris);
		const flags = new Int32Array(numTris);
		for (let triIndex = 0; triIndex < numTris; ++triIndex) {
			for (let j = 0; j < 3; ++j)
				indices[triIndex * 3 + j] = data.getUint16(offset + j * 2, true);
			materialIndices[triIndex] = data.getUint16(offset + 6, true);
			offset += 8;
			for (let j = 0; j < 6; ++j)
				uvs[triIndex * 6 + j] = data.getFloat32(offset + j * 4, true);
			flags[triIndex] = data.getInt32(offset + 24, true);
			offset += 28;
		}

		const bbox = readAABB(data, offset);
		offset += 24;

		// adjust to origin
		if (origin[0] || origin[1] || origin[2]) {
			for (let i = 0; i < numVerts * 3; i += 3) {
				verts[i] -= origin[0];
				verts[i + 1] -= origin[1];
				verts[i + 2] -= origin[2];
			}
		}

		parts[meshIndex] = { name, origin, verts, indices, uvs, materialIndices, flags, bbox };
	}

	const bbox = isMeshGroup ? readAABB(data, offset) : parts[0].bbox;

	if (isMeshGroup)
		offset += 24;

	// todo extra trailing data

	return { name, materials, parts, bbox };
}

type BspData = RawMesh;
function parseBsp(name: string, file: ArrayBufferSlice): BspData {
	const data = file.createDataView();

	const numMaterials = data.getUint32(0, true);
	const materials = new Array<string>(numMaterials);
	for (let i = 0; i < numMaterials; ++i) {
		materials[i] = readString(file, 4 + i * 10, 10);
	}
	let offset = align(4 + numMaterials * 10, 4);

	const numPlanes = data.getUint32(offset, true);
	// todo any interesting info in planes?
	offset += 4 + numPlanes * 44;

	const numTris = data.getUint32(offset, true);
	offset += 4;

	const indices = new Uint16Array(numTris * 3);
	const uvs = new Float32Array(numTris * 6);
	const materialIndices = new Int16Array(numTris);
	const flags = new Int32Array(numTris);
	for (let triIndex = 0; triIndex < numTris; ++triIndex) {
		for (let j = 0; j < 3; ++j)
			indices[triIndex * 3 + j] = data.getUint16(offset + j * 2, true);
		materialIndices[triIndex] = data.getUint16(offset + 6, true);
		offset += 8;
		for (let j = 0; j < 6; ++j)
			uvs[triIndex * 6 + j] = data.getFloat32(offset + j * 4, true);
		flags[triIndex] = data.getInt32(offset + 24, true);
		offset += 28;
	}

	const numVerts = data.getUint32(offset, true);
	const verts = readVerts(file, offset + 4, numVerts);
	offset += 4 + numVerts * 12;

	const bbox = calculateAABB(verts, numVerts);

	return { name, materials, parts: [{ name: "", origin: [0, 0, 0], verts, indices, uvs, materialIndices, flags, bbox }], bbox };
}

export function parseSni(file: ArrayBufferSlice): BspData[] {
	const data = file.createDataView();

	const numEntries = data.getUint32(20, true);

	const bsps: BspData[] = [];
	//const animations = new Map<string, ArrayBufferSlice>();
	//const sounds = new Map<string, ArrayBufferSlice>();

	for (let i = 0; i < numEntries; ++i) {
		const name = readString(file, 24 + i * 24, 12);
		const type = data.getInt32(24 + i * 24 + 12, true);
		const offset = data.getUint32(24 + i * 24 + 16, true) + 4;
		const filesize = data.getUint32(24 + i * 24 + 20, true);

		const entryData = file.subarray(offset, filesize);

		if (type === 0) { // bsp
			bsps.push(parseBsp(name, entryData));
		} else if (type === -1) { // player animation
			//animations.set(name, entryData);
		} else { // sound
			//sounds.set(name, entryData);
		}
	}

	return bsps;
}
export type MtiData = {
	textures: Map<string, MtiTexture>,
	others: Map<string, number>,
};
export function mergeMtiData(dest: MtiData, src: MtiData) {
	src.textures.forEach((tex, name) => dest.textures.set(name, tex));
	src.others.forEach((num, name) => dest.others.set(name, num));
}
export type MtiTexture = { width: number, height: number, pixels: Uint8Array; };
export function parseMti(file: ArrayBufferSlice): MtiData {
	const data = file.createDataView();

	const numMaterials = data.getUint32(20, true);
	let offset = 24;
	const textures = new Map<string, MtiTexture>();
	const others = new Map<string, number>();
	for (let i = 0; i < numMaterials; ++i) {
		const name = readString(file, offset, 8);
		const a = data.getInt32(offset + 8, true);
		if (a === -1) {
			const palIndex = data.getInt32(offset + 12, true);
			others.set(name, palIndex);
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

			textures.set(name, { width, height, pixels });
		}
		offset += 24;
	}

	return { textures, others };
}
