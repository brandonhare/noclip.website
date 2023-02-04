import ArrayBufferSlice from "../ArrayBufferSlice";
import { GfxFormat } from "../gfx/platform/GfxPlatformFormat";
import { assert, readString } from "../util";

export type TGATexture = {
	width : number,
	height : number,
	pixels : Uint8Array | Uint16Array,
	pixelFormat : GfxFormat,
}

export function loadTextureFromTGA(buffer : ArrayBufferSlice) : TGATexture {

	//const footerMagic = readString(buffer, buffer.byteLength - 18, 18, false);
	//assert(footerMagic === "TRUEVISION-XFILE.\0", "not a TGA file!"); // not always present

	const data = buffer.createDataView();

	// read file header
	const idLength = data.getUint8(0);
	const colourMapType = data.getUint8(1);
	const imageType = data.getUint8(2);
	// read colour map spec
	const colourMapFirstEntryIndex = data.getUint16(3, true);
	const colourMapNumEntries = data.getUint16(5, true);
	const colourMapEntrySizeBits = data.getUint8(7)
	// read image spec
	//const xOrigin = data.getUint16(8, true);
	//const yOrigin = data.getUint16(10, true);
	const width = data.getUint16(12, true);
	const height = data.getUint16(14, true);
	const pixelIndexDepth = data.getUint8(16);
	const imageDescriptor = data.getUint8(17);


	const alphaChannelDepth = imageDescriptor & 0xF;
	const rightToLeft = (imageDescriptor & 0x10) !== 0;
	const topToBottom = (imageDescriptor & 0x20) !== 0;

	const imageFormat = imageType & 0x7;
	const usesRLE = (imageType & 0x08) !== 0;
	const usesColourMap = imageFormat === 1;
	const greyscale = imageFormat === 3;

	const colourMapEntrySize = Math.ceil(colourMapEntrySizeBits / 8);
	const bytesPerPixelIndex = Math.ceil(pixelIndexDepth / 8);
	const bytesPerPixel = usesColourMap ? colourMapEntrySize : bytesPerPixelIndex;

	assert(colourMapType <= 1, "Unsupported TGA colour map type");
	assert(!usesColourMap || (colourMapType === 1), "TGA missing required colour map");
	assert(imageType !== 0, "TGA has no image data");
	assert(imageType <= 3 || (imageType >= 9 && imageType <= 11), "Unsupported TGA image type");
	assert((imageDescriptor & 0xC0) === 0, "Unsupported TGA image settings");
	if (usesColourMap){
		assert(bytesPerPixelIndex >= 1 && bytesPerPixelIndex <= 4 && bytesPerPixelIndex !== 3, "Unsupported TGA pixel index size");
		assert(colourMapEntrySize > 0 && (greyscale || colourMapEntrySize !== 1) && colourMapEntrySize <= 4, "Unsupported TGA colour map entry size");
	}

	// todo: flip
	assert(!rightToLeft && topToBottom, "Flipped TGA images not implemented!");

	assert(alphaChannelDepth === 0 || alphaChannelDepth === 1 || alphaChannelDepth === 8, "Unsupported TGA alpha bit-depth");

	function choosePixelFormat(greyscale : boolean, alphaBits : number, bytesPerPixel : number) : GfxFormat | false {
		if (greyscale){
			if (alphaBits === 0){
				switch(bytesPerPixel){
					case 1: return GfxFormat.U8_R_NORM; // probably the only correct one
					case 2: return GfxFormat.U16_R_NORM;
					case 4: return GfxFormat.U32_R;
					default: return false;
				}
			} else {
				// todo: expand to rbga ourselves?
				return false;
			}
		} else { // colour
			switch(alphaBits){
				case 0: {
					switch(bytesPerPixel){
						case 2: return GfxFormat.U16_RGB_565; // probably incorrect
						case 3: return GfxFormat.U8_RGB_NORM;
						default: return false;
					}
				}
				case 1: {
					if (bytesPerPixel === 2)
						return GfxFormat.U16_RGBA_5551;
					else
						return false;
				}
				case 8: {
					if (bytesPerPixel === 4)
						return GfxFormat.U8_RGBA_NORM;
					else
						return false;
				}
				default:
					return false;
			}
		}
	}

	let pixelFormat = choosePixelFormat(greyscale, alphaChannelDepth, bytesPerPixel);
	assert(pixelFormat !== false, "Unsupported TGA pixel format");

	const colourMapDataStart = 18 + idLength;
	const colourMapSizeBytes = colourMapNumEntries * colourMapEntrySize;
	const colourMap = usesColourMap ? buffer.createTypedArray(Uint8Array, colourMapDataStart, colourMapSizeBytes) : undefined;
	const imageDataStart = colourMapDataStart + colourMapSizeBytes;


	function getMapIndex(offset : number){
		let index : number;
		switch(bytesPerPixelIndex){
			case 1: index = data.getUint8(offset); break;
			case 2: index = data.getUint16(offset, true); break;
			case 4: index = data.getUint32(offset, true); break;
		}
		return (index! - colourMapFirstEntryIndex) * colourMapEntrySize;
	}

	// read pixels
	const numPixels = width * height;
	const numPixelBytes = numPixels * bytesPerPixel;
	let pixels : Uint8Array | Uint16Array;
	let offset = imageDataStart;
	if (!usesRLE){
		if (!usesColourMap){
			pixels = buffer.createTypedArray(Uint8Array, imageDataStart, numPixelBytes);
		} else { // colour map with no RLE
			pixels = new Uint8Array(numPixelBytes);
			for (let pixelIndex = 0; pixelIndex < numPixels; ++pixelIndex){
				const mapIndex = getMapIndex(offset);
				offset += bytesPerPixelIndex;
				for (let j = 0; j < bytesPerPixel; ++j){
					pixels[pixelIndex * bytesPerPixel + j] = colourMap![mapIndex + j];
				}
			}
		}
	} else { // uses RLE
		pixels = new Uint8Array(numPixelBytes);
		let pixelIndex = 0;
		const templatePixel = [0,0,0,0];

		if (usesColourMap){
			while (pixelIndex < numPixels){
				const packetHeader = data.getUint8(offset);
				offset++;
				const packetLength = (packetHeader & 0x7F) + 1; // how many pixels this packet represents
				if (packetHeader & 0x80){ // RLE
					const mapIndex = getMapIndex(offset);
					offset += bytesPerPixelIndex;

					for (let i = 0; i < packetLength; ++i){
						for (let j = 0; j < bytesPerPixel; ++j){
							pixels[(pixelIndex + i) * bytesPerPixel + j] = colourMap![mapIndex + j]
						}
					}
					pixelIndex += packetLength;
				} else { // raw
					for (let i = 0; i < packetLength; ++i){
						const mapIndex = getMapIndex(offset);
						offset += bytesPerPixelIndex;
						for (let j = 0; j < bytesPerPixel; ++j){
							pixels[(pixelIndex + i) * bytesPerPixel + j] = colourMap![mapIndex + j];
						}
					}
					pixelIndex += packetLength;
				}
			}
		} else { // no colour map
			while (pixelIndex < numPixels){
				const packetHeader = data.getUint8(offset);
				offset++;
				const packetLength = (packetHeader & 0x7F) + 1; // how many pixels this packet represents
				const packetByteLength = packetLength * bytesPerPixel;
				if (packetHeader & 0x80){ // RLE
					for (let i = 0; i < bytesPerPixel; ++i)
						templatePixel[i] = data.getUint8(offset++);

					for (let i = 0; i < packetLength; ++i){
						for (let j = 0; j < bytesPerPixel; ++j){
							pixels[(pixelIndex + i) * bytesPerPixel + j] = templatePixel[j];
						}
					}
					pixelIndex += packetLength;
				} else { // raw
					for (let i = 0; i < packetByteLength; ++i){
						pixels[pixelIndex * bytesPerPixel + i] = data.getUint8(offset + i);
					}
					offset += packetByteLength;
					pixelIndex += packetLength;
				}
			}
		}
	}

	
	// swizzle
	if (bytesPerPixel === 2){
		pixels = new Uint16Array(pixels.buffer);
		if (pixelFormat === GfxFormat.U16_RGB_565){
			pixelFormat = GfxFormat.U16_RGBA_5551;
			for (let i = 0; i < pixels.length; ++i){
				const p = pixels[i];
				pixels[i] = (p << 1) | 1;
			}
		} else {
			for (let i = 0; i < numPixelBytes; i += 2){
				const value = pixels[i];
				pixels[i] = pixels[i+1];
				pixels[i+1] = value;
			}
		}
	} else if (bytesPerPixel === 3 || bytesPerPixel === 4) {
		// BGR or BGRA
		for (let i = 0; i < numPixelBytes; i += bytesPerPixel){
			const b = pixels[i];
			pixels[i] = pixels[i+2];
			pixels[i+2] = b;
		}
	}
	

	return {
		width,
		height,
		pixels,
		pixelFormat
	}
}
