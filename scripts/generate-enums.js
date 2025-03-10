const FS = require('fs');
const HTTPS = require('https');
const URL = require('url');

const GENERATED_FILE_HEADER = `/* eslint-disable */\n// Auto-generated by generate-enums script on ${(new Date()).toString()}\n\n`;

// Sometimes Valve prefixes an enum with "k_ESomePrefix_", sometimes they prefix with "k_ETheEnumName", and sometimes
// they prefix with "k_ENotTheEnumName" (without an underscore). This third case can't be handled automatically.
const ENUMS_WITH_DIFFERENT_PREFIXES_FROM_THEIR_NAMES = {
	"EFrameAccumulatedStat": "k_EFrameStat",
	"EHIDDeviceDisconnectMethod": "k_EDeviceDisconnectMethod",
	"EHIDDeviceLocation": "k_EDeviceLocation",
	"ELogFileType": "k_ELogFile",
	"EPublishedFileForSaleStatus": "k_PFFSS_",
	"ERemoteClientBroadcastMsg": "k_ERemoteDevice",
	"ERemoteDeviceAuthorizationResult": "k_ERemoteDeviceAuthorization",
	"ERemoteDeviceStreamingResult": "k_ERemoteDeviceStreaming",
	"EStreamControlMessage": "k_EStreamControl",
	"EStreamDataMessage": "k_EStream",
	"EStreamDiscoveryMessage": "k_EStreamDiscovery",
	"EStreamFrameEvent": "k_EStream",
	"EStreamFramerateLimiter": "k_EStreamFramerate",
	"EStreamGamepadInputType": "k_EStreamGamepadInput",
	"EStreamingDataType": "k_EStreaming",
	"EStreamMouseWheelDirection": "k_EStreamMouseWheel",
	"EStreamQualityPreference": "k_EStreamQuality",
	"EStreamStatsMessage": "k_EStreamStats",
	"EChatRoomNotificationLevel": "k_EChatroomNotificationLevel"
};

const ENUMS_WITH_SOMETIMES_DIFFERENT_PREFIXES = {
	"EClientPersonaStateFlag": "k_EClientPersonaState"
};

// Some enums are just named wrong
const ENUM_NAMES_TO_FIX = {
	"EChatroomNotificationLevel": "EChatRoomNotificationLevel"
};

// Generate enums
if (!FS.existsSync(__dirname + '/../enums')) {
	FS.mkdirSync(__dirname + '/../enums');
}

let g_EnumNames = {};
let g_EnumNamesNormalized = {};

processProtobufEnums();
download("https://api.github.com/repos/SteamRE/SteamKit/contents/Resources/SteamLanguage", function(data) {
	let json = JSON.parse(data);
	if (!json.length) {
		throw new Error("Cannot get data from GitHub");
	}

	let remainingFiles = 0;
	json.forEach(function(file) {
		if (!file.name.match(/\.steamd$/)) {
			return;
		}

		remainingFiles++;
		// Get the download URL from the github API
		download(file.download_url, function(fileContents) {
			// This parser isn't terribly robust, but it works as long as SteamRE doesn't change their resource format
			let currentEnum = null;
			fileContents.split("\n").forEach(function(line) {
				// Go line-by-line
				line = line.trim(); // trim whitespace
				let idx = line.indexOf("//");
				if (idx != -1) {
					line = line.substring(0, idx).trim(); // remove line comments
				}

				let match;
				if (!currentEnum) {
					// We're not currently parsing any enum. Is this the opening of one?
					if ((match = line.match(/^enum (E[a-zA-Z0-9]+)(<[a-z]+>)?( flags)?/))) {
						// Okay, this is an enum assuming the next line is a bracket
						currentEnum = match[1];
						if (ENUM_NAMES_TO_FIX[currentEnum]) {
							currentEnum = ENUM_NAMES_TO_FIX[currentEnum];
						}
					}
				} else if (typeof currentEnum === 'string') {
					if (line != "{") {
						throw new Error("Syntax error parsing " + file.name + ", bad token following " + currentEnum);
					} else {
						// Okay now we're *really* parsing this enum
						currentEnum = {
							"name": currentEnum,
							"values": [],
							"dynamicValues": []
						};
					}
				} else {
					if (line.match(/^};?$/)) {
						process.stdout.write(`Generating ${currentEnum.name}.js... `);
						// We're done parsing this enum, let's go ahead and generate the file
						// First make sure it has actually changed
						let enumFileName = `${__dirname}/../enums/${currentEnum.name}.js`;
						let {changed, valuesToAdd} = validateEnum(enumFileName, currentEnum.values, currentEnum.dynamicValues);
						if (!changed) {
							// Enum has not changed
							console.log('unchanged');
							g_EnumNames[currentEnum.name] = true;
							let normalized = currentEnum.name.toLowerCase();
							if (g_EnumNamesNormalized[normalized] && g_EnumNamesNormalized[normalized] != currentEnum.name) {
								throw new Error(`Duplicate enum ${currentEnum.name}`);
							}

							g_EnumNamesNormalized[normalized] = currentEnum.name;
							currentEnum = null;
							return;
						}

						process.stdout.write('\n');

						currentEnum.values = currentEnum.values.concat(valuesToAdd);
						currentEnum.values.sort(sortEnum);

						let file = GENERATED_FILE_HEADER + "/**\n * @enum " + currentEnum.name + "\n */\nmodule.exports = {\n";

						currentEnum.values.forEach(function(val) {
							file += "\t\"" + val.name + "\": " + val.value + "," + (val.comment ? " // " + val.comment.trim() : "") + "\n";
						});

						file += "\n\t// Value-to-name mapping for convenience\n";

						// Put down the reverse, for simplicity in use
						currentEnum.values.forEach(function(val, idx) {
							if (!val.value.match(/^-?[0-9]+/)) {
								return; // it's dynamic
							}

							// Is this the last value in this enum with this value?
							if (currentEnum.values.some(function(val2, idx2) { return val2.value == val.value && idx2 > idx; })) {
								return;
							}

							file += "\t\"" + val.value + "\": \"" + val.name + "\",\n";
						});

						file += "};\n";

						if (currentEnum.dynamicValues.length > 0) {
							file += "\n";
							currentEnum.dynamicValues.forEach(function(val) {
								file += "module.exports." + val.name + " = " + val.value + ";" + (val.comment ? " // " + val.comment.trim() : "") + "\n";
							});
						}

						FS.writeFileSync(enumFileName, file);
						g_EnumNames[currentEnum.name] = true;
						let normalized = currentEnum.name.toLowerCase();
						if (g_EnumNamesNormalized[normalized] && g_EnumNamesNormalized[normalized] != currentEnum.name) {
							throw new Error(`Duplicate enum ${currentEnum.name}`);
						}

						g_EnumNamesNormalized[normalized] = currentEnum.name;
						currentEnum = null;
					} else if ((match = line.match(/^([A-Za-z0-9_]+) = ([^;]+);(.*)$/))) {
						let name = match[1];
						let value = match[2];
						let comment = match[3];

						if (value.match(/^0x[0-9A-Fa-f]+$/)) {
							value = parseInt(value.substring(2), 16).toString();
						}

						let isDynamic = false;

						let flags = value.split('|').map(function(flag) {
							flag = flag.trim();

							if (flag.match(/^-?[0-9]+$/)) {
								return flag;
							} else {
								isDynamic = true;
								return 'module.exports.' + flag;
							}
						});

						value = flags.join(' | ');

						(isDynamic ? currentEnum.dynamicValues : currentEnum.values).push({
							"name": name,
							"value": value,
							"comment": comment
						});
					}
				}
			});

			if (--remainingFiles == 0) {
				// All done
				console.log("Finished downloading and parsing enums");
				g_EnumNames = Object.keys(g_EnumNames);
				g_EnumNames.sort();

				let loader = GENERATED_FILE_HEADER + "const SteamUser = require('../index.js');\n\n";
				loader += g_EnumNames.map(name => "SteamUser." + name + " = require('../enums/" + name + ".js');").join("\n") + "\n";
				FS.writeFileSync(__dirname + '/../resources/enums.js', loader);
			}
		});
	});

	// All done
});

function processProtobufEnums() {
	console.log("Processing protobuf enums...");

	const Schema = require('../protobufs/generated/_load.js');
	for (let enumName in Schema) {
		if (!Schema.hasOwnProperty(enumName)) {
			continue;
		}

		if (enumName[0] != 'E' || Schema[enumName].encode || Schema[enumName].create) {
			continue; // not an enum
		}

		process.stdout.write(`Generating ${enumName}.js... `);
		let thisEnum = Schema[enumName];

		if (ENUM_NAMES_TO_FIX[enumName]) {
			enumName = ENUM_NAMES_TO_FIX[enumName];
		}

		let processed = [];
		for (let i in thisEnum) {
			if (!thisEnum.hasOwnProperty(i)) {
				continue;
			}

			let name = i.replace(new RegExp(`^k_${enumName}_?`), '').replace(/^k_E[^_]+_/, '');
			if (ENUMS_WITH_DIFFERENT_PREFIXES_FROM_THEIR_NAMES[enumName]) {
				name = name.replace(ENUMS_WITH_DIFFERENT_PREFIXES_FROM_THEIR_NAMES[enumName], '');
			} else if (ENUMS_WITH_SOMETIMES_DIFFERENT_PREFIXES[enumName]) {
				if (name.startsWith(ENUMS_WITH_SOMETIMES_DIFFERENT_PREFIXES[enumName]) && !name.startsWith(`k_${enumName}`)) {
					name = name.replace(ENUMS_WITH_SOMETIMES_DIFFERENT_PREFIXES[enumName], '');
				}
			}

			processed.push({
				name,
				value: thisEnum[i]
			});
		}

		let enumFileName = `${__dirname}/../enums/${enumName}.js`;

		// Check to see if the enum has changed at all
		let {changed, valuesToAdd} = validateEnum(enumFileName, processed);
		if (!changed) {
			// Enum did not change
			console.log('unchanged');
			g_EnumNames[enumName] = true;
			let normalized = enumName.toLowerCase();
			if (g_EnumNamesNormalized[normalized] && g_EnumNamesNormalized[normalized] != enumName) {
				throw new Error(`Duplicate enum ${enumName}`);
			}
			g_EnumNamesNormalized[normalized] = enumName;
			continue;
		}

		process.stdout.write('\n');

		processed = processed.concat(valuesToAdd);
		processed.sort(sortEnum);

		let enumFile = `/**\n  * @enum ${enumName}\n  */\nmodule.exports = {\n`;
		enumFile += processed.map(v => `\t"${v.name}": ${v.value},` + (v.comment ? ` // ${v.comment}` : '')).join("\n");
		enumFile += "\n\n\t// Value-to-name mapping for convenience\n";
		enumFile += processed.filter(v => v.comment !== 'obsolete').map(v => `\t"${v.value}": "${v.name}",`).join("\n");
		enumFile += "\n};\n";
		FS.writeFileSync(`${__dirname}/../enums/${enumName}.js`, enumFile);

		g_EnumNames[enumName] = true;
		let normalized = enumName.toLowerCase();
		if (g_EnumNamesNormalized[normalized] && g_EnumNamesNormalized[normalized] != enumName) {
			throw new Error(`Duplicate enum ${enumName}`);
		}
		g_EnumNamesNormalized[normalized] = enumName;
	}

	console.log("Finished processing protobuf enums");
}

// Helper functions
function download(url, callback) {
	let reqData = URL.parse(url);
	reqData.servername = reqData.hostname;
	reqData.headers = {"User-Agent": "node-steam-user data parser"};
	reqData.method = "GET";

	// This will crash if there's an error. But that's fine.
	HTTPS.request(reqData, function(res) {
		let data = "";
		res.on('data', function(chunk) {
			data += chunk;
		});

		res.on('end', function() {
			callback(data);
		});
	}).end();
}

function validateEnum(enumFileName, values, dynamicValues = []) {
	let output = {
		changed: true,
		valuesToAdd: []
	};

	if (FS.existsSync(enumFileName)) {
		let existingEnum = Object.assign({}, require(enumFileName)); // clone it since we're about to manipulate it
		for (let i in existingEnum) {
			if (i.match(/^-?\d+$/)) {
				delete existingEnum[i];
				continue;
			}

			if (dynamicValues.some(v => v.name == i)) {
				// This is a dynamic value
				continue;
			}

			let isGone = !values.some(v => v.value == existingEnum[i] && v.name == i);
			let wasRenamed = isGone && values.some(v => v.value == existingEnum[i] && v.name != i);

			if (isGone) {
				// Looks like the name of this value has changed, or it was deleted entirely
				output.valuesToAdd.push({name: i, value: existingEnum[i].toString(), comment: wasRenamed ? 'obsolete' : 'removed'});
			}
		}

		if (values.length + output.valuesToAdd.length + dynamicValues.length == Object.keys(existingEnum).length) {
			// Enum did not change
			output.changed = false;
		}
	}

	return output;
}

function sortEnum(a, b) {
	let aValue = parseInt(a.value, 10);
	let bValue = parseInt(b.value, 10);
	if (isNaN(aValue)) {
		aValue = a.value;
	}
	if (isNaN(bValue)) {
		bValue = b.value;
	}
	if (aValue == bValue) {
		// We want obsolete/removed values to go first
		if (a.comment && !b.comment) {
			return -1;
		} else if (b.comment && !a.comment) {
			return 1;
		}

		if (a.name == b.name) {
			return 0;
		}

		if (a.name.startsWith('Base') || a.name.endsWith('Base')) {
			return -1;
		} else if (b.name.startsWith('Base') || b.name.endsWith('Base')) {
			return 1;
		}

		return a.name < b.name ? -1 : 1;
	}

	if (aValue == bValue) {
		return 0;
	}

	return aValue < bValue ? -1 : 1;
}
