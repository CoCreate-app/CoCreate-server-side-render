const { parse } = require("node-html-parser");
const { checkValue } = require("@cocreate/utils");

class CoCreateServerSideRender {
	constructor(crud) {
		this.crud = crud;
	}

	async HTML(file) {
		const self = this;
		let ignoreElement = {
			INPUT: true,
			TEXTAREA: true,
			SELECT: true,
			LINK: true,
			IFRAME: true,
			"COCREATE-SELECT": true
		};

		let dep = [];
		let dbCache = new Map();

		async function render(dom, lastKey) {
			// Handle elements with [array][key][object]
			for (let el of dom.querySelectorAll("[array][key][object]")) {
				let meta = el.attributes;

				if (ignoreElement[el.tagName]) continue;

				if (el.closest(".template, [template], template, [render]"))
					continue;

				if (el.hasAttribute("render-query")) continue;

				if (el.hasAttribute("component") || el.hasAttribute("plugin"))
					continue;

				if (el.hasAttribute("actions")) continue;

				let _id = meta["object"],
					array = meta["array"],
					key = meta["key"];
				let crudKey = _id + array + key;

				if (!_id || !key || !array) continue;
				if (!checkValue(_id) || !checkValue(key) || !checkValue(array))
					continue;
				if (dep.includes(crudKey))
					throw new Error(
						`infinite loop: ${lastKey} ${array} ${key} ${_id} has been already rendered`
					);
				else dep.push(crudKey);

				let cacheKey = _id + array;
				let data;
				if (dbCache.has(cacheKey)) {
					data = dbCache.get(cacheKey);
				} else {
					data = await self.crud.send({
						method: "object.read",
						array,
						object: { _id },
						organization_id
					});
					if (data && data.object && data.object[0])
						data = data.object[0];

					dbCache.set(cacheKey, data);
				}

				if (!data || !data[key]) {
					dep.pop();
					continue;
				}

				let chunk = data[key];
				if (!chunk) {
					dep.pop();
					continue;
				}

				chunk = await render(chunk);

				el.setAttribute("rendered", "");
				el.innerHTML = "";
				el.appendChild(chunk);

				dep.pop();
			}

			// Handle elements with [src]
			// for (let el of dom.querySelectorAll(
			// 	"[src]:not(script, img, iframe, audio, video, source, track, input, embed, frame)"
			// )) {
			// 	let src = el.getAttribute("src");
			// 	if (!src) continue;

			// 	// Construct actual pathname using src and the original URL
			// 	let basePath = new URL(url).pathname;
			// 	let resolvedPathname = new URL(
			// 		src,
			// 		`http://localhost${basePath}`
			// 	).pathname;

			// 	if (resolvedPathname.endsWith("/")) {
			// 		resolvedPathname += "index.html";
			// 	}
			// 	let $filter = {
			// 		query: {
			// 			pathname: resolvedPathname
			// 		}
			// 	}; // Use filter to structure query

			// 	let data = await self.crud.send({
			// 		method: "object.read",
			// 		array: "files",
			// 		object: "",
			// 		$filter,
			// 		organization_id
			// 	});

			// 	if (
			// 		data &&
			// 		data.object &&
			// 		data.object[0] &&
			// 		data.object[0].src
			// 	) {
			// 		let chunk = data.object[0].src;
			// 		let path = el.getAttribute("path");
			// 		if (path) chunk = chunk.replaceAll("{{path}}", path);

			// 		chunk = await render(chunk);

			// 		el.setAttribute("rendered", "");
			// 		el.innerHTML = "";
			// 		el.appendChild(chunk);
			// 	}
			// }

			return dom;
		}

		let dom = parse(file.src);
		dom = await render(dom, "root");
		if (file.langRegion || file.lang) {
			dom = translate(dom, file);
			let langLinkTags = createLanguageLinkTags(file);
			const head = dom.querySelector("head");
			if (head && langLinkTags) {
				const linksFragment = parse(
					`<fragment>${langLinkTags}</fragment>`
				);
				for (const link of linksFragment.childNodes) {
					head.appendChild(link);
				}
			}
		}
		dep = [];
		dbCache.clear();
		return dom.toString();
	}

	createLanguageLinkTags(file) {
		let xDefault = file.path;

		if (file.name !== "index.html") {
			if (xDefault.endsWith("/")) {
				xDefault += file.name;
			} else {
				xDefault += "/" + file.name;
			}
		}
		let generatedLinksString = `<link rel="alternate" hreflang="x-default" href="${xDefault}">\n`;

		// Step 1: Create a lookup object that maps base language to its path.
		// This is done once for efficiency.
		const paths = {};
		for (const p of file.pathname) {
			const secondSlashIndex = p.indexOf("/", 1);
			const langKey = p.substring(1, secondSlashIndex); // e.g., 'en', 'es', 'pt'
			const restOfPath = p.substring(secondSlashIndex);
			paths[langKey] = restOfPath;
		}

		// Step 2: Iterate through all supported languages and build the HTML string.
		for (const language of file.languages) {
			// Use the base language to find the correct path in our map
			const path = paths[language] || paths[language.split("-")[0]];

			// If a valid path exists, construct the full link
			if (path) {
				// Construct the full href URL using the full language code from the array
				const hrefUrl = `https://${file.urlObject.hostname}/${language}${path}`;

				// Append the HTML string. The hreflang and the URL path are now in sync.
				generatedLinksString += `<link rel="alternate" hreflang="${language}" href="${hrefUrl}">\n`;
			}
		}
		return generatedLinksString;
	}

	async translate(dom, file) {
		let langRegion = file.langRegion;
		let lang = file.lang;
		if (file.translations & (langRegion || lang)) {
			for (let translation of file.translations) {
				let el = dom.querySelectorAll(translation.selector);
				if (translation.innerHTML) {
					let content =
						translation.innerHTML[langRegion] ||
						translation.innerHTML[lang];
					if (content) {
						el.innerHTML = content;
					}
				}
				if (translation.attributes) {
					for (let [key, language] of Object.entries(
						translation.attributes
					)) {
						let value = language[langRegion] || language[lang];
						if (value) {
							el.setAttribute(key, value);
						}
					}
				}
			}
		}
	}
}

module.exports = CoCreateServerSideRender;
