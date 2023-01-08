import ArrayBufferSlice from "../ArrayBufferSlice";
import { Endianness } from "../endian";
import { assert, assertExists } from "../util";

import { ResourceFork } from "./AppleDouble";
import { LevelObjectDef } from "./entity";

export type ParsedBugdomTerrain = {
	items : LevelObjectDef[],
}

export function parseBugdomTerrain(terrainData: ResourceFork): ParsedBugdomTerrain {

	const MAP2UNIT_VALUE = 160/32;

	function get(resourceName: string, id: number, debugName: string) {
		return assertExists(terrainData.get(resourceName)?.get(id), debugName);
	}
	function getData(resourceName: string, id: number, debugName: string) {
		return get(resourceName, id, debugName)?.createDataView();
	}

	const TERRAIN_POLYGON_SIZE = 160;

	// read header
	const header = getData("Hedr", 1000, "header");
	assert(header.getUint32(0) === 0x7000000, "unknown terrain version number");
	const numItems = header.getUint32(4);
	const mapWidth = header.getUint32(8);
	const mapHeight = header.getUint32(12);
	const numTilePages = header.getUint32(16);
	const numTilesInList = header.getUint32(20);
	const tileSize = header.getFloat32(24);
	const heightMinY = header.getFloat32(28);
	const heightMaxY = header.getFloat32(32);
	const numSplines = header.getUint32(36);
	const numFences = header.getUint32(40);

	// read tile image stufff
	const tileImageData = get("Timg", 1000, "tile image data").createTypedArray(Uint16Array, undefined, undefined, Endianness.BIG_ENDIAN);
	const tileImageTranslationTable = get("Xlat", 1000, "tile->image translation table").createTypedArray(Uint16Array, undefined, undefined, Endianness.BIG_ENDIAN);

	// read tiles
	function loadTiles(buffer?: ArrayBufferSlice) {
		if (!buffer)
			return;
		const data = buffer.createTypedArray(Uint16Array, undefined, undefined, Endianness.BIG_ENDIAN);
		for (let i = 0; i < data.length; ++i) {
			const tile = data[i];
			data[i] = (tile & ~0xFFF) | tileImageTranslationTable[tile & 0xFFF];
		}
		return data;
	}
	const floor = loadTiles(get("Layr", 1000, "floor layer"))!;
	const ceiling = loadTiles(terrainData.get("Layr")!.get(1001));
	const numLayers = ceiling ? 2 : 1;

	// read heights
	const yScale = TERRAIN_POLYGON_SIZE / tileSize;
	const yCoords: Float32Array[] = new Array(numLayers);
	for (let i = 0; i < numLayers; ++i) {
		const heights = get("YCrd", 1000 + i, "layer").createTypedArray(Float32Array, undefined, undefined, Endianness.BIG_ENDIAN);
		for (let j = 0; j < heights.length; ++j)
			heights[j] *= yScale;
		yCoords[i] = (heights);
	}

	// read vertex colours
	const vertexColours: Uint16Array[] = new Array(numLayers);
	for (let i = 0; i < numLayers; ++i) {
		vertexColours[i] = get("Vcol", 1000 + i, "vertex colours").createTypedArray(Uint16Array, undefined, undefined, Endianness.BIG_ENDIAN);
	}

	// read splits
	const splits = new Array(numLayers);
	for (let i = 0; i < numLayers; ++i) {
		splits[i] = get("Splt", 1000 + i, "split data").createTypedArray(Uint8Array);
	}

	// read items
	const itemData = getData("Itms", 1000, "items");
	const items: LevelObjectDef[] = new Array(numItems);
	for (let i = 0; i < numItems; ++i) {
		items[i] = {
			x: itemData.getUint16(i * 12 + 0) * MAP2UNIT_VALUE,
			y: 0,
			z: itemData.getUint16(i * 12 + 2) * MAP2UNIT_VALUE,
			type: itemData.getUint16(i * 12 + 4),
			param0: itemData.getUint8(i * 12 + 6),
			param1: itemData.getUint8(i * 12 + 7),
			param2: itemData.getUint8(i * 12 + 8),
			param3: itemData.getUint8(i * 12 + 9),
			flags: itemData.getUint16(i * 12 + 10)
		};
	}

	type SplineDef = {
		numPoints: number;
		points: Float32Array;
		items: SplineItemDef[];
		top: number;
		left: number;
		bottom: number;
		right: number;
	};

	type SplineItemDef = {
		placement: number;
		type: number;
		param0: number;
		param1: number;
		param2: number;
		param3: number;
		flags: number;
	};

	// read splines
	const splines: SplineDef[] = new Array(numSplines);
	if (numSplines > 0) {
		const splineDefData = getData("Spln", 1000, "spline defs");
		for (let i = 0; i < numSplines; ++i) {
			// read def
			const numNubs = splineDefData.getUint16(i * 32);
			const numPoints = splineDefData.getUint32(i * 32 + 8);
			const numItems = splineDefData.getUint16(i * 32 + 16);
			const top = splineDefData.getInt16(i * 32 + 24);
			const left = splineDefData.getInt16(i * 32 + 26);
			const bottom = splineDefData.getInt16(i * 32 + 28);
			const right = splineDefData.getInt16(i * 32 + 30);

			// read points
			const points = numPoints > 0
				? get("SpPt", 1000 + i, "spline points").createTypedArray(Float32Array, undefined, undefined, Endianness.BIG_ENDIAN)
				: new Float32Array(0);

			// read items
			const items: SplineItemDef[] = new Array(numItems);
			const itemData = getData("SpIt", 1000 + i, "spline items");
			for (let j = 0; j < numItems; ++j) {
				items[j] = {
					placement: itemData.getFloat32(12 * j),
					type: itemData.getUint16(12 * j + 4),
					param0: itemData.getUint8(12 * j + 6),
					param1: itemData.getUint8(12 * j + 7),
					param2: itemData.getUint8(12 * j + 8),
					param3: itemData.getUint8(12 * j + 9),
					flags: itemData.getUint16(12 * j + 10)
				};
			}

			splines[i] = {
				numPoints,
				points,
				items,
				top, left, bottom, right
			};
		}
	}

	// read fences
	type FenceDef = {
		type: number;
		numNubs: number;
		nubs: Int32Array;
		top: number;
		left: number;
		bottom: number;
		right: number;
	};
	const fences: FenceDef[] = new Array(numFences);
	if (numFences > 0) {
		const fenceData = getData("Fenc", 1000, "fences");
		for (let i = 0; i < numFences; ++i) {
			// read fence def
			const type = fenceData.getUint16(i * 16);
			const numNubs = fenceData.getInt16(i * 16 + 2);
			const top = fenceData.getInt16(i * 16 + 8);
			const left = fenceData.getInt16(i * 16 + 10);
			const bottom = fenceData.getInt16(i * 16 + 12);
			const right = fenceData.getInt16(i * 16 + 14);

			// read fence nubs
			const nubs = get("FnNb", 1000 + i, "fence nubs").createTypedArray(Int32Array, undefined, 2 * numNubs, Endianness.BIG_ENDIAN);
			fences[i] = {
				type,
				numNubs,
				nubs,
				top,
				left,
				bottom,
				right
			};
		}
	}


	return {
		mapWidth,
		mapHeight,
		tileImageData,
		floor,
		ceiling,
		vertexColours,
		splits,
		items,
		splines,
		fences,
	} as ParsedBugdomTerrain;
}
