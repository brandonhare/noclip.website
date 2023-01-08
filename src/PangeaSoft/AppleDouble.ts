
// https://en.wikipedia.org/wiki/AppleSingle_and_AppleDouble_formats
// https://en.wikipedia.org/wiki/Resource_fork

import ArrayBufferSlice from "../ArrayBufferSlice";
import { assert, readString } from "../util";

enum EntryId {
	Data_Fork = 1,
	Resource_Fork,
	Real_Name,
	Comment,
	Icon_BW,
	Icon_Color,
	File_Dates_Info,
	Finder_Info,
	Macintosh_File_Info,
	ProDOS_File_Info,
	MSDOS_File_Info,
	Short_Name,
	AFP_File_Info,
	Directory_ID,
};

/*
export type Resource = {
	name : string,
	attributes : number,
	data : ArrayBufferSlice
};
*/
export type ResourceFork = Map<String, Map<number, ArrayBufferSlice>>;

export function parseResourceFork(buffer : ArrayBufferSlice) : ResourceFork{
	const data = buffer.createDataView();

	const dataOffset = data.getUint32(0);
	const mapOffset = data.getUint32(4);
	//const dataLength = data.getUint32(8);
	//const mapLength = data.getUint32(12);
	
	// read map
	assert(data.getUint32(mapOffset) === dataOffset); // copy of file header
	assert(data.getUint32(mapOffset + 4) === mapOffset);
	//assert(data.getUint32(mapOffset + 8) === dataLength);
	//assert(data.getUint32(mapOffset + 12) === mapLength);
	//const nextMapHandle = data.getUint32(mapOffset + 16);
	//const fileRefNumber = data.getUint16(mapOffset + 20);
	//const forkAttributes = data.getUint16(mapOffset + 22);
	const typeListOffset = mapOffset + data.getUint16(mapOffset + 24);
	const nameListOffset = mapOffset + data.getUint16(mapOffset + 26);
	const numTypes = data.getUint16(mapOffset + 28) + 1;

	const result : ResourceFork = new Map();

	for (let typeNum = 0; typeNum < numTypes; ++typeNum){
		const type = readString(buffer, mapOffset + typeNum * 8 + 30, 4, false);
		const numResourcesOfType = data.getUint16(mapOffset + typeNum * 8 + 34) + 1;
		const referenceListOffset = typeListOffset + data.getUint16(mapOffset + typeNum * 8 + 36);

		const resources = new Map<number, ArrayBufferSlice>();
		result.set(type, resources);

		for (let resourceNum = 0; resourceNum < numResourcesOfType; ++resourceNum){
			const resourceId = data.getUint16(referenceListOffset + resourceNum * 12);
			const resourceNameOffset = nameListOffset + data.getUint16(referenceListOffset + resourceNum * 12 + 2);
			const attributesAndDataOffset = data.getUint32(referenceListOffset + resourceNum * 12 + 4);
			const resourceAttributes = (attributesAndDataOffset >> 24) && 0xFF;
			const resourceDataOffset = dataOffset + (attributesAndDataOffset & 0x00FFFFFF);
			//const resourceHandle = data.getUint32(referenceListOffset + resourceNum*12 + 8);

			assert((resourceAttributes & 1) === 0, "Compressed resources not supported");

			const nameLength = data.getUint8(resourceNameOffset);
			const name = readString(buffer, resourceNameOffset + 1, nameLength, false);

			const resourceDataLength = data.getUint32(resourceDataOffset);
			const resourceData = buffer.subarray(resourceDataOffset + 4, resourceDataLength);

			//if (resourceAttributes !== 0) console.log("attribute", name, //resourceAttributes);

			resources.set(resourceId, resourceData);

			/*
			resources.set(resourceId, {
				name,
				attributes : resourceAttributes,
				data : resourceData,
			});
			*/
		}

		
	}

	return result;
}

export function parseAppleDouble(buffer : ArrayBufferSlice) : ResourceFork {
	const data = buffer.createDataView();

	assert(data.getUint32(0) === 0x00051607, "invalid magic number");
	assert(data.getUint32(4) === 0x00020000, "invalid version number");
	const numEntries = data.getUint16(24);

	for (let i = 0; i < numEntries; ++i){
		const id = data.getUint32(i * 12 + 26);
		const offset = data.getUint32(i * 12 + 30);
		const length = data.getUint32(i * 12 + 34);

		if (id === EntryId.Resource_Fork){
			return parseResourceFork(buffer.subarray(offset, length));
		}
	}
	assert(false, "todo");
}
