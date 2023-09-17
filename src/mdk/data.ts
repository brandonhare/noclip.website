import { mat4, vec3, vec4 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice.js";
import { AABB } from "../Geometry.js";
import { align, assert, assertExists, readString } from "../util.js";

export type DtiData = {
	levelPalette: Uint8Array,
	levelStartLocation: mat4,
	translucentColours: vec4[],
	arenas: DtiArenaData[],
};
export type DtiArenaData = {
	name: string,
	num: number, // todo what is this
	entities: DtiEntityData[];
};
export type DtiEntityData = {
	entityType: number,
	a: number,
	b: number,
	pos: vec3,
	data: vec3 | string,
};
export function parseDti(file: ArrayBufferSlice): DtiData {
	const data = file.createDataView();

	const data1Offset = data.getUint32(20 + 4 * 0, true) + 8;
	const startPos = readVec3(data, data1Offset);
	const startAngle = (data.getFloat32(data1Offset + 12, true) - 90) * Math.PI / 180;
	const levelStartLocation = mat4.fromYRotation(mat4.create(), startAngle);
	levelStartLocation[12] = startPos[0];
	levelStartLocation[13] = startPos[1] + 5;
	levelStartLocation[14] = startPos[2];
	const translucentColours = new Array<vec4>(4);
	const translucentColoursOffset = data1Offset + 48;
	for (let i = 0; i < 4; ++i) {
		translucentColours[i] = [
			data.getUint8(translucentColoursOffset + i * 16) / 255,
			data.getUint8(translucentColoursOffset + i * 16 + 4) / 255,
			data.getUint8(translucentColoursOffset + i * 16 + 8) / 255,
			data.getUint8(translucentColoursOffset + i * 16 + 12) / 255,
		];
	}

	let arenaDataOffset = data.getUint32(20 + 4 * 2, true) + 4;
	const numArenas = data.getUint32(arenaDataOffset, true);
	arenaDataOffset += 4;
	const arenas = new Array<DtiArenaData>(numArenas);
	for (let i = 0; i < numArenas; ++i) {
		const arenaName = readString(file, arenaDataOffset + i * 16, 8);
		let entityOffset = data.getUint32(arenaDataOffset + i * 16 + 8, true) + 4;
		const arenaNum = data.getFloat32(arenaDataOffset + i * 16 + 12, true);
		const numEntities = data.getUint32(entityOffset, true);
		entityOffset += 4;
		const entities = new Array<DtiEntityData>(numEntities);
		for (let j = 0; j < numEntities; ++j) {
			const entityType = data.getInt32(entityOffset, true);
			const a = data.getInt32(entityOffset + 4, true);
			const b = data.getInt32(entityOffset + 8, true);
			const pos = readVec3(data, entityOffset + 12);
			const entityData =
				(entityType === 2 || entityType === 4)
					? readString(file, entityOffset + 24, 12)
					: readVec3(data, entityOffset + 24);
			entityOffset += 36;
			entities[j] = { entityType, a, b, pos, data: entityData };
		}
		arenas[i] = { name: arenaName, num: arenaNum, entities };
	}

	const palOffset = data.getUint32(20 + 4 * 3, true) + 8;
	const levelPalette = file.createTypedArray(Uint8Array, palOffset, 0x300);

	// todo: everything else

	return { levelPalette, levelStartLocation, translucentColours, arenas };
}

function readVec3(data: DataView, offset: number): vec3 {
	return [data.getFloat32(offset, true),
	data.getFloat32(offset + 8, true),
	-data.getFloat32(offset + 4, true)
	];
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
	primitives: RawMeshPrimitive[],
	bbox: AABB,
	origin: vec3,
};
export type RawMeshPrimitive = {
	material: string | number,
	indices: Uint16Array,
	positions: Float32Array,
	uvs: Float32Array,
	bbox: AABB,

	uvsAdjusted: boolean, // runtime flag
};

function readAABB(data: DataView, offset: number): AABB {
	return new AABB(
		data.getFloat32(offset, true), // min x
		data.getFloat32(offset + 16, true), // min z
		-data.getFloat32(offset + 8, true), // min y
		data.getFloat32(offset + 4, true), // max x
		data.getFloat32(offset + 20, true), // max z
		-data.getFloat32(offset + 12, true), // max y
	);
}

function calculateAABB(points: ArrayLike<number>, numPoints: number = points.length * 3): AABB {
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


function readVerts(data: DataView, offset: number, numVerts: number): Float32Array {
	const result = new Float32Array(numVerts * 3);
	for (let i = 0; i < numVerts * 3; i += 3) {
		result[i] = data.getFloat32(offset, true);
		result[i + 1] = data.getFloat32(offset + 8, true);
		result[i + 2] = -data.getFloat32(offset + 4, true);
		offset += 12;
	}
	return result;
}

function parseMeshData(name: string, materials: string[], data: DataView, startOffset: number, numTris: number, verts: Float32Array): RawMeshPrimitive[] {

	type RawPrim = {
		material: string | number,
		indices: number[],
		verts: number[],
		uvs: number[],
		seenVerts: Map<number, [number, number, number][]>,
	};

	function newRawPrim(material: string | number): RawPrim {
		return {
			material,
			indices: [],
			verts: [],
			uvs: [],
			seenVerts: new Map()
		};
	}

	const rawPrims = materials.map(newRawPrim);
	const solidPrim = newRawPrim(0x10000); // todo make a better solid colour flag
	rawPrims.push(solidPrim);
	const specialPrims = new Map<number, RawPrim>();

	const endOffset = startOffset + numTris * 36;
	for (let offset = startOffset; offset != endOffset; offset += 36) {
		const i1 = data.getUint16(offset, true);
		const i2 = data.getUint16(offset + 2, true);
		const i3 = data.getUint16(offset + 4, true);
		if (i1 === i2 || i1 === i3 || i2 === i3) {
			continue;
		}
		const materialIndex = data.getInt16(offset + 6, true);
		//const flags = data.getUint32(offset + 32, true); // todo what are these

		let prim: RawPrim | undefined;
		const isTextured = materialIndex >= 0 && materialIndex < materials.length;
		const isSolidColour = -256 < materialIndex && materialIndex < 0;
		const isTranslucent = -1027.0 <= materialIndex && materialIndex <= -1024.0;
		if (isTextured) {
			prim = assertExists(rawPrims[materialIndex]);
		} else if (isSolidColour) {
			prim = solidPrim;
		} else if (isTranslucent) {
			// todo do something more efficient than rendering every triangle individually
			prim = newRawPrim(materialIndex);
			rawPrims.push(prim);
		} else {
			prim = specialPrims.get(materialIndex);
			if (!prim) {
				prim = newRawPrim(materialIndex);
				rawPrims.push(prim);
				specialPrims.set(materialIndex, prim);
			}
		}

		for (let j = 0; j < 3; ++j) {
			const index = data.getUint16(offset + 2 * j, true);
			let u: number;
			let v: number;
			if (isSolidColour) {
				u = -materialIndex;
				v = 0;
			} else if (isTranslucent) {
				// map translucent colour index to [0..4)
				u = -materialIndex - 1024;
				v = 0;
			} else {
				u = data.getFloat32(offset + 8 + j * 8, true);
				v = data.getFloat32(offset + 8 + j * 8 + 4, true);

				if (isTextured && u === 0 && v === 0) {
					continue; // todo figure out what's wrong with these ones
				}
			}
			let seenVertList = prim.seenVerts.get(index);
			if (!seenVertList) {
				seenVertList = [];
				prim.seenVerts.set(index, seenVertList);
			} else {
				let found = false;
				for (const list of seenVertList) {
					if (Math.abs(list[0] - u) <= 0.001 && Math.abs(list[1] - v) <= 0.001) {
						found = true;
						prim.indices.push(list[2]);
						break;
					}
				}
				if (found)
					continue;
			}

			const newVertIndex = prim.verts.length / 3;
			seenVertList.push([u, v, newVertIndex]);
			prim.indices.push(newVertIndex);
			prim.verts.push(verts[index * 3], verts[index * 3 + 1], verts[index * 3 + 2]);
			prim.uvs.push(u, v);
		}
	}

	return rawPrims.filter(prim => prim.indices.length).map(prim => {
		return {
			material: prim.material,
			bbox: calculateAABB(prim.verts),
			indices: new Uint16Array(prim.indices),
			uvs: new Float32Array(prim.uvs),
			positions: new Float32Array(prim.verts),
			uvsAdjusted: prim === solidPrim,
		};
	});
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
			origin[1] = data.getFloat32(offset + 20, true);
			origin[2] = -data.getFloat32(offset + 16, true);
			offset += 24;
		}

		const numVerts = data.getUint32(offset, true);
		const verts = readVerts(data, offset + 4, numVerts);
		offset += 4 + numVerts * 12;

		// adjust to origin
		/*
		if (origin[0] || origin[1] || origin[2]) {
			for (let i = 0; i < numVerts * 3; i += 3) {
				verts[i] -= origin[0];
				verts[i + 1] -= origin[1];
				verts[i + 2] -= origin[2];
			}
		}
		*/

		const numTris = data.getUint32(offset, true);
		offset += 4;
		const primitives = parseMeshData(name, materials, data, offset, numTris, verts);
		offset += numTris * 36;

		const bbox = readAABB(data, offset);
		offset += 24;

		parts[meshIndex] = { name, primitives, bbox, origin };
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
	const triOffset = offset + 4;
	offset = triOffset + 36 * numTris;

	const numVerts = data.getUint32(offset, true);
	offset += 4;
	const verts = readVerts(data, offset, numVerts);
	offset += numVerts * 12;

	const primitives = parseMeshData(name, materials, data, triOffset, numTris, verts);

	const bbox = calculateAABB(verts);

	return { name, materials, parts: [{ name, bbox, primitives, origin: [0, 0, 0] }], bbox };
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
