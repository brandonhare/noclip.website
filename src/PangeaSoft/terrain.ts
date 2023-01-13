
export class TerrainInfo {
	width : number;
	height : number;
	stride : number;
	xzScale : number;
	yScale : number;
	heightmap : Uint8Array | Float32Array;
	constructor(width : number, height : number, heightmap : Uint8Array | Float32Array, xzScale : number, yScale : number){
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
		
		let h1 = this.heightmap[baseIndex];
		let h2 = this.heightmap[baseIndex + 1];
		let h3 = this.heightmap[baseIndex + this.stride];
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

export function convertTilemapId(tile : number){
	const enum FlipFlags {
		SWIZZLE = 0x1000,
		FLIP_X  = 0x2000,
		FLIP_Y  = 0x4000,
	}

	const tileId = tile & 0xFFF;
	const flipX = (tile & 0x8000) !== 0;
	const flipY = (tile & 0x4000) !== 0;
	const rot = (tile >> 12) & 0x3;

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

export function convertTilemapFlips(tilemap : Uint16Array){


	for (let i = 0; i < tilemap.length; ++i){
		tilemap[i] = convertTilemapId(tilemap[i]);
	}
}

// h0 ---- h1
//  |      | 
//  |      |
// h3 ---- h2
function needsFlip(h0 : number, h1 : number, h2 : number, h3 : number) : boolean{
	return Math.abs(h0 - h2) > Math.abs(h1 - h3);
}
function flipped(heightmap : ArrayLike<number>, stride : number, baseIndex : number) : boolean {
	const h0 = heightmap[baseIndex];              
	const h1 = heightmap[baseIndex + 1];          
	const h2 = heightmap[baseIndex + stride + 1]; 
	const h3 = heightmap[baseIndex + stride];     
	return needsFlip(h0, h1, h2, h3);
}



export function createVerticesFromHeightmap(target : Uint16Array | Float32Array, heightmap : ArrayLike<number>, mapWidth : number, mapHeight : number){
	let i = 0;
	const stride = mapWidth + 1;
	for (let row = 0; row <= mapHeight; ++row){
		for (let col = 0; col <= mapWidth; ++col){
			target[i++] = col;
			target[i++] = heightmap[row * stride + col];
			target[i++] = row;
		}
	}
}

export function createTilemapIds(target : Uint16Array, tilemap : Uint16Array, width : number, height : number){
	const stride = width + 1;
	let max = 0;
	for (let row = 0; row < height; ++row){
		for (let col = 0; col < width; ++col){
			const tile = tilemap[row * width + col];
			target[row * stride + col] = tile;
			max = Math.max(max, tile & 0xFFF);
		}
	}
	return max;
}

export function createNormalsFromHeightmap(target : Float32Array, heightmap : ArrayLike<number>, width : number, height : number, xzScale : number, heightScale : number){
	const stride = width + 1;
	heightScale *= 0.1;
	for (let row = 0; row <= height; ++row){
		for (let col = 0; col <= width; ++col){
			//   --h0--
			//  |      | 
			// h3  bi  h1
			//  |      |
			//   --h2--
			const baseIndex = row * stride + col;
			const h0 = row > 0 ? heightmap[baseIndex - stride] : 0;
			const h1 = col < width ? heightmap[baseIndex + 1] : 0;
			const h2 = row < height ? heightmap[baseIndex + stride] : 0;
			const h3 = col > 0 ? heightmap[baseIndex - 1] : 0;
			const x = (h3 - h1) * heightScale;
			const z = (h0 - h2) * heightScale;
			const magnitude = 1 / Math.hypot(x, z, 1);
			target[baseIndex*3  ] = x * magnitude;
			target[baseIndex*3+1] = 1 * magnitude;
			target[baseIndex*3+2] = z * magnitude;

			// todo check scales
		}
	}
}

export function createIndices(heightmap : ArrayLike<number>, tilemap : ArrayLike<number>, width : number, height : number, replacedTextures : Map<number, number>, duplicatedVerts : number[]){

	const stride = width + 1;
	const newVertBaseIndex = stride * (height + 1);
	const indexBuffer = new Uint32Array(width * height * 6);

	let index = 0;
	function addStandard(vertIndex : number){
		const right = vertIndex + 1;
		const down = vertIndex + stride;
		const downRight = down + 1;

		indexBuffer[index++] = down;
		indexBuffer[index++] = downRight;
		indexBuffer[index++] = vertIndex;

		indexBuffer[index++] = downRight;
		indexBuffer[index++] = right;
		indexBuffer[index++] = vertIndex;
	}
	function addFlipRight(vertIndex : number, right = vertIndex + 1){
		const down = vertIndex + stride;
		const downRight = down + 1;

		indexBuffer[index++] = vertIndex;
		indexBuffer[index++] = down;
		indexBuffer[index++] = right;

		indexBuffer[index++] = down;
		indexBuffer[index++] = downRight;
		indexBuffer[index++] = right;
	}
	function addFlipDown(vertIndex : number, down = vertIndex + stride){
		const right = vertIndex + 1;
		const downRight = right + stride;

		indexBuffer[index++] = right;
		indexBuffer[index++] = vertIndex;
		indexBuffer[index++] = down;

		indexBuffer[index++] = downRight;
		indexBuffer[index++] = right;
		indexBuffer[index++] = down;
	}


	for (let row = 0; row < height; ++row){
		for (let col = 0; col < width; ++col){
			const baseVertexIndex = row * stride + col;
			if (!flipped(heightmap, stride, baseVertexIndex)){
				addStandard(baseVertexIndex);
				continue;
			}

			const tile = tilemap[row * width + col];

			const rightIndex = baseVertexIndex + 1;
			const downIndex = baseVertexIndex + stride;
			const rightTile = (col + 1 < width) ? tilemap[row * width + col + 1] : -1;
			const downTile = (row + 1 < height) ? tilemap[(row + 1) * width + col] : -1;
			const rightFlip = flipped(heightmap, stride, rightIndex);
			const downFlip = flipped(heightmap, stride, downIndex);

			// check lucky cases
			if (rightTile === tile && !rightFlip){
				addFlipRight(baseVertexIndex);
				continue;
			} else if (downTile === tile && !downFlip){
				addFlipDown(baseVertexIndex);
				continue;
			}
			// check if we're the edge of the map, can use those verts
			if (rightTile === -1){
				addFlipRight(baseVertexIndex);
				replacedTextures.set(rightIndex, tile);
				continue;
			} else if (downTile === -1){
				addFlipDown(baseVertexIndex);
				replacedTextures.set(downIndex, tile);
				continue;
			}

			// see if a flip from the previous row claimed a tile we can share
			const replacedRightTexture = replacedTextures.get(rightIndex)
			if (replacedRightTexture === tile){
				addFlipRight(baseVertexIndex);
				continue;
			}

			// see if there's an open slot we can use to the right
			if (replacedRightTexture === undefined && rightFlip){
				addFlipRight(baseVertexIndex);
				replacedTextures.set(rightIndex, tile);
				continue;
			}
			
			// see if there's a created vert we can share

			const duplicatedVertOffset = duplicatedVerts.indexOf(rightIndex);
			if (duplicatedVertOffset !== -1){
				const duplicatedVertId = newVertBaseIndex + duplicatedVertOffset;
				if (replacedTextures.get(duplicatedVertId) === tile){
					addFlipRight(baseVertexIndex, duplicatedVertId);
					continue;
				}
			}


			// see if there's an open slot we can use below
			if (downFlip){
				addFlipDown(baseVertexIndex);
				replacedTextures.set(downIndex, tile);
				continue;
			}

			// nowhere available for us to share, make a new vert
			const newVertId = newVertBaseIndex + duplicatedVerts.length;
			duplicatedVerts.push(downIndex);
			addFlipDown(baseVertexIndex, newVertId);
			replacedTextures.set(newVertId, tile);
		}
	}

	return indexBuffer;
}

export function expandVertexColours(target : Uint8Array, source : Uint16Array){
	for (let i = 0; i < source.length; ++i){
		const pixel = source[i];
		// 0-1
		/*
		target[i * 3    ] = ((pixel >> 11) & 0x1F) / 32;
		target[i * 3 + 1] = ((pixel >>  5) & 0x3F) / 64;
		target[i * 3 + 2] = ((pixel      ) & 0x1F) / 32;
		*/
		// 0-255
		target[i * 3    ] = (pixel >> 8) & 0xF8;
		target[i * 3 + 1] = (pixel >> 3) & 0xFC;
		target[i * 3 + 2] = (pixel << 3) & 0xF8;
	}
}
