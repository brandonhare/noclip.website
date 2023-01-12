import { assert } from "../util";

export class TerrainInfo {
	width : number;
	height : number;
	stride : number;
	xzScale : number;
	yScale : number;
	heightmap : Uint8Array;
	constructor(width : number, height : number, heightmap : Uint8Array, xzScale : number, yScale : number){
		this.width = width;
		this.height = height;
		this.stride = width + 1;
		this.xzScale = 1 / xzScale;
		this.yScale = yScale;
		this.heightmap = heightmap;
	}

	getHeight(x : number, z : number) : number {
		x *= this.xzScale;
		z *= this.xzScale;
		const row = Math.floor(z);
		const col = Math.floor(x);
		const baseIndex = row * this.stride + col;
		x %= 1;
		z %= 1;
		
		// (col, row)
		let h1 = this.heightmap[baseIndex];
		// (col+1, row)
		let h2 = this.heightmap[baseIndex + 1];
		// (col+1, row+1)
		let h3 = this.heightmap[baseIndex + this.stride];
		// (col, row+1)
		let h4 = this.heightmap[baseIndex + this.stride + 1];

		if (!needsFlip(h1, h2, h3, h4)){
			x = 1 - x;
			let temp = h1;
			h1 = h2;
			h2 = temp;
			temp = h4;
			h4 = h3;
			h3 = temp;
		}

		if (x + z > 1){
			// reflect
			h1 = h3;
			let temp = x;
			x = 1 - z;
			z = 1 - temp;
		}

		// barycentric between h1,h2,h4
		return (h1 * (1 - x - z) + h2 * x + h4 * z) * this.yScale;
	}


};

function convertTilemapFlip(id : number) : number{
	const enum FlipFlags {
		SWIZZLE = 0x1000,
		FLIP_X  = 0x2000,
		FLIP_Y  = 0x4000,
	}
	const tileId = id & 0xFFF;
	const flipX = (id & 0x8000) !== 0;
	const flipY = (id & 0x4000) !== 0;
	const rot = (id >> 12) & 0x3;

	let result = tileId;

	if (flipX) result |= FlipFlags.FLIP_X;
	if (flipY) result |= FlipFlags.FLIP_Y;
	switch(rot){
		case 1:
			result ^= FlipFlags.FLIP_Y | FlipFlags.SWIZZLE;
			break;
		case 2:
			result ^= FlipFlags.FLIP_X | FlipFlags.FLIP_Y;
			break;
		case 3:
			result ^= FlipFlags.FLIP_X | FlipFlags.SWIZZLE;
			break;
	}
	return result;
}

function needsFlip(y0 : number, y1 : number, y2 : number, y3 : number) : boolean{
	return Math.abs(y0 - y2) > Math.abs(y1 - y3);
}
function flippedPoly(heightmap : ArrayLike<number>, stride : number, baseIndex : number) : boolean {
	const y0 = heightmap[baseIndex];              // y0 ---- y1
	const y1 = heightmap[baseIndex + 1];          //  |  \   | 
	const y2 = heightmap[baseIndex + stride + 1]; //  |   \  |
	const y3 = heightmap[baseIndex + stride];     // y3 ---- y2
	return needsFlip(y0, y1, y2, y3);
}



export function createVerticesFromHeightmap(target : Uint16Array, heightmap : ArrayLike<number>, width : number, height : number) : number{
	let i = 0;
	const stride = width + 1;
	let maxHeight = 0;
	for (let row = 0; row <= height; ++row){
		for (let col = 0; col <= width; ++col){
			const height = heightmap[row * stride + col];
			target[i++] = col;
			target[i++] = height
			target[i++] = row;

			if (height > maxHeight)
				maxHeight = height;
		}
	}
	return maxHeight;
}

export function createTilemapIds(target : Uint16Array, textureLayerData : ArrayLike<number>, width : number, height : number) : number{
	let maxTextureIndex = 0;
	const stride = width + 1;
	for (let row = 0; row <= height; row++) {
		for (let col = 0; col <= width; ++col) {
			const terrainId = textureLayerData[row * width + col] ?? 0;
			target[row * stride + col] = convertTilemapFlip(terrainId);

			maxTextureIndex = Math.max(maxTextureIndex, terrainId & 0xFFF);
		}
	}
	return maxTextureIndex;
}

export function createNormalsFromHeightmap(target : Float32Array, heightmap : ArrayLike<number>, width : number, height : number, heightScale : number){
	const stride = width + 1;
	heightScale *= 0.1;
	for (let row = 0; row <= height; ++row){
		for (let col = 0; col <= width; ++col){
			//   --y0--
			//  |      | 
			// y3  ..  y1
			//  |      |
			//   --y2--
			const baseIndex = row * stride + col;
			const y0 = row > 0 ? heightmap[baseIndex - stride] : 0;
			const y1 = col < width ? heightmap[baseIndex + 1] : 0;
			const y2 = row < height ? heightmap[baseIndex + stride] : 0;
			const y3 = col > 0 ? heightmap[baseIndex - 1] : 0;
			const x = (y3 - y1) * heightScale;
			const z = (y0 - y2) * heightScale;
			const magnitude = 1 / Math.hypot(x, z, 1);
			target[baseIndex*3  ] = x * magnitude;
			target[baseIndex*3+1] = 1 * magnitude;
			target[baseIndex*3+2] = z * magnitude;
		}
	}
}

export function createIndices2(heightmap : ArrayLike<number>, tilemap : ArrayLike<number>, width : number, height : number){
	const stride = width + 1;
	const availableVerts = new Set<number>();
	const solvedLocalFlips : number[] = []; // quads that just need to rotate right or left
	const replacedTextures = new Map<number, number>();

	const unresolvedVerts = new Map<number, number>();

	// scan and solve basic cases
	for (let row = 0; row < height; ++row){
		for (let col = 0; col < width; ++col){
			const baseIndex = row * stride + col;
			if (!flippedPoly(heightmap, stride, baseIndex))
				continue;

			const tile = tilemap[row * width + col];
			availableVerts.add(baseIndex);
			
			// see if there's a neighbour who happens to have what we need
			const rightIndex = baseIndex + 1;
			const rightTile = tilemap[row * width + col + 1];
			if (rightTile === tile && !flippedPoly(heightmap, stride, rightIndex)){
				solvedLocalFlips.push(baseIndex);
				continue;
			}
			const downIndex = baseIndex + stride;
			const downTile = tilemap[(row + 1) * width + col];
			if (downTile === tile && !flippedPoly(heightmap, stride, downIndex)){
				solvedLocalFlips.push(-baseIndex);
				continue;
			}

			// see if we can use an edge's id
			if (col + 1 === width){
				solvedLocalFlips.push(baseIndex);
				replacedTextures.set(rightIndex, tile);
				continue;
			} else if (row + 1 === height){
				solvedLocalFlips.push(-baseIndex);
				replacedTextures.set(downIndex, tile);
				continue;
			}

			unresolvedVerts.set(baseIndex, tile);
		}
	}

	function replaceTex(baseIndex : number, newTile : number){
		assert(!replacedTextures.has(baseIndex), "replacing a vert twice");
		assert(availableVerts.has(baseIndex), "replacing a non-available vert");
		availableVerts.delete(baseIndex);
		replacedTextures.set(baseIndex, newTile);

		const leftIndex = baseIndex - 1;
		let added = 0;
		if (unresolvedVerts.get(leftIndex) === newTile){
			unresolvedVerts.delete(leftIndex);
			solvedLocalFlips.push(leftIndex);
			++added;
		}
		const upIndex = baseIndex - stride;
		if (unresolvedVerts.get(upIndex) === newTile){
			unresolvedVerts.delete(upIndex);
			solvedLocalFlips.push(-upIndex);
			++added;
		}
		return added;
	}

	let total = 0;
	let friends = 0;
	let neighbours = 0;
	while (true){
		let added = 0;
		unresolvedVerts.forEach((tile, baseIndex)=>{
			const rightIndex = baseIndex + 1;
			const downIndex = baseIndex + stride;
			const rightFree = availableVerts.has(rightIndex);
			const downFree = availableVerts.has(downIndex);
			if (rightFree !== downFree){
				if (rightFree){
					added += replaceTex(rightIndex, tile);
				} else {
					added += replaceTex(downIndex, tile);
				}
			}
		});
		if (added > 0){
			//console.log("one neighbour", added);
			total += added;
			neighbours += added;
			continue;
		}
		added = 0;
		unresolvedVerts.forEach((tile, baseIndex)=>{
			const rightIndex = baseIndex + 1;
			const downIndex = baseIndex + stride;
			const rightFree = availableVerts.has(rightIndex);
			const downFree = availableVerts.has(downIndex);
			assert(rightFree === downFree);
			if (!rightFree) return;
			++added;
		});
		console.log(added);


		break;
	}
	const remainder = unresolvedVerts.size;
	console.log({total, friends, neighrbours: neighbours, remainder});
	// slow: 1986, 456, 1530, 2480
	// fast 2106, 290, 1816, 2360

}

export function createIndices(heightmap : ArrayLike<number>, tilemap : ArrayLike<number>, width : number, height : number, out_replacedTextures : number[], out_duplicatedVerts : number[]) : Uint32Array{
	createIndices2(heightmap, tilemap, width, height);
	const stride = width + 1;

	let replacedTextures = new Map<number, number>();
	let resolvedFlips = [];
	let unresolvedFlips = new Set<number>();

	for (let row = 0; row < height; ++row){
		for (let col = 0; col < width; ++col){
			const baseIndex = row * stride + col;
			if (!flippedPoly(heightmap, stride, baseIndex))
				continue;
			
			const tile = tilemap[row * width + col];

			// see if there's a neighbour who happens to have what we need
			const rightIndex = baseIndex + 1;
			const downIndex = baseIndex + stride;
			const rightFlip = flippedPoly(heightmap, stride, rightIndex);
			const downFlip = flippedPoly(heightmap, stride, downIndex);
			if (tilemap[rightIndex] === tile && !rightFlip){
				resolvedFlips.push(baseIndex);
				continue;
			} else if (tilemap[downIndex] === tile && !downFlip){
				resolvedFlips.push(-baseIndex);
				continue;
			}

			// see if we can use an edge's id
			if (col + 1 === width){
				resolvedFlips.push(baseIndex);
				replacedTextures.set(rightIndex, tile);
				continue;
			} else if (row + 1 === height){
				resolvedFlips.push(-baseIndex);
				replacedTextures.set(downIndex, tile);
				continue;
			}

			unresolvedFlips.add(baseIndex);
		}
	}

	const indices = new Uint32Array(width * height * 6);

	let i = 0;
	let nextFlipIndex = 0;
	let nextFlipVertIndex = Math.abs(resolvedFlips[0] ?? 0);
	for (let row = 0; row < height; ++row){
		for (let col = 0; col < width; ++col){
			const vertIndex = row * stride + col;
			if (vertIndex !== nextFlipVertIndex){
				// regular
				indices[i++] = vertIndex + stride + 1;
				indices[i++] = vertIndex + 1;
				indices[i++] = vertIndex;

				indices[i++] = vertIndex + stride;
				indices[i++] = vertIndex + stride + 1;
				indices[i++] = vertIndex;
				continue;
			}

			if (resolvedFlips[nextFlipIndex] > 0){ // flip right
				indices[i++] = vertIndex;
				indices[i++] = vertIndex + stride;
				indices[i++] = vertIndex + 1;

				indices[i++] = vertIndex + stride;
				indices[i++] = vertIndex + stride + 1;
				indices[i++] = vertIndex + 1;
			} else { // flip left
				indices[i++] = vertIndex + 1;
				indices[i++] = vertIndex;
				indices[i++] = vertIndex + stride;

				indices[i++] = vertIndex + stride + 1;
				indices[i++] = vertIndex + 1;
				indices[i++] = vertIndex + stride;
			}

			++nextFlipIndex;
			if (nextFlipIndex < resolvedFlips.length)
				nextFlipVertIndex = Math.abs(resolvedFlips[nextFlipIndex]);
			else
				nextFlipVertIndex = Infinity;
		}
	}
	return indices;
}
