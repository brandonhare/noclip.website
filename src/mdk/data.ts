import { mat4, vec3, vec4 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice.js";
import { NamedArrayBufferSlice } from "../DataFetcher.js";
import { AABB } from "../Geometry.js";
import { clamp } from "../MathHelpers.js";
import { align, assert, assertExists, readString } from "../util.js";

export type DtiData = {
	levelPalette: Uint8Array,
	translucentColours: vec4[],

	levelStartLocation: mat4,

	skybox: MtiTexture,
	skyTopColourIndex: number,
	skyBottomColourIndex: number,

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

	const dataOffset = data.getUint32(20, true) + 8;

	// start location
	const startPos = readVec3(data, dataOffset);
	const startAngle = (data.getFloat32(dataOffset + 12, true) - 90) * Math.PI / 180;
	const levelStartLocation = mat4.fromYRotation(mat4.create(), startAngle);
	levelStartLocation[12] = startPos[0];
	levelStartLocation[13] = startPos[1] + 5;
	levelStartLocation[14] = startPos[2];

	// skybox
	const skyTopColourIndex = data.getInt32(dataOffset + 16, true);
	const skyBottomColourIndex = data.getInt32(dataOffset + 20, true);
	const skyDestWidth = data.getInt32(dataOffset + 32, true) + 4;
	const skySrcHeight = data.getInt32(dataOffset + 36, true);
	const skyReflectionTopColourIndex = data.getInt32(dataOffset + 40, true);
	const skyReflectionBottomColourIndex = data.getInt32(dataOffset + 44, true);
	const skyHasReflections = skyReflectionTopColourIndex > 0;
	const skyboxPixelsOffset = data.getUint32(20 + 16, true) + 4;
	let skyPixels: Uint8Array;
	let skySrcWidth = skyDestWidth;
	let skyDestHeight = skySrcHeight;
	if (skyHasReflections) {
		skySrcWidth = skyDestWidth * 2;
		skyDestHeight = skySrcHeight / 2;
		const srcPixels = file.createTypedArray(Uint8Array, skyboxPixelsOffset, skySrcWidth * skySrcHeight);
		skyPixels = new Uint8Array(skyDestWidth * skyDestHeight);
		for (let row = 0; row < skyDestHeight; ++row) {
			for (let col = 0; col < skyDestWidth; ++col) {
				skyPixels[row * skyDestWidth + col] = srcPixels[row * skySrcWidth + col];
			}
		}
		// todo reflection textures
	} else {
		skyPixels = file.createTypedArray(Uint8Array, skyboxPixelsOffset, skySrcWidth * skyDestHeight);
	}
	const skybox: MtiTexture = {
		width: skyDestWidth,
		height: skyDestHeight,
		pixels: skyPixels
	};

	// translucent colours
	const translucentColoursOffset = dataOffset + 48;
	const translucentColours = new Array<vec4>(4);
	for (let i = 0; i < 4; ++i) {
		translucentColours[i] = [
			data.getUint8(translucentColoursOffset + i * 16) / 255,
			data.getUint8(translucentColoursOffset + i * 16 + 4) / 255,
			data.getUint8(translucentColoursOffset + i * 16 + 8) / 255,
			data.getUint8(translucentColoursOffset + i * 16 + 12) / 255,
		];
	}

	// arenas
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

	// palette
	const palOffset = data.getUint32(20 + 4 * 3, true) + 8;
	const levelPalette = file.createTypedArray(Uint8Array, palOffset, 0x300);

	return { levelPalette, levelStartLocation, skybox, skyTopColourIndex, skyBottomColourIndex, translucentColours, arenas };
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

function calculateAABB(points: ArrayLike<number>, numPoints: number = points.length): AABB {
	const range = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	for (let i = 0; i < numPoints; i += 3) {
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


// todo optimize
type PathPoint = {
	t: number;
	p0: vec3; // world space position
	v1: vec3; // tangent 1 (relative to p0)
	v2: vec3; // tangent 2 (relative to p0)
};
export class Path {
	points: PathPoint[];

	constructor(points: PathPoint[]) {
		this.points = points;
	}

	getPoint(out: vec3, t: number): vec3 {
		t = clamp(t, 0.0, 1.0);

		for (let i = 0; i < this.points.length - 1; ++i) {
			const next_point = this.points[i + 1];
			if (next_point.t < t) {
				continue;
			}
			const point = this.points[i];
			t = (t - point.t) / (next_point.t - point.t);

			for (let j = 0; j < 3; ++j) {
				const p = point.p0[j];
				const v1 = point.v1[j];
				const v2 = point.v2[j];
				const d = next_point.p0[j] - p;

				out[j] = t * (t * (t * (v1 + v2 - 2 * d) + 3 * d - 2 * v1 - v2) + v1) + p;
			}

			break;
		}
		return out;
	}
};

function readPath(data: DataView, offset: number): Path {
	const count = data.getUint32(offset, true);
	offset += 4;
	const points = new Array<PathPoint>(count);

	//    p   a   b
	// t xyz xyz xyz
	// 0 123 456 789

	const max_t = data.getUint32(offset + 40 * (count - 1), true);
	for (let i = 0; i < count; ++i) {
		const t = data.getUint32(offset, true) / max_t;

		const p0 = readVec3(data, offset + 4);
		const v1 = readVec3(data, offset + 28);
		const v2: vec3 = (i == count - 1) ? [0, 0, 0] : readVec3(data, offset + 56); // stored on the next point

		offset += 40;

		points[i] = {
			t, p0, v1, v2
		};
	}

	return new Path(points);
}

export function parseCmi(file: NamedArrayBufferSlice): { path: Path, offset: string; }[] {

	// todo
	const offsets: { [key: string]: number[]; } = {
		LEVEL3: [
			0x6a64, 0x6b80, 0x6c9c, 0x6db8, 0x9d78, 0x9df4, 0x9e70, 0x9eec, 0x9f68, 0x9fe4, 0xa104, 0xa1a8, 0xa24c, 0xa340, 0xa434, 0xb298, 0xb364, 0xb430, 0xffbc, 0x1444c, 0x144c8, 0x14544, 0x18bb0, 0x18ccc, 0x18de8, 0x18f04, 0x19020, 0x1918c, 0x192a8, 0x1943c, 0x1ee00, 0x1fb9c,],
		LEVEL4: [
			0x4777, 0x4a6b, 0x9b5b, 0x9cc7, 0x9e5b, 0x9ed7, 0x9f53, 0xc70f, 0xc8cb, 0xcaaf, 0xcc1b, 0xcd37, 0x1130b, 0x11477, 0x131cb, 0x1622f, 0x19fab, 0x1a077, 0x1a1e3, 0x1a34f, 0x1a4bb, 0x206d3, 0x20817, 0x2402b, 0x24697, 0x2473b, 0x247df, 0x248fb, 0x24a17, 0x26daf, 0x26ecb, 0x26f97, 0x2a973, 0x2aa3f, 0x2e2b3, 0x2e3f7, 0x2e4c3, 0x2e62f, 0x2e74b,],
		LEVEL5: [
			0x4329, 0x4445, 0x4e0d, 0x60b1, 0x612d, 0xc3a9, 0xc44d,],
		LEVEL6: [
			0x1959, 0x1b15, 0x4dcd, 0x4e49, 0x8b0d, 0xeb49, 0x118f1, 0x11bc5, 0x11d09, 0x14549, 0x1481d, 0x14899, 0x14915, 0x17ac9, 0x17b95, 0x17f55, 0x1804d, 0x18265,],
		LEVEL7: [
			0x3eed, 0x4059, 0x423d, 0x43f9, 0x4605, 0x47c1, 0xd161, 0xd1dd, 0xd259, 0x16355, 0x163d1, 0x1644d, 0x165b9, 0x1a969, 0x1a9e5, 0x1aa61, 0x1aadd, 0x1ab59, 0x1ac75, 0x1ad91, 0x1aead, 0x1afc9, 0x1b0e5, 0x1b1dd, 0x1b281, 0x206f5, 0x20749, 0x2079d, 0x207f1, 0x20845, 0x20899, 0x208ed, 0x20941, 0x235d9, 0x2367d,],
		LEVEL8: [
			0x42b7, 0x43ab, 0x4477, 0x861b, 0x875f, 0xf84b, 0xf917, 0xf9e3, 0xfaaf, 0x13373, 0x1343f, 0x1adfb, 0x1af17, 0x1b033, 0x1b0ff, 0x23c67, 0x23dd3,],
	};

	const data = file.createDataView(4);
	return offsets[/TRAVERSE\/(\w+)\//.exec(file.name)![1]].map((offset) => {
		return { path: readPath(data, offset), offset: offset.toString(16) };
	});
}
